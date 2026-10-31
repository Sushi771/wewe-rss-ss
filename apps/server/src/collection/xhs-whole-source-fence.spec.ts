jest.mock('./xhs-dispatch-owner-observation', () => ({observeDispatchOwner: jest.fn(() => 'dead')}));
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import { reviewWholeUnknown } from './xhs-whole-unknown-review';
jest.mock('./xhs-dispatch-owner', () => ({
 createDispatchOwner: () => ({ pid: 1234, startIdentity: 'synthetic-start', nonce: '00000000-0000-4000-8000-000000000001' }),
 ownsDispatch: (v: any, expected: any) => !!expected && v?.pid === 1234 && v?.startIdentity === 'synthetic-start' && v?.nonce === expected.nonce,
}));
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSqliteBudgetStore } from './xhs-request-budget-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsEngagementService } from './xhs-engagement.service';
import {
  prepareWholeSourceFence,
  markWholeSourceStarted,
  commitWholeSourceCheckpoint,
  releasePreparedWholeSourceFence,
} from './xhs-whole-source-fence';

describe('whole creator durable checkpoint fence', () => {
  let db: PrismaClient, folder: string;
  const marker =
    'xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000001';
  const scope = {
    owner: {pid:1234,startIdentity:'synthetic-start',nonce:'00000000-0000-4000-8000-000000000001'},
    jobId: 'synthetic-job',
    creatorId: 'synthetic-creator',
    authorId: 'synthetic-author',
    marker,
    phase: 'detail' as const,
    noteId: 'synthetic-note',
  };
  it('continues observed task counts beyond a historical limit while keeping request spacing', async () => {
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('synthetic-budget',1,1,0,5000)`;
    const store = new XhsSqliteBudgetStore(db as any), budget = new XhsRequestBudget(store);
    await expect(budget.check('synthetic-budget', 1000)).resolves.toBeUndefined();
    expect(await store.reserve('synthetic-budget', 1000)).toBe(true);
    expect(await store.reserve('synthetic-budget', 1001)).toBe(false);
    expect(await store.reserve('synthetic-budget', 6000)).toBe(true);
    expect(await store.read('synthetic-budget')).toMatchObject({limit:1,used:3,nextAt:11000,intervalMs:5000});
  });
  it('counts source phases beyond old limits without losing the durable fence', async () => {
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_set(document,'$.sourceGrant.used.detail',2) WHERE id=${scope.jobId}`;
    await db.$transaction(tx => prepareWholeSourceFence(tx,scope));
    await db.$transaction(tx => markWholeSourceStarted(tx,scope.jobId,marker,scope.owner));
    const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const doc=JSON.parse(rows[0].document);expect(doc.sourceGrant.used.detail).toBe(3);expect(doc.sourceGrant.limits.detail).toBe(2);expect(doc.sourceFence.state).toBe('started');
  });
  it('keeps the owner through checkpoint and stale task saves preserve the terminal receipt', async () => {
    const stale = JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`)[0].document);
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    const read = async () => JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`)[0].document);
    const owner = (await read()).sourceFence.owner;
    expect(owner).toMatchObject({pid:1234, startIdentity:'synthetic-start'});
    await db.$transaction((tx) => markWholeSourceStarted(tx, scope.jobId, marker, scope.owner));
    expect((await read()).sourceFence.owner).toEqual(owner);
    await db.$transaction((tx) => commitWholeSourceCheckpoint(tx, scope.jobId, marker, scope.owner));
    expect((await read()).sourceFence).toBeUndefined();
    expect((await read()).lastSourceOwnerReceipt).toEqual({marker,owner,state:'checkpointed'});
    const whole = new XhsWholeCreatorService(db as any,{} as any,{} as any,{} as any);
    await (whole as any).save(stale);
    expect((await read()).lastSourceOwnerReceipt).toEqual({marker,owner,state:'checkpointed'});
  });
  it('rejects a legacy fence without owner at both dispatch and checkpoint', async () => {
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.sourceFence.owner') WHERE id=${scope.jobId}`;
    await expect(db.$transaction((tx) => markWholeSourceStarted(tx, scope.jobId, marker, scope.owner))).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    await expect(db.$transaction((tx) => commitWholeSourceCheckpoint(tx, scope.jobId, marker, scope.owner))).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  });
  it('rejects replacement of the durable nonce by a different valid nonce',async()=>{
    await db.$transaction(tx=>prepareWholeSourceFence(tx,scope));
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_set(document,'$.sourceFence.owner.nonce','00000000-0000-4000-8000-000000000002') WHERE id=${scope.jobId}`;
    await expect(db.$transaction(tx=>markWholeSourceStarted(tx,scope.jobId,marker,scope.owner))).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    await expect(db.$transaction(tx=>releasePreparedWholeSourceFence(tx,scope.jobId,marker,scope.owner))).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_set(document,'$.sourceFence.state','started') WHERE id=${scope.jobId}`;
    await expect(db.$transaction(tx=>commitWholeSourceCheckpoint(tx,scope.jobId,marker,scope.owner))).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  });
  async function reviewFixture() {
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',312,8,10000,10000)`;
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    await db.$transaction((tx) => markWholeSourceStarted(tx, scope.jobId, marker, scope.owner));
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='paused',document=json_set(document,'$.state','paused','$.code','XHS_DOWNLOAD_BLOCKED') WHERE id=${scope.jobId}`;
    return {jobId:scope.jobId,expectedAuthorId:scope.authorId,expectedNoteId:scope.noteId,expectedMarker:marker,decision:'request-retry' as const};
  }
  it('records one decision idempotently without changing the unknown fence, failure or budget', async () => {
    const input=await reviewFixture();
    const first=await db.$transaction(tx=>reviewWholeUnknown(tx,input));
    expect(first.executionAllowed).toBe(false);
    expect(await db.$transaction(tx=>reviewWholeUnknown(tx,input))).toEqual(first);
    const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const doc=JSON.parse(rows[0].document);
    expect(doc.sourceFence.state).toBe('started');expect(doc.code).toBe('XHS_DOWNLOAD_BLOCKED');
    expect((await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`)[0].used).toBe(8);
    await expect(db.$transaction(tx=>reviewWholeUnknown(tx,{...input,decision:'defer'}))).rejects.toThrow();
  });
  it.each(['alive','unknown'])('refuses %s owner', async state => {
    const input=await reviewFixture();
    (observeDispatchOwner as jest.Mock).mockReturnValueOnce(state);
    await expect(db.$transaction(tx=>reviewWholeUnknown(tx,input))).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  });
  it('refuses legacy owner and mismatched identity scope', async () => {
    const input=await reviewFixture();
    await expect(db.$transaction(tx=>reviewWholeUnknown(tx,{...input,expectedAuthorId:'other'}))).rejects.toThrow();
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.sourceFence.owner') WHERE id=${scope.jobId}`;
    await expect(db.$transaction(tx=>reviewWholeUnknown(tx,input))).rejects.toThrow();
  });
  it('rolls back a decision on a failed transaction without clearing any fence', async () => {
    const input=await reviewFixture();
    await expect(db.$transaction(async tx=>{await reviewWholeUnknown(tx,input);throw Error('synthetic crash');})).rejects.toThrow('synthetic crash');
    const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    expect(JSON.parse(rows[0].document).unknownReview).toBeUndefined();
    expect(JSON.parse(rows[0].document).sourceFence).toBeDefined();
  });
  it('refuses another durable writer', async () => {
    const input=await reviewFixture();
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:dispatch-pending:other',1,1,1,1)`;
    await expect(db.$transaction(tx=>reviewWholeUnknown(tx,input))).rejects.toThrow();
  });
  it('records concurrent identical confirmations only once', async () => {
    const input=await reviewFixture();
    const out=await Promise.allSettled([db.$transaction(tx=>reviewWholeUnknown(tx,input)),db.$transaction(tx=>reviewWholeUnknown(tx,input))]);
    expect(out.some(x=>x.status==='fulfilled')).toBe(true);
    expect(await db.$transaction(tx=>reviewWholeUnknown(tx,input))).toMatchObject({state:'recorded',executionAllowed:false});
  });
  it('rejects state changes after the original decision', async () => {
    const input=await reviewFixture();await db.$transaction(tx=>reviewWholeUnknown(tx,input));
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_set(document,'$.sourceGrant.used.detail',2) WHERE id=${scope.jobId}`;
    await expect(db.$transaction(tx=>reviewWholeUnknown(tx,input))).rejects.toThrow();
  });
  it('preserves the attempt handoff against stale task saves',async()=>{
    const stale=JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`)[0].document);
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_set(document,'$.reviewAttempt',json('{"id":"attempt","state":"consumed"}')) WHERE id=${scope.jobId}`;
    const whole=new XhsWholeCreatorService(db as any,{} as any,{} as any,{} as any);await (whole as any).save(stale);
    const row=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    expect(JSON.parse(row[0].document).reviewAttempt).toEqual({id:'attempt',state:'consumed'});
  });
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(tmpdir(), 'xhs-whole-fence-'));
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
    await db.$executeRaw`DELETE FROM xhs_limited_recovery_append`;
    await db.$executeRaw`DELETE FROM xhs_limited_recovery`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;
    await db.xhsNote.deleteMany();
    await db.xhsCreator.deleteMany();
    await db.xhsCreator.create({
      data: {
        id: scope.creatorId,
        profileUrl: 'https://example.invalid/synthetic',
        displayName: 'Synthetic',
        externalAuthorId: scope.authorId,
      },
    });
    await db.xhsNote.deleteMany();
    await db.xhsNote.create({
      data: {
        id: JSON.stringify(['xiaohongshu', 'note', 'synthetic-note']),
        creatorId: scope.creatorId,
        title: 'Synthetic',
        publishTime: 0,
        kind: 'image-text',
        status: 'listed',
      },
    });
    await db.$executeRaw`UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED',owner=NULL,http_status=NULL,endpoint=NULL WHERE id='source'`;
    const doc = JSON.stringify({
      id: scope.jobId,
      creatorId: scope.creatorId,
      state: 'running',
      sourceGrant: {
        creatorId: scope.creatorId,
        authorId: scope.authorId,
        phases: ['detail'],
        limits: { detail: 2 },
        used: { detail: 0 },
      },
    });
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES(${scope.jobId},${scope.creatorId},'running',${doc},1)`;
  }, 15000);
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }, 40000);
  it.each([
    [true, false, false, false, false, false, false],
    [false, false, false, false, false, false, false],
    [true, true, false, false, false, false, false],
    [false, false, true, false, false, false, false],
    [true, true, false, true, false, false, false],
    [false, false, true, false, true, false, false],
    [false, false, true, false, true, true, false],
    [false, true, true, false, false, false, true],
    [true, true, false, false, false, false, false, true],
  ])(
    'runs scoped checkpoints (list complete: %s, image: %s, directory only: %s, media zero: %s, 10s: %s, cancel: %s, extend: %s)',
    async (
      listEnd,
      hasImage,
      directoryOnly,
      mediaZero,
      slow,
      cancelWait,
      continueStage,
      mediaDenied = false,
    ) => {
      const author = {
        id: scope.authorId,
        name: 'Synthetic',
        profileUrl:
          'https://www.xiaohongshu.com/user/profile/' + scope.authorId,
      };
      const sentAt: number[] = [];
      let sawProfile!: () => void;
      const profileCalled = new Promise<void>((resolve) => {
        sawProfile = resolve;
      });
      const api = jest.fn(async (request: any) => {
        const u = new URL(request.url);
        sentAt.push(Date.now());
        if (u.pathname.endsWith('otherinfo')) sawProfile();
        const data = u.pathname.endsWith('otherinfo')
          ? { syntheticSchema: 1, author }
          : u.pathname.endsWith('user_posted')
            ? {
                notes: [
                  {
                    note_id: scope.noteId,
                    user: { user_id: scope.authorId },
                    xsec_token: 'synthetic-list-access',
                    type: 'normal',
                    display_title: 'Synthetic',
                  },
                ],
                has_more: false,
                cursor: '',
              }
            : {
                items: [
                  {
                    id: scope.noteId,
                    note_card: {
                      note_id: scope.noteId,
                      user: { user_id: scope.authorId, nickname: 'Synthetic' },
                      type: 'normal',
                      time: 1760000000000,
                      title: 'Synthetic',
                      desc: 'Synthetic body',
                      image_list: hasImage
                        ? [
                            {
                              url_default:
                                'https://sns-webpic.xhscdn.com/synthetic.png',
                            },
                          ]
                        : [],
                      interact_info: {
                        liked_count: '0',
                        collected_count: '2',
                        share_count: '3',
                        comment_count: '4',
                      },
                    },
                  },
                ],
              };
        return {
          status: 200,
          url: request.url,
          body: { success: true, code: 0, data },
        };
      });
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
        'base64',
      );
      const media = jest.fn(
        async () =>
          new Response(mediaDenied ? 'synthetic-secret' : png, {
            status: mediaDenied ? 403 : 200,
            headers: { 'content-type': 'image/png' },
          }),
      );
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        media,
        requirePersistentRisk: true,
        profileParser: (raw: any) => raw.author,
      });
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      const sharedLimit = slow ? 6 : 20,
        sharedUsed = slow ? 2 : 0,
        interval = slow ? 10000 : 1000;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES('xhs:source-total',${sharedLimit},${slow ? 10000 : 0},${sharedUsed},0)`;
      const taskLimit = continueStage ? 4 : 20;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},${taskLimit},${interval},0,0)`;
      if (!listEnd) await db.xhsNote.deleteMany();
      const doc = {
        id: scope.jobId,
        creatorId: scope.creatorId,
        state: 'paused',
        updatedAt: 1,
        listEnd,
        profile: 1,
        items: {},
        code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
      };
      await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='paused',document=${JSON.stringify(doc)} WHERE id=${scope.jobId}`;
      const subscriptions = new XhsSubscriptionService(db as any, runtime);
      subscriptions.bindLocalSaver(
        async () => folder,
        async () => ({
          alreadySaved: false,
          mediaComplete: true,
          supplement: { status: 'new' },
        }),
      );
      const whole = new XhsWholeCreatorService(
        db as any,
        subscriptions,
        runtime,
        new XhsEngagementService(db as any, runtime),
      );
      const grant = {
        creatorId: scope.creatorId,
        expectedAuthorId: scope.authorId,
        jobId: scope.jobId,
        requestLimit: taskLimit,
        intervalMs: interval,
        phaseLimits: {
          profile: directoryOnly ? 1 : 10,
          list: directoryOnly ? 3 : 10,
          detail: directoryOnly ? 0 : 10,
          media: directoryOnly || mediaZero ? 0 : 10,
          metrics: directoryOnly ? 0 : 10,
        },
      };
      await expect(
        whole.prepareHistoryGrant({ ...grant, expectedAuthorId: 'other' }),
      ).rejects.toThrow();
      await whole.prepareHistoryGrant(grant);
      expect(api).not.toHaveBeenCalled();
      await expect(whole.prepareHistoryGrant(grant)).rejects.toThrow();
      await whole.resume(scope.jobId);
      if (cancelWait) {
        await profileCalled;
        await whole.cancel(scope.jobId);
      }
      await (whole as any).lane;
      const result = await whole.view(scope.jobId);
      if (mediaDenied) {
        expect(result.state).toBe('paused');
        expect(result.code).toBe('XHS_MEDIA_HTTP_403');
        expect(result.sourceCheckpoint?.state).toBe('unknown');
        expect(result.budget!.used).toBe(4);
        expect(media).toHaveBeenCalledTimes(1);
        const receipt = await subscriptions.task({taskId: result.archiveTask!});
        expect(receipt.code).toBe('XHS_MEDIA_HTTP_403');
        expect(JSON.stringify(receipt)).not.toContain('synthetic-secret');
        await expect(whole.resume(scope.jobId)).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
        runtime.onModuleDestroy();
        return;
      }
      if (cancelWait) {
        expect(result.state).toBe('cancelled');
        expect(api).toHaveBeenCalledTimes(1);
        expect(media).not.toHaveBeenCalled();
        const total = await db.$queryRaw<
          Array<{ used: number }>
        >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
        expect(total[0].used).toBe(3);
        expect(result.budget!.used).toBe(1);
        runtime.onModuleDestroy();
        return;
      }
      if (directoryOnly) {
        expect(result.listEnd).toBe(true);
        expect(result.historyGrant!.used.detail).toBe(1);
        if (slow) expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(9900);
      }
      if (mediaZero) expect(result.historyGrant!.used.media).toBe(1);
      expect(result.state).toBe('completed');
      expect(api).toHaveBeenCalledTimes(3);
      expect(result.budget!.used).toBe(hasImage ? 4 : 3);
      expect(media).toHaveBeenCalledTimes(hasImage ? 1 : 0);
      expect(result.historyGrant!.used.media).toBe(hasImage ? 1 : 0);
      expect(result.historyGrant!.used.profile).toBe(1);
      expect(result.historyGrant!.used.list).toBe(1);
      expect(result.historyGrant!.used.detail).toBe(1);
      expect(
        await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:whole:%'`,
      ).toHaveLength(0);
      const note = await db.xhsNote.findUniqueOrThrow({
        where: { id: JSON.stringify(['xiaohongshu', 'note', scope.noteId]) },
      });
      expect(note.contentHtml).toContain('Synthetic body');
      expect(await new XhsSourceRiskStore(db as any).read()).toBe(
        'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
      );
      runtime.onModuleDestroy();
    },
    40000,
  );
  it('keeps two separately authorized creators bound to their own jobs', async () => {
    const doc = {
      id: scope.jobId,
      creatorId: scope.creatorId,
      state: 'paused',
      updatedAt: 1,
      listEnd: true,
      items: {},
      code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
    };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='paused',document=${JSON.stringify(doc)} WHERE id=${scope.jobId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},20,1000,0,0)`;
    await db.xhsCreator.create({
      data: {
        id: 'second-creator',
        externalAuthorId: 'second-author',
        profileUrl: 'https://example.invalid/second',
        displayName: 'Synthetic',
      },
    });
    const whole = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const limits = { profile: 2, list: 2, detail: 10, media: 10, metrics: 2 };
    await whole.prepareHistoryGrant({
      creatorId: scope.creatorId,
      expectedAuthorId: scope.authorId,
      jobId: scope.jobId,
      requestLimit: 20,
      intervalMs: 1000,
      phaseLimits: limits,
    });
    const second = await whole.prepareHistoryGrant({
      creatorId: 'second-creator',
      expectedAuthorId: 'second-author',
      requestLimit: 20,
      intervalMs: 1000,
      phaseLimits: limits,
    });
    expect(second.state).toBe('paused');
    expect(second.id).not.toBe(scope.jobId);
    const jobs = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs ORDER BY creator_id`;
    const grants = jobs.map((r) => JSON.parse(r.document).sourceGrant);
    expect(grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          creatorId: scope.creatorId,
          authorId: scope.authorId,
        }),
        expect.objectContaining({
          creatorId: 'second-creator',
          authorId: 'second-author',
        }),
      ]),
    );
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='running',document=json_set(document,'$.state','running') WHERE id=${scope.jobId}`;
    await expect(
      db.$transaction((tx) =>
        prepareWholeSourceFence(tx, {
          ...scope,
          creatorId: 'second-creator',
          authorId: 'second-author',
        }),
      ),
    ).rejects.toThrow();
  });
  it('cannot authorize while an earlier single-note result is unresolved', async () => {
    const job = {
      id: scope.jobId,
      creatorId: scope.creatorId,
      state: 'paused',
      updatedAt: 1,
      listEnd: true,
      items: {},
      code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
    };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='paused',document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},20,1000,1,0)`;
    await db.$executeRaw`INSERT INTO xhs_limited_recovery(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round',${scope.noteId},${scope.authorId},'old','unknown',0,0,0)`;
    const whole = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const grant = {
      creatorId: scope.creatorId,
      expectedAuthorId: scope.authorId,
      jobId: scope.jobId,
      requestLimit: 20,
      intervalMs: 1000,
      phaseLimits: {
        profile: 10,
        list: 10,
        detail: 10,
        media: 10,
        metrics: 10,
      },
    };
    await expect(whole.prepareHistoryGrant(grant)).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
    await db.$executeRaw`INSERT INTO xhs_limited_recovery_append(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round',${scope.noteId},${scope.authorId},'new','finished',0,0,0)`;
    await expect(whole.prepareHistoryGrant(grant)).resolves.toMatchObject({
      state: 'paused',
    });
    expect(
      (
        await db.$queryRaw<
          Array<{ used: number }>
        >`SELECT used FROM xhs_request_budgets WHERE id=${scope.jobId}`
      )[0].used,
    ).toBe(1);
    expect(
      (
        await db.$queryRaw<
          Array<{ state: string }>
        >`SELECT state FROM xhs_limited_recovery`
      )[0].state,
    ).toBe('unknown');
  });
  it('does not treat an old exhausted budget as proof that a checkpoint is safe', async () => {
    const job = {
      id: scope.jobId,
      creatorId: scope.creatorId,
      state: 'paused',
      updatedAt: 1,
      listEnd: false,
      items: {},
      code: 'XHS_REQUEST_BUDGET_EXHAUSTED',
    };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='paused',document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},20,1000,20,0)`;
    const whole = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      whole.prepareHistoryGrant({
        creatorId: scope.creatorId,
        expectedAuthorId: scope.authorId,
        jobId: scope.jobId,
        requestLimit: 20,
        intervalMs: 1000,
        phaseLimits: { profile: 1, list: 1, detail: 1, media: 1, metrics: 1 },
      }),
    ).rejects.toThrow('XHS_TASK_NOT_RESUMABLE');
    const rows = await db.$queryRaw<
      Array<{ used: number }>
    >`SELECT used FROM xhs_request_budgets WHERE id=${scope.jobId}`;
    expect(rows[0].used).toBe(20);
  });
  it('continues separate observed profile and list counts while preserving the shared fence', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document);
    job.sourceGrant.phases = ['list'];
    job.sourceGrant.limits = {
      profile: 1,
      list: 3,
      detail: 0,
      media: 0,
      metrics: 0,
    };
    job.sourceGrant.used = {
      profile: 0,
      list: 0,
      detail: 0,
      media: 0,
      metrics: 0,
    };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await db.$transaction((tx) =>
      prepareWholeSourceFence(tx, {
        ...scope,
        phase: 'list',
        noteId: undefined,
      }),
    );
    await db.$transaction((tx) =>
      markWholeSourceStarted(tx, scope.jobId, marker, scope.owner, 'profile'),
    );
    for (let n = 0; n < 3; n++)
      await db.$transaction((tx) =>
        markWholeSourceStarted(tx, scope.jobId, marker, scope.owner, 'list'),
      );
    await db.$transaction((tx) => markWholeSourceStarted(tx, scope.jobId, marker, scope.owner, 'list'));
    await db.$transaction((tx) => markWholeSourceStarted(tx, scope.jobId, marker, scope.owner, 'profile'));
    const after = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    expect(JSON.parse(after[0].document).sourceGrant.used).toEqual({
      profile: 2,
      list: 4,
      detail: 0,
      media: 0,
      metrics: 0,
    });
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(1);
  });
  it('atomically admits one explicit continuation without overwriting its stage grant', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document);
    job.state = 'paused';
    job.code = 'XHS_WHOLE_PHASE_BUDGET_EXHAUSTED';
    job.items = {};
    job.listEnd = false;
    job.updatedAt = 1;
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='paused',document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    const whole = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const schedule = jest
      .spyOn(whole as any, 'schedule')
      .mockImplementation(() => undefined);
    const results = await Promise.allSettled([
      whole.resume(scope.jobId),
      whole.resume(scope.jobId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    const after = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    expect(JSON.parse(after[0].document).sourceGrant).toEqual(job.sourceGrant);
  });
  it('holds the actual source-dispatch fence until the business transaction commits', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document);
    job.sourceGrant.phases = ['list'];
    job.sourceGrant.limits = { list: 10, profile: 10 };
    job.sourceGrant.used = { list: 0, profile: 0 };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES('xhs:source-total',20,0,0,0)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},20,0,0,0)`;
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: new URL(request.url).pathname.endsWith('otherinfo')
          ? {
              syntheticSchema: 1,
              author: {
                id: scope.authorId,
                name: 'Synthetic',
                profileUrl:
                  'https://www.xiaohongshu.com/user/profile/' + scope.authorId,
              },
            }
          : { notes: [], has_more: false, cursor: '' },
      },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: (raw: any) => raw.author,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const budget = new XhsRequestBudget(new XhsSqliteBudgetStore(db as any));
    await runtime.withWholeAuthorization(
      {
        jobId: scope.jobId,
        creatorId: scope.creatorId,
        authorId: scope.authorId,
      },
      () =>
        runtime.withRequestBudget(budget, scope.jobId, () =>
          runtime.withCheckpointGroup(
            'list',
            scope.authorId,
            undefined,
            async () => {
              await runtime.list(scope.authorId, null);
              const pending = await db.$queryRaw<
                Array<{ id: string }>
              >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:whole:%'`;
              expect(pending).toHaveLength(1);
              await db.$transaction(async (tx) => {
                await tx.$executeRaw`UPDATE xhs_creators SET last_status='listed' WHERE id=${scope.creatorId}`;
                await runtime.checkpointWholeSource(tx);
              });
            },
          ),
        ),
    );
    expect(api).toHaveBeenCalled();
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:whole:%'`,
    ).toHaveLength(0);
    expect(await new XhsSourceRiskStore(db as any).read()).toBe(
      'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
    );
    runtime.onModuleDestroy();
  }, 40000);
  it('retains an actual dispatch group after a checkpoint rollback and blocks a fresh runtime', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document);
    job.sourceGrant.phases = ['list'];
    job.sourceGrant.limits = { list: 10, profile: 10 };
    job.sourceGrant.used = { list: 0, profile: 0 };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES('xhs:source-total',20,0,0,0)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},20,0,0,0)`;
    const author = {
      id: scope.authorId,
      name: 'Synthetic',
      profileUrl: 'https://www.xiaohongshu.com/user/profile/' + scope.authorId,
    };
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: new URL(request.url).pathname.endsWith('otherinfo')
          ? { author }
          : { notes: [], has_more: false, cursor: '' },
      },
    }));
    const makeRuntime = async () => {
      const r = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
        profileParser: (raw: any) => raw.author,
      });
      r.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, r);
      await r.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      return r;
    };
    const first = await makeRuntime(),
      budget = new XhsRequestBudget(new XhsSqliteBudgetStore(db as any));
    await expect(
      first.withWholeAuthorization(
        {
          jobId: scope.jobId,
          creatorId: scope.creatorId,
          authorId: scope.authorId,
        },
        () =>
          first.withRequestBudget(budget, scope.jobId, () =>
            first.withCheckpointGroup(
              'list',
              scope.authorId,
              undefined,
              async () => {
                await first.list(scope.authorId, null);
                await db.$transaction(async (tx) => {
                  await first.checkpointWholeSource(tx);
                  throw Error('synthetic checkpoint rollback');
                });
              },
            ),
          ),
      ),
    ).rejects.toThrow();
    const count = api.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:whole:%'`,
    ).toHaveLength(1);
    first.onModuleDestroy();
    const second = await makeRuntime();
    await expect(
      second.withWholeAuthorization(
        {
          jobId: scope.jobId,
          creatorId: scope.creatorId,
          authorId: scope.authorId,
        },
        () =>
          second.withRequestBudget(budget, scope.jobId, () =>
            second.withCheckpointGroup('list', scope.authorId, undefined, () =>
              second.list(scope.authorId, null),
            ),
          ),
      ),
    ).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(count);
    second.onModuleDestroy();
  }, 40000);
  it('stops after an actual synthetic refusal and blocks restart and other grants', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document);
    job.sourceGrant.phases = ['list'];
    job.sourceGrant.limits = { list: 2, profile: 2 };
    job.sourceGrant.used = { list: 0, profile: 0 };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES('xhs:source-total',20,0,0,0)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},20,0,0,0)`;
    const api = jest.fn(async (request: any) => ({
      status: 461,
      url: request.url,
      body: {},
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: (raw: any) => raw.author,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const budget = new XhsRequestBudget(new XhsSqliteBudgetStore(db as any));
    await expect(
      runtime.withWholeAuthorization(
        {
          jobId: scope.jobId,
          creatorId: scope.creatorId,
          authorId: scope.authorId,
        },
        () =>
          runtime.withRequestBudget(budget, scope.jobId, () =>
            runtime.withCheckpointGroup('list', scope.authorId, undefined, () =>
              runtime.list(scope.authorId, null),
            ),
          ),
      ),
    ).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    const pending = await db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:whole:%'`;
    expect(pending).toHaveLength(1);
    const whole = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await whole.onModuleInit();
    await expect(whole.resume(scope.jobId)).rejects.toThrow(
      'XHS_WHOLE_SOURCE_FENCE_BLOCKED',
    );
    await expect(
      whole.prepareHistoryGrant({
        creatorId: scope.creatorId,
        expectedAuthorId: scope.authorId,
        requestLimit: 20,
        intervalMs: 1000,
        phaseLimits: { profile: 1, list: 1, detail: 1, media: 1, metrics: 1 },
      }),
    ).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  }, 40000);
  it('still rejects an unauthorized source phase after an old limit is exceeded', async () => {
    const rows = await db.$queryRaw<Array<{ document: string }>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document);
    job.sourceGrant.phases = ['list'];
    job.sourceGrant.limits = { list: 1 };
    job.sourceGrant.used = { list: 2 };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await expect(db.$transaction(tx => prepareWholeSourceFence(tx, {...scope,phase:'profile',noteId:undefined}))).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    expect(await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`).toHaveLength(0);
  });
  it('keeps an uncommitted multi-request group fenced after exceeding the historical phase count', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document);
    job.sourceGrant.phases = ['list'];
    job.sourceGrant.limits = { list: 1, profile: 1 };
    job.sourceGrant.used = { list: 0, profile: 0 };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES('xhs:source-total',20,0,0,0)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used,next_at) VALUES(${scope.jobId},20,0,0,0)`;
    const author = {
      id: scope.authorId,
      name: 'Synthetic',
      profileUrl: 'https://www.xiaohongshu.com/user/profile/' + scope.authorId,
    };
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: {
        success: true,
        code: 0,
        data: new URL(request.url).pathname.endsWith('otherinfo')
          ? { author }
          : { notes: [], has_more: false, cursor: '' },
      },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: (raw: any) => raw.author,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const budget = new XhsRequestBudget(new XhsSqliteBudgetStore(db as any));
    await expect(
      runtime.withWholeAuthorization(
        {
          jobId: scope.jobId,
          creatorId: scope.creatorId,
          authorId: scope.authorId,
        },
        () =>
          runtime.withRequestBudget(budget, scope.jobId, () =>
            runtime.withCheckpointGroup(
              'list',
              scope.authorId,
              undefined,
              async () => {
                await runtime.list(scope.authorId, null);
                await runtime.list(scope.authorId, null);
              },
            ),
          ),
      ),
    ).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(3);
    const ledger = await db.$queryRaw<
      Array<{ used: number }>
    >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
    expect(ledger[0].used).toBe(3);
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:whole:%'`,
    ).toHaveLength(1);
    runtime.onModuleDestroy();
  }, 40000);
  it('retains the dispatched fence across a failed business checkpoint and removes it atomically after success', async () => {
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    await db.$transaction((tx) =>
      markWholeSourceStarted(tx, scope.jobId, marker, scope.owner),
    );
    await expect(
      db.$transaction(async (tx) => {
        await commitWholeSourceCheckpoint(tx, scope.jobId, marker, scope.owner);
        throw Error('synthetic rollback');
      }),
    ).rejects.toThrow();
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(1);
    const reopened = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(folder, 'test.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    try {
      await expect(
        reopened.$transaction((tx) => prepareWholeSourceFence(tx, scope)),
      ).rejects.toThrow();
    } finally {
      await reopened.$disconnect();
    }
    await db.$transaction((tx) =>
      commitWholeSourceCheckpoint(tx, scope.jobId, marker, scope.owner),
    );
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(0);
  }, 40000);
  it('commits metrics coverage and fence release together and preserves them against stale saves', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const job = JSON.parse(rows[0].document),
      key = JSON.stringify(['xiaohongshu', 'note', scope.noteId]);
    job.sourceGrant.phases = ['metrics'];
    job.sourceGrant.limits = { metrics: 1 };
    job.sourceGrant.used = { metrics: 0 };
    job.items = { [key]: {} };
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId}`;
    const metricScope = { ...scope, phase: 'metrics' as const };
    await db.$transaction((tx) => prepareWholeSourceFence(tx, metricScope));
    await db.$transaction((tx) =>
      markWholeSourceStarted(tx, scope.jobId, marker, scope.owner),
    );
    await expect(
      db.$transaction(async (tx) => {
        await commitWholeSourceCheckpoint(tx, scope.jobId, marker, scope.owner, 1234);
        throw Error('synthetic rollback');
      }),
    ).rejects.toThrow();
    const before = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    expect(JSON.parse(before[0].document).items[key].metrics).toBeUndefined();
    await db.$transaction((tx) =>
      commitWholeSourceCheckpoint(tx, scope.jobId, marker, scope.owner, 1234),
    );
    const whole = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await (whole as any).save(job);
    const after = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    expect(JSON.parse(after[0].document).items[key].metrics).toBe(1234);
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(0);
  });
  it('keeps the in-flight fence when cancellation commits before the checkpoint', async () => {
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    await db.$transaction((tx) =>
      markWholeSourceStarted(tx, scope.jobId, marker, scope.owner),
    );
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='cancelled',document=json_set(document,'$.state','cancelled') WHERE id=${scope.jobId}`;
    await expect(
      db.$transaction((tx) =>
        commitWholeSourceCheckpoint(tx, scope.jobId, marker, scope.owner),
      ),
    ).rejects.toThrow();
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(1);
  });
  it('keeps the durable fence and stage budget when a stale job snapshot is saved', async () => {
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const stale = JSON.parse(rows[0].document);
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    await db.$transaction((tx) =>
      markWholeSourceStarted(tx, scope.jobId, marker, scope.owner),
    );
    const whole = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await (whole as any).save(stale);
    const saved = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${scope.jobId}`;
    const doc = JSON.parse(saved[0].document);
    expect(doc.sourceFence).toMatchObject({ marker, state: 'started' });
    expect(doc.sourceGrant.used.detail).toBe(1);
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(1);
  });
  it('releases only a proven pre-dispatch cancellation and never releases a started attempt', async () => {
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    await db.$transaction((tx) =>
      releasePreparedWholeSourceFence(tx, scope.jobId, marker, scope.owner),
    );
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(0);
    await db.$transaction((tx) => prepareWholeSourceFence(tx, scope));
    await db.$transaction((tx) =>
      markWholeSourceStarted(tx, scope.jobId, marker, scope.owner),
    );
    await expect(
      db.$transaction((tx) =>
        releasePreparedWholeSourceFence(tx, scope.jobId, marker, scope.owner),
      ),
    ).rejects.toThrow();
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(1);
  });
  it('admits at most one concurrent grant group for the same creator', async () => {
    const another = {
      ...scope,
      marker: 'xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000002',
    };
    const results = await Promise.allSettled([
      db.$transaction((tx) => prepareWholeSourceFence(tx, scope)),
      db.$transaction((tx) => prepareWholeSourceFence(tx, another)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:whole:%'`,
    ).toHaveLength(1);
  }, 40000);
  it('rejects unrelated identities, phases and confirmed blocks before preparing a fence', async () => {
    await expect(
      db.$transaction((tx) =>
        prepareWholeSourceFence(tx, { ...scope, authorId: 'other' }),
      ),
    ).rejects.toThrow();
    await expect(
      db.$transaction((tx) =>
        prepareWholeSourceFence(tx, { ...scope, phase: 'list' }),
      ),
    ).rejects.toThrow();
    await db.$executeRaw`UPDATE xhs_source_risk SET code='XHS_SOURCE_VERIFICATION_BLOCKED' WHERE id='source'`;
    await expect(
      db.$transaction((tx) => prepareWholeSourceFence(tx, scope)),
    ).rejects.toThrow();
    expect(
      await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id=${marker}`,
    ).toHaveLength(0);
  });
});
