import { createHash } from 'node:crypto';
import { XhsSubscriptionError } from './xhs-subscription-errors';

/** Proven local rejection before the resumed task INSERT, not an unknown commit. */
export class XhsBatchOperationCancelledError extends XhsSubscriptionError {
  constructor() {
    super('XHS_TASK_NOT_RESUMABLE');
  }
}

type Reader = {
  $queryRaw<T>(sql: TemplateStringsArray, ...values: any[]): Promise<T>;
};
type Tx = Reader & {
  $executeRaw(sql: TemplateStringsArray, ...values: any[]): Promise<number>;
};
export const BATCH_LOCAL_CANCELLATION = 'xhs-batch-local-cancellation-v1';
type Batch = { id: string; state: string; created_at: string };
type Item = {
  batch_id: string;
  position: number;
  creator_id: string;
  operation_id: string | null;
  state: string;
  outcome: string | null;
};
type TaskRow = {
  id: string;
  creator_id: string;
  state: string;
  document: string;
  updated_at: string;
};
const uuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const sha = (x: unknown): x is string =>
  typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const pack = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));
const hash = (x: unknown) => createHash('sha256').update(pack(x)).digest('hex');
function check(v: unknown): asserts v {
  if (!v) throw new XhsSubscriptionError('XHS_BATCH_LOCAL_REVIEW_REQUIRED');
}
function object(x: unknown): x is Record<string, any> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
const emptyObject = (x: unknown) => object(x) && Object.keys(x).length === 0;
const integerTime = (x: unknown) => typeof x === 'string' && /^\d+$/.test(x);

/** A narrow positive proof of the observed legacy failure, never absence alone. */
function unsentTask(row: TaskRow, operationId: string, creatorId: string) {
  check(
    row.id === operationId &&
      row.creator_id === creatorId &&
      row.state === 'blocked' &&
      integerTime(row.updated_at),
  );
  const d = JSON.parse(row.document);
  check(pack(d) === row.document);
  const keys = [
    'taskId',
    'creatorId',
    'kind',
    'state',
    'noteIds',
    'items',
    'total',
    'completed',
    'skipped',
    'failed',
    'remaining',
    'message',
    'code',
    'taskFailure',
  ];
  check(
    object(d) &&
      Object.keys(d).every((k) => keys.includes(k)) &&
      d.taskId === operationId &&
      d.creatorId === creatorId &&
      d.kind === 'list' &&
      d.state === row.state,
  );
  check(
    d.code === 'XHS_SOURCE_RISK_REVIEW_REQUIRED' &&
      Array.isArray(d.noteIds) &&
      d.noteIds.length === 0 &&
      emptyObject(d.items),
  );
  check(
    ['total', 'completed', 'skipped', 'failed', 'remaining'].every(
      (k) => d[k] === 0,
    ),
  );
  const f = d.taskFailure;
  check(
    object(f) &&
      Object.keys(f).every((k) =>
        ['phase', 'code', 'errorKind', 'dispatched'].includes(k),
      ) &&
      f.phase === 'prepare' &&
      f.code === d.code &&
      f.dispatched === false,
  );
  check(
    f.errorKind === undefined ||
      ['TypeError', 'RangeError', 'SyntaxError', 'Error', 'Other'].includes(
        f.errorKind,
      ),
  );
  return hash(row);
}
async function noOperationEvidence(db: Reader, operationId: string) {
  const requests = await db.$queryRaw<
    any[]
  >`SELECT operation_id FROM xhs_unbound_owner_requests WHERE task_id=${operationId} OR operation_id=${operationId} LIMIT 1`;
  const jobs = await db.$queryRaw<
    any[]
  >`SELECT owner FROM xhs_refresh_jobs WHERE owner=${operationId} LIMIT 1`;
  const linked = await db.$queryRaw<
    any[]
  >`SELECT id FROM xhs_whole_creator_jobs WHERE id=${operationId} OR instr(document,${operationId})>0 LIMIT 1`;
  const linkedTasks = await db.$queryRaw<
    any[]
  >`SELECT id FROM xhs_subscription_tasks WHERE id<>${operationId} AND instr(document,${operationId})>0 LIMIT 1`;
  const budgets = await db.$queryRaw<
    any[]
  >`SELECT id FROM xhs_request_budgets WHERE instr(id,${operationId})>0 LIMIT 1`;
  check(
    !requests.length &&
      !jobs.length &&
      !linkedTasks.length &&
      !linked.length &&
      !budgets.length,
  );
}
export type BatchCancellationReceipt = {
  kind: typeof BATCH_LOCAL_CANCELLATION;
  decision: 'cancelled-not-dispatched';
  batchId: string;
  position: number;
  creatorId: string;
  operationId: string;
  digest: string;
  taskDigest: string;
  confirmedAt: number;
  backupSha256: string;
  auditDigest: string;
  originalBatch: Batch;
  originalItems: Item[];
};

