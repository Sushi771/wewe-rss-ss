import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsLimitedRecoveryStore } from './xhs-limited-recovery-store';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';

describe('bounded single-note recovery reservation (synthetic only)', () => {
  let folder: string, db: PrismaClient;
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-recovery-test-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(folder, 'test.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const root = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(root)).sort()) {
      if (!(await fs.stat(path.join(root, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
  }, 40000);
  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM xhs_limited_recovery`;
    await db.$executeRaw`UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED',owner=NULL,http_status=NULL,endpoint=NULL WHERE id='source'`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
  });
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }, 40000);

  it('preserves the risk, binds the note and consumes the one attempt before dispatch', async () => {
    const store = new XhsLimitedRecoveryStore(db as any);
    const owner = await store.arm('synthetic-note', 'synthetic-author');
    await expect(store.start(owner, 'wrong-note')).rejects.toThrow();
    await store.start(owner, 'synthetic-note');
    await expect(store.start(owner, 'synthetic-note')).rejects.toThrow();
    await store.finish(owner, 'finished');
    await expect(
      store.arm('synthetic-note', 'synthetic-author'),
    ).rejects.toThrow();
    const risk = await db.$queryRaw<
      Array<{ state: string; code: string }>
    >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
    expect(risk).toEqual([
      { state: 'blocked', code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' },
    ]);
  });
  it('allows only one concurrent claimant and does not rearm after uncertain completion', async () => {
    const a = new XhsLimitedRecoveryStore(db as any),
      b = new XhsLimitedRecoveryStore(db as any);
    const claims = await Promise.allSettled([
      a.arm('synthetic-note', 'synthetic-author'),
      b.arm('synthetic-note', 'synthetic-author'),
    ]);
    expect(claims.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const owner = (
      claims.find(
        (x) => x.status === 'fulfilled',
      ) as PromiseFulfilledResult<string>
    ).value;
    await a.start(owner, 'synthetic-note');
    await expect(
      new XhsLimitedRecoveryStore(db as any).arm(
        'synthetic-note',
        'synthetic-author',
      ),
    ).rejects.toThrow();
    await a.finish(owner, 'unknown');
    await expect(b.arm('other-note', 'synthetic-author')).rejects.toThrow();
  });
  it.each([
    'success',
    'wrong-author',
    'exhausted',
    'refused',
    'token-echo',
    'media',
    'disabled-creator',
  ] as const)(
    'uses one scoped detail call and preserves history: %s',
    async (mode) => {
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,interval_ms) VALUES('xhs:source-total',3,${mode === 'exhausted' ? 3 : 0},1000)`;
      const note = `synthetic-${mode}`;
      if (mode === 'disabled-creator') {
        await db.xhsNote.deleteMany();
        await db.xhsCreator.deleteMany();
        await db.xhsCreator.create({
          data: {
            id: 'disabled',
            externalAuthorId: 'author',
            displayName: 'Synthetic',
            profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
            enabled: false,
          },
        });
      }
      const api = jest.fn(async (request: any) => ({
        status: mode === 'refused' ? 461 : 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: {
            items: [
              {
                id: note,
                note_card: {
                  note_id: note,
                  user: {
                    user_id: mode === 'wrong-author' ? 'other' : 'author',
                    nickname: 'Synthetic',
                  },
                  type: 'normal',
                  time: 1760000000000,
                  title: 'Synthetic',
                  desc:
                    mode === 'token-echo'
                      ? 'synthetic-ephemeral'
                      : 'Full synthetic body <script>unsafe</script>',
                  interact_info: {
                    liked_count: '0',
                    collected_count: '2',
                    share_count: '3',
                    comment_count: '4',
                  },
                  image_list:
                    mode === 'media'
                      ? [
                          {
                            url_default:
                              'https://sns-webpic.xhscdn.com/synthetic.jpg?secret=synthetic-image',
                          },
                        ]
                      : [],
                },
              },
            ],
          },
        },
      }));
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      runtime.bindLimitedRecoveryStore(new XhsLimitedRecoveryStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      const url = `https://www.xiaohongshu.com/discovery/item/${note}?xsec_token=synthetic-ephemeral&xsec_source=pc_share`;
      const work = runtime.resolveLimitedRecovery(url, 'author');
      if (mode === 'success' || mode === 'media') {
        const result = await work;
        const service = new XhsSubscriptionService(db as any, runtime);
        const saved = await service.commitLimitedRecovery(result);
        expect(saved).toMatchObject({
          subscribed: true,
          body: 'saved',
          media: mode === 'media' ? 'pending' : 'none',
        });
        const body = await db.xhsNote.findUniqueOrThrow({
          where: { id: saved.noteId },
        });
        expect(body.contentHtml).toContain('Full synthetic body');
        expect(body.contentHtml).toContain('&lt;script&gt;');
        expect(body.status).toBe('listed');
        expect(body.contentHtml).not.toContain('<img');
        const metrics = await db.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_metric_snapshots WHERE owner_id=${saved.noteId}`;
        expect(JSON.parse(metrics[0].document).values).toEqual({
          likes: 0,
          collects: 2,
          shares: 3,
          comments: 4,
        });
      } else if (mode === 'disabled-creator') {
        const result = await work;
        await expect(
          new XhsSubscriptionService(db as any, runtime).commitLimitedRecovery(
            result,
          ),
        ).rejects.toThrow('XHS_SUBSCRIPTION_CHANGED');
        expect(
          (await db.xhsCreator.findUniqueOrThrow({ where: { id: 'disabled' } }))
            .enabled,
        ).toBe(false);
      } else await expect(work).rejects.toThrow();
      if (mode !== 'success' && mode !== 'media')
        expect(
          await db.xhsNote.findUnique({
            where: { id: JSON.stringify(['xiaohongshu', 'note', note]) },
          }),
        ).toBeNull();
      expect(api).toHaveBeenCalledTimes(mode === 'exhausted' ? 0 : 1);
      const budgets = await db.$queryRaw<
        Array<{ used: number }>
      >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
      expect(budgets[0].used).toBe(mode === 'exhausted' ? 3 : 1);
      await expect(
        runtime.resolveLimitedRecovery(url, 'author'),
      ).rejects.toThrow();
      await expect(runtime.resolve(url)).rejects.toThrow();
      const risk = await new XhsSourceRiskStore(db as any).read();
      expect(risk).toBe(
        mode === 'refused'
          ? 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'
          : 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
      );
      const receipts = await db.$queryRaw<
        Array<{ note_id: string; author_id: string; state: string }>
      >`SELECT note_id,author_id,state FROM xhs_limited_recovery`;
      expect(JSON.stringify(receipts)).not.toContain('synthetic-ephemeral');
      const tasks = await db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT COUNT(*) AS count FROM xhs_subscription_tasks`;
      expect(Number(tasks[0].count)).toBe(0);
      runtime.onModuleDestroy();
    },
    40000,
  );

  it('stops expired authorization before transport and never enables a disabled source', async () => {
    const store = new XhsLimitedRecoveryStore(db as any);
    const owner = await store.arm('synthetic-note', 'synthetic-author');
    await db.$executeRaw`UPDATE xhs_limited_recovery SET expires_at=0`;
    await expect(store.start(owner, 'synthetic-note')).rejects.toThrow();
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({ enabled: () => false, api });
    runtime.bindLimitedRecoveryStore(store);
    await expect(
      runtime.resolveLimitedRecovery(
        'https://www.xiaohongshu.com/explore/synthetic-note?xsec_token=synthetic',
        'synthetic-author',
      ),
    ).rejects.toThrow('XHS_LIVE_ACCESS_DISABLED');
    expect(api).not.toHaveBeenCalled();
  });
  it('honors cancellation before reserving a recovery attempt or source budget', async () => {
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({ enabled: () => true, api });
    const arm = jest.fn();
    runtime.bindLimitedRecoveryStore({ arm } as any);
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      runtime.resolveLimitedRecovery(
        'https://www.xiaohongshu.com/explore/synthetic?xsec_token=synthetic',
        'author',
        () => true,
      ),
    ).rejects.toThrow('XHS_TASK_CANCELLED');
    expect(arm).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
  });

  it.each([
    'XHS_SOURCE_AUTHENTICATION_BLOCKED',
    'XHS_SOURCE_VERIFICATION_BLOCKED',
    'XHS_SOURCE_SIGNATURE_BLOCKED',
  ])('never grants a separate explicit block %s', async (code) => {
    await db.$executeRaw`UPDATE xhs_source_risk SET code=${code} WHERE id='source'`;
    await expect(
      new XhsLimitedRecoveryStore(db as any).arm(
        'synthetic-note',
        'synthetic-author',
      ),
    ).rejects.toThrow();
  });
});
