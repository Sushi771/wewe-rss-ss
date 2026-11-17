import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XiaohongshuBatches } from './xiaohongshu-batches';
import { readLegacyXhsSourceFence } from './xhs-legacy-source-fence';
import { assertUnboundDispatch } from './xhs-unbound-round';
import {
  parsePersistentCreatorBatch,
  inspectPersistentBatch,
} from '../../../web/src/utils/xiaohongshu-refresh';
const { DatabaseSync } = createRequire(__filename)('node:sqlite');

// Newly created synthetic database only. Real Prisma, migrations, writer gate,
// consistent local backup, review/commit, source fence and frontend parser.
describe('unsent legacy batch local cancellation', () => {
  jest.setTimeout(60000);
  let db: PrismaClient, folder: string, database: string;
  let runtime: XhsSubscriptionRuntime,
    service: XhsSubscriptionService,
    batch: XiaohongshuBatches;
  let backup: jest.Mock,
    api: jest.Mock,
    batchId: string,
    taskId: string,
    taskDocument: string;
  const creator = 'synthetic-a',
    time = 1794798578834n;
  const sha = (v: Buffer) => createHash('sha256').update(v).digest('hex');
  const fixedHistoricalOperation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const preserved = () =>
    Promise.all([
      db.$queryRawUnsafe(
        'SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) updated_at FROM xhs_subscription_tasks ORDER BY id',
      ),
      db.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
      ),
      db.$queryRawUnsafe(
        'SELECT id,used,request_limit,CAST(next_at AS TEXT) next_at,interval_ms FROM xhs_request_budgets ORDER BY id',
      ),
      db.$queryRawUnsafe(
        'SELECT id,scope_json,original_outcome,CAST(approved_at AS TEXT) approved_at FROM xhs_unbound_owner_reviews ORDER BY id',
      ),
      db.xhsNote.findMany(),
    ]);
  const batchRows = () =>
    Promise.all([
      db.$queryRawUnsafe(
        'SELECT id,state,CAST(created_at AS TEXT) created_at FROM xhs_refresh_batches ORDER BY id',
      ),
      db.$queryRawUnsafe(
        'SELECT * FROM xhs_refresh_batch_items ORDER BY position',
      ),
      db.$queryRawUnsafe(
        'SELECT creator_id,generation,owner,state,outcome FROM xhs_refresh_jobs ORDER BY owner',
      ),
    ]);
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(tmpdir(), 'xhs-local-cancel-'));
    database = path.join(folder, 'fixture.sqlite');
    const url = 'file:' + database.replace(/\\/g, '/');
    await applyFixtureMigrations(url);
    db = new PrismaClient({ datasources: { db: { url } } });
    for (const id of [creator, 'synthetic-b', 'synthetic-c'])
      await db.xhsCreator.create({
        data: {
          id,
          externalAuthorId: 'author-' + id,
          profileUrl: 'https://example.invalid/' + id,
          displayName: id,
        },
      });
    await db.xhsNote.create({
      data: {
        id: 'old-note',
        creatorId: creator,
        title: 'protected',
        publishTime: 123,
        kind: 'image-text',
        status: 'complete',
        contentHtml: '<div id="js_content"><p>protected body</p></div>',
      },
    });
    batchId = randomUUID();
    taskId = randomUUID();
    taskDocument = JSON.stringify({
      taskId,
      creatorId: creator,
      kind: 'list',
      state: 'blocked',
      noteIds: [],
      items: {},
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
      message: 'synthetic local failure',
      code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
      taskFailure: {
        phase: 'prepare',
        code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
        errorKind: 'Error',
        dispatched: false,
      },
    });
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES(?,?,'blocked',?,?)",
      taskId,
      creator,
      taskDocument,
      time + 10n,
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES('historical-task','synthetic-b','blocked',?,?)",
      JSON.stringify({
        taskId: 'historical-task',
        creatorId: 'synthetic-b',
        state: 'blocked',
        sourceActive: { phase: 'detail', outcome: 'started' },
        sourceUnknowns: [{ phase: 'detail', outcome: 'unknown' }],
      }),
      time - 10n,
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_refresh_batches VALUES(?,'running',?)",
      batchId,
      time,
    );
    for (const [position, id] of [
      creator,
      'synthetic-b',
      'synthetic-c',
    ].entries())
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_refresh_batch_items(batch_id,position,creator_id,operation_id,state) VALUES(?,?,?,?,?)',
        batchId,
        position,
        id,
        position === 0 ? taskId : null,
        position === 0 ? 'reserved' : 'queued',
      );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_unbound_owner_reviews VALUES('historical-review',?,'{}','unknown','[]','[]','{}','[]',?, ?,?)",
      'a'.repeat(64),
      JSON.stringify({ reviewKind: 'synthetic-history-v1' }),
      'b'.repeat(64),
      time - 100n,
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_unbound_owner_requests VALUES(?,'historical-review','historical-task','synthetic-b','detail','historical-note','unknown',NULL)",
      fixedHistoricalOperation,
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',7,100,0,1000),('xhs:dispatch-pending:historical',1,1,0,1000)",
    );
    api = jest.fn(async () => {
      throw Error('NETWORK_FORBIDDEN');
    });
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    service = new XhsSubscriptionService(db as any, runtime);
    backup = jest.fn(async () => {
      const file = path.join(
        folder,
        'backup-' + backup.mock.calls.length + '.sqlite',
      );
      const native = new DatabaseSync(database);
      try {
        native.prepare('VACUUM INTO ?').run(file);
      } finally {
        native.close();
      }
      const check = new DatabaseSync(file, { readOnly: true });
      let integrity: string;
      try {
        integrity = check
          .prepare('PRAGMA integrity_check')
          .get().integrity_check;
      } finally {
        check.close();
      }
      return {
        source: database,
        backup: file,
        sha256: sha(await fs.readFile(file)),
        integrityCheck: integrity,
        recoveryOrigin: {
          format: 'sqlite-recovery-origin-v1',
          kind: 'protected',
        },
      };
    });
    batch = new XiaohongshuBatches(db, service, backup);
  });
  afterEach(async () => {
    expect(api).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
    await db.$disconnect();
    // Exact per-test directory allocated above; never a computed parent target.
    await fs.rm(folder, { recursive: true, force: true });
  });
  const preview = async () => {
    const p = await batch.prepareLocalCancellation(batchId);
    return {
      batchId,
      digest: p.digest,
      acknowledgedNotDispatched: true as const,
    };
  };
  it('cancels locally with a verified backup and retains the old operation, task, body, unknowns and budgets', async () => {
    const old = await preserved(),
      before = await batchRows();
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
    });
    const input = await preview();
    expect(await batchRows()).toEqual(before);
    expect(backup).not.toHaveBeenCalled();
    const result = await batch.confirmLocalCancellation(input);
    expect(result.alreadyCancelled).toBe(false);
    expect(result.sourceStatusRefreshed).toBe(true);
    const status = parsePersistentCreatorBatch(result.batch);
    expect(status.state).toBe('stopped');
    expect(status.items.map((i) => i.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(status.items[0].operationId).toBe(taskId);
    expect(status.items[0].outcome).toMatchObject({
      kind: 'xhs-batch-local-cancellation-v1',
      decision: 'cancelled-not-dispatched',
      originalBatch: { state: 'running' },
      digest: input.digest,
    });
    expect(await preserved()).toEqual(old);
    expect(await db.$queryRawUnsafe('SELECT * FROM xhs_refresh_jobs')).toEqual(
      [],
    );
    expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'clear' });
    await expect(assertUnboundDispatch(db)).rejects.toThrow(
      'APPROVED_NEW_ROUND_REQUIRED',
    );
    expect(backup).toHaveBeenCalledTimes(1);
  });
  it('is idempotent across new service instances and concurrent confirmations', async () => {
    const input = await preview();
    const other = new XiaohongshuBatches(db, service, backup);
    const results = await Promise.all([
      batch.confirmLocalCancellation(input),
      other.confirmLocalCancellation(input),
    ]);
    expect(results.map((r) => r.alreadyCancelled).sort()).toEqual([
      false,
      true,
    ]);
    const saved = await batchRows();
    expect((await other.confirmLocalCancellation(input)).alreadyCancelled).toBe(
      true,
    );
    expect(await batchRows()).toEqual(saved);
    expect(backup).toHaveBeenCalledTimes(1);
  });
  it.each(['unknown', 'transport-entered', undefined, true])(
    'rejects an unproved dispatch outcome %s',
    async (dispatched) => {
      const task = JSON.parse(taskDocument);
      task.taskFailure.dispatched = dispatched;
      await db.$executeRawUnsafe(
        'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
        JSON.stringify(task),
        taskId,
      );
      const old = await batchRows();
      await expect(preview()).rejects.toBeDefined();
      expect(await batchRows()).toEqual(old);
      expect(backup).not.toHaveBeenCalled();
    },
  );
  it.each(['detail', 'listing', 'media'])(
    'rejects a later failure phase %s',
    async (phase) => {
      const task = JSON.parse(taskDocument);
      task.taskFailure.phase = phase;
      await db.$executeRawUnsafe(
        'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
        JSON.stringify(task),
        taskId,
      );
      await expect(preview()).rejects.toBeDefined();
    },
  );
  it.each([
    'sourceActive',
    'sourceUnknowns',
    'sourceReceipt',
    'sourceFailures',
    'schedule',
    'resumedFromTaskId',
  ])('rejects extra source evidence %s', async (key) => {
    const task = JSON.parse(taskDocument);
    task[key] = key === 'sourceUnknowns' ? [] : {};
    await db.$executeRawUnsafe(
      'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
      JSON.stringify(task),
      taskId,
    );
    await expect(preview()).rejects.toBeDefined();
  });
  it.each(['running', 'queued', 'partial', 'cancelled'])(
    'rejects task state %s',
    async (state) => {
      const task = JSON.parse(taskDocument);
      task.state = state;
      await db.$executeRawUnsafe(
        'UPDATE xhs_subscription_tasks SET state=?,document=? WHERE id=?',
        state,
        JSON.stringify(task),
        taskId,
      );
      await expect(preview()).rejects.toBeDefined();
    },
  );
  it('rejects contradictory duplicate JSON fields and malformed documents', async () => {
    await db.$executeRawUnsafe(
      'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
      taskDocument.replace(
        '"dispatched":false',
        '"dispatched":true,"dispatched":false',
      ),
      taskId,
    );
    await expect(preview()).rejects.toBeDefined();
    await db.$executeRawUnsafe(
      "UPDATE xhs_subscription_tasks SET document='broken' WHERE id=?",
      taskId,
    );
    await expect(preview()).rejects.toBeDefined();
  });
  it.each(['unknown', 'started', 'response-received'])(
    'rejects any dispatch ledger for the operation (%s)',
    async (outcome) => {
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES(?,'historical-review',?,?,'list','cursor:synthetic',?,NULL)",
        randomUUID(),
        taskId,
        creator,
        outcome,
      );
      await expect(preview()).rejects.toBeDefined();
    },
  );
  it.each([
    'XHS_SOURCE_AUTHENTICATION_BLOCKED',
    'XHS_SOURCE_RATE_LIMIT_BLOCKED',
    'XHS_SOURCE_VERIFICATION_BLOCKED',
  ])('retains a real source restriction %s', async (code) => {
    const input = await preview(),
      old = await batchRows();
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='blocked',code=?,http_status=?,endpoint='list' WHERE id='source'",
      code,
      code.includes('AUTHENTICATION') ? 401 : 429,
    );
    await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
    expect(await batchRows()).toEqual(old);
    expect(backup).not.toHaveBeenCalled();
    expect(
      await db.$queryRawUnsafe(
        "SELECT state,code FROM xhs_source_risk WHERE id='source'",
      ),
    ).toEqual([{ state: 'blocked', code }]);
  });
  it('retains pending owners and active runtime/source work', async () => {
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner=? WHERE id='source'",
      randomUUID(),
    );
    await expect(preview()).rejects.toBeDefined();
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='clear',owner=NULL WHERE id='source'",
    );
    (runtime as any).activeSourceSessions = 1;
    await expect(preview()).rejects.toBeDefined();
    (runtime as any).activeSourceSessions = 0;
    (runtime as any).stopCode = 'XHS_SOURCE_AUTHENTICATION_BLOCKED';
    await expect(preview()).rejects.toBeDefined();
  });
  it('rejects stale confirmation after task evidence changes', async () => {
    const input = await preview();
    await db.$executeRawUnsafe(
      'UPDATE xhs_subscription_tasks SET updated_at=updated_at+1 WHERE id=?',
      taskId,
    );
    const old = await batchRows();
    await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
    expect(await batchRows()).toEqual(old);
    expect(backup).not.toHaveBeenCalled();
  });
  it('never resumes the operation after its explicit local cancellation', async () => {
    const input = await preview();
    await batch.confirmLocalCancellation(input);
    const before = await preserved();
    await expect(service.resumeTask({ taskId })).rejects.toMatchObject({
      code: 'XHS_TASK_NOT_RESUMABLE',
    });
    expect(await preserved()).toEqual(before);
  });
  it('rejects a resume that passed its initial read before cancellation committed', async () => {
    const input = await preview();
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>((r) => {
        arrive = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const creatorLookup = (service as any).creator.bind(service);
    jest
      .spyOn(service as any, 'creator')
      .mockImplementationOnce(async (...args: any[]) => {
        arrive();
        await gate;
        return creatorLookup(...args);
      });
    const resumed = service.resumeTask({ taskId }).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await arrived;
    await batch.confirmLocalCancellation(input);
    const before = await preserved();
    release();
    expect((await resumed).error).toMatchObject({
      code: 'XHS_TASK_NOT_RESUMABLE',
    });
    expect(await preserved()).toEqual(before);
    expect((await batch.status(batchId)).state).toBe('stopped');
    expect(service.hasLocalSourceWork()).toBe(false);
    expect((await batch.confirmLocalCancellation(input)).alreadyCancelled).toBe(
      true,
    );
  });
  it('rejects stop/advance state changes that race the backup', async () => {
    const input = await preview();
    const take = backup.getMockImplementation()!;
    backup.mockImplementationOnce(async () => {
      const report = await take();
      await batch.advance(batchId);
      return report;
    });
    await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
    expect((await batch.status(batchId)).items[0]).toMatchObject({
      state: 'reserved',
      operationId: taskId,
      outcome: null,
    });
  });
  it('rejects an actual stop that wins while the backup is being checked', async () => {
    const input = await preview(),
      take = backup.getMockImplementation()!;
    backup.mockImplementationOnce(async () => {
      const report = await take();
      await batch.stop(batchId);
      return report;
    });
    await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
    expect((await batch.status(batchId)).state).toBe('stopped');
    expect((await batch.status(batchId)).items[0].state).toBe('reserved');
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
    });
  });
  it.each(['started', 'unknown'])(
    'rejects a new request after preview (%s)',
    async (outcome) => {
      const input = await preview(),
        old = await batchRows();
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES(?,'historical-review','historical-task','synthetic-b','list','cursor:new',?,NULL)",
        randomUUID(),
        outcome,
      );
      await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
      expect(await batchRows()).toEqual(old);
    },
  );
  it('rejects a task that has already produced another linked task', async () => {
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES('linked-child',?,'blocked',?,?)",
      creator,
      JSON.stringify({
        taskId: 'linked-child',
        creatorId: creator,
        state: 'blocked',
        resumedFromTaskId: taskId,
      }),
      time + 20n,
    );
    await expect(preview()).rejects.toBeDefined();
  });
  it('rejects an operation-linked budget and a prior legacy job', async () => {
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,1,1,0,1000)',
      'xhs:dispatch-pending:' + taskId,
    );
    await expect(preview()).rejects.toBeDefined();
    await db.$executeRawUnsafe(
      'DELETE FROM xhs_request_budgets WHERE id=?',
      'xhs:dispatch-pending:' + taskId,
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_refresh_jobs(creator_id,generation,owner,started_at,state) VALUES(?,1,?,?,'stopped')",
      creator,
      taskId,
      time,
    );
    await expect(preview()).rejects.toBeDefined();
  });
  it.each([
    'digest',
    'taskDigest',
    'backupSha256',
    'operationId',
    'decision',
    'auditDigest',
  ])('rejects a corrupted cancellation audit (%s)', async (key) => {
    const input = await preview();
    await batch.confirmLocalCancellation(input);
    const [row] = await db.$queryRawUnsafe<any[]>(
      'SELECT outcome FROM xhs_refresh_batch_items WHERE operation_id=?',
      taskId,
    );
    const receipt = JSON.parse(row.outcome);
    receipt[key] = [
      'digest',
      'taskDigest',
      'backupSha256',
      'auditDigest',
    ].includes(key)
      ? 'f'.repeat(64)
      : 'invalid';
    await db.$executeRawUnsafe(
      'UPDATE xhs_refresh_batch_items SET outcome=? WHERE operation_id=?',
      JSON.stringify(receipt),
      taskId,
    );
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
    });
    await expect(batch.prepareLocalCancellation(batchId)).rejects.toBeDefined();
  });
  it('rolls back the audit and every item if stopping the batch fails', async () => {
    const input = await preview(),
      old = await batchRows();
    await db.$executeRawUnsafe(
      "CREATE TRIGGER synthetic_cancel_failure BEFORE UPDATE ON xhs_refresh_batches WHEN NEW.state='stopped' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    );
    await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
    expect(await batchRows()).toEqual(old);
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
    });
  });
  it('rejects missing/unverified backups and leaves the reservation untouched', async () => {
    const input = await preview(),
      old = await batchRows();
    backup.mockResolvedValueOnce({
      source: database,
      backup: database,
      sha256: 'a'.repeat(64),
      integrityCheck: 'ok',
      recoveryOrigin: {
        format: 'sqlite-recovery-origin-v1',
        kind: 'protected',
      },
    });
    await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
    expect(await batchRows()).toEqual(old);
  });
  it('does not remove a later real restriction when reading an already cancelled receipt', async () => {
    const input = await preview();
    await batch.confirmLocalCancellation(input);
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_RATE_LIMIT_BLOCKED',http_status=429,endpoint='list' WHERE id='source'",
    );
    expect(await new XhsSourceRiskStore(db as any).read()).toBe(
      'XHS_SOURCE_RATE_LIMIT_BLOCKED',
    );
    const before = await batchRows();
    await batch.confirmLocalCancellation(input);
    expect(await batchRows()).toEqual(before);
    expect(await new XhsSourceRiskStore(db as any).read()).toBe(
      'XHS_SOURCE_RATE_LIMIT_BLOCKED',
    );
  });
  it('closes the fence if a cancellation receipt or its immutable task is damaged', async () => {
    const input = await preview();
    await batch.confirmLocalCancellation(input);
    await db.$executeRawUnsafe(
      'UPDATE xhs_subscription_tasks SET updated_at=updated_at+1 WHERE id=?',
      taskId,
    );
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
    });
    await expect(batch.confirmLocalCancellation(input)).rejects.toBeDefined();
  });
  it('validates acknowledgements and digests without sending or cancelling', async () => {
    const input = await preview(),
      old = await batchRows();
    await expect(
      batch.confirmLocalCancellation({
        ...input,
        acknowledgedNotDispatched: false,
      } as any),
    ).rejects.toBeDefined();
    await expect(
      batch.confirmLocalCancellation({ ...input, digest: 'f'.repeat(64) }),
    ).rejects.toBeDefined();
    await expect(
      batch.prepareLocalCancellation('../bad'),
    ).rejects.toBeDefined();
    expect(await batchRows()).toEqual(old);
    expect(backup).not.toHaveBeenCalled();
  });
  it('restores a cancelled frontend batch by status only and rejects forged retained operations', async () => {
    const input = await preview();
    const result = await batch.confirmLocalCancellation(input);
    const storage = {
      getItem: () => batchId,
      setItem: jest.fn(),
      removeItem: jest.fn(),
    };
    const status = jest.fn(async () =>
        parsePersistentCreatorBatch(result.batch),
      ),
      active = jest.fn();
    const restored = await inspectPersistentBatch(storage, status, active);
    expect(restored?.state).toBe('stopped');
    expect(active).not.toHaveBeenCalled();
    const forged = JSON.parse(JSON.stringify(result.batch));
    forged.items[0].outcome.operationId = randomUUID();
    expect(() => parsePersistentCreatorBatch(forged)).toThrow();
    forged.items[0].outcome = result.batch.items[0].outcome;
    forged.state = 'running';
    expect(() => parsePersistentCreatorBatch(forged)).toThrow();
  });
});