/** Used by the source fence as well as idempotent confirmation. No source grant. */
export async function verifyBatchLocalCancellation(
  db: Reader,
  item: Item,
  batchState: string,
): Promise<BatchCancellationReceipt> {
  check(
    batchState === 'stopped' &&
      item.state === 'cancelled' &&
      uuid(item.operation_id) &&
      typeof item.outcome === 'string' &&
      item.outcome.length <= 65536,
  );
  const r = JSON.parse(item.outcome);
  check(pack(r) === item.outcome);
  const keys = [
    'kind',
    'decision',
    'batchId',
    'position',
    'creatorId',
    'operationId',
    'digest',
    'taskDigest',
    'confirmedAt',
    'backupSha256',
    'originalBatch',
    'originalItems',
    'auditDigest',
  ];
  check(
    object(r) &&
      Object.keys(r).length === keys.length &&
      Object.keys(r).every((k) => keys.includes(k)),
  );
  const { auditDigest, ...audit } = r;
  check(sha(auditDigest) && hash(audit) === auditDigest);
  check(
    r.kind === BATCH_LOCAL_CANCELLATION &&
      r.decision === 'cancelled-not-dispatched' &&
      r.batchId === item.batch_id &&
      r.position === item.position &&
      r.creatorId === item.creator_id &&
      r.operationId === item.operation_id,
  );
  check(
    sha(r.digest) &&
      sha(r.taskDigest) &&
      sha(r.backupSha256) &&
      Number.isSafeInteger(r.confirmedAt) &&
      r.confirmedAt > 0,
  );
  check(
    object(r.originalBatch) &&
      r.originalBatch.id === item.batch_id &&
      ['running', 'paused'].includes(r.originalBatch.state) &&
      integerTime(r.originalBatch.created_at),
  );
  const batch = await db.$queryRaw<
    Batch[]
  >`SELECT id,state,CAST(created_at AS TEXT) created_at FROM xhs_refresh_batches WHERE id=${item.batch_id}`;
  check(
    batch.length === 1 &&
      batch[0].state === 'stopped' &&
      batch[0].created_at === r.originalBatch.created_at,
  );
  const current = await db.$queryRaw<
    Item[]
  >`SELECT batch_id,position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${item.batch_id} ORDER BY position`;
  check(
    Array.isArray(r.originalItems) &&
      r.originalItems.length > 0 &&
      r.originalItems.length <= 100 &&
      r.originalItems.length === current.length,
  );
  let reserved = 0;
  for (let i = 0; i < current.length; i++) {
    const before = r.originalItems[i],
      after = current[i];
    check(
      object(before) &&
        before.batch_id === item.batch_id &&
        before.position === after.position &&
        before.creator_id === after.creator_id &&
        before.operation_id === after.operation_id &&
        before.outcome === null &&
        after.state === 'cancelled',
    );
    if (before.position === item.position) {
      check(
        before.state === 'reserved' &&
          before.operation_id === item.operation_id &&
          after.outcome === item.outcome,
      );
      reserved++;
    } else
      check(
        before.state === 'queued' &&
          before.operation_id === null &&
          after.outcome === null,
      );
  }
  check(reserved === 1);
  const tasks = await db.$queryRaw<
    TaskRow[]
  >`SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) updated_at FROM xhs_subscription_tasks WHERE id=${item.operation_id}`;
  check(
    tasks.length === 1 &&
      unsentTask(tasks[0], item.operation_id, item.creator_id) === r.taskDigest,
  );
  await noOperationEvidence(db, item.operation_id);
  return r as BatchCancellationReceipt;
}
async function sourceSnapshot(db: Reader) {
  const risk = await db.$queryRaw<
    any[]
  >`SELECT state,code,owner,http_status,endpoint,CAST(updated_at AS TEXT) updated_at FROM xhs_source_risk WHERE id='source'`;
  check(
    risk.length === 1 &&
      risk[0].state === 'clear' &&
      ['code', 'owner', 'http_status', 'endpoint'].every(
        (k) => risk[0][k] === null,
      ),
  );
  const tasks = await db.$queryRaw<
    any[]
  >`SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) updated_at FROM xhs_subscription_tasks ORDER BY id LIMIT 10001`;
  const jobs = await db.$queryRaw<
    any[]
  >`SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) updated_at FROM xhs_whole_creator_jobs ORDER BY id LIMIT 10001`;
  const requests = await db.$queryRaw<
    any[]
  >`SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id LIMIT 100001`;
  const budgets = await db.$queryRaw<
    any[]
  >`SELECT id,used,request_limit,CAST(next_at AS TEXT) next_at,interval_ms FROM xhs_request_budgets ORDER BY id LIMIT 10001`;
  check(
    tasks.length <= 10000 &&
      jobs.length <= 10000 &&
      requests.length <= 100000 &&
      budgets.length <= 10000,
  );
  check(
    [...tasks, ...jobs].every(
      (row) =>
        object(JSON.parse(row.document)) &&
        !['queued', 'running'].includes(row.state),
    ) && !requests.some((row) => row.outcome === 'started'),
  );
  const activeLegacy = await db.$queryRaw<
    any[]
  >`SELECT owner FROM xhs_refresh_jobs WHERE state IN ('running','stopped') LIMIT 1`;
  check(!activeLegacy.length);
  const creators = await db.$queryRaw<
    any[]
  >`SELECT id,external_author_id,enabled FROM xhs_creators ORDER BY id LIMIT 10001`;
  check(creators.length <= 10000);
  return {
    risk,
    creators: hash(creators),
    tasks: tasks.map((row) => hash(row)),
    jobs: jobs.map((row) => hash(row)),
    requests: hash(requests),
    budgets: hash(budgets),
  };
}
export async function prepareBatchLocalCancellation(
  db: Reader,
  batchId: string,
) {
  check(uuid(batchId));
  const batches = await db.$queryRaw<
    Batch[]
  >`SELECT id,state,CAST(created_at AS TEXT) created_at FROM xhs_refresh_batches WHERE id=${batchId}`;
  check(batches.length === 1);
  const batch = batches[0];
  const items = await db.$queryRaw<
    Item[]
  >`SELECT batch_id,position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${batchId} ORDER BY position`;
  check(items.length > 0 && items.length <= 100);
  const settled = items.filter(
    (item) => item.operation_id !== null && item.state === 'cancelled',
  );
  if (batch.state === 'stopped' && settled.length === 1) {
    const receipt = await verifyBatchLocalCancellation(
      db,
      settled[0],
      batch.state,
    );
    return {
      state: 'cancelled' as const,
      batchId,
      digest: receipt.digest,
      receipt,
    };
  }
  check(
    ['running', 'paused'].includes(batch.state) &&
      items.every((item) => item.outcome === null),
  );
  const reserved = items.filter((item) => item.state === 'reserved');
  check(reserved.length === 1 && uuid(reserved[0].operation_id));
  const item = reserved[0];
  check(
    items.every(
      (other) =>
        other === item ||
        (other.state === 'queued' && other.operation_id === null),
    ),
  );
  const tasks = await db.$queryRaw<
    TaskRow[]
  >`SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) updated_at FROM xhs_subscription_tasks WHERE id=${item.operation_id}`;
  check(tasks.length === 1);
  const taskDigest = unsentTask(tasks[0], item.operation_id!, item.creator_id);
  check(
    integerTime(batch.created_at) &&
      BigInt(tasks[0].updated_at) >= BigInt(batch.created_at),
  );
  await noOperationEvidence(db, item.operation_id!);
  check(
    integerTime(batch.created_at) &&
      items.every(
        (item) =>
          Number.isSafeInteger(item.position) &&
          item.position >= 0 &&
          typeof item.creator_id === 'string' &&
          item.creator_id.length > 0 &&
          item.creator_id.length <= 128,
      ),
  );
  const safety = await sourceSnapshot(db);
  const snapshot = { batch, items, taskDigest, safety };
  return {
    state: 'reviewable' as const,
    batchId,
    digest: hash(snapshot),
    snapshot,
    item,
    taskDigest,
  };
}
/** Same SQLite transaction rechecks the preview, writes the audit, and stops the batch. */
export async function confirmBatchLocalCancellation(
  db: Tx,
  input: { batchId: string; digest: string; acknowledgedNotDispatched: true },
  backupSha256: string,
  now: number,
) {
  check(input.acknowledgedNotDispatched === true && sha(input.digest));
  const plan = await prepareBatchLocalCancellation(db, input.batchId);
  check(plan.digest === input.digest);
  if (plan.state === 'cancelled')
    return { receipt: plan.receipt, alreadyCancelled: true };
  check(sha(backupSha256) && Number.isSafeInteger(now) && now > 0);
  const audit: Omit<BatchCancellationReceipt, 'auditDigest'> = {
    kind: BATCH_LOCAL_CANCELLATION,
    decision: 'cancelled-not-dispatched',
    batchId: input.batchId,
    position: plan.item.position,
    creatorId: plan.item.creator_id,
    operationId: plan.item.operation_id!,
    digest: input.digest,
    taskDigest: plan.taskDigest,
    confirmedAt: now,
    backupSha256,
    originalBatch: plan.snapshot.batch,
    originalItems: plan.snapshot.items,
  };
  const receipt: BatchCancellationReceipt = {
    ...audit,
    auditDigest: hash(audit),
  };
  const changed =
    await db.$executeRaw`UPDATE xhs_refresh_batch_items SET state='cancelled',outcome=${pack(receipt)} WHERE batch_id=${input.batchId} AND position=${plan.item.position} AND creator_id=${plan.item.creator_id} AND operation_id=${plan.item.operation_id} AND state='reserved' AND outcome IS NULL`;
  check(changed === 1);
  const queued =
    await db.$executeRaw`UPDATE xhs_refresh_batch_items SET state='cancelled' WHERE batch_id=${input.batchId} AND state='queued' AND operation_id IS NULL AND outcome IS NULL`;
  check(queued === plan.snapshot.items.length - 1);
  check(
    (await db.$executeRaw`UPDATE xhs_refresh_batches SET state='stopped' WHERE id=${input.batchId} AND state=${plan.snapshot.batch.state}`) ===
      1,
  );
  return { receipt, alreadyCancelled: false };
}

/** Freeze the reviewed operation even if a task-resume caller races confirmation. */
export async function assertBatchOperationNotCancelled(
  db: Reader,
  operationId: string,
) {
  const tables = await db.$queryRaw<
    any[]
  >`SELECT name FROM sqlite_master WHERE type='table' AND name='xhs_refresh_batch_items'`;
  if (!tables.length) return; // Older schemas cannot contain this cancellation audit.
  const cancelled = await db.$queryRaw<
    any[]
  >`SELECT batch_id FROM xhs_refresh_batch_items WHERE operation_id=${operationId} AND state='cancelled' LIMIT 1`;
  if (cancelled.length) throw new XhsBatchOperationCancelledError();
}
