import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { readHistoryHandoffs } from './xhs-history-handoff';
import { taskSourceFingerprint } from './xhs-task-source-fence';
import { XhsSubscriptionError } from './xhs-subscription-errors';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
const deny = (): never => {
  throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const restricted = (x: any): boolean => {
  if (!x || typeof x !== 'object') return false;
  if (
    typeof x.code === 'string' &&
    /^XHS_SOURCE_(?:AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(
      x.code,
    )
  )
    return true;
  if (
    [x.status, x.httpStatus, x.http_status].some((v) =>
      [401, 403, 406, 429, 461, 471].includes(v),
    )
  )
    return true;
  const failures =
    x.sourceFailures && typeof x.sourceFailures === 'object'
      ? Object.values(x.sourceFailures)
      : [];
  return [
    x.sourceReceipt,
    x.lastSourceReceipt,
    x.receipt,
    x.sourceFence,
    x.activeFence,
    x.generation,
    x.taskFailure,
    ...failures,
    ...(Array.isArray(x.events) ? x.events : []),
  ].some(restricted);
};

/** Preview a legacy unbound owner. The selected note is a conservative
 * exclusion, never an assertion that the owner actually belongs to it. */
export async function prepareLegacyPendingReview(tx: Tx) {
  const risk = await tx.$queryRaw<
    Array<{
      state: string;
      owner: string | null;
      code: string | null;
      http_status: number | null;
      endpoint: string | null;
      updated_at: string;
    }>
  >`SELECT state,owner,code,http_status,endpoint,CAST(updated_at AS TEXT) AS updated_at FROM xhs_source_risk WHERE id='source'`;
  if (
    risk.length !== 1 ||
    risk[0].state !== 'pending' ||
    !risk[0].owner ||
    !/^[a-f0-9-]{36}$/.test(risk[0].owner) ||
    risk[0].code !== null ||
    risk[0].http_status !== null ||
    risk[0].endpoint !== null ||
    !/^\d+$/.test(risk[0].updated_at)
  )
    return deny();
  const tasks = await tx.$queryRaw<
    Array<{
      id: string;
      creator_id: string;
      state: string;
      document: string;
      updated_at: string;
    }>
  >`SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_subscription_tasks ORDER BY id`;
  const jobs = await tx.$queryRaw<
    Array<{ id: string; state: string; document: string; updated_at: string }>
  >`SELECT id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_whole_creator_jobs ORDER BY id`;
  if (
    tasks.some(
      (t) =>
        !['completed', 'partial', 'blocked', 'failed', 'cancelled'].includes(
          t.state,
        ),
    ) ||
    jobs.some(
      (j) =>
        !['completed', 'partial', 'paused', 'failed', 'cancelled'].includes(
          j.state,
        ),
    )
  )
    return deny();
  const candidates: Array<{
    taskId: string;
    creatorId: string;
    noteKey: string;
    noteId: string;
    raw: string;
  }> = [];
  for (const row of tasks) {
    let task: any;
    try {
      task = JSON.parse(row.document);
    } catch {
      return deny();
    }
    if (
      !task ||
      task.taskId !== row.id ||
      task.creatorId !== row.creator_id ||
      task.state !== row.state ||
      !/^\d+$/.test(row.updated_at)
    )
      return deny();
    if (JSON.stringify(task).includes(risk[0].owner!)) return deny();
    if (
      BigInt(row.updated_at) >= BigInt(risk[0].updated_at) &&
      restricted(task)
    )
      return deny();
    if (
      !['blocked', 'partial', 'failed', 'cancelled'].includes(row.state) ||
      BigInt(row.updated_at) < BigInt(risk[0].updated_at) ||
      task.sourceActive ||
      task.sourcePreflight ||
      !Array.isArray(task.noteIds) ||
      !task.sourceFailures ||
      typeof task.sourceFailures !== 'object'
    )
      continue;
    for (const [noteKey, failure] of Object.entries(
      task.sourceFailures,
    ) as Array<[string, any]>) {
      if (
        failure?.guardCode !== 'P2028' ||
        failure.guardStage !== 'source-admission' ||
        failure.dispatched !== false ||
        failure.code !== 'XHS_STORAGE_FAILED' ||
        !task.noteIds.includes(noteKey)
      )
        continue;
      let tuple: any;
      try {
        tuple = JSON.parse(noteKey);
      } catch {
        return deny();
      }
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 3 ||
        tuple[0] !== 'xiaohongshu' ||
        tuple[1] !== 'note' ||
        typeof tuple[2] !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(tuple[2])
      )
        return deny();
      candidates.push({
        taskId: row.id,
        creatorId: row.creator_id,
        noteKey,
        noteId: tuple[2],
        raw: row.document,
      });
    }
  }
  for (const row of jobs) {
    let job: any;
    try {
      job = JSON.parse(row.document);
    } catch {
      return deny();
    }
    if (
      !/^\d+$/.test(row.updated_at) ||
      JSON.stringify(job).includes(risk[0].owner!) ||
      (BigInt(row.updated_at) >= BigInt(risk[0].updated_at) && restricted(job))
    )
      return deny();
  }
  if (candidates.length !== 1) return deny();
  const selected = candidates[0];
  const note = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM xhs_notes WHERE id=${selected.noteKey} AND creator_id=${selected.creatorId}`;
  if (note.length !== 1) return deny();
  const cursorHash = hash(''),
    fingerprint = taskSourceFingerprint(
      selected.creatorId,
      'detail',
      selected.noteId,
      cursorHash,
    ),
    marker = 'xhs:dispatch-pending:unknown:' + fingerprint;
  const prior = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM xhs_subscription_tasks WHERE json_valid(document) AND (json_extract(document,'$.sourceActive.fingerprint')=${fingerprint} OR EXISTS(SELECT 1 FROM json_each(document,'$.sourceUnknowns') j WHERE json_extract(j.value,'$.fingerprint')=${fingerprint})) LIMIT 1`;
  if (prior.length) return deny();
  const histories = await readHistoryHandoffs(tx),
    pending = await tx.$queryRaw<
      Array<{ id: string; used: number; request_limit: number }>
    >`SELECT id,used,request_limit FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' ORDER BY id`;
  const expected = [...new Set(histories.markers)].sort();
  if (
    pending.length !== expected.length ||
    pending.some(
      (p, i) => p.id !== expected[i] || p.used !== 1 || p.request_limit !== 1,
    )
  )
    return deny();
  const budgets = await tx.$queryRaw<
    Array<{
      id: string;
      used: number;
      request_limit: number;
      next_at: string;
      interval_ms: number;
    }>
  >`SELECT id,used,request_limit,CAST(next_at AS TEXT) AS next_at,interval_ms FROM xhs_request_budgets ORDER BY id`;
  if (!budgets.some((b) => b.id === 'xhs:source-total')) return deny();
  const digest = hash(
    JSON.stringify({
      kind: 'legacy-pending-owner-review-v1',
      risk,
      tasks,
      jobs,
      pending,
      budgets,
      selected: {
        taskId: selected.taskId,
        creatorId: selected.creatorId,
        noteKey: selected.noteKey,
      },
      fingerprint,
    }),
  );
  return {
    kind: 'legacy-pending' as const,
    digest,
    taskId: selected.taskId,
    creatorId: selected.creatorId,
    noteKey: selected.noteKey,
    fingerprint,
    marker,
    cursorHash,
    risk: risk[0],
    budgets,
    raw: selected.raw,
  };
}

/** Caller supplies an independently verified backup and holds the write lock. */
export async function confirmLegacyPendingReview(
  tx: Tx,
  input: {
    digest: string;
    acknowledgedUnknownScope: true;
    backupSha256: string;
  },
  now = Date.now(),
) {
  if (
    input.acknowledgedUnknownScope !== true ||
    !/^[a-f0-9]{64}$/.test(input.digest) ||
    !/^[a-f0-9]{64}$/.test(input.backupSha256) ||
    !Number.isSafeInteger(now) ||
    now < 1
  )
    return deny();
  const lock = await tx.$queryRaw<
    Array<{ id: string }>
  >`UPDATE xhs_request_budgets SET next_at=next_at WHERE id='xhs:source-total' RETURNING id`;
  if (lock.length !== 1) return deny();
  const s = await prepareLegacyPendingReview(tx);
  if (s.digest !== input.digest) return deny();
  const task = JSON.parse(s.raw),
    entries = task.sourceUnknowns ?? [],
    reviews = task.legacyPendingReviews ?? [];
  if (
    !Array.isArray(entries) ||
    entries.length >= 1000 ||
    !Array.isArray(reviews) ||
    reviews.length >= 100
  )
    return deny();
  entries.push({
    marker: s.marker,
    fingerprint: s.fingerprint,
    phase: 'detail',
    targetHash: hash(JSON.parse(s.noteKey)[2]),
    cursorHash: s.cursorHash,
    outcome: 'unknown',
    classification: 'request-outcome-unknown',
    taskId: s.taskId,
    creatorId: s.creatorId,
    provenance: 'legacy-pending-conservative-exclusion',
    ownerBinding: 'unproved',
  });
  reviews.push({
    version: 1,
    digest: s.digest,
    confirmedAt: now,
    riskSnapshot: s.risk,
    budgetSnapshot: s.budgets,
    backupSha256: input.backupSha256,
    ownerBinding: 'unproved',
    knownTarget: s.noteKey,
    acknowledgedUnknownScope: true,
  });
  task.sourceUnknowns = entries;
  task.legacyPendingReviews = reviews;
  await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${s.marker},1,1,0,0)`;
  if (
    (await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)},updated_at=${BigInt(now)} WHERE id=${s.taskId} AND creator_id=${s.creatorId} AND document=${s.raw}`) !==
    1
  )
    return deny();
  if (
    (await tx.$executeRaw`UPDATE xhs_source_risk SET state='clear',owner=NULL,code=NULL,http_status=NULL,endpoint=NULL,updated_at=${BigInt(now)} WHERE id='source' AND state='pending' AND owner=${s.risk.owner} AND code IS NULL AND http_status IS NULL AND endpoint IS NULL AND updated_at=${BigInt(s.risk.updated_at)}`) !==
    1
  )
    return deny();
  return { state: 'confirmed' as const, excludedCount: 1 };
}
