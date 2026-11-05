import { TextDecoder } from 'node:util';
import { XhsSubscriptionError } from './xhs-subscription-errors';

export type LegacyXhsQuery = {
  $queryRaw<T>(sql: TemplateStringsArray, ...values: any[]): Promise<T>;
};
export const LEGACY_XHS_REVIEW = 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED';
export type LegacyXhsFence = {
  state: 'absent' | 'clear' | 'blocked';
  reason?:
    | 'schema'
    | 'unavailable'
    | 'limit'
    | 'receipt'
    | 'state'
    | 'unresolved';
};
const tables: Record<string, string> = {
  xhs_refresh_jobs:
    'CREATE TABLE "xhs_refresh_jobs" (\n  "creator_id" TEXT NOT NULL,\n  "generation" INTEGER NOT NULL,\n  "owner" TEXT NOT NULL,\n  "started_at" INTEGER NOT NULL,\n  "state" TEXT NOT NULL CHECK ("state" IN (\'running\', \'stopped\', \'complete\')),\n  "outcome" TEXT,\n  PRIMARY KEY ("creator_id", "generation"),\n  FOREIGN KEY ("creator_id") REFERENCES "xhs_creators"("id") ON DELETE RESTRICT\n)',
  xhs_refresh_failures:
    'CREATE TABLE "xhs_refresh_failures" (\n  "creator_id" TEXT NOT NULL,\n  "generation" INTEGER NOT NULL,\n  "note_id" TEXT NOT NULL,\n  "code" TEXT NOT NULL CHECK ("code" = \'NOTE_BODY_OR_MEDIA_INVALID\'),\n  PRIMARY KEY ("creator_id", "generation", "note_id")\n)',
  xhs_refresh_batches:
    'CREATE TABLE "xhs_refresh_batches" (\n  "id" TEXT NOT NULL PRIMARY KEY,\n  "state" TEXT NOT NULL CHECK ("state" IN (\'running\',\'paused\',\'stopped\',\'complete\')),\n  "created_at" INTEGER NOT NULL\n)',
  xhs_refresh_batch_items:
    'CREATE TABLE "xhs_refresh_batch_items" (\n  "batch_id" TEXT NOT NULL REFERENCES "xhs_refresh_batches"("id") ON DELETE RESTRICT,\n  "position" INTEGER NOT NULL,\n  "creator_id" TEXT NOT NULL REFERENCES "xhs_creators"("id") ON DELETE RESTRICT,\n  "operation_id" TEXT,\n  "state" TEXT NOT NULL CHECK ("state" IN (\'queued\',\'reserved\',\'complete\',\'partial\',\'cancelled\')),\n  "outcome" TEXT,\n  PRIMARY KEY ("batch_id", "position"),\n  UNIQUE ("batch_id", "creator_id"),\n  UNIQUE ("operation_id")\n)',
};
const indexes: Record<string, string> = {
  xhs_refresh_one_unresolved:
    'CREATE UNIQUE INDEX "xhs_refresh_one_unresolved" ON "xhs_refresh_jobs"("creator_id") WHERE "state" IN (\'running\', \'stopped\')',
  xhs_refresh_source_unresolved:
    'CREATE UNIQUE INDEX "xhs_refresh_source_unresolved" ON "xhs_refresh_jobs"((1)) WHERE "state" IN (\'running\', \'stopped\')',
  xhs_refresh_operation_id:
    'CREATE UNIQUE INDEX "xhs_refresh_operation_id" ON "xhs_refresh_jobs"("owner")',
  xhs_refresh_batches_one_active:
    'CREATE UNIQUE INDEX "xhs_refresh_batches_one_active" ON "xhs_refresh_batches"((1)) WHERE "state" IN (\'running\',\'paused\')',
};
// Normalize only SQL syntax. String literal bytes/case/whitespace carry semantics.
function normalize(sql: string) {
  let value = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      value += c;
      for (i++; i < sql.length; i++) {
        value += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += sql[++i];
            continue;
          }
          break;
        }
      }
    } else if (c === '"' || c.charCodeAt(0) === 96) {
      let identifier = '';
      for (i++; i < sql.length; i++) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            identifier += sql[++i];
            continue;
          }
          break;
        }
        identifier += sql[i];
      }
      value += identifier.toLowerCase();
    } else if (!/\s/.test(c)) value += c.toLowerCase();
  }
  return value.replace(/;$/, '');
}
const blocked = (reason: LegacyXhsFence['reason']): LegacyXhsFence => ({
  state: 'blocked',
  reason,
});
const integer = (v: unknown, min = 0) =>
  (typeof v === 'number' || typeof v === 'bigint') &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) >= min;
