import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XiaohongshuBatches } from './xiaohongshu-batches';
import { scheduledTaskId } from './xhs-scheduled-admission';
import {
  FULL_HISTORY_KIND,
  fullHistoryContext,
} from './xhs-full-history-scope';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
  assertScheduledRoundAdmission,
  assertScheduledDispatch,
} from './xhs-scheduled-review-scope';
import { assertUnboundDispatch } from './xhs-unbound-round';
import { parseXhsProfile } from './xhs-profile';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { readLegacyXhsSourceFence } from './xhs-legacy-source-fence';
import { ChannelTaskHistory } from './channel-task-history';
import { parsePersistentCreatorBatch } from '../../../web/src/utils/xiaohongshu-refresh';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';

// Real Prisma, production migrations, admission, protected writes, recurring
// review, batch/task orchestration and runtime. Only the source is synthetic.
// No production URL/config is read; the process-level network guard denies I/O.
describe('manual batch recurring list review (isolated Prisma)', () => {
  jest.setTimeout(60000);
  let db: PrismaClient, dir: string, runtime: XhsSubscriptionRuntime;
  let service: XhsSubscriptionService, batch: XiaohongshuBatches;
  let api: jest.Mock, batchId: string, oldDocument: string;
  let historical: unknown, release: (() => void) | undefined;
  const ids = ['batch-a', 'batch-b', 'batch-c'];
  const authors = Object.fromEntries(ids.map((id) => [id, 'author-' + id]));
  const now = 1794787200000n; // millisecond INTEGER approval shape
  const reviewIds = ['1', '2', '3'].map((x) => 'unbound-' + x.repeat(64));
  const sha = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const oldOperation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const snapshot = () =>
    Promise.all([
      db.$queryRawUnsafe(
        'SELECT id,plan_digest,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,CAST(approved_at AS TEXT) AS approved_at FROM xhs_unbound_owner_reviews WHERE id IN (?,?,?) ORDER BY id',
        ...reviewIds,
      ),
      db.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests WHERE operation_id=?',
        oldOperation,
      ),
      db.$queryRawUnsafe(
        "SELECT * FROM xhs_request_budgets WHERE id='xhs:dispatch-pending:old-detail'",
      ),
      db.$queryRawUnsafe(
        "SELECT * FROM xhs_subscription_tasks WHERE id='old-task'",
      ),
    ]);
  const operation = () => scheduledTaskId('batch/' + batchId, ids[0], 'basic');
  const waitForLane = () => (service as any)?.lane as Promise<void>;
  function holdLane() {
    (service as any).lane = new Promise<void>((resolve) => {
      release = resolve;
    });
  }
  async function stoppedUnsentTask(withLegacyStop = true) {
    jest
      .spyOn(service as any, 'prepareScheduledContext')
      .mockRejectedValue(
        new XhsSubscriptionError('XHS_ACCESS_CONTEXT_EXPIRED'),
      );
    const id = batchId,
      taskId = operation();
    await batch.advance(id);
    await waitForLane();
    await batch.advance(id);
    // Observed deployed shape carries retained exclusions even when no source
    // operation started. Keep them verbatim; they are not dispatched note IDs.
    const [row] = await db.$queryRawUnsafe<any[]>(
      'SELECT document FROM xhs_subscription_tasks WHERE id=?',
      taskId,
    );
    const saved = JSON.parse(row.document);
    saved.historyExcludedIds = [
      'retained-note-a',
      'retained-note-b',
      'retained-note-c',
    ];
    await db.$executeRawUnsafe(
      'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
      JSON.stringify(saved),
      taskId,
    );
    await batch.stop(id);
    if (withLegacyStop)
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_refresh_jobs(creator_id,generation,owner,started_at,state,outcome) VALUES(?,1,?,?,'stopped',NULL)",
        ids[0],
        taskId,
        BigInt(Date.now()),
      );
    return { id, taskId };
  }
  function localSettler() {
    const backup = jest.fn(async () => {
      const { DatabaseSync } = createRequire(__filename)('node:sqlite');
      const source = path.join(dir, 'fixture.sqlite');
      const target = path.join(dir, randomUUID() + '.sqlite');
      const connection = new DatabaseSync(source, { readOnly: true });
      try {
        connection.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
      } finally {
        connection.close();
      }
      const copied = new DatabaseSync(target, { readOnly: true });
      const integrityCheck = copied
        .prepare('PRAGMA integrity_check')
        .get().integrity_check;
      copied.close();
      const bytes = await import('node:fs/promises').then((fs) =>
        fs.readFile(target),
      );
      return {
        source,
        backup: target,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrityCheck,
        recoveryOrigin: {
          format: 'sqlite-recovery-origin-v1',
          kind: 'protected',
        },
      };
    });
    return { backup, settle: new XiaohongshuBatches(db, service, backup) };
  }
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'xhs-batch-review-'));
    const url = 'file:' + path.join(dir, 'fixture.sqlite').replace(/\\/g, '/');
    await applyFixtureMigrations(url);
    db = new PrismaClient({ datasources: { db: { url } } });
    for (const id of ids)
      await db.xhsCreator.create({
        data: {
          id,
          externalAuthorId: authors[id],
          displayName: id,
          profileUrl: 'https://www.xiaohongshu.com/user/profile/' + authors[id],
        },
      });
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',0,100,0,1000),('xhs:dispatch-pending:old-detail',1,1,0,1000)",
    );
    oldDocument = JSON.stringify({
      taskId: 'old-task',
      creatorId: ids[1],
      kind: 'list',
      state: 'blocked',
      code: 'XHS_SOURCE_TRANSPORT_BLOCKED',
      sourceActive: {
        phase: 'detail',
        outcome: 'started',
        targetHash: sha('old-note'),
        cursorHash: sha(''),
        owner: oldOperation,
      },
      sourceUnknowns: [
        { phase: 'detail', outcome: 'unknown', targetHash: sha('old-note') },
      ],
    });
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES('old-task',?,'blocked',?,?)",
      ids[1],
      oldDocument,
      now - 10n,
    );
    const scope = {
      reviewKind: FULL_HISTORY_KIND,
      bindings: ids.map((creatorId) => ({
        creatorId,
        jobId: 'old-job-' + creatorId,
      })),
      maxRequests: 1,
      phaseLimits: { profile: 1, list: 1, detail: 1, media: 1 },
      exclusions: { [ids[1]]: [{ phase: 'detail', target: 'old-note' }] },
    };
    for (const [index, id] of reviewIds.entries()) {
      const evidence =
        index === 0
          ? scope
          : {
              ...scope,
              authorizationRootReviewId: reviewIds[0],
              lineageReviewIds: reviewIds.slice(0, index),
              narrowedCreatorId: ids[index],
              narrowing: 'parent-receipt-marker-phase-identity',
            };
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id,
        sha('synthetic-' + id),
        '{}',
        'unknown',
        '[]',
        '[]',
        JSON.stringify(authors),
        '[]',
        JSON.stringify(evidence),
        'a'.repeat(64),
        now + BigInt(index),
      );
    }
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,?)',
      oldOperation,
      reviewIds[0],
      'old-task',
      ids[1],
      'detail',
      'old-note',
      'unknown',
      null,
    );
    const input = {
      creatorIds: ids,
      maxRequests: 20,
      phaseLimits: { profile: 3, list: 3, detail: 10, media: 10 },
    };
    await db.$transaction(async (tx) => {
      const plan = await prepareScheduledPolicy(tx, input);
      expect(plan.scope.retainedHistoryEvidence).toHaveLength(3);
      await confirmScheduledPolicy(
        tx,
        input,
        plan.digest,
        {
          assertQuiescent: async () => {},
          verifyBackup: async () => 'b'.repeat(64),
        },
        now + 3n,
      );
    });
    historical = await snapshot();
    api = jest.fn(async (request: any) => {
      const u = new URL(request.url);
      if (u.pathname.endsWith('/user/otherinfo')) {
        const authorId = u.searchParams.get('target_user_id')!;
        return {
          status: 200,
          url: request.url,
          body: {
            success: true,
            code: 0,
            data: {
              result: { success: true, code: 0 },
              basic_info: {
                user_id: authorId,
                nickname: 'Synthetic author',
                red_id: 'synthetic',
              },
              interactions: [],
            },
          },
        };
      }
      const authorId = u.searchParams.get('user_id')!;
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: {
            notes: [
              {
                note_id: 'new-' + authorId,
                user: { user_id: authorId },
                display_title: 'Synthetic new note',
                xsec_token: 'synthetic-token',
              },
            ],
            has_more: false,
            cursor: '',
          },
        },
      };
    });
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      profileParser: parseXhsProfile,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    service = new XhsSubscriptionService(db as any, runtime);
    // Use the production full-history writer and candidate-aware legacy guard.
    new XhsWholeCreatorService(db as any, service, runtime, {} as any);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    // Deliberately cold: no test-only injection of the private author map.
    batch = new XiaohongshuBatches(db, service);
    batchId = randomUUID();
    await batch.create(batchId, ids);
  });
  afterEach(async () => {
    release?.();
    release = undefined;
    await waitForLane();
    runtime?.onModuleDestroy();
    await db.$disconnect();
    // dir is the exact directory returned by mkdtemp for this test.
    await rm(dir, { recursive: true, force: true });
  });
  it('rebuilds cold list-only contexts through real review, preserving unknowns byte-for-byte', async () => {
    await expect(assertUnboundDispatch(db)).rejects.toThrow(
      'APPROVED_NEW_ROUND_REQUIRED',
    );
    for (const creatorId of ids) {
      await batch.advance(batchId);
      await waitForLane();
      await batch.advance(batchId);
      const [saved] = await db.$queryRawUnsafe<any[]>(
        'SELECT document FROM xhs_subscription_tasks WHERE id=?',
        scheduledTaskId('batch/' + batchId, creatorId, 'basic'),
      );
      expect(JSON.parse(saved.document)).toMatchObject({ state: 'completed' });
      expect(await db.xhsNote.count({ where: { creatorId } })).toBe(1);
    }
    expect((await batch.status(batchId)).state).toBe('complete');
    expect(api).toHaveBeenCalledTimes(6);
    expect(
      api.mock.calls.every(([request]) =>
        /\/(?:user_posted|user\/otherinfo)$/.test(
          new URL(request.url).pathname,
        ),
      ),
    ).toBe(true);
    const tasks = await db.$queryRawUnsafe<any[]>(
      "SELECT document FROM xhs_subscription_tasks WHERE id<>'old-task'",
    );
    expect(tasks).toHaveLength(3);
    for (const task of tasks)
      expect(JSON.parse(task.document)).toMatchObject({
        kind: 'list',
        state: 'completed',
        scheduledContext: { used: 1, state: 'confirmed' },
      });
    expect(
      tasks.every((task) => !JSON.parse(task.document).collectDetails),
    ).toBe(true);
    const ledger = await db.$queryRawUnsafe<any[]>(
      'SELECT phase,outcome FROM xhs_unbound_owner_requests WHERE operation_id<>?',
      oldOperation,
    );
    expect(ledger).toHaveLength(6);
    expect(
      ledger.every(
        (x) =>
          ['profile', 'list'].includes(x.phase) &&
          x.outcome === 'response-received',
      ),
    ).toBe(true);
    expect(await snapshot()).toEqual(historical);
    await batch.advance(batchId);
    await service.startBatchItem({ batchId, position: 0, creatorId: ids[0] });
    expect(api).toHaveBeenCalledTimes(6);
  });
  it('one selected account is a paginated list task, not a single-page or detail/media collection', async () => {
    await batch.stop(batchId);
    batchId = randomUUID();
    const creatorId = ids[2];
    const baseApi = api.getMockImplementation()!;
    let pages = 0;
    api.mockImplementation(async (request: any) => {
      const result = await baseApi(request);
      if (new URL(request.url).pathname.endsWith('/user_posted')) {
        pages++;
        result.body.data.has_more = pages === 1;
        result.body.data.cursor = pages === 1 ? 'synthetic-next-page' : '';
        if (pages === 2)
          result.body.data.notes.push({
            ...result.body.data.notes[0],
            note_id: 'second-' + authors[creatorId],
          });
      }
      return result;
    });
    await batch.create(batchId, [creatorId]);
    await batch.advance(batchId);
    await waitForLane();
    await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('complete');
    expect(pages).toBe(2);
    expect(api).toHaveBeenCalledTimes(3); // one author context + two list pages
    expect(
      api.mock.calls.every(([r]) => {
        const u = new URL(r.url);
        return (
          /\/(?:user_posted|user\/otherinfo)$/.test(u.pathname) &&
          (u.searchParams.get('user_id') ??
            u.searchParams.get('target_user_id')) === authors[creatorId]
        );
      }),
    ).toBe(true);
    expect(await db.xhsNote.count({ where: { creatorId } })).toBe(2); // duplicate on page two saved once
    expect(
      await db.xhsNote.count({ where: { creatorId: { not: creatorId } } }),
    ).toBe(0);
    const [saved] = await db.$queryRawUnsafe<any[]>(
      'SELECT document FROM xhs_subscription_tasks WHERE id=?',
      scheduledTaskId('batch/' + batchId, creatorId, 'basic'),
    );
    expect(JSON.parse(saved.document)).toMatchObject({
      kind: 'list',
      state: 'completed',
    });
    expect(JSON.parse(saved.document).collectDetails).not.toBe(true);
    expect(await snapshot()).toEqual(historical);
    await batch.advance(batchId);
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('excludes an entire retained-unknown account from an exact two-member cold batch', async () => {
    await batch.stop(batchId);
    batchId = randomUUID();
    const selected = [ids[0], ids[2]];
    await batch.create(batchId, selected);
    for (let remaining = selected.length; remaining > 0; remaining--) {
      await batch.advance(batchId);
      await waitForLane();
      await batch.advance(batchId);
    }
    expect((await batch.status(batchId)).state).toBe('complete');
    expect(api).toHaveBeenCalledTimes(4);
    expect(
      api.mock.calls.every(([r]) => {
        const u = new URL(r.url);
        return [authors[ids[0]], authors[ids[2]]].includes(
          u.searchParams.get('target_user_id') ??
            u.searchParams.get('user_id')!,
        );
      }),
    ).toBe(true);
    expect(await snapshot()).toEqual(historical);
    expect(await db.xhsNote.count({ where: { creatorId: ids[1] } })).toBe(0);
  });
  it('ordinary stop does not manufacture a legacy request for an unsent scheduled task', async () => {
    const old = await stoppedUnsentTask(false);
    expect(
      await db.$queryRawUnsafe(
        'SELECT owner FROM xhs_refresh_jobs WHERE owner=?',
        old.taskId,
      ),
    ).toEqual([]);
    expect(api).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(historical);
  });
  it('permits only authenticated local settlement while eight queued WeChat items and all source work remain held', async () => {
    const old = await stoppedUnsentTask();
    const original = { ...process.env };
    const priorAudit = (globalThis as any).__weweStartupAudit;
    let trpc: TrpcService | undefined;
    const wxSource = jest
      .fn()
      .mockRejectedValue(new Error('unexpected source'));
    const database = path.join(dir, 'fixture.sqlite');
    const producer = new Wechat2RssSubscriptionBatches(
      () => database,
      () => 'synthetic-instance',
      wxSource,
      wxSource,
      wxSource,
    );
    producer.attachRefresh(wxSource);
    const wx = await producer.enqueueRefresh(
      Array.from({ length: 8 }, (_, i) => 'MP_WXS_' + (1234500000 + i)),
      'e'.repeat(64),
      'scheduled-refresh',
    );
    producer.close();
    const file = path.join(
      dir,
      '.wechat2rss-subscription-batches',
      wx.batchId + '.json',
    );
    const pending = JSON.parse(await readFile(file, 'utf8'));
    pending.state = 'running';
    await writeFile(file, JSON.stringify(pending));
    const originalWx = await readFile(file);
    const { settle, backup } = localSettler();
    try {
      Object.assign(process.env, {
        NODE_ENV: 'production',
        PRIVATE_ONLINE_MODE: '0',
        WEWE_ACCEPTANCE_MODE: '0',
        WECHAT2RSS_RECOVERY_HOLD: '1',
      });
      const config = {
        get: (key: string) =>
          key === 'platform' ? { url: '' } : { updateDelayTime: 0 },
      } as any;
      trpc = new TrpcService(db as any, config, {} as any, {} as any);
      const router = new TrpcRouter(
        trpc,
        db as any,
        config,
        {} as any,
        {} as any,
        undefined,
        service,
        runtime,
      );
      jest.spyOn(router as any, 'xhsBatches', 'get').mockReturnValue(settle);
      // The real startup hooks and worker retain the original hold; allowing a
      // local procedure never toggles it or starts a consumer/timer.
      await trpc.onModuleInit();
      const held = (trpc as any).subscriptionBatches;
      await held.runDue();
      expect(held.timer).toBeUndefined();
      const ctx = { errorMsg: null, isLocalSave: true, isLocalXhsRead: true };
      const caller = router.appRouter.createCaller(ctx);
      const input = { batchId: old.id };
      const plan =
        await caller.xiaohongshu.prepareRefreshBatchLocalCancellation(input);
      const confirm = {
        ...input,
        digest: plan.digest,
        acknowledgedNotDispatched: true as const,
      };
      await expect(
        router.appRouter
          .createCaller({ ...ctx, errorMsg: 'bad auth' })
          .xiaohongshu.prepareRefreshBatchLocalCancellation(input),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(
        router.appRouter
          .createCaller({
            errorMsg: null,
            isLocalSave: false,
            isLocalXhsRead: false,
          })
          .xiaohongshu.prepareRefreshBatchLocalCancellation(input),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(
        router.appRouter
          .createCaller({
            errorMsg: null,
            isLocalSave: false,
            isLocalXhsRead: true,
          })
          .xiaohongshu.confirmRefreshBatchLocalCancellation(confirm),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(
        caller.xiaohongshu.confirmRefreshBatchLocalCancellation({
          ...confirm,
          acknowledgedNotDispatched: false,
        } as any),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.xiaohongshu.prepareRefreshBatchLocalCancellation({
          ...input,
          extra: true,
        } as any),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.xiaohongshu.advanceRefreshBatch(input),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(caller.xiaohongshu.restoreSession()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      (globalThis as any).__weweStartupAudit = {
        status: 'failed',
        reason: 'fixture-write-hold',
      };
      await expect(
        caller.xiaohongshu.confirmRefreshBatchLocalCancellation(confirm),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      (globalThis as any).__weweStartupAudit = priorAudit;
      expect(backup).not.toHaveBeenCalled();
      backup.mockResolvedValueOnce(undefined as any); // Deliberately invalid external backup report.
      await expect(
        caller.xiaohongshu.confirmRefreshBatchLocalCancellation(confirm),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((await batch.status(old.id)).items[0]).toMatchObject({
        state: 'reserved',
        outcome: null,
      });
      const result =
        await caller.xiaohongshu.confirmRefreshBatchLocalCancellation(confirm);
      expect(result.batch.items.every((i) => i.state === 'cancelled')).toBe(
        true,
      );
      expect((await caller.xiaohongshu.refreshBatchStatus(input)).state).toBe(
        'stopped',
      );
      expect(
        (await caller.xiaohongshu.connectionStatus()).requestAttempts,
      ).toMatchObject({ profiles: 0, lists: 0, details: 0, media: 0 });
      await held.runDue();
      expect(await readFile(file)).toEqual(originalWx);
      expect(
        JSON.parse((await readFile(file)).toString()).items.filter(
          (i) => i.state === 'queued',
        ),
      ).toHaveLength(8);
      expect(wxSource).not.toHaveBeenCalled();
      expect(api).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(historical);
      expect(process.env.WECHAT2RSS_RECOVERY_HOLD).toBe('1');
    } finally {
      trpc?.onModuleDestroy();
      producer.close();
      process.env = original;
      (globalThis as any).__weweStartupAudit = priorAudit;
    }
  });
  it('audits the exact stopped prepare failure, then the admission-only successor, preserving legacy rows and unknowns', async () => {
    const old = await stoppedUnsentTask();
    const legacy = await db.$queryRawUnsafe(
      'SELECT * FROM xhs_refresh_jobs ORDER BY owner',
    );
    batchId = randomUUID();
    await batch.create(batchId, [ids[0], ids[2]]);
    await batch.advance(batchId);
    const next = (await batch.status(batchId)).items[0].operationId!;
    expect((await service.task({ taskId: next })).code).toBe(
      'XHS_SCHEDULE_SOURCE_BLOCKED',
    );
    const { settle, backup } = localSettler();
    await expect(
      settle.prepareLocalCancellation(batchId),
    ).rejects.toBeDefined();
    const plan = await settle.prepareLocalCancellation(old.id);
    const done = await settle.confirmLocalCancellation({
      batchId: old.id,
      digest: plan.digest,
      acknowledgedNotDispatched: true,
    });
    expect((done.batch.items[0].outcome as any).scheduledProof).toMatchObject({
      kind: 'scheduled-list-prepare-v1',
      legacyStop: { owner: old.taskId, state: 'stopped', outcome: null },
    });
    expect(parsePersistentCreatorBatch(done.batch).state).toBe('stopped');
    const tampered = JSON.parse(JSON.stringify(done.batch));
    tampered.items[0].outcome.scheduledProof.legacyStop.owner = randomUUID();
    expect(() => parsePersistentCreatorBatch(tampered)).toThrow();
    const repeat = await settle.confirmLocalCancellation({
      batchId: old.id,
      digest: plan.digest,
      acknowledgedNotDispatched: true,
    });
    expect(repeat.alreadyCancelled).toBe(true);
    expect(backup).toHaveBeenCalledTimes(1);
    const newer = await settle.prepareLocalCancellation(batchId);
    const second = await settle.confirmLocalCancellation({
      batchId,
      digest: newer.digest,
      acknowledgedNotDispatched: true,
    });
    expect((second.batch.items[0].outcome as any).scheduledProof.kind).toBe(
      'scheduled-list-admission-v1',
    );
    expect(second.batch.items.every((i) => i.state === 'cancelled')).toBe(true);
    expect(parsePersistentCreatorBatch(second.batch).state).toBe('stopped');
    expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'clear' });
    expect(
      await db.$queryRawUnsafe('SELECT * FROM xhs_refresh_jobs ORDER BY owner'),
    ).toEqual(legacy);
    await expect(
      service.resumeTask({ taskId: old.taskId }),
    ).rejects.toMatchObject({ code: 'XHS_TASK_NOT_RESUMABLE' });
    await expect(service.resumeTask({ taskId: next })).rejects.toMatchObject({
      code: 'XHS_TASK_NOT_RESUMABLE',
    });
    expect(await snapshot()).toEqual(historical);
    expect(api).not.toHaveBeenCalled();
    // Settlement itself sends nothing. A separately admitted, explicit new
    // two-account batch can then use the normal source lane, without replaying.
    (service as any).prepareScheduledContext.mockRestore();
    const fresh = randomUUID();
    await batch.create(fresh, [ids[0], ids[2]]);
    for (let remaining = 2; remaining > 0; remaining--) {
      await batch.advance(fresh);
      await waitForLane();
      await batch.advance(fresh);
    }
    expect((await batch.status(fresh)).state).toBe('complete');
    expect(api).toHaveBeenCalledTimes(4);
    expect(await snapshot()).toEqual(historical);
  });
  it('settles a fully observed list with a retained history omission without sending it again', async () => {
    await batch.stop(batchId);
    const { backup } = localSettler();
    const history = new ChannelTaskHistory(
      db,
      () => path.join(dir, 'fixture.sqlite'),
      backup,
      () => {},
    );
    const preview = (action: 'archive' | 'pause' | 'resume') =>
      history.preview('xiaohongshu', action);
    const confirm = (p: Awaited<ReturnType<typeof preview>>) =>
      history.confirm({
        channel: 'xiaohongshu',
        action: p.action,
        digest: p.digest,
        acknowledged: true,
      });
    await confirm(await preview('archive'));
    await confirm(await preview('resume'));
    backup.mockClear();
    await db.xhsNote.create({
      data: {
        id: JSON.stringify(['xiaohongshu', authors[ids[1]], 'old-note']),
        creatorId: ids[1],
        title: 'Retained old note',
        publishTime: 1,
        status: 'listed',
      },
    });
    const id = randomUUID();
    await batch.create(id, [ids[1]]);
    await batch.advance(id);
    await waitForLane();
    const reserved = (await batch.status(id)).items[0];
    const terminal = await service.task({ taskId: reserved.operationId! });
    expect(terminal).toMatchObject({
      state: 'partial',
      code: 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED',
      failed: 0,
      remaining: 0,
    });
    const calls = api.mock.calls.length;
    expect(calls).toBe(2);
    await expect(confirm(await preview('pause'))).resolves.toMatchObject({
      paused: true,
    });
    await expect(batch.advance(id)).rejects.toThrow('CHANNEL_PAUSED');
    const reviewed = await preview('resume');
    await db.$executeRaw`INSERT INTO xhs_refresh_batch_items(batch_id,position,creator_id,state) VALUES(${id},1,${ids[2]},'queued')`;
    await expect(confirm(await preview('resume'))).rejects.toThrow(
      'CHANNEL_ACTIVE_HISTORY_REVIEW_REQUIRED',
    );
    await db.$executeRaw`DELETE FROM xhs_refresh_batch_items WHERE batch_id=${id} AND position=1`;
    await db.$executeRaw`UPDATE xhs_unbound_owner_requests SET outcome='unknown' WHERE task_id=${reserved.operationId} AND phase='profile'`;
    await expect(confirm(reviewed)).rejects.toThrow('CHANNEL_PREVIEW_CHANGED');
    await expect(confirm(await preview('resume'))).rejects.toThrow(
      'CHANNEL_ACTIVE_HISTORY_REVIEW_REQUIRED',
    );
    expect(backup).toHaveBeenCalledTimes(1);
    await db.$executeRaw`UPDATE xhs_unbound_owner_requests SET outcome='response-received' WHERE task_id=${reserved.operationId} AND phase='profile'`;
    await expect(confirm(await preview('resume'))).resolves.toMatchObject({
      paused: false,
    });
    expect(backup).toHaveBeenCalledTimes(2);
    expect((await readLegacyXhsSourceFence(db)).state).toBe('blocked');
    expect(api).toHaveBeenCalledTimes(calls);
    const result = await batch.advance(id);
    expect(result.state).toBe('complete');
    expect(result.items[0]).toMatchObject({
      state: 'partial',
      outcome: { status: 'partial', historyExcludedCount: 1 },
    });
    expect(await batch.advance(id)).toEqual(result);
    expect(api).toHaveBeenCalledTimes(calls);
    expect(await snapshot()).toEqual(historical);
    expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'clear' });
    await db.$executeRaw`UPDATE xhs_unbound_owner_requests SET outcome='unknown' WHERE task_id=${reserved.operationId} AND phase='profile'`;
    expect((await readLegacyXhsSourceFence(db)).state).toBe('blocked');
  });
  it('serializes repeated confirmations of a stopped scheduled item without a second backup or source call', async () => {
    const old = await stoppedUnsentTask();
    const { settle, backup } = localSettler();
    const p = await settle.prepareLocalCancellation(old.id);
    const results = await Promise.all(
      [1, 2].map(() =>
        settle.confirmLocalCancellation({
          batchId: old.id,
          digest: p.digest,
          acknowledgedNotDispatched: true,
        }),
      ),
    );
    expect(results.filter((r) => r.alreadyCancelled)).toHaveLength(1);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(historical);
  });
  it.each([
    'dispatched',
    'phase',
    'missing-proof',
    'budget',
    'stop',
    'binding',
    'running',
    'unknown',
    'active',
    'noncanonical',
    'duplicate-exclusions',
    'invalid-exclusions',
  ])('rejects unproven scheduled cancellation: %s', async (bad) => {
    const old = await stoppedUnsentTask();
    const { settle, backup } = localSettler();
    if (bad === 'budget')
      await db.$executeRawUnsafe(
        'UPDATE xhs_request_budgets SET used=1 WHERE instr(id,?)>0',
        old.taskId,
      );
    else if (bad === 'stop')
      await db.$executeRawUnsafe(
        "UPDATE xhs_refresh_jobs SET state='running' WHERE owner=?",
        old.taskId,
      );
    else {
      const [r] = await db.$queryRawUnsafe<any[]>(
        'SELECT document FROM xhs_subscription_tasks WHERE id=?',
        old.taskId,
      );
      const d = JSON.parse(r.document);
      if (bad === 'dispatched') d.taskFailure.dispatched = true;
      if (bad === 'phase') d.taskFailure.phase = 'unknown';
      if (bad === 'missing-proof') delete d.taskFailure;
      if (bad === 'binding') d.schedule.round = 'batch/' + randomUUID();
      if (bad === 'running') d.state = 'running';
      if (bad === 'unknown')
        d.sourceUnknowns = [{ phase: 'profile', outcome: 'unknown' }];
      if (bad === 'active')
        d.sourceActive = { phase: 'profile', outcome: 'started' };
      if (bad === 'duplicate-exclusions')
        d.historyExcludedIds = ['retained-note-a', 'retained-note-a'];
      if (bad === 'invalid-exclusions') d.historyExcludedIds = [null];
      await db.$executeRawUnsafe(
        'UPDATE xhs_subscription_tasks SET document=?,state=? WHERE id=?',
        JSON.stringify(d) + (bad === 'noncanonical' ? ' ' : ''),
        d.state,
        old.taskId,
      );
    }
    await expect(settle.prepareLocalCancellation(old.id)).rejects.toBeDefined();
    expect(backup).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });
  it.each([401, 429])(
    'keeps actual source restriction %s during scheduled settlement',
    async (status) => {
      const old = await stoppedUnsentTask();
      const { settle } = localSettler();
      await db.$executeRawUnsafe(
        "UPDATE xhs_source_risk SET state='blocked',code=?,http_status=? WHERE id='source'",
        status === 401
          ? 'XHS_SOURCE_AUTHENTICATION_BLOCKED'
          : 'XHS_SOURCE_RATE_LIMIT_BLOCKED',
        status,
      );
      await expect(
        settle.prepareLocalCancellation(old.id),
      ).rejects.toBeDefined();
      expect(
        await db.$queryRawUnsafe(
          "SELECT state,http_status FROM xhs_source_risk WHERE id='source'",
        ),
      ).toEqual([{ state: 'blocked', http_status: status }]);
      expect(api).not.toHaveBeenCalled();
    },
  );
  it('keeps an audited stop closed after policy revocation and rejects changed stop evidence', async () => {
    const old = await stoppedUnsentTask();
    const { settle } = localSettler();
    const p = await settle.prepareLocalCancellation(old.id);
    await settle.confirmLocalCancellation({
      batchId: old.id,
      digest: p.digest,
      acknowledgedNotDispatched: true,
    });
    const [policy] = await db.$queryRawUnsafe<any[]>(
      "SELECT id FROM xhs_unbound_owner_reviews WHERE json_extract(scope_json,'$.reviewKind')='scheduled-recurring-policy-v1'",
    );
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      'synthetic-revocation',
      'c'.repeat(64),
      '{}',
      'unknown',
      '[]',
      '[]',
      '{}',
      '[]',
      JSON.stringify({
        reviewKind: 'scheduled-recurring-revocation-v1',
        policyId: policy.id,
      }),
      'b'.repeat(64),
      BigInt(Date.now()),
    );
    expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'clear' });
    expect((await settle.prepareLocalCancellation(old.id)).state).toBe(
      'cancelled',
    );
    await db.$executeRawUnsafe(
      'UPDATE xhs_refresh_jobs SET started_at=started_at+1 WHERE owner=?',
      old.taskId,
    );
    expect((await readLegacyXhsSourceFence(db)).state).toBe('blocked');
    expect(api).not.toHaveBeenCalled();
  });
  it('rolls back scheduled audit and job protection atomically when batch settlement fails', async () => {
    const old = await stoppedUnsentTask();
    const { settle } = localSettler();
    await db.$executeRawUnsafe(
      "CREATE TRIGGER settlement_failure BEFORE UPDATE ON xhs_refresh_batches BEGIN SELECT RAISE(ABORT,'synthetic settlement failure'); END",
    );
    const p = await settle.prepareLocalCancellation(old.id);
    await expect(
      settle.confirmLocalCancellation({
        batchId: old.id,
        digest: p.digest,
        acknowledgedNotDispatched: true,
      }),
    ).rejects.toBeDefined();
    expect((await batch.status(old.id)).items[0]).toMatchObject({
      state: 'reserved',
      outcome: null,
    });
    expect(
      (
        await db.$queryRawUnsafe<any[]>(
          'SELECT state,outcome FROM xhs_refresh_jobs WHERE owner=?',
          old.taskId,
        )
      )[0],
    ).toEqual({ state: 'stopped', outcome: null });
    expect(api).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(historical);
  });
  it('stops an author-mismatched rebuild before listing and never retries it', async () => {
    api.mockImplementation(async (r: any) => ({
      status: 200,
      url: r.url,
      body: {
        success: true,
        code: 0,
        data: {
          result: { success: true, code: 0 },
          basic_info: {
            user_id: 'different-author',
            nickname: 'synthetic',
            red_id: 'synthetic',
          },
          interactions: [],
        },
      },
    }));
    await batch.advance(batchId);
    await waitForLane();
    await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('paused');
    await batch.advance(batchId);
    await service.startBatchItem({ batchId, position: 0, creatorId: ids[0] });
    expect(api).toHaveBeenCalledTimes(1);
    expect(new URL(api.mock.calls[0][0].url).pathname).toMatch(
      /\/user\/otherinfo$/,
    );
    expect(await db.xhsNote.count()).toBe(0);
    expect(await snapshot()).toEqual(historical);
  });
  it('preserves a newly unknown profile request and never retries its bound task', async () => {
    api.mockRejectedValueOnce(Error('synthetic interrupted profile transport'));
    await batch.advance(batchId);
    await waitForLane();
    await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('paused');
    const [saved] = await db.$queryRawUnsafe<any[]>(
      'SELECT document FROM xhs_subscription_tasks WHERE id=?',
      operation(),
    );
    expect(JSON.parse(saved.document).scheduledContext).toMatchObject({
      used: 1,
      state: 'started',
    });
    const unknown = await db.$queryRawUnsafe<any[]>(
      'SELECT phase,outcome FROM xhs_unbound_owner_requests WHERE task_id=?',
      operation(),
    );
    expect(unknown).toEqual([{ phase: 'profile', outcome: 'unknown' }]);
    await batch.advance(batchId);
    await service.startBatchItem({ batchId, position: 0, creatorId: ids[0] });
    expect(api).toHaveBeenCalledTimes(1);
    expect(await db.xhsNote.count()).toBe(0);
    expect(await snapshot()).toEqual(historical);
  });
  it('keeps a failed profile-confirmation transaction started and never repeats its source request', async () => {
    await db.$executeRawUnsafe(
      "CREATE TRIGGER context_confirmation_failure BEFORE UPDATE ON xhs_subscription_tasks WHEN json_extract(NEW.document,'$.scheduledContext.state')='confirmed' BEGIN SELECT RAISE(ABORT,'synthetic confirmation failure'); END",
    );
    await batch.advance(batchId);
    await waitForLane();
    await batch.advance(batchId);
    const [saved] = await db.$queryRawUnsafe<any[]>(
      'SELECT document FROM xhs_subscription_tasks WHERE id=?',
      operation(),
    );
    expect(JSON.parse(saved.document).scheduledContext).toMatchObject({
      used: 1,
      state: 'started',
    });
    expect((await batch.status(batchId)).state).toBe('paused');
    await db.$executeRawUnsafe('DROP TRIGGER context_confirmation_failure');
    await batch.advance(batchId);
    await service.startBatchItem({ batchId, position: 0, creatorId: ids[0] });
    expect(api).toHaveBeenCalledTimes(1);
    expect(await db.xhsNote.count()).toBe(0);
    expect(await snapshot()).toEqual(historical);
  });
  it('reuses an existing task with a queued candidate without running it again', async () => {
    const taskId = operation();
    const task = {
      taskId,
      creatorId: ids[0],
      kind: 'list',
      state: 'completed',
      pageLimit: 1,
      noteIds: [],
      items: {},
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
      message: 'old receipt',
      schedule: { round: 'batch/' + batchId, phase: 'basic' },
    };
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES(?,?,'completed',?,?)",
      taskId,
      ids[0],
      JSON.stringify(task),
      now,
    );
    await batch.advance(batchId);
    expect((await batch.status(batchId)).items[0]).toMatchObject({
      state: 'complete',
      operationId: taskId,
    });
    expect(api).not.toHaveBeenCalled();
  });
  it('refuses detail dispatch even under the manual batch review context', async () => {
    holdLane();
    await batch.advance(batchId);
    const [review] = await db.$queryRawUnsafe<any[]>(
      "SELECT id,scope_json FROM xhs_unbound_owner_reviews WHERE json_extract(scope_json,'$.taskBinding.taskId')=?",
      operation(),
    );
    const scope = JSON.parse(review.scope_json);
    const context = {
      reviewId: review.id,
      creatorId: ids[0],
      jobId: operation(),
      authorId: authors[ids[0]],
      sessionBinding: runtime.fullScopeSessionBinding(),
      budgetId: scope.budgetId,
    };
    const request = {
      operationId: randomUUID(),
      creatorId: ids[0],
      taskId: operation(),
      phase: 'detail' as const,
      target: 'old-note',
    };
    await fullHistoryContext.run(context, async () => {
      await expect(
        db.$transaction((tx) =>
          assertScheduledRoundAdmission(tx, review.id, review, request),
        ),
      ).rejects.toThrow('SCHEDULED_PHASE_BINDING_CHANGED');
      await expect(
        db.$transaction((tx) =>
          assertScheduledDispatch(tx, review.id, request),
        ),
      ).rejects.toThrow('SCHEDULED_PHASE_BINDING_CHANGED');
    });
    expect(api).not.toHaveBeenCalled();
  });
  it('rolls back admission when stop wins after review preparation', async () => {
    const prepare = runtime.withScheduledReview.bind(runtime);
    jest
      .spyOn(runtime, 'withScheduledReview')
      .mockImplementation((input, work) =>
        prepare(input, async () => {
          await batch.stop(batchId);
          return work();
        }),
      );
    await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('stopped');
    expect(
      (await batch.status(batchId)).items.every(
        (x) => x.state === 'cancelled' && !x.operationId,
      ),
    ).toBe(true);
    expect(
      await db.$queryRawUnsafe(
        'SELECT id FROM xhs_subscription_tasks WHERE id=?',
        operation(),
      ),
    ).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
  it('rolls back a task insert failure and permits one later local retry', async () => {
    await db.$executeRawUnsafe(
      "CREATE TRIGGER synthetic_insert_failure BEFORE INSERT ON xhs_subscription_tasks BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END",
    );
    await expect(batch.advance(batchId)).rejects.toMatchObject({
      code: 'XHS_LOCAL_OPERATION_FAILED',
    });
    expect((await batch.status(batchId)).items[0]).toMatchObject({
      state: 'queued',
      operationId: null,
    });
    expect(
      await db.$queryRawUnsafe(
        'SELECT id FROM xhs_subscription_tasks WHERE id=?',
        operation(),
      ),
    ).toEqual([]);
    expect(api).not.toHaveBeenCalled();
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_insert_failure');
    await batch.advance(batchId);
    await waitForLane();
    expect(api).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual(historical);
  });
  it('rolls back reservation and blocked task if pausing the batch fails', async () => {
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_RATE_LIMIT_BLOCKED',http_status=429,endpoint='list' WHERE id='source'",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER synthetic_pause_failure BEFORE UPDATE ON xhs_refresh_batches WHEN NEW.state='paused' BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END",
    );
    await expect(batch.advance(batchId)).rejects.toMatchObject({
      code: 'XHS_LOCAL_OPERATION_FAILED',
    });
    expect((await batch.status(batchId)).items[0]).toMatchObject({
      state: 'queued',
      operationId: null,
    });
    expect(
      await db.$queryRawUnsafe(
        'SELECT id FROM xhs_subscription_tasks WHERE id=?',
        operation(),
      ),
    ).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
  it.each([401, 429])(
    'stops after a real runtime restriction response (%s)',
    async (status) => {
      api.mockImplementation(async (request: any) => ({
        status,
        url: request.url,
        body: { success: false },
      }));
      await batch.advance(batchId);
      await waitForLane();
      await batch.advance(batchId);
      expect((await batch.status(batchId)).state).toBe('paused');
      await batch.advance(batchId);
      expect(api).toHaveBeenCalledTimes(1);
      expect(
        await db.$queryRawUnsafe(
          "SELECT state FROM xhs_source_risk WHERE id='source'",
        ),
      ).toEqual([{ state: 'blocked' }]);
      expect(await snapshot()).toEqual(historical);
    },
  );
  it('rolls back conflicting task binding without reserving or replacing it', async () => {
    const taskId = operation(),
      doc = JSON.stringify({ taskId, creatorId: ids[1], state: 'blocked' });
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES(?,?,'blocked',?,?)",
      taskId,
      ids[1],
      doc,
      now,
    );
    await expect(batch.advance(batchId)).rejects.toBeDefined();
    expect((await batch.status(batchId)).items[0]).toMatchObject({
      state: 'queued',
      operationId: null,
    });
    expect(
      await db.$queryRawUnsafe(
        'SELECT document FROM xhs_subscription_tasks WHERE id=?',
        taskId,
      ),
    ).toEqual([{ document: doc }]);
    expect(api).not.toHaveBeenCalled();
  });
  it('does not dispatch twice when two callers admit the same candidate concurrently', async () => {
    holdLane();
    const input = { batchId, position: 0, creatorId: ids[0] };
    const results = await Promise.allSettled([
      service.startBatchItem(input),
      service.startBatchItem(input),
    ]);
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(
      await db.$queryRawUnsafe(
        'SELECT id FROM xhs_subscription_tasks WHERE id=?',
        operation(),
      ),
    ).toHaveLength(1);
    release!();
    release = undefined;
    await waitForLane();
    await batch.advance(batchId);
    await batch.advance(batchId);
    await waitForLane();
    expect(
      api.mock.calls.filter(
        ([r]) => new URL(r.url).searchParams.get('user_id') === authors[ids[0]],
      ),
    ).toHaveLength(1);
  });
  it('shares one durable candidate across concurrent batch advances', async () => {
    holdLane();
    const advanced = await Promise.all([
      batch.advance(batchId),
      batch.advance(batchId),
    ]);
    expect(advanced.every((x) => x.items[0].operationId === operation())).toBe(
      true,
    );
    release!();
    release = undefined;
    await waitForLane();
    expect(api).toHaveBeenCalledTimes(2);
  });
  it.each([
    'XHS_SOURCE_RATE_LIMIT_BLOCKED',
    'XHS_SOURCE_AUTHENTICATION_BLOCKED',
  ])(
    'persists blocked admission and pauses without clearing %s',
    async (code) => {
      await db.$executeRawUnsafe(
        "UPDATE xhs_source_risk SET state='blocked',code=?,http_status=?,endpoint='list' WHERE id='source'",
        code,
        code.includes('RATE') ? 429 : 401,
      );
      await batch.advance(batchId);
      expect((await batch.status(batchId)).state).toBe('paused');
      expect((await batch.status(batchId)).items[0]).toMatchObject({
        state: 'reserved',
        operationId: operation(),
      });
      expect(
        await db.$queryRawUnsafe(
          'SELECT state FROM xhs_subscription_tasks WHERE id=?',
          operation(),
        ),
      ).toEqual([{ state: 'blocked' }]);
      await batch.advance(batchId);
      await service.startBatchItem({ batchId, position: 0, creatorId: ids[0] });
      expect(api).not.toHaveBeenCalled();
      expect(
        await db.$queryRawUnsafe(
          "SELECT state,code FROM xhs_source_risk WHERE id='source'",
        ),
      ).toEqual([{ state: 'blocked', code }]);
      expect(await snapshot()).toEqual(historical);
    },
  );
  it('keeps a pending source request deferred and leaves the candidate queued', async () => {
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner=? WHERE id='source'",
      randomUUID(),
    );
    await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('running');
    expect((await batch.status(batchId)).items[0]).toMatchObject({
      state: 'queued',
      operationId: null,
    });
    expect(
      await db.$queryRawUnsafe(
        'SELECT id FROM xhs_subscription_tasks WHERE id=?',
        operation(),
      ),
    ).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
  it('blocks a newly changed unknown after enqueue and never retries an unknown detail', async () => {
    holdLane();
    await batch.advance(batchId);
    await db.$executeRawUnsafe(
      "UPDATE xhs_subscription_tasks SET document=? WHERE id='old-task'",
      oldDocument.replace(sha('old-note'), sha('changed-note')),
    );
    release!();
    release = undefined;
    await waitForLane();
    await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('paused');
    expect(api).not.toHaveBeenCalled();
  });
});
