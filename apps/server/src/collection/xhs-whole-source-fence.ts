import type { Prisma } from '@prisma/client';
import { XhsSubscriptionError } from './xhs-subscription-errors';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export type Phase = 'profile' | 'list' | 'detail' | 'metrics';
export type Scope = {
  jobId: string;
  creatorId: string;
  authorId: string;
  marker: string;
  phase: Phase;
  noteId?: string;
};
export type WholeSourceGroup = Scope & { acquired: boolean; started: boolean };
const bad = (): never => {
  throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
};
async function noUnresolvedRecovery(tx: Tx) {
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT original.id FROM xhs_limited_recovery original WHERE original.state IN ('armed','started','unknown') AND NOT EXISTS(SELECT 1 FROM xhs_limited_recovery_append followup WHERE followup.id=original.id AND followup.note_id=original.note_id AND followup.author_id=original.author_id AND followup.state='finished') LIMIT 1`;
  if (rows.length) return bad();
}

/** Must execute under the same SQLite write lock as dispatch admission. */
export async function prepareWholeSourceFence(tx: Tx, scope: Scope) {
  await noUnresolvedRecovery(tx);
  if (!/^xhs:dispatch-pending:whole:[a-f0-9-]{36}$/.test(scope.marker))
    return bad();
  const rows = await tx.$queryRaw<Array<{ document: string }>>`
    SELECT j.document FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id
    JOIN xhs_source_risk r ON r.id='source'
    WHERE j.id=${scope.jobId} AND j.creator_id=${scope.creatorId} AND j.state='running'
    AND c.enabled=1 AND c.external_author_id=${scope.authorId}
    AND r.state='blocked' AND r.code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED'`;
  if (rows.length !== 1) return bad();
  const job = JSON.parse(rows[0].document);
  if (
    !job.sourceGrant ||
    job.sourceGrant.creatorId !== scope.creatorId ||
    job.sourceGrant.authorId !== scope.authorId ||
    !Array.isArray(job.sourceGrant.phases) ||
    !job.sourceGrant.phases.includes(scope.phase) ||
    !Number.isSafeInteger(job.sourceGrant.limits?.[scope.phase]) ||
    job.sourceGrant.limits[scope.phase] < 1 ||
    !Number.isSafeInteger(job.sourceGrant.used?.[scope.phase]) ||
    job.sourceGrant.used[scope.phase] < 0 ||
    job.sourceFence
  )
    return bad();
  if (job.sourceGrant.used[scope.phase] >= job.sourceGrant.limits[scope.phase])
    throw new XhsSubscriptionError('XHS_WHOLE_PHASE_BUDGET_EXHAUSTED');
  if (scope.phase === 'detail' || scope.phase === 'metrics') {
    if (!scope.noteId || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.noteId))
      return bad();
    const noteKey = JSON.stringify(['xiaohongshu', 'note', scope.noteId]);
    const notes = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_notes WHERE id=${noteKey} AND creator_id=${scope.creatorId}`;
    if (notes.length !== 1) return bad();
  } else if (scope.noteId) return bad();
  const active = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' LIMIT 1`;
  if (active.length) return bad();
  job.sourceFence = {
    marker: scope.marker,
    phase: scope.phase,
    noteId: scope.noteId,
    state: 'prepared',
  };
  const changed =
    await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${scope.jobId} AND state='running' AND document=${rows[0].document}`;
  if (changed !== 1) return bad();
  await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${scope.marker},1,1,${BigInt(Date.now())},0)`;
}
/** Synchronous transport entry is serialized with the durable started state. */
export async function markWholeSourceStarted(
  tx: Tx,
  jobId: string,
  marker: string,
) {
  await noUnresolvedRecovery(tx);
  const rows = await tx.$queryRaw<
    Array<{ document: string }>
  >`SELECT j.document FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id JOIN xhs_source_risk r ON r.id='source' WHERE j.id=${jobId} AND j.state='running' AND c.enabled=1 AND c.external_author_id=json_extract(j.document,'$.sourceGrant.authorId') AND j.creator_id=json_extract(j.document,'$.sourceGrant.creatorId') AND r.state='blocked' AND r.code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED' AND EXISTS(SELECT 1 FROM xhs_request_budgets WHERE id=${marker})`;
  if (rows.length !== 1) return bad();
  const job = JSON.parse(rows[0].document);
  const fence = job.sourceFence,
    grant = job.sourceGrant;
  if (
    !fence ||
    fence.marker !== marker ||
    !['prepared', 'started'].includes(fence.state) ||
    !grant ||
    !Number.isSafeInteger(grant.limits?.[fence.phase]) ||
    !Number.isSafeInteger(grant.used?.[fence.phase]) ||
    grant.used[fence.phase] >= grant.limits[fence.phase]
  )
    return bad();
  if (fence.phase === 'detail' || fence.phase === 'metrics') {
    if (!fence.noteId || !/^[a-zA-Z0-9_-]{1,128}$/.test(fence.noteId))
      return bad();
    const noteKey = JSON.stringify(['xiaohongshu', 'note', fence.noteId]);
    const notes = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_notes WHERE id=${noteKey} AND creator_id=${job.creatorId}`;
    if (notes.length !== 1) return bad();
  }
  grant.used[fence.phase]++;
  fence.state = 'started';
  const changed =
    await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${jobId} AND state='running' AND document=${rows[0].document}`;
  if (changed !== 1) return bad();
}
/** Call only inside the transaction persisting the corresponding business checkpoint. */
export async function commitWholeSourceCheckpoint(
  tx: Tx,
  jobId: string,
  marker: string,
  collectedAt?: number,
) {
  const rows = await tx.$queryRaw<
    Array<{ document: string }>
  >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId} AND state='running' AND EXISTS(SELECT 1 FROM xhs_request_budgets WHERE id=${marker})`;
  if (rows.length !== 1) return bad();
  const job = JSON.parse(rows[0].document),
    fence = job.sourceFence;
  if (!fence || fence.marker !== marker || fence.state !== 'started')
    return bad();
  if (fence.phase === 'profile' || fence.phase === 'metrics') {
    if (!Number.isSafeInteger(collectedAt) || !collectedAt || collectedAt < 1)
      return bad();
    if (fence.phase === 'profile') job.profile = collectedAt;
    else {
      if (!fence.noteId) return bad();
      const key = JSON.stringify(['xiaohongshu', 'note', fence.noteId]);
      if (!job.items?.[key]) return bad();
      job.items[key].metrics = collectedAt;
    }
  }
  delete job.sourceFence;
  const changed =
    await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${jobId} AND state='running' AND document=${rows[0].document}`;
  if (changed !== 1) return bad();
  const removed =
    await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
  if (removed !== 1) return bad();
}

/** Only the original dispatch stack may call this after proving transport never started. */
export async function releasePreparedWholeSourceFence(
  tx: Tx,
  jobId: string,
  marker: string,
) {
  const changed =
    await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.sourceFence'),updated_at=${BigInt(Date.now())} WHERE id=${jobId} AND json_extract(document,'$.sourceFence.marker')=${marker} AND json_extract(document,'$.sourceFence.state')='prepared' AND EXISTS(SELECT 1 FROM xhs_request_budgets WHERE id=${marker})`;
  if (changed !== 1) return bad();
  const removed =
    await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
  if (removed !== 1) return bad();
}