const identity = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 300;
const operation = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
type Receipt = {
  status: 'complete' | 'partial';
  added: number;
  message: string;
  failureScope?: 'article';
  failedCount?: number;
};
function receipt(row: any): Receipt | undefined {
  // HEX is a stable TEXT projection even when the first SQLite result is NULL.
  // Preserve SQL NULL/storage kind; never guess a base64 interpretation.
  if (
    row.outcome_storage !== 'text' ||
    typeof row.outcome !== 'string' ||
    typeof row.outcome_hex !== 'string' ||
    !row.outcome_hex.length ||
    row.outcome_hex.length > 32 * 1024 * 1024 ||
    row.outcome_hex.length % 2 !== 0 ||
    /[^0-9A-F]/.test(row.outcome_hex) ||
    Number(row.duplicates) !== 0
  )
    return;
  const outcomeBytes = Buffer.from(row.outcome_hex, 'hex');
  let value: any;
  try {
    if (
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        outcomeBytes,
      ) !== row.outcome
    )
      return;
    value = JSON.parse(row.outcome);
  } catch {
    return;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['complete', 'partial'].includes(value.status) ||
    !Number.isSafeInteger(value.added) ||
    value.added < 0 ||
    typeof value.message !== 'string'
  )
    return;
  if (
    Object.keys(value).some(
      (k) =>
        !['status', 'added', 'message', 'failureScope', 'failedCount'].includes(
          k,
        ),
    )
  )
    return;
  if ((value.failureScope === undefined) !== (value.failedCount === undefined))
    return;
  if (
    value.failureScope !== undefined &&
    (value.status !== 'partial' ||
      value.failureScope !== 'article' ||
      !Number.isSafeInteger(value.failedCount) ||
      value.failedCount < 1)
  )
    return;
  return value;
}
const acceptedItem = (value: Receipt) =>
  value.status === 'complete' ||
  (value.status === 'partial' &&
    value.failureScope === 'article' &&
    integer(value.failedCount, 1));

/** Observes legacy receipts only. Never repairs, replays, clears or transfers ownership.
 * Call again inside candidate admission/dispatch transactions. This does not make
 * unmodified legacy processes share the candidate lock: release still requires
 * every old writer to be quiescent and a verified consistent database snapshot. */
