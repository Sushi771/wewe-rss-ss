import { approveSyntheticScheduledPolicy } from '../../test/fixtures/xhs-scheduled-policy';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { XhsMediaError } from './xhs-media-error';
import { downloadRedbookMedia } from './redbook-response';
import {
  bindXhsSourceTotalBudget,
  configureXhsSourceBudget,
} from './xhs-source-request-policy';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsEngagementService } from './xhs-engagement.service';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
import { extractXhsMediaManifest } from './xhs-native-media';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { RedbookClient, RedbookPauseError } from './redbook-client';
import {
  createRedbookHttpTransport,
  XhsHttpsRequest,
} from './xhs-http-transport';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { taskSourceFingerprint } from './xhs-task-source-fence';
import * as taskFence from './xhs-task-source-fence';
import * as signing from './redbook-vendor/signing';

describe('durable synthetic source risk fence', () => {
  // These cases target detail transport; model a successful author refresh
  // independently so its GET cannot consume the injected detail failure.
  function successfulProfile(runtime: XhsSubscriptionRuntime, author: string) {
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    jest.spyOn(runtime, 'resolve').mockResolvedValue({
      inputKind: 'profile',
      author: { id: author },
    } as any);
  }

  it('reports the actual worker settlement separately from an unresumable unknown receipt', () => {
    const service: any = new XhsSubscriptionService({} as any, {} as any);
    const task: any = {
      taskId: 'synthetic',
      creatorId: 'synthetic',
      kind: 'list',
      state: 'blocked',
      code: 'XHS_DETAIL_OUTCOME_UNKNOWN',
      sourceUnknowns: [{}],
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 1,
      remaining: 0,
    };
    expect(service.view(task)).toMatchObject({
      settling: false,
      resumable: false,
    });
    service.pending.set(task.taskId, task);
    expect(service.view(task)).toMatchObject({
      settling: true,
      resumable: false,
    });
    service.pending.delete(task.taskId);
    expect(service.view(task)).toMatchObject({
      settling: false,
      resumable: false,
    });
  });
  it('does not treat a transport-thrown configuration error as undispatched', async () => {
    const transport = jest.fn(async () => {
      throw new RedbookPauseError('configuration');
    });
    const client = new RedbookClient({
      transport,
      cookies: () => ({ a1: 'synthetic-a1', web_session: 'synthetic-session' }),
    });
    await expect(
      client.getNoteById('synthetic-note', 'synthetic-token'),
    ).rejects.toMatchObject({ reason: 'transport' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  let db: PrismaClient, folder: string;
  // Each case owns its synthetic database, including immutable review history.
  // Teardown destroys the fixture; it never deletes audit rows to relax guards.
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-risk-synthetic-'));
    db = new PrismaClient({
      datasources: {
        db: {
          // Native BEGIN/COMMIT migration statements must share one connection.
          url:
            'file:' +
            path.join(folder, 'risk.sqlite').replace(/\\/g, '/') +
            '?connection_limit=1',
        },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
  }, 40000);
  afterEach(async () => {
    await db.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL,updated_at=0 WHERE id='source'`;
    const scoped = await db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_creators WHERE id='creator-a'`;
    if (scoped.length) {
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id IN ('task-a','task-a2','task-b','task-c','task-d')`;
      await db.$executeRaw`DELETE FROM xhs_creators WHERE id IN ('creator-a','creator-b','creator-c','creator-d')`;
    }
    const mediaScoped = await db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_creators WHERE id='media-creator-a'`;
    if (mediaScoped.length) {
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id IN ('media-creator-a','media-creator-b')`;
      await db.$executeRaw`DELETE FROM xhs_notes WHERE creator_id IN ('media-creator-a','media-creator-b')`;
      await db.$executeRaw`DELETE FROM xhs_creators WHERE id IN ('media-creator-a','media-creator-b')`;
    }
    const parseScoped = await db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_creators WHERE id='parse-creator'`;
    if (parseScoped.length) {
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
      await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id IN (${JSON.stringify(['xiaohongshu', 'note', 'parse-a'])},${JSON.stringify(['xiaohongshu', 'note', 'parse-b'])})`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id='parse-creator'`;
      await db.$executeRaw`DELETE FROM xhs_notes WHERE creator_id='parse-creator'`;
      await db.$executeRaw`DELETE FROM xhs_creators WHERE id='parse-creator'`;
    }
  });
  afterEach(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }, 40000);

  it.each(['parse', 'transport', 'budget'] as const)(
    'keeps source risk conservative for %s list failures',
    async (mode) => {
      const api = jest.fn(async (request: any): Promise<any> => {
        if (mode === 'transport') throw Error('synthetic-private-transport');
        return {
          status: 200,
          url: request.url,
          body: {
            success: true,
            code: 0,
            data: {
              notes: 'synthetic-private-body',
              has_more: false,
              cursor: '',
            },
          },
        };
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      if (mode === 'budget')
        runtime.bindSourceAdmission(async () => {
          throw new XhsSubscriptionError('XHS_REQUEST_BUDGET_EXHAUSTED');
        });
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      (runtime as any).adapter.restoreDefaultAuthorAccess('synthetic-author');
      const expected =
        mode === 'parse'
          ? 'XHS_LIST_PARSE_FAILED'
          : mode === 'transport'
            ? 'transport'
            : 'XHS_REQUEST_BUDGET_EXHAUSTED';
      await expect(runtime.list('synthetic-author', null)).rejects.toThrow(
        expected,
      );
      const rows = await db.$queryRaw<
        Array<{
          state: string;
          code: string | null;
          http_status: number | null;
          endpoint: string | null;
        }>
      >`SELECT state,code,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
      expect(rows[0]).toMatchObject(
        mode === 'budget' || mode === 'parse'
          ? { state: 'clear', code: null }
          : {
              state: 'blocked',
              code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
              http_status: null,
              endpoint: null,
            },
      );
      expect(JSON.stringify(rows)).not.toContain('synthetic-private');
      expect(api).toHaveBeenCalledTimes(mode === 'budget' ? 0 : 1);
      if (mode === 'parse') {
        api.mockImplementationOnce(async (request: any) => ({
          status: 200,
          url: request.url,
          body: {
            success: true,
            code: 0,
            data: { notes: [], has_more: false, cursor: '' },
          },
        }));
        (runtime as any).adapter.restoreDefaultAuthorAccess('other-author');
        await expect(runtime.list('other-author', null)).resolves.toMatchObject(
          { authorId: 'other-author', notes: [] },
        );
        expect(api).toHaveBeenCalledTimes(2);
      }
      runtime.onModuleDestroy();
    },
    20000,
  );
  it('keeps missing list author identity unknown and blocks subsequent dispatch', async () => {
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: {
          notes: [{ note_id: 'note', user: {}, xsec_token: 'synthetic' }],
          has_more: false,
          cursor: '',
        },
      },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess('synthetic-author');
    await expect(
      runtime.list('synthetic-author', null),
    ).rejects.not.toMatchObject({ code: 'XHS_LIST_PARSE_FAILED' });
    const rows = await db.$queryRaw<
      Array<{ state: string; code: string }>
    >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject({
      state: 'blocked',
      code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    });
    await expect(runtime.list('synthetic-author', null)).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  }, 20000);
  it('keeps a 200 HTML media response unknown and blocks a second account dispatch', async () => {
    const media = jest.fn(
      async () =>
        new Response('<html>verification</html>', {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      media,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const run = () =>
      runtime.withScheduledMediaSession((transport) =>
        downloadRedbookMedia(
          new URL('https://sns-webpic.xhscdn.com/synthetic.png'),
          1000000,
          transport,
        ),
      );
    await expect(run()).rejects.toThrow('XHS_MEDIA_RESPONSE_INVALID');
    const rows = await db.$queryRaw<
      Array<{ state: string; code: string }>
    >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject({
      state: 'blocked',
      code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    });
    await expect(run()).rejects.toThrow();
    expect(media).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows)).not.toContain('verification');
    runtime.onModuleDestroy();
  }, 20000);
  it.each(['parse', 'unknown', 'unknown-full'] as const)(
    'handles %s detail under the source outcome contract',
    async (mode) => {
      const creatorId = 'parse-creator',
        author = 'parse-author',
        keys = ['parse-a', 'parse-b'].map((n) =>
          JSON.stringify(['xiaohongshu', 'note', n]),
        );
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: 'https://example.invalid/parse-author',
          displayName: 'Synthetic',
        },
      });
      for (const id of keys)
        await db.xhsNote.create({
          data: {
            id,
            creatorId,
            title: 'Old',
            publishTime: 0,
            kind: 'image-text',
            status: 'listed',
          },
        });
      const task: any = {
        taskId: 'parse-task',
        creatorId,
        kind: 'list',
        state: 'queued',
        collectionStage: 'details',
        collectDetails: true,
        basicOnly: mode !== 'unknown-full',
        reuseCompleteCache: false,
        noteIds: keys,
        items: {},
        total: 2,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: 2,
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api = jest.fn(async (request: any) => {
        const note = JSON.parse(request.body).source_note_id;
        if (note === 'parse-a' && mode.startsWith('unknown'))
          throw Error('synthetic detail connection lost');
        return {
          status: 200,
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
                    user: { user_id: author },
                    type:
                      note === 'parse-a' && mode === 'parse'
                        ? 'unrecognized'
                        : 'normal',
                    time: 1760000000000,
                    title: 'New',
                    desc: 'saved body',
                    image_list: [],
                    interact_info: { liked_count: '0', comment_count: '0' },
                  },
                },
              ],
            },
          },
        };
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      successfulProfile(runtime, author);
      for (const note of ['parse-a', 'parse-b'])
        (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
          token: 'synthetic-token',
          source: 'pc_user',
          expiresAt: Date.now() + 60000,
        });
      const service: any = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      await service.run(task);
      const parsed = mode === 'parse';
      expect(api).toHaveBeenCalledTimes(parsed ? 2 : 1);
      expect(task).toMatchObject({
        state: parsed ? 'partial' : 'blocked',
        failed: 1,
        completed: parsed ? 1 : 0,
        code: parsed ? 'XHS_DETAIL_PARSE_FAILED' : 'XHS_DETAIL_OUTCOME_UNKNOWN',
        items: {
          [keys[0]]: 'failed',
          ...(parsed ? { [keys[1]]: 'completed' } : {}),
        },
        ...(mode === 'unknown-full'
          ? {}
          : { basicResults: { [keys[0]]: 'missing' } }),
      });
      const notes = await db.xhsNote.findMany({
        where: { creatorId },
        orderBy: { id: 'asc' },
      });
      expect(notes[0].contentHtml).toBeNull();
      if (parsed) expect(notes[1].contentHtml).toContain('saved body');
      else expect(notes[1].contentHtml).toBeNull();
      const risk = await db.$queryRaw<
        any[]
      >`SELECT state FROM xhs_source_risk WHERE id='source'`;
      expect(risk[0].state).toBe('clear');
      const metrics = await db.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='note' AND owner_id=${keys[1]}`;
      if (parsed)
        expect(JSON.parse(metrics[0].document).values).toMatchObject({
          likes: 0,
          comments: 0,
          collects: null,
          shares: null,
        });
      else expect(metrics).toHaveLength(0);
      if (mode.startsWith('unknown'))
        expect(task.sourceFailures[keys[0]]).toMatchObject({
          phase: 'detail',
          code: 'XHS_DETAIL_OUTCOME_UNKNOWN',
          dispatched: 'transport-entered',
        });
      if (mode.startsWith('unknown')) {
        const next = {
          ...task,
          taskId: 'parse-task-2',
          state: 'queued',
          noteIds: [keys[0]],
          items: {},
          basicResults: {},
          total: 1,
          completed: 0,
          skipped: 0,
          failed: 0,
          remaining: 1,
          code: undefined,
        };
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task-2',${creatorId},'queued',${JSON.stringify(next)},1)`;
        await service.run(next);
        expect(next).toMatchObject({
          state: 'blocked',
          failed: 1,
          code: 'XHS_DETAIL_OUTCOME_UNKNOWN',
        });
        expect(api).toHaveBeenCalledTimes(1);
      }
      runtime.onModuleDestroy();
    },
    40000,
  );
  it.each(['sign', 'configuration'] as const)(
    'records a %s failure before dispatch and continues the next normal detail',
    async (mode) => {
      const creatorId = 'parse-creator',
        author = 'parse-author',
        first = mode === 'configuration' ? 'invalid!' : 'parse-a',
        keys = [first, 'parse-b'].map((n) =>
          JSON.stringify(['xiaohongshu', 'note', n]),
        );
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: 'https://example.invalid/parse-author',
          displayName: 'Synthetic',
        },
      });
      for (const id of keys)
        await db.xhsNote.create({
          data: {
            id,
            creatorId,
            title: 'Old',
            publishTime: 0,
            kind: 'image-text',
            status: 'listed',
          },
        });
      const task: any = {
        taskId: 'parse-task',
        creatorId,
        kind: 'list',
        state: 'queued',
        collectionStage: 'details',
        collectDetails: true,
        basicOnly: false,
        noteIds: keys,
        items: {},
        total: 2,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: 2,
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api = jest.fn(async (request: any) => ({
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: {
            items: [
              {
                id: 'parse-b',
                note_card: {
                  note_id: 'parse-b',
                  user: { user_id: author },
                  type: 'normal',
                  time: 1760000000000,
                  title: 'New',
                  desc: 'saved body',
                  image_list: [],
                  interact_info: { liked_count: '0', comment_count: '0' },
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
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      successfulProfile(runtime, author);
      for (const note of [first, 'parse-b'])
        (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
          token: 'synthetic-token',
          source: 'pc_user',
          expiresAt: Date.now() + 60000,
        });
      const sign =
        mode === 'sign'
          ? jest.spyOn(signing, 'signMainApi').mockImplementationOnce(() => {
              throw Error('synthetic private signing failure');
            })
          : undefined;
      try {
        const service: any = new XhsSubscriptionService(db as any, runtime);
        service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
        await service.run(task);
        expect(api).toHaveBeenCalledTimes(1);
        expect(task.sourceFailures[keys[0]]).toEqual({
          phase: 'detail',
          code: 'XHS_LOCAL_PRE_DISPATCH_FAILED',
          dispatched: false,
        });
        expect(task.items[keys[0]]).toBe('failed');
        const rows = await db.$queryRaw<
          any[]
        >`SELECT state FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0].state).toBe('clear');
        const saved = await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
        expect(JSON.parse(saved[0].document).sourceFailures[keys[0]]).toEqual(
          task.sourceFailures[keys[0]],
        );
        expect(saved[0].document).not.toContain(
          'synthetic private signing failure',
        );
      } finally {
        sign?.mockRestore();
        runtime.onModuleDestroy();
      }
    },
    40000,
  );
  it('isolates a bound P2028 detail before dispatch and permits unrelated work', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      keys = ['parse-a', 'parse-b'].map((n) =>
        JSON.stringify(['xiaohongshu', 'note', n]),
      );
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    for (const id of keys)
      await db.xhsNote.create({
        data: {
          id,
          creatorId,
          title: 'Old',
          publishTime: 0,
          kind: 'image-text',
          status: 'listed',
        },
      });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      state: 'queued',
      collectionStage: 'details',
      collectDetails: true,
      basicOnly: true,
      reuseCompleteCache: false,
      noteIds: keys,
      items: {},
      total: 2,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 2,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data:
          request.method === 'POST'
            ? {
                items: [
                  {
                    id: 'parse-b',
                    note_card: {
                      note_id: 'parse-b',
                      user: { user_id: author },
                      type: 'normal',
                      time: 1760000000000,
                      title: 'New',
                      desc: 'saved body',
                      image_list: [
                        {
                          url_default:
                            'https://sns-webpic.xhscdn.com/synthetic.png',
                        },
                      ],
                      interact_info: {
                        liked_count: '0',
                        collected_count: '0',
                        share_count: '0',
                        comment_count: '0',
                      },
                    },
                  },
                ],
              }
            : { notes: [], has_more: false, cursor: '' },
      },
    }));
    const media = jest.fn(
      async () =>
        new Response(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
            'base64',
          ),
          { status: 200, headers: { 'content-type': 'image/png' } },
        ),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      media,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    successfulProfile(runtime, author);
    for (const n of ['parse-a', 'parse-b'])
      (runtime as any).adapter.tokens.set(JSON.stringify([author, n]), {
        token: 'synthetic-token',
        source: 'pc_user',
        expiresAt: Date.now() + 60000,
      });
    let inject = false;
    const originalPrepare = taskFence.prepareTaskDetailAdmission,
      originalReserve = XhsRequestBudget.prototype.reserve;
    const prepare = jest
      .spyOn(taskFence, 'prepareTaskDetailAdmission')
      .mockImplementation(async (tx, scope) => {
        await originalPrepare(tx, scope);
        if (scope.target === 'parse-a') inject = true;
      });
    const reserve = jest
      .spyOn(XhsRequestBudget.prototype, 'reserve')
      .mockImplementation(async function (this: XhsRequestBudget, id, now) {
        if (inject) {
          inject = false;
          await originalReserve.call(this, id, now);
          throw new Prisma.PrismaClientKnownRequestError(
            'synthetic-lost-budget-ack',
            { code: 'P2028', clientVersion: '5.10.1' },
          );
        }
        return originalReserve.call(this, id, now);
      });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    const save = jest.fn(async () => ({ mediaComplete: true }));
    service.bindLocalSaver(async () => '/synthetic/archive', save);
    try {
      await service.run(task, '/synthetic/archive');
      expect(task).toMatchObject({
        state: 'partial',
        failed: 1,
        completed: 1,
        code: 'XHS_LOCAL_PRE_DISPATCH_FAILED',
      });
      expect(
        api.mock.calls
          .filter(([r]: any) => r.method === 'POST')
          .map(([r]: any) => JSON.parse(r.body).source_note_id),
      ).toEqual(['parse-b']);
      expect(media).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(
        Number(
          (
            await db.$queryRaw<
              any[]
            >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`
          )[0].used,
        ),
      ).toBe(3);
      const saved = JSON.parse(
        (
          await db.$queryRaw<
            any[]
          >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`
        )[0].document,
      );
      expect(saved.sourceFailures[keys[0]]).toMatchObject({
        code: 'XHS_LOCAL_PRE_DISPATCH_FAILED',
        guardCode: 'P2028',
        guardStage: 'source-admission',
        dispatched: false,
      });
      expect(saved.sourcePreflight).toBeUndefined();
      expect(saved.sourceUnknowns).toHaveLength(1);
      expect(saved.sourceUnknowns[0]).toMatchObject({
        phase: 'detail',
        outcome: 'not-dispatched',
        classification: 'local-pre-dispatch-review',
        taskId: 'parse-task',
        creatorId,
      });
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('clear');
      const next = {
        ...task,
        taskId: 'parse-task-2',
        state: 'queued',
        noteIds: [keys[0]],
        items: {},
        total: 1,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: 1,
        sourceUnknowns: undefined,
        code: undefined,
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task-2',${creatorId},'queued',${JSON.stringify(next)},1)`;
      await service.run(next);
      expect(next).toMatchObject({
        state: 'partial',
        failed: 1,
        code: 'XHS_LOCAL_PRE_DISPATCH_FAILED',
      });
      expect(
        api.mock.calls.filter(([r]: any) => r.method === 'POST'),
      ).toHaveLength(1);
      const mediaNote = await db.xhsNote.findUnique({ where: { id: keys[1] } });
      expect(mediaNote?.contentHtml).toContain('data:image/png;base64,');
      expect(mediaNote?.contentHtml).toContain('data-xhs-media');
      await db.xhsCreator.create({
        data: {
          id: 'creator-b',
          externalAuthorId: 'author-b',
          profileUrl: 'https://example.invalid/b',
          displayName: 'Other',
        },
      });
      const other = {
        taskId: 'task-b',
        creatorId: 'creator-b',
        state: 'running',
        noteIds: [],
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('task-b','creator-b','running',${JSON.stringify(other)},1)`;
      (runtime as any).adapter.restoreDefaultAuthorAccess('author-b');
      await runtime.withTaskScope(
        { taskId: 'task-b', creatorId: 'creator-b' },
        () => runtime.list('author-b', null),
      );
      expect(
        api.mock.calls.filter(([r]: any) => r.method === 'GET'),
      ).toHaveLength(1);
    } finally {
      prepare.mockRestore();
      reserve.mockRestore();
      runtime.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:unknown:%'`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id='task-b'`;
      await db.xhsCreator.deleteMany({ where: { id: 'creator-b' } });
    }
  }, 40000);
  it('keeps a terminal prepared preflight pending without proof of non-dispatch', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      note = 'parse-a',
      key = JSON.stringify(['xiaohongshu', 'note', note]),
      owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hash = (s: string) => createHash('sha256').update(s).digest('hex'),
      cursorHash = hash(''),
      fingerprint = taskSourceFingerprint(
        creatorId,
        'detail',
        note,
        cursorHash,
      );
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      state: 'blocked',
      code: 'XHS_TASK_INTERRUPTED',
      collectionStage: 'details',
      collectDetails: true,
      basicOnly: true,
      noteIds: [key],
      items: {},
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 1,
      sourcePreflight: {
        fingerprint,
        phase: 'detail',
        targetHash: hash(note),
        cursorHash,
        owner,
        outcome: 'prepared',
      },
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'blocked',${JSON.stringify(task)},1)`;
    await db.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner},code=NULL,http_status=NULL,endpoint=NULL WHERE id='source'`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,7,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=7,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => ({
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: { notes: [], has_more: false, cursor: '' },
        },
      })),
      runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    const state = async () =>
      (
        await db.$queryRaw<
          any[]
        >`SELECT state FROM xhs_source_risk WHERE id='source'`
      )[0].state;
    try {
      const legacy = { ...task, sourcePreflight: undefined };
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(legacy)} WHERE id='parse-task'`;
      await service.task({ taskId: 'parse-task' });
      expect(await state()).toBe('pending');
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id='parse-task'`;
      service.pending.set('parse-task', task);
      await service.task({ taskId: 'parse-task' });
      expect(await state()).toBe('pending');
      service.pending.delete('parse-task');
      const tampered = {
        ...task,
        sourcePreflight: {
          ...task.sourcePreflight,
          targetHash: hash('wrong-note'),
        },
      };
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(tampered)} WHERE id='parse-task'`;
      await service.task({ taskId: 'parse-task' });
      expect(await state()).toBe('pending');
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id='parse-task'`;
      const active = {
        ...task,
        sourceActive: {
          fingerprint,
          phase: 'detail',
          targetHash: hash(note),
          cursorHash,
          owner,
          outcome: 'started',
        },
      };
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(active)} WHERE id='parse-task'`;
      await service.task({ taskId: 'parse-task' });
      expect(await state()).toBe('pending');
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id='parse-task'`;
      const marker = 'xhs:dispatch-pending:synthetic-inflight';
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,0,0)`;
      await service.task({ taskId: 'parse-task' });
      expect(await state()).toBe('pending');
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
      await service.onModuleDestroy();
      const restarted: any = new XhsSubscriptionService(db as any, runtime);
      restarted.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      await restarted.onModuleInit();
      expect(await state()).toBe('pending');
      const saved = JSON.parse(
        (
          await db.$queryRaw<
            any[]
          >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`
        )[0].document,
      );
      expect(saved.sourcePreflight).toEqual(task.sourcePreflight);
      expect(saved.sourceUnknowns).toBeUndefined();
      expect(
        await taskFence.hasTaskDetailLocalReview(db as any, creatorId, note),
      ).toBe(false);
      expect(
        Number(
          (
            await db.$queryRaw<
              any[]
            >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`
          )[0].used,
        ),
      ).toBe(7);
      expect(api).not.toHaveBeenCalled();
    } finally {
      runtime.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id='task-b'`;
      await db.xhsCreator.deleteMany({ where: { id: 'creator-b' } });
    }
  }, 40000);
  it('does not recover a bound preflight when detail transport began and commit failed', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      note = 'parse-a',
      key = JSON.stringify(['xiaohongshu', 'note', note]);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const task = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      state: 'running',
      collectionStage: 'details',
      collectDetails: true,
      basicOnly: true,
      noteIds: [key],
      items: {},
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 1,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'running',${JSON.stringify(task)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    let failCheck = false;
    const original = fs.statfs.bind(fs),
      stat = jest.spyOn(fs, 'statfs').mockImplementation((async (
        ...args: any[]
      ) => {
        if (failCheck) {
          failCheck = false;
          throw Error('synthetic-disk-failure-after-transport');
        }
        return (original as any)(...args);
      }) as any);
    const api = jest.fn(async (request: any) => {
      failCheck = true;
      return {
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: { items: [] } },
      };
    });
    const store = new XhsSourceRiskStore(db as any),
      finish = jest
        .spyOn(store, 'finish')
        .mockRejectedValueOnce(Error('synthetic-owner-settlement-failure'));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(store);
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
      token: 'synthetic-token',
      source: 'pc_user',
      expiresAt: Date.now() + 60000,
    });
    let restarted: XhsSubscriptionRuntime | undefined;
    try {
      await expect(
        runtime.withTaskScope({ taskId: 'parse-task', creatorId }, () =>
          runtime.detail(author, note),
        ),
      ).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(1);
      const before = JSON.parse(
        (
          await db.$queryRaw<
            any[]
          >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`
        )[0].document,
      );
      expect(before.sourcePreflight?.outcome).toBe('prepared');
      const markers = await db.$queryRaw<
        any[]
      >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
      expect(markers).toHaveLength(1);
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('pending');
      runtime.onModuleDestroy();
      finish.mockRestore();
      restarted = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      restarted.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, restarted);
      const service: any = new XhsSubscriptionService(db as any, restarted);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      await service.onModuleInit();
      const after = JSON.parse(
        (
          await db.$queryRaw<
            any[]
          >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`
        )[0].document,
      );
      expect(after).toMatchObject({
        state: 'blocked',
        sourcePreflight: before.sourcePreflight,
      });
      expect(after.sourceUnknowns).toBeUndefined();
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('pending');
      expect(
        await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`,
      ).toEqual(markers);
      await restarted.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      await expect(
        restarted.withTaskScope({ taskId: 'parse-task', creatorId }, () =>
          restarted!.detail(author, note),
        ),
      ).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(1);
    } finally {
      stat.mockRestore();
      finish.mockRestore();
      runtime.onModuleDestroy();
      restarted?.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
    }
  }, 40000);
  it('refreshFull all saves remaining details after one confirmed local pre-dispatch failure', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      ids = Array.from({ length: 29 }, (_, i) => `note-${i}`);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        displayName: 'Synthetic',
      },
    });
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => {
      const note =
        request.method === 'POST'
          ? JSON.parse(request.body).source_note_id
          : '';
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data:
            request.method === 'GET'
              ? new URL(request.url).pathname.endsWith('/user_posted')
                ? {
                    notes: ids.map((note_id) => ({
                      note_id,
                      user: { user_id: author },
                      xsec_token: 'synthetic-token',
                    })),
                    has_more: false,
                    cursor: '',
                  }
                : {}
              : {
                  items: [
                    {
                      id: note,
                      note_card: {
                        note_id: note,
                        user: { user_id: author },
                        type: 'normal',
                        time: 1760000000000,
                        title: 'Synthetic',
                        desc: 'saved body',
                        image_list:
                          note === ids[1]
                            ? [
                                {
                                  url_default:
                                    'https://sns-webpic.xhscdn.com/all-synthetic.png',
                                },
                              ]
                            : [],
                        interact_info: {
                          liked_count: '0',
                          collected_count: '0',
                          share_count: '0',
                          comment_count: '0',
                        },
                      },
                    },
                  ],
                },
        },
      };
    });
    const media = jest.fn(
      async () =>
        new Response(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
            'base64',
          ),
          { status: 200, headers: { 'content-type': 'image/png' } },
        ),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      media,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: author,
        name: 'Synthetic',
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        metrics: {
          values: { fans: 82, following: null },
          collectedAt: 2,
          contract: 'synthetic',
          evidence: 'source-only',
        },
      }),
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    const original = signing.signMainApi;
    let injected = false;
    const sign = jest
      .spyOn(signing, 'signMainApi')
      .mockImplementation((...args) => {
        if (args[0] === 'POST' && !injected) {
          injected = true;
          throw Error('synthetic local signing failure');
        }
        return original(...args);
      });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    const save = jest.fn(async () => ({ mediaComplete: true }));
    service.bindLocalSaver(async () => '/synthetic/archive', save);
    try {
      const started = await service.refreshFull({
        id: creatorId,
        scope: 'all',
        basicOnly: true,
        reuseCompleteCache: false,
      });
      await service.lane;
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`;
      const saved = JSON.parse(rows[0].document);
      expect(saved).toMatchObject({
        state: 'partial',
        code: 'XHS_LOCAL_PRE_DISPATCH_FAILED',
        completed: 28,
        failed: 1,
        remaining: 0,
      });
      expect(
        Object.values(saved.basicResults).filter((x) => x === 'missing'),
      ).toHaveLength(1);
      expect(
        api.mock.calls.filter(([r]: any) => r.method === 'POST'),
      ).toHaveLength(28);
      expect(media).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(28);
      expect(
        JSON.parse(
          (
            await db.$queryRaw<
              any[]
            >`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='creator' AND owner_id=${creatorId}`
          )[0].document,
        ).values.fans,
      ).toBe(82);
      const risk = await db.$queryRaw<
        any[]
      >`SELECT state FROM xhs_source_risk WHERE id='source'`;
      expect(risk[0].state).toBe('clear');
    } finally {
      sign.mockRestore();
      runtime.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id=${creatorId}`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${creatorId}`;
      await db.xhsNote.deleteMany({ where: { creatorId } });
      await db.xhsCreator.deleteMany({ where: { id: creatorId } });
    }
  }, 40000);
  it.each(['note', 'author'] as const)(
    'refreshFull all isolates raw %s identity mismatch and continues',
    async (mode) => {
      const creatorId = 'parse-creator',
        author = 'parse-author',
        ids = Array.from({ length: 29 }, (_, i) => `note-${i}`);
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
          displayName: 'Synthetic',
        },
      });
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api = jest.fn(async (request: any) => {
        const note =
          request.method === 'POST'
            ? JSON.parse(request.body).source_note_id
            : '';
        return {
          status: 200,
          url: request.url,
          body: {
            success: true,
            code: 0,
            data:
              request.method === 'GET'
                ? new URL(request.url).pathname.endsWith('/user_posted')
                  ? {
                      notes: ids.map((note_id) => ({
                        note_id,
                        user: { user_id: author },
                        xsec_token: 'synthetic-token',
                      })),
                      has_more: false,
                      cursor: '',
                    }
                  : {}
                : {
                    items: [
                      {
                        id:
                          note === ids[0] && mode === 'note'
                            ? 'wrong-note'
                            : note,
                        note_card: {
                          note_id: note,
                          user: {
                            user_id:
                              note === ids[0] && mode === 'author'
                                ? 'wrong-author'
                                : author,
                          },
                          type: 'normal',
                          time: 1760000000000,
                          title: 'Synthetic',
                          desc: 'saved body',
                          image_list:
                            note === ids[1]
                              ? [
                                  {
                                    url_default:
                                      'https://sns-webpic.xhscdn.com/all-synthetic.png',
                                  },
                                ]
                              : [],
                          interact_info: {
                            liked_count: '0',
                            collected_count: '0',
                            share_count: '0',
                            comment_count: '0',
                          },
                        },
                      },
                    ],
                  },
          },
        };
      });
      const media = jest.fn(
        async () =>
          new Response(
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
              'base64',
            ),
            { status: 200, headers: { 'content-type': 'image/png' } },
          ),
      );
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        media,
        requirePersistentRisk: true,
        profileParser: () => ({
          id: author,
          name: 'Synthetic',
          profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
          metrics: {
            values: { fans: 82, following: null },
            collectedAt: 2,
            contract: 'synthetic',
            evidence: 'source-only',
          },
        }),
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      (runtime as any).adapter.restoreDefaultAuthorAccess(author);
      const service: any = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      const save = jest.fn(async () => ({ mediaComplete: true }));
      service.bindLocalSaver(async () => '/synthetic/archive', save);
      try {
        const started = await service.refreshFull({
          id: creatorId,
          scope: 'all',
          basicOnly: true,
          reuseCompleteCache: false,
        });
        await service.lane;
        const rows = await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`;
        const saved = JSON.parse(rows[0].document);
        expect(saved).toMatchObject({
          state: 'partial',
          code: 'XHS_DETAIL_PARSE_FAILED',
          completed: 28,
          failed: 1,
          remaining: 0,
        });
        expect(
          Object.values(saved.basicResults).filter((x) => x === 'missing'),
        ).toHaveLength(1);
        const wrongKey = JSON.stringify(['xiaohongshu', 'note', ids[0]]);
        expect(
          (await db.xhsNote.findUnique({ where: { id: wrongKey } }))
            ?.contentHtml,
        ).toBeFalsy();
        expect(
          api.mock.calls.filter(([r]: any) => r.method === 'POST'),
        ).toHaveLength(29);
        expect(media).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledTimes(28);
        expect(
          JSON.parse(
            (
              await db.$queryRaw<
                any[]
              >`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='creator' AND owner_id=${creatorId}`
            )[0].document,
          ).values.fans,
        ).toBe(82);
        const risk = await db.$queryRaw<
          any[]
        >`SELECT state FROM xhs_source_risk WHERE id='source'`;
        expect(risk[0].state).toBe('clear');
      } finally {
        runtime.onModuleDestroy();
        await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id=${creatorId}`;
        await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${creatorId}`;
        await db.xhsNote.deleteMany({ where: { creatorId } });
        await db.xhsCreator.deleteMany({ where: { id: creatorId } });
      }
    },
    40000,
  );
  it('blocks refreshFull all when an older detail remains started', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author';
    const activeAuthor = author,
      ids = Array.from({ length: 29 }, (_, i) => `note-${i}`);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        displayName: 'Synthetic',
      },
    });
    const oldId = '01230b48-a87f-4797-aa96-1c27c574567e',
      key = JSON.stringify(['xiaohongshu', 'note', ids[0]]),
      hash = (s: string) => createHash('sha256').update(s).digest('hex'),
      cursorHash = hash('');
    const oldDocument = JSON.stringify({
      taskId: oldId,
      creatorId,
      state: 'blocked',
      noteIds: [key],
      sourceActive: {
        fingerprint: taskSourceFingerprint(
          creatorId,
          'detail',
          ids[0],
          cursorHash,
        ),
        phase: 'detail',
        targetHash: hash(ids[0]),
        cursorHash,
        owner: '00000000-0000-4000-8000-000000000001',
        outcome: 'started',
      },
    });
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${oldId},${creatorId},'blocked',${oldDocument},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => {
      const note =
        request.method === 'POST'
          ? JSON.parse(request.body).source_note_id
          : '';
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data:
            request.method === 'GET'
              ? new URL(request.url).pathname.endsWith('/user_posted')
                ? {
                    notes: ids.map((note_id) => ({
                      note_id,
                      user: { user_id: activeAuthor },
                      xsec_token: 'synthetic-token',
                    })),
                    has_more: false,
                    cursor: '',
                  }
                : {}
              : {
                  items: [
                    {
                      id: note,
                      note_card: {
                        note_id: note,
                        user: { user_id: activeAuthor },
                        type: 'normal',
                        time: 1760000000000,
                        title: 'Synthetic',
                        desc: 'saved body',
                        image_list:
                          note === ids[1]
                            ? [
                                {
                                  url_default:
                                    'https://sns-webpic.xhscdn.com/all-synthetic.png',
                                },
                              ]
                            : [],
                        interact_info: {
                          liked_count: '0',
                          collected_count: '0',
                          share_count: '0',
                          comment_count: '0',
                        },
                      },
                    },
                  ],
                },
        },
      };
    });
    const media = jest.fn(
      async () =>
        new Response(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
            'base64',
          ),
          { status: 200, headers: { 'content-type': 'image/png' } },
        ),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      media,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: activeAuthor,
        name: 'Synthetic',
        profileUrl: `https://www.xiaohongshu.com/user/profile/${activeAuthor}`,
        metrics: {
          values: { fans: 82, following: null },
          collectedAt: 2,
          contract: 'synthetic',
          evidence: 'source-only',
        },
      }),
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    const save = jest.fn(async () => ({ mediaComplete: true }));
    service.bindLocalSaver(async () => '/synthetic/archive', save);
    try {
      const started = await service.refreshFull({
        id: creatorId,
        scope: 'all',
        basicOnly: true,
        reuseCompleteCache: false,
      });
      await service.lane;
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`;
      const saved = JSON.parse(rows[0].document);
      expect(saved).toMatchObject({
        state: 'blocked',
        code: 'XHS_REQUEST_RATE_PAUSED',
        completed: 0,
      });
      expect(api).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT document FROM xhs_subscription_tasks WHERE id=${oldId}`
        )[0].document,
      ).toBe(oldDocument);
    } finally {
      runtime.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id=${creatorId}`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${creatorId}`;
      await db.xhsNote.deleteMany({ where: { creatorId } });
      await db.xhsCreator.deleteMany({ where: { id: creatorId } });
    }
  }, 40000);
  it('blocks fresh selected refresh and preserves cached notes when an outcome is unknown', async () => {
    const creatorId = 'fresh-creator',
      author = 'fresh-author',
      notes = ['old-unknown', 'old-safe'],
      keys = notes.map((n) => JSON.stringify(['xiaohongshu', 'note', n]));
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        displayName: 'Synthetic',
      },
    });
    for (const id of keys)
      await db.xhsNote.create({
        data: {
          id,
          creatorId,
          title: 'Old',
          publishTime: 1,
          kind: 'image-text',
          status: 'complete',
          contentHtml: '<div id="js_content"><p>old body</p></div>',
        },
      });
    const hash = (s: string) => createHash('sha256').update(s).digest('hex'),
      cursorHash = hash(''),
      fp = taskSourceFingerprint(creatorId, 'detail', notes[0], cursorHash),
      marker = 'xhs:dispatch-pending:unknown:' + fp;
    const old = {
      taskId: 'fresh-old-task',
      creatorId,
      state: 'blocked',
      sourceUnknowns: [
        {
          marker,
          fingerprint: fp,
          phase: 'detail',
          targetHash: hash(notes[0]),
          cursorHash,
          outcome: 'unknown',
          classification: 'request-outcome-unknown',
          taskId: 'fresh-old-task',
          creatorId,
        },
      ],
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('fresh-old-task',${creatorId},'blocked',${JSON.stringify(old)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,0,0)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    await db.$executeRaw`INSERT INTO xhs_metric_snapshots(owner_kind,owner_id,document) VALUES('note',${keys[1]},${JSON.stringify({ values: { likes: 1, collects: 1, shares: 1, comments: 1 }, collectedAt: 1, contract: 'synthetic', evidence: 'source-only' })})`;
    const bodyText = 'new body',
      imageUrl = 'https://sns-webpic.xhscdn.com/synthetic.png';
    const api = jest.fn(async (request: any) => {
      const url = new URL(request.url),
        n =
          request.method === 'POST'
            ? JSON.parse(request.body).source_note_id
            : '';
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: url.pathname.endsWith('/user_posted')
            ? {
                notes: notes.map((note_id) => ({
                  note_id,
                  user: { user_id: author },
                  xsec_token: 'synthetic-token',
                })),
                has_more: false,
                cursor: '',
              }
            : request.method === 'POST'
              ? {
                  items: [
                    {
                      id: n,
                      note_card: {
                        note_id: n,
                        user: { user_id: author },
                        type: 'normal',
                        time: 1760000000000,
                        title: 'New',
                        desc: bodyText,
                        image_list: [{ url_default: imageUrl }],
                        interact_info: {
                          liked_count: '9',
                          collected_count: '2',
                          share_count: '3',
                          comment_count: '4',
                        },
                      },
                    },
                  ],
                }
              : {},
        },
      };
    });
    const media = jest.fn(
      async () =>
        new Response(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
            'base64',
          ),
          { status: 200, headers: { 'content-type': 'image/png' } },
        ),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      media,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: author,
        name: 'Synthetic',
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        metrics: {
          values: { fans: 82, following: null },
          collectedAt: 2,
          contract: 'synthetic',
          evidence: 'source-only',
        },
      }),
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    const save = jest.fn(async () => ({ mediaComplete: true }));
    service.bindLocalSaver(async () => '/synthetic/archive', save);
    try {
      const started = await service.refreshFull({
        id: creatorId,
        scope: 'selected',
        noteIds: keys,
        basicOnly: true,
        reuseCompleteCache: false,
      });
      await service.lane;
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`;
      expect(JSON.parse(rows[0].document)).toMatchObject({
        state: 'blocked',
        completed: 0,
      });
      expect(api).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      for (const id of keys)
        expect(
          (await db.xhsNote.findUniqueOrThrow({ where: { id } })).contentHtml,
        ).toContain('old body');
      expect(
        await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
      ).toHaveLength(1);
    } finally {
      runtime.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
      await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id=${creatorId} OR owner_id IN (${keys[0]},${keys[1]})`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${creatorId}`;
      await db.xhsNote.deleteMany({ where: { creatorId } });
      await db.xhsCreator.deleteMany({ where: { id: creatorId } });
    }
  }, 40000);
  it('does not isolate identity mismatch when durable response settlement fails', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      state: 'queued',
      collectionStage: 'details',
      collectDetails: true,
      basicOnly: true,
      noteIds: [key],
      items: {},
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 1,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: {
          items: [
            {
              id: 'wrong-note',
              note_card: {
                note_id: 'parse-a',
                user: { user_id: author },
                type: 'normal',
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
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    successfulProfile(runtime, author);
    (runtime as any).adapter.tokens.set(JSON.stringify([author, 'parse-a']), {
      token: 'synthetic-token',
      source: 'pc_user',
      expiresAt: Date.now() + 60000,
    });
    const settle = jest
      .spyOn(taskFence, 'settleTaskSource')
      .mockRejectedValueOnce(Error('synthetic-storage-failure'));
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      await service.run(task, 'synthetic-directory');
      expect(api).toHaveBeenCalledTimes(1);
      const doc = JSON.parse(
        (
          await db.$queryRaw<
            any[]
          >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`
        )[0].document,
      );
      expect(doc.sourceActive?.outcome).toBe('started');
      expect(doc.code).not.toBe('XHS_DETAIL_PARSE_FAILED');
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('blocked');
    } finally {
      settle.mockRestore();
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('retains the owner and reports local storage on pre-dispatch P2028', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    runtime.bindSourceAdmission(async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        'synthetic-private-transaction',
        { code: 'P2028', clientVersion: '5.10.1' },
      );
    });
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    successfulProfile(runtime, author);
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      const started = await service.refreshFull({
        id: creatorId,
        scope: 'selected',
        noteIds: [key],
        basicOnly: true,
        reuseCompleteCache: false,
      });
      await service.lane;
      const row = (
        await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`
      )[0].document;
      const task = JSON.parse(row);
      expect(api).not.toHaveBeenCalled();
      expect(task.taskFailure).toMatchObject({
        phase: 'listing',
        code: 'XHS_STORAGE_FAILED',
        dispatched: false,
        guardStage: 'source-admission',
        guardCode: 'P2028',
      });
      expect(row).not.toContain('synthetic-private-transaction');
      const risk = (
        await db.$queryRaw<
          any[]
        >`SELECT state,owner,code,http_status FROM xhs_source_risk WHERE id='source'`
      )[0];
      expect(risk.state).toBe('pending');
      expect(risk.owner).toBeTruthy();
      expect(risk.code).toBeNull();
      expect(risk.http_status).toBeNull();
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('persists only safe P2028 source transaction diagnostics in a task', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const api = jest.fn(),
      runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    runtime.bindSourceAdmission(async () => {
      const spy = jest.spyOn(db, '$transaction').mockImplementation((() => {
        throw new Prisma.PrismaClientKnownRequestError(
          'synthetic-private-start',
          {
            code: 'P2028',
            clientVersion: '5.10.1',
            meta: { error: 'Unable to start transaction: synthetic-private' },
          },
        );
      }) as any);
      try {
        await configureXhsSourceBudget(
          db as any,
          { purpose: 'resolution' },
          100,
          1000,
        );
      } finally {
        spy.mockRestore();
      }
    });
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    successfulProfile(runtime, author);
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      const started = await service.refreshFull({
        id: creatorId,
        scope: 'selected',
        noteIds: [key],
        basicOnly: true,
        reuseCompleteCache: false,
      });
      await service.lane;
      const row = (
        await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`
      )[0].document;
      const task = JSON.parse(row);
      expect(api).not.toHaveBeenCalled();
      expect(task.taskFailure).toMatchObject({
        code: 'XHS_STORAGE_FAILED',
        guardCode: 'P2028',
        transactionStage: 'opening',
        transactionError: 'start-failed',
        transactionTotalMs: expect.any(Number),
        transactionOpenMs: expect.any(Number),
      });
      expect(row).not.toContain('synthetic-private');
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('pending');
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('persists a fixed pre-dispatch guard failure without exposing its message', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      state: 'queued',
      collectionStage: 'details',
      collectionScope: 'selected',
      collectDetails: true,
      basicOnly: true,
      noteIds: [key],
      items: {},
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 1,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    const api = jest.fn(),
      runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    runtime.bindSourceAdmission(
      async () => {},
      async () => {
        throw Object.assign(new Error('synthetic-secret-private-body'), {
          code: 'P2034',
        });
      },
    );
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    successfulProfile(runtime, author);
    (runtime as any).adapter.tokens.set(JSON.stringify([author, 'parse-a']), {
      token: 'synthetic-token',
      source: 'pc_user',
      expiresAt: Date.now() + 60000,
    });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      await service.run(task, 'synthetic-directory');
      expect(api).not.toHaveBeenCalled();
      const row = (
        await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`
      )[0].document;
      const saved = JSON.parse(row);
      expect(saved.sourceFailures[key]).toMatchObject({
        dispatched: false,
        guardStage: 'source-dispatch',
        guardErrorKind: 'Error',
        guardCode: 'P2034',
      });
      expect(row).not.toContain('synthetic-secret-private-body');
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('blocked');
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it.each(['download', 'selected-basic'] as const)(
    'persists safe detail diagnostics for an unclassified %s failure',
    async (mode) => {
      const creatorId = 'parse-creator',
        author = 'parse-author',
        key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: 'https://example.invalid/parse-author',
          displayName: 'Synthetic',
        },
      });
      await db.xhsNote.create({
        data: {
          id: key,
          creatorId,
          title: 'Old',
          publishTime: 0,
          kind: 'image-text',
          status: 'listed',
        },
      });
      const task: any = {
        taskId: 'parse-task',
        creatorId,
        kind: mode === 'download' ? 'download' : 'list',
        ...(mode === 'selected-basic'
          ? {
              collectionStage: 'details',
              collectionScope: 'selected',
              collectDetails: true,
              basicOnly: true,
              reuseCompleteCache: true,
            }
          : {}),
        state: 'queued',
        noteIds: [key],
        items: {},
        total: 1,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: 1,
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api = jest.fn(async (request: any) => ({
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: { items: 'synthetic-private-payload' },
        },
      }));
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      (runtime as any).adapter.tokens.set(JSON.stringify([author, 'parse-a']), {
        token: 'synthetic-token',
        source: 'pc_user',
        expiresAt: Date.now() + 60000,
      });
      const service: any = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      try {
        await service.run(task, 'synthetic-directory');
        expect(api).toHaveBeenCalledTimes(1);
        const rows = await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
        const saved = JSON.parse(rows[0].document);
        expect(saved).toMatchObject({
          state: 'blocked',
          code: 'XHS_DOWNLOAD_BLOCKED',
          failed: 1,
          sourceFailures: {
            [key]: {
              phase: 'detail',
              code: 'XHS_SOURCE_FAILURE_UNCLASSIFIED',
              errorKind: 'Error',
              dispatched: 'transport-entered',
            },
          },
        });
        expect(rows[0].document).not.toContain('synthetic-private-payload');
        expect(rows[0].document).not.toContain('synthetic-token');
      } finally {
        runtime.onModuleDestroy();
      }
    },
    40000,
  );
  it('persists selected basic diagnostics through refreshFull enqueue, list and detail', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data:
          request.method === 'GET'
            ? {
                notes: [
                  {
                    note_id: 'parse-a',
                    user: { user_id: author },
                    xsec_token: 'synthetic-token',
                  },
                ],
                has_more: false,
                cursor: '',
              }
            : { items: 'synthetic-private-payload' },
      },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      const started = await service.refreshFull({
        id: creatorId,
        scope: 'selected',
        noteIds: [key],
        basicOnly: true,
        reuseCompleteCache: true,
      });
      await service.lane;
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`;
      const saved = JSON.parse(rows[0].document);
      expect(api.mock.calls.map(([r]: any) => r.method)).toEqual([
        'GET',
        'POST',
      ]);
      expect(saved).toMatchObject({
        state: 'blocked',
        collectionStage: 'details',
        collectionScope: 'selected',
        basicOnly: true,
        sourceFailures: {
          [key]: {
            phase: 'detail',
            code: 'XHS_SOURCE_FAILURE_UNCLASSIFIED',
            errorKind: 'Error',
            dispatched: 'transport-entered',
          },
        },
      });
      expect(rows[0].document).not.toContain('synthetic-private-payload');
      expect(rows[0].document).not.toContain('synthetic-token');
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('keeps malformed empty response identity under shared review', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data:
          request.method === 'GET'
            ? {
                notes: [
                  {
                    note_id: 'parse-a',
                    user: { user_id: author },
                    xsec_token: 'synthetic-token',
                  },
                ],
                has_more: false,
                cursor: '',
              }
            : {
                items: [
                  {
                    id: '',
                    note_card: {
                      note_id: 'parse-a',
                      user: { user_id: author },
                      type: 'normal',
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
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      const started = await service.refreshFull({
        id: creatorId,
        scope: 'selected',
        noteIds: [key],
        basicOnly: true,
        reuseCompleteCache: true,
      });
      await service.lane;
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`;
      const saved = JSON.parse(rows[0].document);
      expect(api.mock.calls.map(([r]: any) => r.method)).toEqual([
        'GET',
        'POST',
      ]);
      expect(saved).toMatchObject({
        state: 'blocked',
        collectionStage: 'details',
        collectionScope: 'selected',
        basicOnly: true,
        sourceFailures: {
          [key]: {
            phase: 'detail',
            code: 'XHS_SOURCE_FAILURE_UNCLASSIFIED',
            errorKind: 'Error',
            dispatched: 'transport-entered',
          },
        },
      });
      expect(rows[0].document).not.toContain('synthetic-private-payload');
      expect(rows[0].document).not.toContain('synthetic-token');
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it.each([
    'XHS_REQUEST_BUDGET_EXHAUSTED',
    'XHS_SESSION_CHANGED',
    'XHS_TASK_CANCELLED',
  ])(
    'records %s pre-dispatch through the selected refreshFull entry',
    async (code) => {
      const creatorId = 'parse-creator',
        author = 'parse-author',
        key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: 'https://example.invalid/parse-author',
          displayName: 'Synthetic',
        },
      });
      await db.xhsNote.create({
        data: {
          id: key,
          creatorId,
          title: 'Old',
          publishTime: 0,
          kind: 'image-text',
          status: 'listed',
        },
      });
      const api = jest.fn();
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      runtime.bindSourceAdmission(async () => {
        throw new XhsSubscriptionError(code);
      });
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      (runtime as any).adapter.restoreDefaultAuthorAccess(author);
      const service: any = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      try {
        const started = await service.refreshFull({
          id: creatorId,
          scope: 'selected',
          noteIds: [key],
          basicOnly: true,
          reuseCompleteCache: true,
        });
        await service.lane;
        const rows = await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id=${started.taskId}`;
        const saved = JSON.parse(rows[0].document);
        expect(api).not.toHaveBeenCalled();
        expect(saved).toMatchObject({
          state: 'blocked',
          taskFailure: { phase: 'listing', code, dispatched: false },
        });
        const risk = await db.$queryRaw<
          any[]
        >`SELECT state FROM xhs_source_risk WHERE id='source'`;
        expect(risk[0].state).toBe('clear');
      } finally {
        runtime.onModuleDestroy();
      }
    },
    40000,
  );
  it('records selected basic expired context as a local undispatched detail failure', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      collectionStage: 'details',
      collectionScope: 'selected',
      collectDetails: true,
      basicOnly: true,
      reuseCompleteCache: true,
      state: 'queued',
      noteIds: [key],
      items: {},
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 1,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      await service.run(task);
      expect(api).not.toHaveBeenCalled();
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
      expect(JSON.parse(rows[0].document)).toMatchObject({
        state: 'blocked',
        code: 'XHS_ACCESS_CONTEXT_EXPIRED',
        sourceFailures: {
          [key]: {
            phase: 'detail',
            code: 'XHS_ACCESS_CONTEXT_EXPIRED',
            dispatched: false,
          },
        },
      });
      const risk = await db.$queryRaw<
        any[]
      >`SELECT state FROM xhs_source_risk WHERE id='source'`;
      expect(risk[0].state).toBe('clear');
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('records a safe outer task failure before source dispatch', async () => {
    const creatorId = 'parse-creator';
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: 'parse-author',
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
        enabled: false,
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      collectionStage: 'listing',
      state: 'queued',
      noteIds: [],
      items: {},
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      await service.run(task);
      expect(api).not.toHaveBeenCalled();
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
      expect(JSON.parse(rows[0].document).taskFailure).toMatchObject({
        phase: 'listing',
        dispatched: false,
      });
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('retains cancellation and records an outer failure after a cancelled wait', async () => {
    const creatorId = 'parse-creator';
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: 'parse-author',
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      collectionStage: 'listing',
      state: 'queued',
      noteIds: [],
      items: {},
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    const api = jest.fn(),
      runtime = new XhsSubscriptionRuntime({ enabled: () => true, api });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (entered = r));
    service.creator = async () => {
      entered();
      await gate;
      throw new Error('synthetic-private-outer-error');
    };
    try {
      const running = service.run(task);
      await ready;
      task.state = 'cancelled';
      release();
      await running;
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
      expect(JSON.parse(rows[0].document)).toMatchObject({
        state: 'cancelled',
        taskFailure: {
          phase: 'listing',
          code: 'XHS_LOCAL_OPERATION_FAILED',
          errorKind: 'Error',
          dispatched: false,
        },
      });
      expect(rows[0].document).not.toContain('synthetic-private-outer-error');
      expect(api).not.toHaveBeenCalled();
    } finally {
      release();
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('persists only the safe native transport cause on a selected detail unknown', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      collectionStage: 'details',
      collectionScope: 'selected',
      collectDetails: true,
      basicOnly: true,
      state: 'queued',
      noteIds: [key],
      items: {},
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 1,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const request = jest.fn(() => {
      const req = new EventEmitter() as any;
      req.destroy = jest.fn();
      req.end = jest.fn(() =>
        queueMicrotask(() =>
          req.emit(
            'error',
            Object.assign(new Error('synthetic-private-error'), {
              code: 'ECONNRESET',
            }),
          ),
        ),
      );
      return req;
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api: createRedbookHttpTransport(request as unknown as XhsHttpsRequest),
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    successfulProfile(runtime, author);
    (runtime as any).adapter.tokens.set(JSON.stringify([author, 'parse-a']), {
      token: 'synthetic-token',
      source: 'pc_user',
      expiresAt: Date.now() + 60000,
    });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      await service.run(task);
      expect(request).toHaveBeenCalledTimes(1);
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
      expect(JSON.parse(rows[0].document).sourceFailures[key]).toMatchObject({
        phase: 'detail',
        code: 'XHS_DETAIL_OUTCOME_UNKNOWN',
        dispatched: 'transport-entered',
        transportFailure: 'request-error',
        nativeCode: 'ECONNRESET',
      });
      expect(rows[0].document).not.toContain('synthetic-private-error');
      expect(rows[0].document).not.toContain('synthetic-token');
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it.each([
    ['response-json', 'malformed'],
    ['response-error', 'stream'],
  ] as const)(
    'persists HTTP 200 and %s without replaying the unknown request',
    async (failure, mode) => {
      const creatorId = 'parse-creator',
        author = 'parse-author',
        key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: 'https://example.invalid/parse-author',
          displayName: 'Synthetic',
        },
      });
      await db.xhsNote.create({
        data: {
          id: key,
          creatorId,
          title: 'Old',
          publishTime: 0,
          kind: 'image-text',
          status: 'listed',
        },
      });
      const task: any = {
        taskId: 'parse-task',
        creatorId,
        kind: 'list',
        collectionStage: 'details',
        collectionScope: 'selected',
        collectDetails: true,
        basicOnly: true,
        state: 'queued',
        noteIds: [key],
        items: {},
        total: 1,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: 1,
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const request = jest.fn((_url: any, _options: any, callback: any) => {
        const req = new EventEmitter() as any;
        req.destroy = jest.fn();
        req.end = () =>
          queueMicrotask(() => {
            const res = new PassThrough() as any;
            res.statusCode = 200;
            res.headers = { 'content-type': 'application/json' };
            callback(res);
            if (mode === 'stream')
              res.emit(
                'error',
                Object.assign(new Error('synthetic-private-not-json'), {
                  code: 'ECONNRESET',
                }),
              );
            else res.end('synthetic-private-not-json');
          });
        return req;
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api: createRedbookHttpTransport(request as unknown as XhsHttpsRequest),
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      successfulProfile(runtime, author);
      (runtime as any).adapter.tokens.set(JSON.stringify([author, 'parse-a']), {
        token: 'synthetic-token',
        source: 'pc_user',
        expiresAt: Date.now() + 60000,
      });
      const service: any = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      try {
        await service.run(task);
        expect(request).toHaveBeenCalledTimes(1);
        const rows = await db.$queryRaw<
          any[]
        >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
        expect(JSON.parse(rows[0].document).sourceFailures[key]).toMatchObject({
          phase: 'detail',
          httpStatus: 200,
          transportFailure: failure,
          dispatched: 'transport-entered',
          ...(mode === 'stream' ? { nativeCode: 'ECONNRESET' } : {}),
        });
        expect(rows[0].document).not.toContain('synthetic-private-not-json');
        expect(rows[0].document).not.toContain('synthetic-token');
        await service.run(task);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        runtime.onModuleDestroy();
      }
    },
    40000,
  );
  it('records a local transport guard rejection as not sent even after task transport entry', async () => {
    const creatorId = 'parse-creator',
      author = 'parse-author',
      key = JSON.stringify(['xiaohongshu', 'note', 'parse-a']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/parse-author',
        displayName: 'Synthetic',
      },
    });
    await db.xhsNote.create({
      data: {
        id: key,
        creatorId,
        title: 'Old',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      collectionStage: 'details',
      collectionScope: 'selected',
      collectDetails: true,
      basicOnly: true,
      state: 'queued',
      noteIds: [key],
      items: {},
      total: 1,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 1,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const request = jest.fn();
    const guarded = createRedbookHttpTransport(
      request as unknown as XhsHttpsRequest,
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api: (input) =>
        guarded({
          ...input,
          headers: { ...input.headers, 'x-unreviewed': 'synthetic' },
        }),
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    successfulProfile(runtime, author);
    (runtime as any).adapter.tokens.set(JSON.stringify([author, 'parse-a']), {
      token: 'synthetic-token',
      source: 'pc_user',
      expiresAt: Date.now() + 60000,
    });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      await service.run(task);
      expect(request).not.toHaveBeenCalled();
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id='parse-task'`;
      expect(JSON.parse(rows[0].document).sourceFailures[key]).toMatchObject({
        phase: 'detail',
        dispatched: false,
        transportFailure: 'guard-headers',
      });
    } finally {
      runtime.onModuleDestroy();
    }
  }, 40000);
  it('isolates a durable unknown list request across accounts and never replays it after restart', async () => {
    const people = [
      ['task-a', 'creator-a', 'author-a'],
      ['task-b', 'creator-b', 'author-b'],
      ['task-c', 'creator-c', 'author-c'],
      ['task-d', 'creator-d', 'author-d'],
    ];
    for (const [taskId, creatorId, authorId] of people) {
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: authorId,
          profileUrl: `https://example.invalid/${authorId}`,
          displayName: 'Synthetic',
        },
      });
      const doc = JSON.stringify({
        taskId,
        creatorId,
        state: 'running',
        noteIds: [],
      });
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creatorId},'running',${doc},1)`;
    }
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any): Promise<any> => {
      const author = new URL(request.url).searchParams.get('user_id');
      if (author === 'author-a') throw Error('synthetic transport lost');
      if (author === 'author-c')
        return { status: 461, url: request.url, body: {} };
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: { notes: [], has_more: false, cursor: '' },
        },
      };
    });
    const connect = async () => {
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      for (const [, , author] of people)
        (runtime as any).adapter.restoreDefaultAuthorAccess(author);
      return runtime;
    };
    const call = (runtime: XhsSubscriptionRuntime, i: number) =>
      runtime.withTaskScope(
        { taskId: people[i][0], creatorId: people[i][1] },
        () => runtime.list(people[i][2], null),
      );
    let runtime = await connect();
    await expect(call(runtime, 0)).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    const risk = await db.$queryRaw<
      any[]
    >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
    expect(risk[0]).toMatchObject({ state: 'clear', code: null });
    const saved = await db.$queryRaw<
      any[]
    >`SELECT document FROM xhs_subscription_tasks WHERE id='task-a'`;
    const item = JSON.parse(saved[0].document).sourceUnknowns[0];
    expect(item.outcome).toBe('unknown');
    expect(item.marker).toMatch(/^xhs:dispatch-pending:unknown:[a-f0-9]{64}$/);
    expect(saved[0].document).not.toContain('synthetic transport');
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    await service.persist({
      taskId: 'task-a',
      creatorId: 'creator-a',
      state: 'running',
      noteIds: [],
    });
    const afterStale = await db.$queryRaw<
      any[]
    >`SELECT document FROM xhs_subscription_tasks WHERE id='task-a'`;
    const savedTask = JSON.parse(afterStale[0].document);
    expect(savedTask.sourceUnknowns).toEqual([item]);
    expect(
      service.view({
        ...savedTask,
        kind: 'list',
        state: 'blocked',
        total: 1,
        completed: 0,
        skipped: 0,
      }).resumable,
    ).toBe(false);
    runtime.onModuleDestroy();
    runtime = await connect();
    await expect(call(runtime, 0)).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    const resumed = JSON.stringify({
      taskId: 'task-a2',
      creatorId: 'creator-a',
      state: 'running',
      noteIds: [],
    });
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('task-a2','creator-a','running',${resumed},1)`;
    await expect(
      runtime.withTaskScope({ taskId: 'task-a2', creatorId: 'creator-a' }, () =>
        runtime.list('author-a', null),
      ),
    ).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    await expect(call(runtime, 1)).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    await expect(call(runtime, 2)).rejects.toThrow();
    await expect(call(runtime, 3)).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  }, 40000);
  it.each(['comments', 'replies', 'parse'] as const)(
    'handles scheduled %s failure without replay or bypassing an unknown',
    async (mode) => {
      const round = '2026-11-01/09:15',
        records: Array<{
          creator: string;
          author: string;
          note: string;
          key: string;
          task: string;
        }> = [];
      try {
        for (const label of ['a', 'b', 'c', 'd']) {
          const creator = `comment-creator-${label}`,
            author = `comment-author-${label}`,
            note = `comment-note-${label}`,
            key = JSON.stringify(['xiaohongshu', 'note', note]),
            task = scheduledTaskId(round, creator, 'basic');
          await db.xhsCreator.create({
            data: {
              id: creator,
              externalAuthorId: author,
              profileUrl: `https://example.invalid/${author}`,
              displayName: 'Synthetic',
            },
          });
          await db.xhsNote.create({
            data: {
              id: key,
              creatorId: creator,
              title: 'Synthetic',
              publishTime: 1,
              kind: 'image-text',
              status: 'complete',
            },
          });
          const doc = {
            taskId: task,
            creatorId: creator,
            state: 'completed',
            schedule: { round, phase: 'basic' },
            noteIds: [key],
            failed: 0,
          };
          await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${task},${creator},'completed',${JSON.stringify(doc)},1)`;
          records.push({ creator, author, note, key, task });
        }
        await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
        const api = jest.fn(async (request: any): Promise<any> => {
          const url = new URL(request.url),
            note = url.searchParams.get('note_id'),
            sub = url.pathname.endsWith('/sub/page');
          if (
            note === records[0].note &&
            (mode === 'comments' || (mode === 'replies' && sub))
          )
            throw Error('synthetic lost');
          if (note === records[0].note && mode === 'parse')
            return {
              status: 200,
              url: request.url,
              body: {
                success: true,
                code: 0,
                data: { comments: [{ id: null }], has_more: false, cursor: '' },
              },
            };
          if (note === records[2].note)
            return { status: 461, url: request.url, body: {} };
          const comments =
            note === records[0].note
              ? [
                  {
                    id: 'root',
                    content: 'text',
                    like_count: '0',
                    user_info: { user_id: 'synthetic', nickname: 'Synthetic' },
                  },
                ]
              : [];
          return {
            status: 200,
            url: request.url,
            body: {
              success: true,
              code: 0,
              data: { comments, has_more: false, cursor: '' },
            },
          };
        });
        const connect = async () => {
          const runtime = new XhsSubscriptionRuntime({
            enabled: () => true,
            commentsEnabled: () => true,
            api,
            requirePersistentRisk: true,
          });
          runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
          bindXhsSourceTotalBudget(db as any, runtime);
          await runtime.connectSession({
            a1: 'synthetic-a1',
            webSession: 'synthetic-session',
          });
          for (const r of records)
            (runtime as any).adapter.tokens.set(
              JSON.stringify([r.author, r.note]),
              {
                token: 'synthetic-token',
                source: 'pc_user',
                expiresAt: Date.now() + 60000,
              },
            );
          return runtime;
        };
        let runtime = await connect(),
          svc: any = new XhsEngagementService(db as any, runtime);
        svc.write = async (fn: any) => db.$transaction(fn);
        expect(
          await svc.collectScheduled(round, records[0].creator),
        ).toMatchObject({ incomplete: true });
        const firstCalls = mode === 'replies' ? 2 : 1;
        expect(api).toHaveBeenCalledTimes(firstCalls);
        const firstTask = await db.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_subscription_tasks WHERE id=${records[0].task}`;
        expect(JSON.parse(firstTask[0].document).commentSummary).toMatchObject(
          mode === 'parse'
            ? { failedNotes: 1, unknownNotes: 0 }
            : { failedNotes: 0, unknownNotes: 1 },
        );
        let risk = await db.$queryRaw<
          any[]
        >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        expect(risk[0]).toMatchObject({ state: 'clear', code: null });
        runtime.onModuleDestroy();
        runtime = await connect();
        svc = new XhsEngagementService(db as any, runtime);
        svc.write = async (fn: any) => db.$transaction(fn);
        expect(
          await svc.collectScheduled(round, records[0].creator),
        ).toMatchObject({ incomplete: true });
        expect(api).toHaveBeenCalledTimes(firstCalls);
        if (mode !== 'parse') {
          expect(await svc.collectScheduled(round, records[1].creator)).toEqual(
            { pending: false, incomplete: true },
          );
          expect(api).toHaveBeenCalledTimes(firstCalls);
          runtime.onModuleDestroy();
          return;
        }
        expect(await svc.collectScheduled(round, records[1].creator)).toEqual({
          pending: false,
          incomplete: false,
        });
        expect(api).toHaveBeenCalledTimes(firstCalls + 1);
        const used = await db.$queryRaw<
          Array<{ used: number }>
        >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
        expect(used[0].used).toBe(firstCalls + 1);
        const otherRuntime = await connect(),
          otherSvc: any = new XhsEngagementService(db as any, otherRuntime);
        otherSvc.write = async (fn: any) => db.$transaction(fn);
        expect(
          await svc.collectScheduled(round, records[2].creator),
        ).toMatchObject({ incomplete: true });
        risk = await db.$queryRaw<
          any[]
        >`SELECT state,code,http_status FROM xhs_source_risk WHERE id='source'`;
        expect(risk[0]).toMatchObject({
          state: 'blocked',
          code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
          http_status: 461,
        });
        expect(api).toHaveBeenCalledTimes(firstCalls + 2);
        expect(
          await otherSvc.collectScheduled(round, records[3].creator),
        ).toMatchObject({ incomplete: true });
        expect(api).toHaveBeenCalledTimes(firstCalls + 2);
        const neverSent = await db.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_comment_windows WHERE note_id=${records[3].key} AND scope='top'`;
        expect(neverSent.length).toBe(1);
        expect(
          JSON.parse(neverSent[0].document).pendingDispatch,
        ).toBeUndefined();
        otherRuntime.onModuleDestroy();
        runtime.onModuleDestroy();
      } finally {
        await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
        for (const r of records) {
          await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id=${r.task}`;
          await db.xhsNote.deleteMany({ where: { creatorId: r.creator } });
          await db.xhsCreator.deleteMany({ where: { id: r.creator } });
        }
      }
    },
    40000,
  );
  it('resumes context rehydration after a known pre-dispatch busy page without repeating confirmed pages', async () => {
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api: jest.fn(),
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({ a1: 'synthetic', webSession: 'synthetic' });
    const cursors: (string | null)[] = [];
    let busy = true;
    (runtime as any).adapter.list = jest.fn(
      async (_author: string, cursor: string | null) => {
        cursors.push(cursor);
        if (cursor === 'second' && busy) {
          busy = false;
          throw new XhsSubscriptionError('XHS_REQUEST_RATE_PAUSED');
        }
        return { notes: [], nextCursor: null };
      },
    );
    const work = () =>
      runtime.withTaskScope(
        { taskId: 'synthetic-rebuild', creatorId: 'synthetic' },
        () => runtime.restoreScheduledNoteContexts('author', [null, 'second']),
      );
    await expect(work()).rejects.toMatchObject({
      code: 'XHS_REQUEST_RATE_PAUSED',
    });
    await expect(work()).resolves.toBeUndefined();
    expect(cursors).toEqual([null, 'second', 'second']);
    runtime.onModuleDestroy();
  }, 40000);
  it.each(['success', 'unknown'])(
    'rehydrates only checkpointed list pages after restart, with %s protected from replay',
    async (mode) => {
      const creator = 'rehydrate-creator',
        author = 'rehydrate-author',
        note = 'rehydrate-note',
        key = JSON.stringify(['xiaohongshu', 'note', note]),
        round = '2026-11-01/14:00',
        taskId = scheduledTaskId(round, creator, 'basic');
      try {
        await db.xhsCreator.create({
          data: {
            id: creator,
            externalAuthorId: author,
            profileUrl: 'https://example.invalid/rehydrate',
            displayName: 'Synthetic',
          },
        });
        await db.xhsNote.create({
          data: {
            id: key,
            creatorId: creator,
            title: 'Synthetic',
            publishTime: 1,
            kind: 'image-text',
            status: 'complete',
          },
        });
        const doc = {
          taskId,
          creatorId: creator,
          state: 'completed',
          schedule: { round, phase: 'basic' },
          noteIds: [key],
          failed: 0,
          listFinished: true,
          cursorHistory: [null],
        };
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creator},'completed',${JSON.stringify(doc)},1)`;
        const window = {
          scope: 'top',
          nextCursor: 'next',
          pages: 1,
          state: 'partial',
          code: null,
          collectedAt: 1,
          cursors: [''],
          scheduledRound: round,
        };
        await db.$executeRaw`INSERT INTO xhs_comment_windows(note_id,scope,document) VALUES(${key},'top',${JSON.stringify(window)})`;
        await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
        const api = jest.fn(async (request: any): Promise<any> => {
          const url = new URL(request.url);
          if (url.pathname.endsWith('/user_posted')) {
            if (mode === 'unknown') throw Error('synthetic lost');
            return {
              status: 200,
              url: request.url,
              body: {
                success: true,
                code: 0,
                data: {
                  notes: [
                    {
                      note_id: note,
                      user: { user_id: author },
                      xsec_token: 'synthetic-token',
                    },
                  ],
                  has_more: false,
                  cursor: '',
                },
              },
            };
          }
          return {
            status: 200,
            url: request.url,
            body: {
              success: true,
              code: 0,
              data: { comments: [], has_more: false, cursor: '' },
            },
          };
        });
        const connect = async () => {
          const runtime = new XhsSubscriptionRuntime({
            enabled: () => true,
            commentsEnabled: () => true,
            api,
            requirePersistentRisk: true,
          });
          runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
          bindXhsSourceTotalBudget(db as any, runtime);
          await runtime.connectSession({
            a1: 'synthetic-a1',
            webSession: 'synthetic-session',
          });
          const svc: any = new XhsEngagementService(db as any, runtime);
          svc.write = async (fn: any) => db.$transaction(fn);
          return { runtime, svc };
        };
        let { runtime, svc } = await connect();
        const result = await svc.collectScheduled(round, creator);
        expect(result.incomplete).toBe(mode === 'unknown');
        expect(api).toHaveBeenCalledTimes(mode === 'unknown' ? 1 : 2);
        runtime.onModuleDestroy();
        ({ runtime, svc } = await connect());
        const again = await svc.collectScheduled(round, creator);
        expect(again.incomplete).toBe(mode === 'unknown');
        expect(api).toHaveBeenCalledTimes(mode === 'unknown' ? 1 : 2);
        if (mode === 'success') {
          await expect(
            runtime.withTaskScope({ taskId, creatorId: creator }, () =>
              runtime.restoreScheduledNoteContexts(author, [
                'not-checkpointed',
              ]),
            ),
          ).rejects.toThrow();
          expect(api).toHaveBeenCalledTimes(2);
        }
        const used = await db.$queryRaw<
          Array<{ used: number }>
        >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
        expect(used[0].used).toBe(mode === 'unknown' ? 1 : 2);
        runtime.onModuleDestroy();
      } finally {
        await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
        await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id=${taskId}`;
        await db.xhsNote.deleteMany({ where: { creatorId: creator } });
        await db.xhsCreator.deleteMany({ where: { id: creator } });
      }
    },
    40000,
  );
  it('keeps a manual comment unknown closed for another creator without replay', async () => {
    const records: Array<{
      creator: string;
      author: string;
      note: string;
      key: string;
    }> = [];
    try {
      for (const label of ['a', 'b']) {
        const creator = `manual-creator-${label}`,
          author = `manual-author-${label}`,
          note = `manual-note-${label}`,
          key = JSON.stringify(['xiaohongshu', 'note', note]);
        await db.xhsCreator.create({
          data: {
            id: creator,
            externalAuthorId: author,
            profileUrl: `https://example.invalid/${author}`,
            displayName: 'Synthetic',
          },
        });
        await db.xhsNote.create({
          data: {
            id: key,
            creatorId: creator,
            title: 'Synthetic',
            publishTime: 1,
            kind: 'image-text',
            status: 'complete',
          },
        });
        records.push({ creator, author, note, key });
      }
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api = jest.fn(async (request: any): Promise<any> => {
        const note = new URL(request.url).searchParams.get('note_id');
        if (note === records[0].note) throw Error('synthetic lost');
        return {
          status: 200,
          url: request.url,
          body: {
            success: true,
            code: 0,
            data: { comments: [], has_more: false, cursor: '' },
          },
        };
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        commentsEnabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      for (const r of records)
        (runtime as any).adapter.tokens.set(
          JSON.stringify([r.author, r.note]),
          {
            token: 'synthetic-token',
            source: 'pc_user',
            expiresAt: Date.now() + 60000,
          },
        );
      const svc: any = new XhsEngagementService(db as any, runtime);
      svc.write = async (fn: any) => db.$transaction(fn);
      const request = (r: (typeof records)[number]) => ({
        creatorId: r.creator,
        noteId: r.key,
        maxPages: 1,
        maxItems: 200,
      });
      expect((await svc.collect(request(records[0]))).windows[0].state).toBe(
        'failed',
      );
      expect(api).toHaveBeenCalledTimes(1);
      const risk = await db.$queryRaw<
        any[]
      >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
      expect(risk[0]).toMatchObject({ state: 'clear', code: null });
      await expect(svc.collect(request(records[0]))).rejects.toThrow(
        'XHS_COMMENT_RECEIPT_UNCERTAIN',
      );
      expect(api).toHaveBeenCalledTimes(1);
      expect((await svc.collect(request(records[1]))).windows[0].state).toBe(
        'failed',
      );
      expect(api).toHaveBeenCalledTimes(1);
      runtime.onModuleDestroy();
    } finally {
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
      for (const r of records) {
        await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${r.creator}`;
        await db.xhsNote.deleteMany({ where: { creatorId: r.creator } });
        await db.xhsCreator.deleteMany({ where: { id: r.creator } });
      }
    }
  }, 40000);
  it('scheduled raw identity mismatch leaves other notes and the next creator eligible', async () => {
    const round = '2026-11-01/09:15',
      records = [
        {
          id: 'scheduled-mismatch-a',
          author: 'scheduled-author-a',
          notes: ['bad-a', 'good-a'],
        },
        {
          id: 'scheduled-mismatch-b',
          author: 'scheduled-author-b',
          notes: ['good-b'],
        },
      ];
    let current = records[0];
    for (const r of records)
      await db.xhsCreator.create({
        data: {
          id: r.id,
          externalAuthorId: r.author,
          profileUrl: `https://www.xiaohongshu.com/user/profile/${r.author}`,
          displayName: 'Synthetic',
        },
      });
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,1000) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=1000`;
    const api = jest.fn(async (request: any) => {
      const note =
        request.method === 'POST'
          ? JSON.parse(request.body).source_note_id
          : '';
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data:
            request.method === 'GET'
              ? new URL(request.url).pathname.endsWith('/user_posted')
                ? {
                    notes: current.notes.map((note_id) => ({
                      note_id,
                      user: { user_id: current.author },
                      xsec_token: 'synthetic-token',
                    })),
                    has_more: false,
                    cursor: '',
                  }
                : {}
              : {
                  items: [
                    {
                      id: note,
                      note_card: {
                        note_id: note,
                        user: {
                          user_id:
                            note === 'bad-a' ? 'wrong-author' : current.author,
                        },
                        type: 'normal',
                        time: 1760000000000,
                        title: 'Synthetic',
                        desc: 'saved body',
                        image_list: [],
                        interact_info: {
                          liked_count: '0',
                          collected_count: '0',
                          share_count: '0',
                          comment_count: '0',
                        },
                      },
                    },
                  ],
                },
        },
      };
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: current.author,
        name: 'Synthetic',
        profileUrl: `https://www.xiaohongshu.com/user/profile/${current.author}`,
        metrics: {
          values: { fans: 1, following: null },
          collectedAt: 2,
          contract: 'synthetic',
          evidence: 'source-only',
        },
      }),
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    const policy = await approveSyntheticScheduledPolicy(
      db,
      runtime,
      records.map((r) => r.id),
    );
    try {
      for (const r of records) {
        current = r;
        (runtime as any).adapter.restoreDefaultAuthorAccess(r.author);
        const started = await service.scheduleCreatorPhase({
          round,
          creatorId: r.id,
          phase: 'basic',
        });
        await service.lane;
        const task = await service.task({ taskId: started.taskId });

        expect(task).toMatchObject(
          r === records[0]
            ? {
                state: 'partial',
                completed: 1,
                failed: 1,
                code: 'XHS_DETAIL_PARSE_FAILED',
              }
            : { state: 'completed', completed: 1 },
        );
      }
      expect(
        api.mock.calls
          .filter(([r]: any) => r.method === 'POST')
          .map(([r]: any) => JSON.parse(r.body).source_note_id),
      ).toEqual(['bad-a', 'good-a', 'good-b']);
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('clear');
    } finally {
      await policy.cleanup();
      runtime.onModuleDestroy();
      for (const r of records) {
        await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id=${r.id}`;
        await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${r.id}`;
        await db.xhsNote.deleteMany({ where: { creatorId: r.id } });
        await db.xhsCreator.deleteMany({ where: { id: r.id } });
      }
    }
  }, 60000);
  it('refreshes profile once per scheduled round even when context is already cached', async () => {
    const creator = 'profile-refresh-creator',
      author = 'profile-refresh-author';
    await db.xhsCreator.create({
      data: {
        id: creator,
        externalAuthorId: author,
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        displayName: 'Synthetic',
      },
    });
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,1000) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=1000`;
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: new URL(request.url).pathname.endsWith('/user_posted')
          ? { notes: [], has_more: false, cursor: '' }
          : {},
      },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: author,
        name: 'Synthetic',
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        metrics: {
          values: { fans: 82, following: null },
          collectedAt: 100,
          contract: 'synthetic',
          evidence: 'source-only',
        },
      }),
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    const policy = await approveSyntheticScheduledPolicy(db, runtime, [
      creator,
    ]);
    try {
      for (const round of ['2026-11-01/09:15', '2026-11-01/14:00']) {
        const started = await service.scheduleCreatorPhase({
          round,
          creatorId: creator,
          phase: 'basic',
        });
        await service.lane;
        expect((await service.task({ taskId: started.taskId })).state).toBe(
          'completed',
        );
        const beforeRepeat = await db.$queryRawUnsafe(
          'SELECT id,used,next_at FROM xhs_request_budgets ORDER BY id',
        );
        const requestsBeforeRepeat = await db.$queryRawUnsafe(
          'SELECT operation_id,outcome FROM xhs_unbound_owner_requests ORDER BY operation_id',
        );
        await service.scheduleCreatorPhase({
          round,
          creatorId: creator,
          phase: 'basic',
        });
        await service.lane;
        expect(
          await db.$queryRawUnsafe(
            'SELECT id,used,next_at FROM xhs_request_budgets ORDER BY id',
          ),
        ).toEqual(beforeRepeat);
        expect(
          await db.$queryRawUnsafe(
            'SELECT operation_id,outcome FROM xhs_unbound_owner_requests ORDER BY operation_id',
          ),
        ).toEqual(requestsBeforeRepeat);
      }
      expect(
        api.mock.calls.filter(([r]: any) =>
          new URL(r.url).pathname.endsWith('/user/otherinfo'),
        ),
      ).toHaveLength(2);
      const rows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='creator' AND owner_id=${creator}`;
      expect(JSON.parse(rows[0].document).values.fans).toBe(82);
    } finally {
      await policy.cleanup();
      runtime.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id=${creator}`;
      await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${creator}`;
      await db.xhsCreator.deleteMany({ where: { id: creator } });
    }
  }, 40000);
  it('runs scheduled comments and replies for two creators through the real runtime and SQLite', async () => {
    const round = '2026-11-01/14:00',
      records: Array<{
        creator: string;
        author: string;
        note: string;
        key: string;
        task: string;
      }> = [];
    try {
      for (const label of ['a', 'b']) {
        const creator = `integration-creator-${label}`,
          author = `integration-author-${label}`,
          note = `integration-note-${label}`,
          key = JSON.stringify(['xiaohongshu', 'note', note]),
          task = scheduledTaskId(round, creator, 'basic');
        await db.xhsCreator.create({
          data: {
            id: creator,
            externalAuthorId: author,
            profileUrl: `https://example.invalid/${author}`,
            displayName: 'Synthetic',
          },
        });
        await db.xhsNote.create({
          data: {
            id: key,
            creatorId: creator,
            title: 'Synthetic',
            publishTime: 1,
            kind: 'image-text',
            status: 'complete',
          },
        });
        const doc = {
          taskId: task,
          creatorId: creator,
          state: 'completed',
          schedule: { round, phase: 'basic' },
          noteIds: [key],
          failed: 0,
        };
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${task},${creator},'completed',${JSON.stringify(doc)},1)`;
        records.push({ creator, author, note, key, task });
      }
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api = jest.fn(async (request: any) => {
        const u = new URL(request.url),
          reply = u.pathname.endsWith('/sub/page'),
          item = {
            id: reply ? 'reply' : 'root',
            content: 'synthetic',
            like_count: '0',
            user_info: { user_id: 'synthetic', nickname: 'Synthetic' },
          };
        return {
          status: 200,
          url: request.url,
          body: {
            success: true,
            code: 0,
            data: { comments: [item], has_more: false, cursor: '' },
          },
        };
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        commentsEnabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      for (const r of records)
        (runtime as any).adapter.tokens.set(
          JSON.stringify([r.author, r.note]),
          {
            token: 'synthetic-token',
            source: 'pc_user',
            expiresAt: Date.now() + 60000,
          },
        );
      const engagement: any = new XhsEngagementService(db as any, runtime);
      engagement.write = async (fn: any) => db.$transaction(fn);
      const service = {
        scheduleCreatorPhase: async (input: {
          creatorId: string;
          phase: 'basic' | 'media';
        }) =>
          input.phase === 'basic'
            ? {
                taskId: records.find((r) => r.creator === input.creatorId)!
                  .task,
              }
            : { state: 'nothing-to-archive' },
        task: async () => ({ state: 'completed', failed: 0, remaining: 0 }),
      };
      const runner = new XhsScheduledRunner(db as any, service, engagement);
      await runner.run(round);
      expect(api).toHaveBeenCalledTimes(4);
      await runner.run(round);
      expect(api).toHaveBeenCalledTimes(4);
      for (const r of records) {
        const view = await engagement.view({
          creatorId: r.creator,
          noteId: r.key,
        });
        expect(view.totalSaved).toBe(2);
        expect(view.comments.find((c: any) => c.id === 'reply')?.rootId).toBe(
          'root',
        );
      }
      runtime.onModuleDestroy();
    } finally {
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
      for (const r of records) {
        await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id=${r.task}`;
        await db.xhsNote.deleteMany({ where: { creatorId: r.creator } });
        await db.xhsCreator.deleteMany({ where: { id: r.creator } });
      }
    }
  }, 40000);
  it('retains the dispatch fence when the final transaction check fails after transport enters', async () => {
    for (const [taskId, creatorId, author] of [
      ['task-a', 'creator-a', 'author-a'],
      ['task-b', 'creator-b', 'author-b'],
    ]) {
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: `https://example.invalid/${author}`,
          displayName: 'Synthetic',
        },
      });
      const doc = JSON.stringify({
        taskId,
        creatorId,
        state: 'running',
        noteIds: [],
      });
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creatorId},'running',${doc},1)`;
    }
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    let failCheck = false,
      failedChecks = 0;
    const original = fs.statfs.bind(fs);
    const stat = jest.spyOn(fs, 'statfs').mockImplementation((async (
      ...args: any[]
    ) => {
      if (failCheck) {
        failCheck = false;
        failedChecks++;
        throw Error('synthetic-final-disk-check');
      }
      return (original as any)(...args);
    }) as any);
    const api = jest.fn(async (request: any) => {
      failCheck = true;
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: { notes: [], has_more: false, cursor: '' },
        },
      };
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    for (const author of ['author-a', 'author-b'])
      (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    let restarted: XhsSubscriptionRuntime | undefined;
    try {
      await expect(
        runtime.withTaskScope(
          { taskId: 'task-a', creatorId: 'creator-a' },
          () => runtime.list('author-a', null),
        ),
      ).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(1);
      expect(failedChecks).toBe(1);
      const fences = await db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
      expect(fences.length).toBeGreaterThan(0);
      const risk = await db.$queryRaw<
        any[]
      >`SELECT state FROM xhs_source_risk WHERE id='source'`;
      expect(['blocked', 'pending']).toContain(risk[0].state);
      runtime.onModuleDestroy();
      restarted = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      restarted.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, restarted);
      await restarted.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      for (const author of ['author-a', 'author-b'])
        (restarted as any).adapter.restoreDefaultAuthorAccess(author);
      await expect(
        restarted.withTaskScope(
          { taskId: 'task-a', creatorId: 'creator-a' },
          () => restarted!.list('author-a', null),
        ),
      ).rejects.toThrow();
      await expect(
        restarted.withTaskScope(
          { taskId: 'task-b', creatorId: 'creator-b' },
          () => restarted!.list('author-b', null),
        ),
      ).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(1);
      expect(
        await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`,
      ).toEqual(fences);
    } finally {
      stat.mockRestore();
      runtime.onModuleDestroy();
      restarted?.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
    }
  }, 40000);
  it('does not isolate a received but untrusted API response as a transport unknown', async () => {
    for (const [taskId, creatorId, author] of [
      ['task-a', 'creator-a', 'author-a'],
      ['task-b', 'creator-b', 'author-b'],
    ]) {
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: author,
          profileUrl: `https://example.invalid/${author}`,
          displayName: 'Synthetic',
        },
      });
      const doc = JSON.stringify({
        taskId,
        creatorId,
        state: 'running',
        noteIds: [],
      });
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creatorId},'running',${doc},1)`;
    }
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async () => {
      throw new RedbookPauseError('response');
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    for (const author of ['author-a', 'author-b'])
      (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    await expect(
      runtime.withTaskScope({ taskId: 'task-a', creatorId: 'creator-a' }, () =>
        runtime.list('author-a', null),
      ),
    ).rejects.toThrow('response');
    const risk = await db.$queryRaw<
      any[]
    >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
    expect(risk[0]).toMatchObject({
      state: 'blocked',
      code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    });
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:unknown:%'`,
    ).toHaveLength(0);
    await expect(
      runtime.withTaskScope({ taskId: 'task-b', creatorId: 'creator-b' }, () =>
        runtime.list('author-b', null),
      ),
    ).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  }, 40000);
  it.each([
    'preheaders',
    'stream',
    'html',
    'typed-html',
    'typed-461',
    'receipt-failure',
  ] as const)(
    'handles media %s uncertainty with the correct scope',
    async (mode) => {
      const round = '2026-11-01/09:15',
        records: Array<any> = [];
      for (const label of ['a', 'b']) {
        const creatorId = `media-creator-${label}`,
          author = `media-author-${label}`,
          note = `media-note-${label}`,
          noteKey = JSON.stringify(['xiaohongshu', 'note', note]);
        await db.xhsCreator.create({
          data: {
            id: creatorId,
            externalAuthorId: author,
            profileUrl: `https://example.invalid/${author}`,
            displayName: 'Synthetic',
          },
        });
        await db.xhsNote.create({
          data: {
            id: noteKey,
            creatorId,
            title: 'Synthetic',
            publishTime: 1,
            kind: 'image-text',
            status: 'listed',
            contentHtml: '<div id="js_content"><p>body</p></div>',
          },
        });
        const media = extractXhsMediaManifest(
          {
            items: [
              {
                id: note,
                note_card: {
                  note_id: note,
                  user: { user_id: author },
                  type: 'normal',
                  image_list: [
                    {
                      url_default: `https://sns-webpic.xhscdn.com/${label}.png`,
                    },
                  ],
                },
              },
            ],
          },
          author,
          note,
        );
        const basicId = scheduledTaskId(round, creatorId, 'basic'),
          taskId = scheduledTaskId(round, creatorId, 'media');
        const basic = {
          taskId: basicId,
          creatorId,
          state: 'completed',
          schedule: { round, phase: 'basic' },
          noteIds: [noteKey],
          mediaManifests: {
            [noteKey]: { state: 'pending', manifest: media.manifest },
          },
        };
        const task: any = {
          taskId,
          creatorId,
          kind: 'list',
          state: 'running',
          schedule: { round, phase: 'media' },
          noteIds: [noteKey],
          items: {},
          total: 1,
          completed: 0,
          skipped: 0,
          failed: 0,
          remaining: 1,
        };
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${basicId},${creatorId},'completed',${JSON.stringify(basic)},1)`;
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creatorId},'running',${JSON.stringify(task)},1)`;
        records.push({
          creatorId,
          author,
          note,
          noteKey,
          basicId,
          task,
          media,
        });
      }
      const first = records[0],
        extraNote = 'media-note-a2',
        extraKey = JSON.stringify(['xiaohongshu', 'note', extraNote]);
      await db.xhsNote.create({
        data: {
          id: extraKey,
          creatorId: first.creatorId,
          title: 'Synthetic',
          publishTime: 1,
          kind: 'image-text',
          status: 'listed',
          contentHtml: '<div id="js_content"><p>second</p></div>',
        },
      });
      first.extra = {
        note: extraNote,
        media: extractXhsMediaManifest(
          {
            items: [
              {
                id: extraNote,
                note_card: {
                  note_id: extraNote,
                  user: { user_id: first.author },
                  type: 'normal',
                  image_list: [
                    { url_default: 'https://sns-webpic.xhscdn.com/a2.png' },
                  ],
                },
              },
            ],
          },
          first.author,
          extraNote,
        ),
      };
      const basicRows = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${first.basicId}`;
      const firstBasic = JSON.parse(basicRows[0].document);
      firstBasic.noteIds.push(extraKey);
      firstBasic.mediaManifests[extraKey] = {
        state: 'pending',
        manifest: first.extra.media.manifest,
      };
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(firstBasic)} WHERE id=${first.basicId}`;
      first.task.noteIds.push(extraKey);
      first.task.total = 2;
      first.task.remaining = 2;
      await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(first.task)} WHERE id=${first.task.taskId}`;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
        'base64',
      );
      const media = jest.fn(async (url: URL) => {
        if (url.pathname === '/a.png') {
          if (mode === 'preheaders' || mode === 'receipt-failure')
            throw new XhsMediaError('XHS_MEDIA_TRANSPORT_FAILED');
          if (mode === 'typed-html')
            throw new XhsMediaError('XHS_MEDIA_TYPE_REJECTED');
          if (mode === 'typed-461')
            throw new XhsMediaError('XHS_MEDIA_HTTP_461');
          if (mode === 'html')
            return new Response('<html>verification</html>', {
              status: 200,
              headers: { 'content-type': 'image/png' },
            });
          return new Response(
            new ReadableStream({
              start(c) {
                c.error(Error('synthetic stream loss'));
              },
            }),
            { status: 200, headers: { 'content-type': 'image/png' } },
          );
        }
        return new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      });
      const connect = async () => {
        const runtime = new XhsSubscriptionRuntime({
          enabled: () => true,
          media,
          requirePersistentRisk: true,
        });
        runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
        bindXhsSourceTotalBudget(db as any, runtime);
        await runtime.connectSession({
          a1: 'synthetic-a1',
          webSession: 'synthetic-session',
        });
        for (const r of records) {
          (runtime as any).transientMedia.set(
            JSON.stringify([r.author, r.note]),
            {
              generation: (runtime as any).generation,
              expiresAt: Date.now() + 60000,
              version: r.media.manifest.version,
              getUrl: r.media.getUrl,
            },
          );
          if (r.extra)
            (runtime as any).transientMedia.set(
              JSON.stringify([r.author, r.extra.note]),
              {
                generation: (runtime as any).generation,
                expiresAt: Date.now() + 60000,
                version: r.extra.media.manifest.version,
                getUrl: r.extra.media.getUrl,
              },
            );
        }
        const service: any = new XhsSubscriptionService(db as any, runtime);
        service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
        return { runtime, service };
      };
      let { runtime, service } = await connect();
      if (mode === 'receipt-failure') {
        let writes = 0;
        service.write = async (_bytes: number, fn: any) => {
          if (++writes === 3) throw Error('synthetic receipt storage failure');
          return db.$transaction(fn);
        };
      }
      const run = (r: any) =>
        runtime.withTaskScope(
          { taskId: r.task.taskId, creatorId: r.creatorId },
          () =>
            service.runScheduledMedia(r.task, {
              id: r.creatorId,
              externalAuthorId: r.author,
            }),
        );
      const restricted =
        mode === 'html' || mode === 'typed-html' || mode === 'typed-461';
      if (restricted || mode === 'receipt-failure') {
        const code =
          mode === 'html'
            ? 'XHS_MEDIA_RESPONSE_INVALID'
            : mode === 'typed-html'
              ? 'XHS_MEDIA_TYPE_REJECTED'
              : mode === 'typed-461'
                ? 'XHS_MEDIA_HTTP_461'
                : 'XHS_SOURCE_RISK_UNAVAILABLE';
        await expect(run(records[0])).rejects.toThrow(code);
        expect(media).toHaveBeenCalledTimes(1);
      } else {
        await expect(run(records[0])).rejects.toThrow(
          'XHS_SOURCE_OUTCOME_UNKNOWN',
        );
        expect(media).toHaveBeenCalledTimes(1);
      }
      const risk = await db.$queryRaw<
        any[]
      >`SELECT state,code,http_status FROM xhs_source_risk WHERE id='source'`;
      expect(risk[0].state).toBe(restricted ? 'blocked' : 'clear');
      if (mode === 'typed-461')
        expect(risk[0]).toMatchObject({
          code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
          http_status: 461,
        });
      const basic = await db.$queryRaw<
        any[]
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${records[0].basicId}`;
      expect(
        JSON.parse(basic[0].document).mediaManifests[records[0].noteKey].items[
          '1'
        ].state,
      ).toBe(mode === 'receipt-failure' ? 'started' : 'unknown');
      if (restricted || mode === 'receipt-failure') {
        await expect(run(records[1])).rejects.toThrow();
        expect(media).toHaveBeenCalledTimes(1);
        runtime.onModuleDestroy();
        return;
      }
      runtime.onModuleDestroy();
      ({ runtime, service } = await connect());
      await expect(run(records[1])).rejects.toThrow();
      expect(media).toHaveBeenCalledTimes(1);
      runtime.onModuleDestroy();
    },
    40000,
  );
  it('persists the actual fixed 461 classification and prevents restore, reconnect and restart dispatch', async () => {
    let enabled = true;
    const api = jest.fn(async (request: any) => ({
      status: 461,
      url: request.url,
      body: {},
    }));
    const storage = {
      policy: jest.fn(async () => ({
        autoRestore: false,
        needsReconnect: false,
      })),
      status: jest.fn(async () => ({ stored: true })),
      load: jest.fn(async () => ({
        a1: 'synthetic-a1',
        web_session: 'synthetic-session',
      })),
      store: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {}),
    };
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => enabled,
      api,
      vault: storage,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      runtime.resolve(
        'https://www.xiaohongshu.com/explore/synthetic-note?xsec_token=synthetic&xsec_source=app_share',
      ),
    ).rejects.toThrow('unknown_rejection');
    const rows = await db.$queryRaw<
      Array<{
        state: string;
        code: string;
        http_status: number;
        endpoint: string;
        owner: string | null;
      }>
    >`SELECT state,code,http_status,endpoint,owner FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject({
      state: 'blocked',
      code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
      http_status: 461,
      endpoint: 'detail',
      owner: null,
    });
    expect(JSON.stringify(rows)).not.toContain('synthetic-session');
    enabled = false;
    expect(await runtime.connectionStatus()).toMatchObject({
      liveEnabled: false,
      sessionPresent: true,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    expect(storage.status).not.toHaveBeenCalled();
    enabled = true;
    await runtime.restoreSession();
    await runtime.disconnectSession();
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      runtime.resolve(
        'https://www.xiaohongshu.com/user/profile/synthetic-author',
      ),
    ).rejects.toThrow('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    runtime.onModuleDestroy();
    let restartedEnabled = false;
    const restarted = new XhsSubscriptionRuntime({
      enabled: () => restartedEnabled,
      api,
      requirePersistentRisk: true,
    });
    restarted.bindRiskStore(new XhsSourceRiskStore(db as any));
    expect(await restarted.connectionStatus()).toMatchObject({
      liveEnabled: false,
      sessionPresent: false,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    restartedEnabled = true;
    await restarted.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      restarted.resolve(
        'https://www.xiaohongshu.com/user/profile/synthetic-author',
      ),
    ).rejects.toThrow('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    expect(api).toHaveBeenCalledTimes(1);
    restarted.onModuleDestroy();
  }, 40000);

  it('keeps a durable pending fence across instances and failed completion', async () => {
    const first = new XhsSourceRiskStore(db as any),
      second = new XhsSourceRiskStore(db as any);
    const owner = await first.begin();
    await expect(second.begin()).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
    await expect(
      first.finish('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(Error('synthetic commit failure') as never);
    try {
      await expect(first.finish(owner)).rejects.toThrow(
        'XHS_SOURCE_RISK_UNAVAILABLE',
      );
    } finally {
      transaction.mockRestore();
    }
    expect(await second.read()).toBe('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    await expect(second.begin()).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
  }, 40000);

  it('fails closed when persistent risk cannot be read or reserved', async () => {
    const store = new XhsSourceRiskStore({
      $queryRaw: jest.fn().mockRejectedValue(Error('synthetic')),
    } as any);
    await expect(store.read()).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    await expect(store.begin()).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
  });

  it('clears only a successful pending operation and retains normal budget exhaustion without dispatch', async () => {
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: {} },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const profile = 'https://www.xiaohongshu.com/user/profile/author';
    await runtime.resolve(profile);
    expect(await risk.read()).toBeUndefined();
    const budget = new XhsRequestBudget({
      read: async (id) => ({ id, used: 1, limit: 1, nextAt: 0, intervalMs: 0 }),
      reserve: async () => false,
    });
    await expect(
      runtime.withRequestBudget(budget, 'synthetic', () =>
        runtime.resolve(profile),
      ),
    ).rejects.toThrow('XHS_REQUEST_RATE_PAUSED');
    expect(await risk.read()).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
    await runtime.resolve(profile);
    expect(api).toHaveBeenCalledTimes(2);
    expect(await risk.read()).toBeUndefined();
    runtime.onModuleDestroy();
  }, 40000);

  it.each([false, true])(
    'distinguishes local cancellation before dispatch from cancellation after dispatch (dispatched=%s)',
    async (dispatched) => {
      let used = 0;
      const api = jest.fn(async () => {
        throw new XhsSubscriptionError('XHS_TASK_CANCELLED');
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      const risk = new XhsSourceRiskStore(db as any);
      runtime.bindRiskStore(risk);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      const budget = new XhsRequestBudget({
        read: async (id) => ({ id, used, limit: 2, nextAt: 0, intervalMs: 0 }),
        reserve: async () => {
          used++;
          return true;
        },
        rollback: async () => {
          used--;
          return true;
        },
        assertReady: async () => {
          if (!dispatched) throw new XhsSubscriptionError('XHS_TASK_CANCELLED');
        },
      });
      const operation = runtime.withRequestBudget(budget, 'synthetic', () =>
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      );
      if (dispatched) await expect(operation).rejects.toThrow();
      else await expect(operation).rejects.toThrow('XHS_TASK_CANCELLED');
      expect(api).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(used).toBe(dispatched ? 1 : 0);
      expect(await risk.read()).toBe(
        dispatched ? 'XHS_SOURCE_RISK_REVIEW_REQUIRED' : undefined,
      );
      runtime.onModuleDestroy();
    },
    40000,
  );

  it('does not dispatch if a required risk reservation cannot be persisted', async () => {
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(Error('synthetic write failure') as never);
    try {
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    } finally {
      transaction.mockRestore();
    }
    expect(api).not.toHaveBeenCalled();
    expect((await runtime.connectionStatus()).riskCode).toBe(
      'XHS_SOURCE_RISK_UNAVAILABLE',
    );
    runtime.onModuleDestroy();
  }, 40000);

  it('does not replay an uncertain risk completion after a successful source response', async () => {
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: {} },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const finish = jest
      .spyOn(risk, 'finish')
      .mockRejectedValueOnce(Error('synthetic unknown commit'));
    try {
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
      expect(finish).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalledTimes(1);
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
      expect(api).toHaveBeenCalledTimes(1);
    } finally {
      finish.mockRestore();
    }
    expect(await risk.read()).toBe('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    runtime.onModuleDestroy();
  }, 40000);

  it('rejects a concurrent caller without poisoning the still-active owner', async () => {
    let release!: (value: any) => void;
    const api = jest.fn(
      (request: any) =>
        new Promise<{ status: number; url: string; body: unknown }>(
          (resolve) => {
            release = () =>
              resolve({
                status: 200,
                url: request.url,
                body: { success: true, code: 0, data: {} },
              });
          },
        ),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const url = 'https://www.xiaohongshu.com/user/profile/author';
    const first = runtime.resolve(url);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await expect(runtime.resolve(url)).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
    expect(api).toHaveBeenCalledTimes(1);
    release(undefined);
    await expect(first).resolves.toMatchObject({ author: { id: 'author' } });
    expect(await risk.read()).toBeUndefined();
    runtime.onModuleDestroy();
  }, 40000);

  it.each([
    ['XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED', 'blocked'],
    ['XHS_REQUEST_BUDGET_EXHAUSTED', 'clear'],
  ] as const)(
    'migrates partial only for an explicit source rejection (%s)',
    async (code, state) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path.join(folder, `partial-${state}.sqlite`).replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({ code });
        await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','partial',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{ state: string; code: string | null }>
        >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state,
          code:
            state === 'blocked' ? 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' : null,
        });
        const saved = await legacy.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(saved[0].document).toBe(old);
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );

  it.each([
    ['whole', 'XHS_SOURCE_VERIFICATION_BLOCKED', 'blocked'],
    ['subscription', 'XHS_SOURCE_VERIFICATION_BLOCKED', 'blocked'],
    ['whole', 'XHS_TASK_CANCELLED', 'clear'],
    ['subscription', 'XHS_TASK_CANCELLED', 'clear'],
  ] as const)(
    'migrates cancelled %s with %s only when it records a source rejection',
    async (kind, code, state) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path
                .join(folder, `cancel-${kind}-${state}.sqlite`)
                .replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({ code, stage: 'replies' });
        if (kind === 'whole')
          await legacy.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,state,document) VALUES('legacy','cancelled',${old})`;
        else
          await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','cancelled',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{ state: string; code: string | null }>
        >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state,
          code:
            state === 'blocked' ? 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' : null,
        });
        const saved =
          kind === 'whole'
            ? await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_whole_creator_jobs WHERE id='legacy'`
            : await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(saved[0].document).toBe(old);
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );

  it.each(['whole', 'subscription'] as const)(
    'migrates a legacy %s source stop to unknown review without asserting verification or clearing history',
    async (kind) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path.join(folder, `legacy-${kind}.sqlite`).replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({
          code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
          stage: 'replies',
        });
        if (kind === 'whole')
          await legacy.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,state,document) VALUES('legacy','paused',${old})`;
        else
          await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','blocked',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{
            state: string;
            code: string;
            http_status: number | null;
            endpoint: string | null;
          }>
        >`SELECT state,code,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state: 'blocked',
          code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
          http_status: null,
          endpoint: null,
        });
        const jobs =
          kind === 'whole'
            ? await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_whole_creator_jobs WHERE id='legacy'`
            : await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(jobs[0].document).toBe(old);
        const api = jest.fn();
        const runtime = new XhsSubscriptionRuntime({
          enabled: () => true,
          api,
          requirePersistentRisk: true,
        });
        runtime.bindRiskStore(new XhsSourceRiskStore(legacy as any));
        await runtime.connectSession({
          a1: 'synthetic-a1',
          webSession: 'synthetic-session',
        });
        await expect(
          runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
        ).rejects.toThrow('XHS_SOURCE_HISTORY_REVIEW_REQUIRED');
        expect(api).not.toHaveBeenCalled();
        runtime.onModuleDestroy();
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );
});
