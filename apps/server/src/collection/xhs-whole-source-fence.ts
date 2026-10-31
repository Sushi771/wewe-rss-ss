import { DispatchOwner, ownsDispatch } from './xhs-dispatch-owner';
import { Prisma } from '@prisma/client';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { activeWholeFence, setActiveWholeFence, retainedGenerationMarkers, generationReviewSettled } from './xhs-whole-generation';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export type Phase = 'profile' | 'list' | 'detail' | 'metrics';
export type Charge = Phase | 'media';
export type Scope = {
  owner: DispatchOwner;
  jobId: string;
  creatorId: string;
  authorId: string;
  marker: string;
  phase: Phase;
  noteId?: string;
  generationId?: string;
  mediaAttempt?: { taskId: string; ordinal: number; resourceKey: string };
};
export type WholeSourceGroup = Scope & { acquired: boolean; started: boolean; mediaDispatch?: (tx: Tx) => Promise<void>; mediaDispatched?: boolean };
const bad = (): never => {
  throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
};
export async function noUnresolvedRecovery(tx: Tx) {
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT original.id FROM xhs_limited_recovery original WHERE original.state IN ('armed','started','unknown') AND NOT EXISTS(SELECT 1 FROM xhs_limited_recovery_append followup WHERE followup.id=original.id AND followup.note_id=original.note_id AND followup.author_id=original.author_id AND followup.state='finished') LIMIT 1`;
  if (rows.length) return bad();
}

/** Must execute under the same SQLite write lock as dispatch admission. */
export async function prepareWholeSourceFence(tx: Tx, scope: Scope) {
  await noUnresolvedRecovery(tx);
  const retained = await retainedGenerationMarkers(tx, scope);
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
  if (scope.mediaAttempt) {
    const { taskId, ordinal, resourceKey } = scope.mediaAttempt;
    if (scope.phase !== 'detail' || !scope.noteId || !taskId || taskId.length > 128 ||
        !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 60 || !/^[a-f0-9]{64}$/.test(resourceKey)) return bad();
    const tasks = await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${taskId} AND creator_id=${scope.creatorId}`;
    if (tasks.length !== 1) return bad();
    const task = JSON.parse(tasks[0].document), noteKey = JSON.stringify(['xiaohongshu','note',scope.noteId]);
    const slot = task.mediaManifests?.[noteKey], image = slot?.manifest?.images?.[ordinal-1];
    if (slot?.manifest?.authorId !== scope.authorId || slot?.manifest?.noteId !== scope.noteId ||
        image?.ordinal !== ordinal || image?.resourceKey !== resourceKey || slot?.items?.[String(ordinal)]) return bad();
  }
  if (
    !job.sourceGrant ||
    job.sourceGrant.creatorId !== scope.creatorId ||
    job.sourceGrant.authorId !== scope.authorId ||
    !Array.isArray(job.sourceGrant.phases) ||
    !job.sourceGrant.phases.includes(scope.phase) ||
    !Number.isSafeInteger(job.sourceGrant.limits?.[scope.phase]) ||
    job.sourceGrant.limits[scope.phase] < 0 ||
    !Number.isSafeInteger(job.sourceGrant.used?.[scope.phase]) ||
    job.sourceGrant.used[scope.phase] < 0 ||
    activeWholeFence(job) || (!!job.generation && job.generation.id !== scope.generationId)
  )
    return bad();
  if (scope.phase === 'detail' || scope.phase === 'metrics') {
    if (!scope.noteId || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.noteId))
      return bad();
    const noteKey = JSON.stringify(['xiaohongshu', 'note', scope.noteId]);
    const recoveredMedia=!!scope.mediaAttempt && generationReviewSettled(job) && job.reviewAttempt?.receipt?.noteId===noteKey;
    if (scope.generationId && (!job.listEnd || !Array.isArray(job.generation.directoryIds) || (!job.generation.directoryIds.includes(noteKey) && !recoveredMedia))) return bad();
    const notes = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_notes WHERE id=${noteKey} AND creator_id=${scope.creatorId}`;
    if (notes.length !== 1) return bad();
  } else if (scope.noteId) return bad();
  const active = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' AND id NOT IN (${Prisma.join(retained.length ? retained : [''])}) LIMIT 1`;
  if (active.length) return bad();
  const owner = scope.owner;
  if (!ownsDispatch(owner, scope.owner)) return bad();
  setActiveWholeFence(job, {
    owner,
    marker: scope.marker,
    phase: scope.phase,
    noteId: scope.noteId,
    state: 'prepared',
    ...(scope.mediaAttempt ? { mediaAttempt: scope.mediaAttempt } : {}),
  });
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
  expectedOwner: DispatchOwner,
  charge?: Charge,
  generationId?: string,
) {
  await noUnresolvedRecovery(tx);
  const rows = await tx.$queryRaw<
    Array<{ document: string }>
  >`SELECT j.document FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id JOIN xhs_source_risk r ON r.id='source' WHERE j.id=${jobId} AND j.state='running' AND c.enabled=1 AND c.external_author_id=json_extract(j.document,'$.sourceGrant.authorId') AND j.creator_id=json_extract(j.document,'$.sourceGrant.creatorId') AND r.state='blocked' AND r.code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED' AND EXISTS(SELECT 1 FROM xhs_request_budgets WHERE id=${marker})`;
  if (rows.length !== 1) return bad();
  const job = JSON.parse(rows[0].document);
  if (job.generation?.id !== generationId) return bad();
  await retainedGenerationMarkers(tx, { jobId, creatorId: job.creatorId, authorId: job.sourceGrant.authorId, generationId });
  const fence = activeWholeFence(job),
    grant = job.sourceGrant,
    category = charge ?? fence?.phase;
  if (
    !fence ||
    !ownsDispatch(fence.owner, expectedOwner) ||
    fence.marker !== marker ||
    !['prepared', 'started'].includes(fence.state) ||
    !grant ||
    (generationId && category !== fence.phase && !(category === 'media' && fence.phase === 'detail')) ||
    !(['profile', 'list', 'detail', 'metrics', 'media'] as string[]).includes(category) ||
    (category === 'media' && fence.phase !== 'detail') ||
    (fence.mediaAttempt && category !== 'media') ||
    (category === 'metrics' && fence.phase !== 'metrics') ||
    (category === 'detail' && fence.phase !== 'detail') ||
    !Number.isSafeInteger(grant.limits?.[category]) ||
    !Number.isSafeInteger(grant.used?.[category])
  )
    return bad();
  if (fence.phase === 'detail' || fence.phase === 'metrics') {
    if (!fence.noteId || !/^[a-zA-Z0-9_-]{1,128}$/.test(fence.noteId))
      return bad();
    const noteKey = JSON.stringify(['xiaohongshu', 'note', fence.noteId]);
    const recoveredMedia=!!fence.mediaAttempt && generationReviewSettled(job) && job.reviewAttempt?.receipt?.noteId===noteKey;
    if (generationId && (!job.listEnd || !Array.isArray(job.generation.directoryIds) || (!job.generation.directoryIds.includes(noteKey) && !recoveredMedia))) return bad();
    const notes = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_notes WHERE id=${noteKey} AND creator_id=${job.creatorId}`;
    if (notes.length !== 1) return bad();
  }
  // Count is observation; prevent unsafe-integer corruption without imposing a business quota.
  if (grant.used[category] >= Number.MAX_SAFE_INTEGER) return bad();
  grant.used[category]++;
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
  expectedOwner: DispatchOwner,
  collectedAt?: number,
  generationId?: string,
) {
  const rows = await tx.$queryRaw<
    Array<{ document: string }>
  >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId} AND state='running' AND EXISTS(SELECT 1 FROM xhs_request_budgets WHERE id=${marker})`;
  if (rows.length !== 1) return bad();
  const job = JSON.parse(rows[0].document),
    fence = activeWholeFence(job);
  if (job.generation?.id !== generationId) return bad();
  await retainedGenerationMarkers(tx, { jobId, creatorId: job.creatorId, authorId: job.sourceGrant.authorId, generationId });
  if (!fence || fence.mediaAttempt || !ownsDispatch(fence.owner, expectedOwner) || fence.marker !== marker || fence.state !== 'started')
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
  job.lastSourceOwnerReceipt = { marker, owner: fence.owner, state: 'checkpointed' };
  if (job.generation && fence.receipt) job.generation.lastSourceReceipt = { ...fence.receipt, stage:'checkpoint', outcome:'checkpointed', settled:true };
  if (job.generation && fence.phase === 'detail' && fence.noteId) {
    const key = JSON.stringify(['xiaohongshu','note',fence.noteId]);
    job.generation.detailReceipts = { ...(job.generation.detailReceipts ?? {}), [key]: { outcome:'checkpointed', at:Date.now(), ...(Number.isInteger(fence.receipt?.status) ? {status:fence.receipt.status} : {}) } };
  }
  setActiveWholeFence(job, undefined);
  const changed =
    await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${jobId} AND state='running' AND document=${rows[0].document}`;
  if (changed !== 1) return bad();
  const removed =
    await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
  if (removed !== 1) return bad();
}

/** Release a media fence only with its own persisted resource receipt. */
export async function commitWholeMediaCheckpoint(tx: Tx, jobId: string, marker: string, expectedOwner: DispatchOwner, generationId?: string) {
  const rows = await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId} AND state='running' AND EXISTS(SELECT 1 FROM xhs_request_budgets WHERE id=${marker})`;
  if (rows.length !== 1) return bad();
  const job = JSON.parse(rows[0].document), fence = activeWholeFence(job), media = fence?.mediaAttempt;
  if (job.generation?.id !== generationId || !media || fence.phase !== 'detail' || !fence.noteId ||
      fence.marker !== marker || fence.state !== 'started' || !ownsDispatch(fence.owner, expectedOwner)) return bad();
  await retainedGenerationMarkers(tx, { jobId, creatorId: job.creatorId, authorId: job.sourceGrant.authorId, generationId });
  const tasks = await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${media.taskId} AND creator_id=${job.creatorId}`;
  if (tasks.length !== 1) return bad();
  const noteKey = JSON.stringify(['xiaohongshu','note',fence.noteId]);
  const slot = JSON.parse(tasks[0].document).mediaManifests?.[noteKey], item = slot?.items?.[String(media.ordinal)];
  if (slot?.manifest?.authorId !== job.sourceGrant.authorId || slot?.manifest?.noteId !== fence.noteId ||
      slot?.manifest?.images?.[media.ordinal-1]?.resourceKey !== media.resourceKey || item?.resourceKey !== media.resourceKey ||
      !((item.state === 'saved' && /^[a-f0-9]{64}$/.test(item.sha256 ?? '') && Number.isSafeInteger(item.bytes) && item.bytes > 0) ||
        (item.state === 'refresh' && ['XHS_MEDIA_HTTP_404','XHS_MEDIA_HTTP_410'].includes(item.code)))) return bad();
  const target = job.generation ?? job, key = JSON.stringify([media.taskId,noteKey,media.ordinal]);
  target.mediaReceipts = { ...(target.mediaReceipts ?? {}), [key]: { resourceKey: media.resourceKey, outcome: item.state, at: Date.now() } };
  job.lastSourceOwnerReceipt = { marker, owner: fence.owner, state: 'checkpointed' };
  setActiveWholeFence(job, undefined);
  const changed = await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${jobId} AND state='running' AND document=${rows[0].document}`;
  if (changed !== 1) return bad();
  const removed = await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
  if (removed !== 1) return bad();
}

/** Only the original dispatch stack may call this after proving transport never started. */
export async function releasePreparedWholeSourceFence(
  tx: Tx,
  jobId: string,
  marker: string,
  expectedOwner: DispatchOwner,
  generationId?: string,
) {
  const ownerRows = await tx.$queryRaw<Array<{ document: string }>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId}`;
  if (ownerRows.length !== 1) return bad();
  const job = JSON.parse(ownerRows[0].document), fence = activeWholeFence(job);
  if (job.generation?.id !== generationId || !ownsDispatch(fence?.owner, expectedOwner) || fence.marker !== marker || fence.state !== 'prepared') return bad();
  setActiveWholeFence(job, undefined);
  const changed =
    await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${jobId} AND document=${ownerRows[0].document} AND EXISTS(SELECT 1 FROM xhs_request_budgets WHERE id=${marker})`;
  if (changed !== 1) return bad();
  const removed =
    await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
  if (removed !== 1) return bad();
}