export async function readLegacyXhsSourceFence(
  db: LegacyXhsQuery,
): Promise<LegacyXhsFence> {
  try {
    const schema = await db.$queryRaw<
      Array<{ name: string; type: string; sql: string | null }>
    >`SELECT name,type,sql FROM sqlite_master WHERE name IN ('xhs_refresh_jobs','xhs_refresh_failures','xhs_refresh_batches','xhs_refresh_batch_items','xhs_refresh_one_unresolved','xhs_refresh_source_unresolved','xhs_refresh_operation_id','xhs_refresh_batches_one_active','xhs_subscription_tasks','xhs_subscription_tasks_creator_id_state_idx')`;
    const legacyObjects = schema.filter(
      (row) =>
        ![
          'xhs_subscription_tasks',
          'xhs_subscription_tasks_creator_id_state_idx',
        ].includes(row.name),
    );
    if (!legacyObjects.length) {
      const history = await db.$queryRaw<
        Array<{ name: string }>
      >`SELECT name FROM sqlite_master WHERE name='_prisma_migrations'`;
      if (history.length) {
        const receipts = await db.$queryRaw<
          Array<{ migration_name: string }>
        >`SELECT migration_name FROM _prisma_migrations WHERE migration_name IN ('20261105000000_xhs_refresh_ledger','20261106000000_xhs_refresh_batches') LIMIT 1`;
        if (receipts.length) return blocked('schema');
      }
      // Absence is an observation, not proof that no old writer/history existed.
      return { state: 'absent' };
    }
    // Versioned complete three-table profiles. Mixed old/new timestamps stay closed.
    const schemaTables = {
      ...tables,
      xhs_subscription_tasks:
        'CREATE TABLE "xhs_subscription_tasks" (\r\n  "id" TEXT NOT NULL PRIMARY KEY,\r\n  "creator_id" TEXT NOT NULL,\r\n  "state" TEXT NOT NULL,\r\n  "document" TEXT NOT NULL,\r\n  "updated_at" INTEGER NOT NULL\r\n)',
    };
    const oldDefinitions = {
      ...schemaTables,
      ...indexes,
      xhs_subscription_tasks_creator_id_state_idx:
        'CREATE INDEX "xhs_subscription_tasks_creator_id_state_idx" ON "xhs_subscription_tasks"("creator_id", "state")',
    };
    const bigintDefinitions = {
      ...oldDefinitions,
      xhs_subscription_tasks: schemaTables.xhs_subscription_tasks.replace(
        '"updated_at" INTEGER NOT NULL',
        '"updated_at" BIGINT NOT NULL',
      ),
      xhs_refresh_jobs: tables.xhs_refresh_jobs.replace(
        '"started_at" INTEGER NOT NULL',
        '"started_at" BIGINT NOT NULL',
      ),
      xhs_refresh_batches: tables.xhs_refresh_batches.replace(
        '"created_at" INTEGER NOT NULL',
        '"created_at" BIGINT NOT NULL',
      ),
    };
    const knownProfile = [oldDefinitions, bigintDefinitions].some(
      (definitions) =>
        Object.entries(definitions).every(([name, sql]) => {
          const actual = schema.filter((s) => s.name === name);
          return (
            actual.length === 1 &&
            actual[0].type === (name in schemaTables ? 'table' : 'index') &&
            typeof actual[0].sql === 'string' &&
            normalize(actual[0].sql!) === normalize(sql)
          );
        }),
    );
    if (!knownProfile) return blocked('schema');
    const jobs = await db.$queryRaw<
      any[]
    >`SELECT j.*, typeof(outcome) AS outcome_storage, CASE WHEN outcome IS NULL THEN NULL ELSE hex(CAST(outcome AS BLOB)) END AS outcome_hex,
      CASE WHEN typeof(outcome)='text' AND length(CAST(outcome AS BLOB))<=16777216 AND json_valid(outcome) THEN
        (SELECT COUNT(*) FROM (SELECT parent,key FROM json_tree(j.outcome) WHERE typeof(key)='text' GROUP BY parent,key HAVING COUNT(*)>1)) ELSE -1 END AS duplicates,
      EXISTS(SELECT 1 FROM xhs_creators c WHERE c.id=j.creator_id) AS creator_exists
      FROM xhs_refresh_jobs j LIMIT 10001`;
    const batches = await db.$queryRaw<
      any[]
    >`SELECT * FROM xhs_refresh_batches LIMIT 10001`;
    const items = await db.$queryRaw<
      any[]
    >`SELECT i.*, typeof(outcome) AS outcome_storage, CASE WHEN outcome IS NULL THEN NULL ELSE hex(CAST(outcome AS BLOB)) END AS outcome_hex,
      CASE WHEN typeof(outcome)='text' AND length(CAST(outcome AS BLOB))<=16777216 AND json_valid(outcome) THEN
        (SELECT COUNT(*) FROM (SELECT parent,key FROM json_tree(i.outcome) WHERE typeof(key)='text' GROUP BY parent,key HAVING COUNT(*)>1)) ELSE -1 END AS duplicates,
      EXISTS(SELECT 1 FROM xhs_creators c WHERE c.id=i.creator_id) AS creator_exists
      FROM xhs_refresh_batch_items i LIMIT 10001`;
    const failures = await db.$queryRaw<
      any[]
    >`SELECT * FROM xhs_refresh_failures LIMIT 10001`;
    if ([jobs, batches, items, failures].some((rows) => rows.length > 10000))
      return blocked('limit');
    const byOwner = new Map<string, any>(),
      byBatch = new Map<string, any>();
    let unresolved = false;
    for (const job of jobs) {
      if (
        !identity(job.creator_id) ||
        !operation(job.owner) ||
        !integer(job.generation, 1) ||
        !integer(job.started_at) ||
        Number(job.creator_exists) !== 1 ||
        !['running', 'stopped', 'complete'].includes(job.state) ||
        byOwner.has(job.owner)
      )
        return blocked('state');
      byOwner.set(job.owner, job);
      if (job.state !== 'complete') {
        unresolved = true;
        if (job.outcome !== null && !receipt(job)) return blocked('receipt');
      } else if (!receipt(job)) return blocked('receipt');
    }
    for (const failure of failures) {
      if (
        !identity(failure.creator_id) ||
        !integer(failure.generation, 1) ||
        !identity(failure.note_id) ||
        failure.code !== 'NOTE_BODY_OR_MEDIA_INVALID' ||
        !jobs.some(
          (j) =>
            j.creator_id === failure.creator_id &&
            Number(j.generation) === Number(failure.generation),
        )
      )
        return blocked('state');
    }
    for (const batch of batches) {
      if (
        !identity(batch.id) ||
        !integer(batch.created_at) ||
        !['running', 'paused', 'stopped', 'complete'].includes(batch.state) ||
        byBatch.has(batch.id)
      )
        return blocked('state');
      byBatch.set(batch.id, batch);
      if (batch.state === 'running' || batch.state === 'paused')
        unresolved = true;
    }
    for (const item of items) {
      const batch = byBatch.get(item.batch_id);
      if (
        !batch ||
        !identity(item.creator_id) ||
        Number(item.creator_exists) !== 1 ||
        !integer(item.position) ||
        !['queued', 'reserved', 'complete', 'partial', 'cancelled'].includes(
          item.state,
        )
      )
        return blocked('state');
      if (item.state === 'queued' || item.state === 'cancelled') {
        if (
          item.operation_id !== null ||
          item.outcome !== null ||
          (item.state === 'queued' && batch.state !== 'running') ||
          (item.state === 'cancelled' && batch.state !== 'stopped')
        )
          return blocked('state');
        if (item.state === 'queued') unresolved = true;
        continue;
      }
      const job = byOwner.get(item.operation_id);
      if (
        !operation(item.operation_id) ||
        !job ||
        job.creator_id !== item.creator_id
      )
        return blocked('state');
      const jobReceipt = job.state === 'complete' ? receipt(job) : undefined;
      if (item.state === 'reserved') {
        if (item.outcome !== null || batch.state === 'complete')
          return blocked('state');
        // stop can race a committed receipt before batch bookkeeping. Observing
        // that exact receipt does not replay or mutate the reserved operation.
        if (batch.state !== 'stopped' || !jobReceipt) unresolved = true;
      } else {
        const value = receipt(item);
        if (
          !value ||
          !acceptedItem(value) ||
          value.status !== item.state ||
          !jobReceipt ||
          item.outcome !== job.outcome
        )
          return blocked('receipt');
      }
    }
    if (batches.some((b) => !items.some((i) => i.batch_id === b.id)))
      return blocked('state');
    return unresolved ? blocked('unresolved') : { state: 'clear' };
  } catch {
    return blocked('unavailable');
  }
}
export async function assertLegacyXhsSourceReady(
  db: LegacyXhsQuery,
): Promise<void> {
  if ((await readLegacyXhsSourceFence(db)).state === 'blocked')
    throw new XhsSubscriptionError(LEGACY_XHS_REVIEW);
}
