import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XiaohongshuBatches } from './xiaohongshu-batches';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { FULL_HISTORY_KIND, fullHistoryContext } from './xhs-full-history-scope';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
  assertScheduledRoundAdmission,
  assertScheduledDispatch,
} from './xhs-scheduled-review-scope';
import { assertUnboundDispatch } from './xhs-unbound-round';

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
    for (const id of ids)
      (runtime as any).adapter.restoreDefaultAuthorAccess(authors[id]);
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
  it('updates all three accounts through real review and list dispatch, preserving unknowns byte-for-byte', async () => {
    await expect(assertUnboundDispatch(db)).rejects.toThrow(
      'APPROVED_NEW_ROUND_REQUIRED',
    );
    for (const creatorId of ids) {
      await batch.advance(batchId);
      await waitForLane();
      await batch.advance(batchId);
      expect(await db.xhsNote.count({ where: { creatorId } })).toBe(1);
    }
    expect((await batch.status(batchId)).state).toBe('complete');
    expect(api).toHaveBeenCalledTimes(3);
    expect(
      api.mock.calls.every(([request]) =>
        new URL(request.url).pathname.endsWith('/user_posted'),
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
      });
    expect(tasks.every(task => !JSON.parse(task.document).collectDetails)).toBe(true);
    const ledger = await db.$queryRawUnsafe<any[]>(
      'SELECT phase,outcome FROM xhs_unbound_owner_requests WHERE operation_id<>?',
      oldOperation,
    );
    expect(ledger).toHaveLength(3);
    expect(
      ledger.every(
        (x) => x.phase === 'list' && x.outcome === 'response-received',
      ),
    ).toBe(true);
    expect(await snapshot()).toEqual(historical);
    await batch.advance(batchId);
    await service.startBatchItem({ batchId, position: 0, creatorId: ids[0] });
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('reuses an existing task with a queued candidate without running it again', async () => {
    const taskId = operation();
    const task = {
      taskId,
      creatorId: ids[0],
      kind: 'list',
      state: 'completed',
      collectDetails: false,
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
    const [review] = await db.$queryRawUnsafe<any[]>("SELECT id,scope_json FROM xhs_unbound_owner_reviews WHERE json_extract(scope_json,'$.taskBinding.taskId')=?", operation());
    const scope = JSON.parse(review.scope_json);
    const context = { reviewId: review.id, creatorId: ids[0], jobId: operation(), authorId: authors[ids[0]], sessionBinding: runtime.fullScopeSessionBinding(), budgetId: scope.budgetId };
    const request = { operationId: randomUUID(), creatorId: ids[0], taskId: operation(), phase: 'detail' as const, target: 'old-note' };
    await fullHistoryContext.run(context, async () => {
      await expect(db.$transaction(tx => assertScheduledRoundAdmission(tx, review.id, review, request))).rejects.toThrow('SCHEDULED_PHASE_BINDING_CHANGED');
      await expect(db.$transaction(tx => assertScheduledDispatch(tx, review.id, request))).rejects.toThrow('SCHEDULED_PHASE_BINDING_CHANGED');
    });
    expect(api).not.toHaveBeenCalled();
  });
  it('rolls back admission when stop wins after review preparation', async () => {
    const prepare = runtime.withScheduledReview.bind(runtime);
    jest.spyOn(runtime, 'withScheduledReview').mockImplementation((input, work) => prepare(input, async () => {
      await batch.stop(batchId);
      return work();
    }));
    await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('stopped');
    expect((await batch.status(batchId)).items.every(x => x.state === 'cancelled' && !x.operationId)).toBe(true);
    expect(await db.$queryRawUnsafe('SELECT id FROM xhs_subscription_tasks WHERE id=?', operation())).toEqual([]);
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
    expect(api).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(historical);
  });
  it('rolls back reservation and blocked task if pausing the batch fails', async () => {
    await db.$executeRawUnsafe("UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_RATE_LIMIT_BLOCKED',http_status=429,endpoint='list' WHERE id='source'");
    await db.$executeRawUnsafe("CREATE TRIGGER synthetic_pause_failure BEFORE UPDATE ON xhs_refresh_batches WHEN NEW.state='paused' BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END");
    await expect(batch.advance(batchId)).rejects.toMatchObject({ code: 'XHS_LOCAL_OPERATION_FAILED' });
    expect((await batch.status(batchId)).items[0]).toMatchObject({ state: 'queued', operationId: null });
    expect(await db.$queryRawUnsafe('SELECT id FROM xhs_subscription_tasks WHERE id=?', operation())).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
  it.each([401, 429])('stops after a real runtime restriction response (%s)', async status => {
    api.mockImplementation(async (request: any) => ({ status, url: request.url, body: { success: false } }));
    await batch.advance(batchId); await waitForLane(); await batch.advance(batchId);
    expect((await batch.status(batchId)).state).toBe('paused');
    await batch.advance(batchId);
    expect(api).toHaveBeenCalledTimes(1);
    expect(await db.$queryRawUnsafe("SELECT state FROM xhs_source_risk WHERE id='source'")).toEqual([{ state: 'blocked' }]);
    expect(await snapshot()).toEqual(historical);
  });
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
    expect(results.every(x => x.status === 'fulfilled')).toBe(true);
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
    const advanced = await Promise.all([batch.advance(batchId), batch.advance(batchId)]);
    expect(advanced.every(x => x.items[0].operationId === operation())).toBe(true);
    release!(); release = undefined; await waitForLane();
    expect(api).toHaveBeenCalledTimes(1);
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
