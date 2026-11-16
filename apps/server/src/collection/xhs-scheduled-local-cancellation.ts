import { createHash } from 'node:crypto';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { readScheduledKnownAuthProof } from './xhs-scheduled-review-scope';

/** Local settlement evidence only. It never grants or dispatches source work. */
export const SCHEDULED_LOCAL_CANCELLATION = 'xhs-batch-local-cancellation-v2';
type Reader = {
  $queryRaw<T>(sql: TemplateStringsArray, ...values: any[]): Promise<T>;
  $queryRawUnsafe?: <T>(sql: string, ...values: any[]) => Promise<T>;
};
type Tx = Reader & {
  $executeRaw(sql: TemplateStringsArray, ...values: any[]): Promise<number>;
};
type Batch = { id: string; state: string; created_at: string };
type Item = {
  batch_id: string;
  position: number;
  creator_id: string;
  operation_id: string | null;
  state: string;
  outcome: string | null;
};
type Stop = {
  creator_id: string;
  generation: number;
  owner: string;
  started_at: string;
  state: string;
  outcome: null;
};
type Proof = {
  kind: 'scheduled-list-prepare-v1' | 'scheduled-list-admission-v1';
  reviewId: string;
  reviewDigest: string;
  budgetId: string;
  budgetDigest: string;
  legacyStop: Stop | null;
};
export type ScheduledCancellationReceipt = {
  kind: typeof SCHEDULED_LOCAL_CANCELLATION;
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
  scheduledProof: Proof;
};
const pack = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const hash = (v: unknown) => createHash('sha256').update(pack(v)).digest('hex');
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const time = (v: unknown): v is string =>
  typeof v === 'string' && /^\d+$/.test(v);
function check(v: unknown): asserts v {
  if (!v) throw new XhsSubscriptionError('XHS_BATCH_LOCAL_REVIEW_REQUIRED');
}

export function matchesScheduledLocalStop(
  receipt: ScheduledCancellationReceipt,
  row: any,
) {
  const s = receipt.scheduledProof.legacyStop;
  return (
    !!s &&
    hash(s) ===
      hash({
        creator_id: row.creator_id,
        generation: Number(row.generation),
        owner: row.owner,
        started_at: String(row.started_at),
        state: row.state,
        outcome: row.outcome,
      })
  );
}

async function taskProof(
  db: Reader,
  batchId: string,
  item: Item,
  stopped: boolean,
  frozen?: Proof,
) {
  const rows = await db.$queryRaw<
    any[]
  >`SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) updated_at FROM xhs_subscription_tasks WHERE id=${item.operation_id}`;
  check(rows.length === 1);
  const row = rows[0],
    d = JSON.parse(row.document);
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
    'schedule',
    'historyExcludedIds',
  ];
  check(
    object(d) &&
      pack(d) === row.document &&
      Object.keys(d).every((k) => keys.includes(k)) &&
      row.state === 'blocked' &&
      d.state === row.state &&
      d.taskId === row.id &&
      d.creatorId === row.creator_id &&
      row.id === item.operation_id &&
      row.creator_id === item.creator_id &&
      time(row.updated_at),
  );
  check(
    d.kind === 'list' &&
      Array.isArray(d.noteIds) &&
      d.noteIds.length === 0 &&
      object(d.items) &&
      !Object.keys(d.items).length &&
      ['total', 'completed', 'skipped', 'failed', 'remaining'].every(
        (k) => d[k] === 0,
      ),
  );
  check(
    d.historyExcludedIds === undefined ||
      (Array.isArray(d.historyExcludedIds) &&
        d.historyExcludedIds.length <= 10000 &&
        d.historyExcludedIds.every(
          (id) => typeof id === 'string' && id.length > 0 && id.length <= 300,
        ) &&
        new Set(d.historyExcludedIds).size === d.historyExcludedIds.length),
  );
  check(
    object(d.schedule) &&
      Object.keys(d.schedule).length === 2 &&
      d.schedule.round === `batch/${batchId}` &&
      d.schedule.phase === 'basic',
  );
  let kind: Proof['kind'];
  if (d.code === 'XHS_ACCESS_CONTEXT_EXPIRED') {
    const f = d.taskFailure;
    check(
      object(f) &&
        Object.keys(f).every((k) =>
          ['phase', 'code', 'errorKind', 'dispatched'].includes(k),
        ) &&
        f.code === d.code &&
        f.phase === 'prepare' &&
        f.dispatched === false &&
        (f.errorKind === undefined ||
          ['TypeError', 'RangeError', 'SyntaxError', 'Error', 'Other'].includes(
            f.errorKind,
          )),
    );
    kind = 'scheduled-list-prepare-v1';
  } else {
    // This exact blocked constructor returns before the task enters the lane.
    // Bind it to the real review and its still-unused durable request budget.
    check(
      d.code === 'XHS_SCHEDULE_SOURCE_BLOCKED' &&
        d.taskFailure === undefined &&
        d.historyExcludedIds === undefined,
    );
    kind = 'scheduled-list-admission-v1';
  }
  const reviews = await db.$queryRaw<
    any[]
  >`SELECT id,plan_digest,scope_json FROM xhs_unbound_owner_reviews WHERE instr(scope_json,${item.operation_id})>0`;
  const bound = reviews.filter((r) => {
    const s = JSON.parse(r.scope_json);
    return (
      s.reviewKind === 'scheduled-round-review-v1' &&
      s.taskBinding?.taskId === item.operation_id
    );
  });
  check(bound.length === 1);
  const review = bound[0],
    scope = JSON.parse(review.scope_json);
  check(
    scope.round === d.schedule.round &&
      scope.taskBinding.creatorId === item.creator_id &&
      scope.taskBinding.phase === 'basic' &&
      scope.taskBinding.batch === 0 &&
      typeof scope.policyId === 'string' &&
      sha(scope.sessionBinding) &&
      review.plan_digest === hash(scope),
  );
  check(
    typeof scope.budgetId === 'string' &&
      scope.budgetId.includes(item.operation_id!),
  );
  if (!frozen) {
    check(typeof db.$queryRawUnsafe === 'function');
    // Reuse the installed read-only recurring-policy binding/baseline proof.
    await readScheduledKnownAuthProof(
      db as any,
      item.operation_id!,
      review.id,
      scope.policyId,
    );
  }
  const budgets = await db.$queryRaw<
    any[]
  >`SELECT id,used,request_limit,CAST(next_at AS TEXT) next_at,interval_ms FROM xhs_request_budgets WHERE instr(id,${item.operation_id})>0`;
  check(
    budgets.length === 1 &&
      budgets[0].id === scope.budgetId &&
      Number(budgets[0].used) === 0 &&
      Number(budgets[0].request_limit) === scope.maxRequests &&
      Number(budgets[0].interval_ms) >= 1000 &&
      time(budgets[0].next_at),
  );
  const requests = await db.$queryRaw<
    any[]
  >`SELECT operation_id FROM xhs_unbound_owner_requests WHERE task_id=${item.operation_id} OR operation_id=${item.operation_id} LIMIT 1`;
  const whole = await db.$queryRaw<
    any[]
  >`SELECT id FROM xhs_whole_creator_jobs WHERE id=${item.operation_id} OR instr(document,${item.operation_id})>0 LIMIT 1`;
  const linked = await db.$queryRaw<
    any[]
  >`SELECT id FROM xhs_subscription_tasks WHERE id<>${item.operation_id} AND instr(document,${item.operation_id})>0 LIMIT 1`;
  check(!requests.length && !whole.length && !linked.length);
  const stops = await db.$queryRaw<
    any[]
  >`SELECT creator_id,generation,owner,CAST(started_at AS TEXT) started_at,state,outcome FROM xhs_refresh_jobs WHERE owner=${item.operation_id}`;
  check(stops.length <= 1);
  let legacyStop: Stop | null = null;
  if (stops.length) {
    const s = stops[0];
    check(
      stopped &&
        kind === 'scheduled-list-prepare-v1' &&
        s.creator_id === item.creator_id &&
        s.owner === item.operation_id &&
        Number.isSafeInteger(Number(s.generation)) &&
        Number(s.generation) > 0 &&
        s.state === 'stopped' &&
        s.outcome === null &&
        time(s.started_at) &&
        BigInt(s.started_at) >= BigInt(row.updated_at),
    );
    legacyStop = { ...s, generation: Number(s.generation) };
  }
  const proof: Proof = {
    kind,
    reviewId: review.id,
    reviewDigest: hash(review),
    budgetId: scope.budgetId,
    budgetDigest: hash(budgets[0]),
    legacyStop,
  };
  // Once audited, cancellation remains valid after policy revocation/session
  // rotation; its immutable review/budget/stop proof still must match exactly.
  if (frozen) check(pack(proof) === pack(frozen));
  return { taskDigest: hash(row), proof, updatedAt: row.updated_at };
}

/** Stopped legacy rows stay intact. Only an exact local audit can carry them. */
export async function assertScheduledLocalStops(
  db: Reader,
  permitted: Stop | null = null,
) {
  const stops = await db.$queryRaw<
    any[]
  >`SELECT creator_id,generation,owner,CAST(started_at AS TEXT) started_at,state,outcome FROM xhs_refresh_jobs WHERE state IN ('running','stopped')`;
  for (const stop of stops) {
    if (
      permitted &&
      hash({ ...stop, generation: Number(stop.generation) }) === hash(permitted)
    )
      continue;
    const items = await db.$queryRaw<
      Item[]
    >`SELECT batch_id,position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE operation_id=${stop.owner} AND state='cancelled'`;
    check(items.length === 1);
    const receipt = await verifyScheduledLocalCancellation(
      db,
      items[0],
      'stopped',
    );
    check(matchesScheduledLocalStop(receipt, stop));
  }
}

async function safety(db: Reader, stop: Stop | null) {
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
  const creators = await db.$queryRaw<
    any[]
  >`SELECT id,external_author_id,enabled FROM xhs_creators ORDER BY id LIMIT 10001`;
  check(
    tasks.length <= 10000 &&
      jobs.length <= 10000 &&
      requests.length <= 100000 &&
      budgets.length <= 10000 &&
      creators.length <= 10000,
  );
  check(
    [...tasks, ...jobs].every(
      (r) =>
        object(JSON.parse(r.document)) &&
        !['queued', 'running'].includes(r.state),
    ) && !requests.some((r) => r.outcome === 'started'),
  );
  await assertScheduledLocalStops(db, stop);
  return {
    risk,
    tasks: hash(tasks),
    jobs: hash(jobs),
    requests: hash(requests),
    budgets: hash(budgets),
    creators: hash(creators),
  };
}

export async function verifyScheduledLocalCancellation(
  db: Reader,
  item: Item,
  batchState: string,
): Promise<ScheduledCancellationReceipt> {
  check(
    batchState === 'stopped' &&
      item.state === 'cancelled' &&
      uuid(item.operation_id) &&
      typeof item.outcome === 'string' &&
      item.outcome.length <= 65536,
  );
  const r = JSON.parse(item.outcome);
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
    'auditDigest',
    'originalBatch',
    'originalItems',
    'scheduledProof',
  ];
  check(
    object(r) &&
      pack(r) === item.outcome &&
      Object.keys(r).length === keys.length &&
      Object.keys(r).every((k) => keys.includes(k)),
  );
  const { auditDigest, ...audit } = r;
  check(
    r.kind === SCHEDULED_LOCAL_CANCELLATION &&
      r.decision === 'cancelled-not-dispatched' &&
      r.batchId === item.batch_id &&
      r.position === item.position &&
      r.creatorId === item.creator_id &&
      r.operationId === item.operation_id &&
      sha(r.digest) &&
      sha(r.taskDigest) &&
      sha(r.backupSha256) &&
      sha(auditDigest) &&
      hash(audit) === auditDigest &&
      Number.isSafeInteger(r.confirmedAt) &&
      r.confirmedAt > 0,
  );
  check(
    object(r.originalBatch) &&
      r.originalBatch.id === item.batch_id &&
      ['running', 'paused', 'stopped'].includes(r.originalBatch.state) &&
      time(r.originalBatch.created_at),
  );
  const batches = await db.$queryRaw<
    Batch[]
  >`SELECT id,state,CAST(created_at AS TEXT) created_at FROM xhs_refresh_batches WHERE id=${item.batch_id}`;
  check(
    batches.length === 1 &&
      batches[0].state === 'stopped' &&
      batches[0].created_at === r.originalBatch.created_at,
  );
  const items = await db.$queryRaw<
    Item[]
  >`SELECT batch_id,position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${item.batch_id} ORDER BY position`;
  check(
    Array.isArray(r.originalItems) &&
      r.originalItems.length > 0 &&
      r.originalItems.length <= 100 &&
      r.originalItems.length === items.length,
  );
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const old = r.originalItems[i],
      current = items[i];
    check(
      object(old) &&
        old.batch_id === item.batch_id &&
        old.position === current.position &&
        old.creator_id === current.creator_id &&
        old.operation_id === current.operation_id &&
        old.outcome === null &&
        current.state === 'cancelled',
    );
    if (old.position === item.position) {
      check(old.state === 'reserved' && current.outcome === item.outcome);
      count++;
    } else
      check(
        ['queued', 'cancelled'].includes(old.state) &&
          old.operation_id === null &&
          current.outcome === null &&
          (old.state !== 'cancelled' || r.originalBatch.state === 'stopped'),
      );
  }
  check(count === 1 && object(r.scheduledProof));
  const proof = await taskProof(
    db,
    item.batch_id,
    item,
    true,
    r.scheduledProof as Proof,
  );
  check(
    proof.taskDigest === r.taskDigest &&
      r.confirmedAt >= Number(proof.updatedAt),
  );
  return r as ScheduledCancellationReceipt;
}

export async function prepareScheduledLocalCancellation(
  db: Reader,
  batchId: string,
) {
  const batches = await db.$queryRaw<
    Batch[]
  >`SELECT id,state,CAST(created_at AS TEXT) created_at FROM xhs_refresh_batches WHERE id=${batchId}`;
  if (batches.length !== 1) return undefined;
  const items = await db.$queryRaw<
    Item[]
  >`SELECT batch_id,position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${batchId} ORDER BY position`;
  const bound = items.filter((i) => i.operation_id !== null);
  if (bound.length !== 1) return undefined;
  const item = bound[0],
    batch = batches[0];
  if (
    item.state === 'cancelled' &&
    item.outcome &&
    JSON.parse(item.outcome).kind === SCHEDULED_LOCAL_CANCELLATION
  ) {
    const receipt = await verifyScheduledLocalCancellation(
      db,
      item,
      batch.state,
    );
    return {
      state: 'cancelled' as const,
      batchId,
      digest: receipt.digest,
      receipt,
    };
  }
  const task = await db.$queryRaw<
    any[]
  >`SELECT document FROM xhs_subscription_tasks WHERE id=${item.operation_id}`;
  if (task.length !== 1 || !JSON.parse(task[0].document).schedule)
    return undefined;
  check(
    uuid(item.operation_id) &&
      ['running', 'paused', 'stopped'].includes(batch.state) &&
      time(batch.created_at) &&
      items.length <= 100 &&
      items.every(
        (i) =>
          i.outcome === null &&
          (i === item
            ? i.state === 'reserved'
            : i.operation_id === null &&
              (i.state === 'queued' ||
                (batch.state === 'stopped' && i.state === 'cancelled'))),
      ),
  );
  const proof = await taskProof(db, batchId, item, batch.state === 'stopped');
  check(BigInt(proof.updatedAt) >= BigInt(batch.created_at));
  const snapshot = {
    batch,
    items,
    taskDigest: proof.taskDigest,
    scheduledProof: proof.proof,
    safety: await safety(db, proof.proof.legacyStop),
  };
  return {
    state: 'reviewable' as const,
    batchId,
    digest: hash(snapshot),
    snapshot,
    item,
    taskDigest: proof.taskDigest,
  };
}

export async function confirmScheduledLocalCancellation(
  db: Tx,
  input: { batchId: string; digest: string; acknowledgedNotDispatched: true },
  backupSha256: string,
  now: number,
) {
  const plan = await prepareScheduledLocalCancellation(db, input.batchId);
  check(
    plan &&
      plan.digest === input.digest &&
      input.acknowledgedNotDispatched === true &&
      sha(backupSha256) &&
      Number.isSafeInteger(now) &&
      now > 0,
  );
  if (plan.state === 'cancelled')
    return { receipt: plan.receipt, alreadyCancelled: true };
  const audit: Omit<ScheduledCancellationReceipt, 'auditDigest'> = {
    kind: SCHEDULED_LOCAL_CANCELLATION,
    decision: 'cancelled-not-dispatched',
    batchId: input.batchId,
    position: plan.item.position,
    creatorId: plan.item.creator_id,
    operationId: plan.item.operation_id!,
    digest: plan.digest,
    taskDigest: plan.taskDigest,
    confirmedAt: now,
    backupSha256,
    originalBatch: plan.snapshot.batch,
    originalItems: plan.snapshot.items,
    scheduledProof: plan.snapshot.scheduledProof,
  };
  const receipt: ScheduledCancellationReceipt = {
    ...audit,
    auditDigest: hash(audit),
  };
  check(
    (await db.$executeRaw`UPDATE xhs_refresh_batch_items SET state='cancelled',outcome=${pack(receipt)} WHERE batch_id=${input.batchId} AND position=${plan.item.position} AND operation_id=${plan.item.operation_id} AND state='reserved' AND outcome IS NULL`) ===
      1,
  );
  check(
    (await db.$executeRaw`UPDATE xhs_refresh_batch_items SET state='cancelled' WHERE batch_id=${input.batchId} AND state='queued' AND operation_id IS NULL AND outcome IS NULL`) ===
      plan.snapshot.items.filter((i) => i.state === 'queued').length,
  );
  check(
    (await db.$executeRaw`UPDATE xhs_refresh_batches SET state='stopped' WHERE id=${input.batchId} AND state=${plan.snapshot.batch.state}`) ===
      1,
  );
  return { receipt, alreadyCancelled: false };
}
