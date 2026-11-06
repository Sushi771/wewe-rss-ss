import type { RoundTx, RoundRequest } from './xhs-unbound-round';
const requireScope = (ok: unknown, code: string) => {
  if (!ok) throw Error(code);
};
export async function readRoundLineage(tx: RoundTx, rootReviewId: string) {
  requireScope(
    /^unbound-[a-f0-9]{64}$/.test(rootReviewId),
    'ORIGINAL_REVIEW_REQUIRED',
  );
  const all = await tx.$queryRawUnsafe<any[]>(
    'SELECT id,plan_digest,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,CAST(approved_at AS TEXT) AS approved_at FROM xhs_unbound_owner_reviews ORDER BY id',
  );
  const root = all.find((r) => r.id === rootReviewId);
  requireScope(root, 'ORIGINAL_REVIEW_REQUIRED');
  const scope = JSON.parse(root.scope_json),
    bindings = JSON.parse(root.creator_bindings_json);
  requireScope(
    !scope.continuationRootReviewId &&
      scope.creatorIds?.length === 3 &&
      new Set(scope.creatorIds).size === 3 &&
      scope.maxListPages === 1,
    'ORIGINAL_THREE_CREATOR_SCOPE_REQUIRED',
  );
  const reviews = all.filter(
    (r) =>
      r.id === rootReviewId ||
      JSON.parse(r.scope_json).continuationRootReviewId === rootReviewId,
  );
  const allRequests = await tx.$queryRawUnsafe<any[]>(
    'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
  );
  const requests = allRequests.filter((r) =>
    reviews.some((v) => v.id === r.review_id),
  );
  requireScope(
    requests.every(
      (r) =>
        scope.creatorIds.includes(r.creator_id) &&
        ['profile', 'list'].includes(r.phase),
    ),
    'LINEAGE_SCOPE_INVALID',
  );
  const receipts = await tx.$queryRawUnsafe<any[]>(
    'SELECT * FROM xhs_unbound_source_receipts ORDER BY operation_id',
  );
  return { root, scope, bindings, reviews, requests, allRequests, receipts };
}
export async function prepareRemainingScope(
  tx: RoundTx,
  creatorIds: string[],
  rootReviewId: string,
  sessionBinding: string,
) {
  const lineage = await readRoundLineage(tx, rootReviewId);
  requireScope(
    /^[a-f0-9]{64}$/.test(sessionBinding),
    'SERVER_SESSION_BINDING_REQUIRED',
  );
  requireScope(
    JSON.stringify([...creatorIds].sort()) ===
      JSON.stringify([...lineage.scope.creatorIds].sort()),
    'ORIGINAL_CREATOR_SCOPE_CHANGED',
  );
  requireScope(
    lineage.allRequests.every((r) =>
      ['unknown', 'response-received', 'not-sent'].includes(r.outcome),
    ),
    'SOURCE_REQUEST_STILL_ACTIVE',
  );
  requireScope(lineage.reviews.length === 1, 'CONTINUATION_ALREADY_REVIEWED');
  requireScope(
    lineage.requests.some((r) => r.outcome === 'unknown') &&
      lineage.requests.every((r) =>
        ['unknown', 'response-received', 'not-sent'].includes(r.outcome),
      ),
    'TERMINAL_UNKNOWN_REQUIRED',
  );
  const creatorIdsRemaining = creatorIds
    .filter((id) => !lineage.requests.some((r) => r.creator_id === id))
    .sort();
  requireScope(
    creatorIdsRemaining.length > 0 && creatorIdsRemaining.length < 3,
    'REMAINING_CREATORS_REQUIRED',
  );
  requireScope(
    lineage.requests.length + creatorIdsRemaining.length * 2 <= 6,
    'ORIGINAL_REQUEST_LIMIT',
  );
  const creators = await tx.$queryRawUnsafe<any[]>(
    'SELECT id,external_author_id,enabled FROM xhs_creators ORDER BY id',
  );
  requireScope(
    creatorIds.every((id) =>
      creators.some(
        (r) =>
          r.id === id &&
          Number(r.enabled) === 1 &&
          r.external_author_id === lineage.bindings[id],
      ),
    ),
    'CREATOR_BINDING_CHANGED',
  );
  return { rootReviewId, sessionBinding, creatorIdsRemaining, lineage };
}
/** Rechecked in the same transaction as request admission and budget reservation. */
export async function assertRemainingAdmission(
  tx: RoundTx,
  reviewId: string,
  scope: any,
  request: RoundRequest,
) {
  const l = await readRoundLineage(tx, scope.continuationRootReviewId);
  requireScope(
    l.reviews.length === 2 && l.reviews.some((r) => r.id === reviewId),
    'CONTINUATION_LINEAGE_CHANGED',
  );
  requireScope(
    ['profile', 'list'].includes(request.phase) &&
      scope.creatorIds.includes(request.creatorId),
    'REMAINING_SCOPE_EXCEEDED',
  );
  requireScope(
    !l.requests.some(
      (r) => r.review_id !== reviewId && r.creator_id === request.creatorId,
    ),
    'CREATOR_ALREADY_ATTEMPTED',
  );
  requireScope(
    l.requests.length < 6 &&
      !l.requests.some(
        (r) => r.creator_id === request.creatorId && r.phase === request.phase,
      ),
    'ORIGINAL_REQUEST_LIMIT',
  );
  if (request.phase === 'list')
    requireScope(
      l.requests.some(
        (r) =>
          r.review_id === reviewId &&
          r.creator_id === request.creatorId &&
          r.phase === 'profile' &&
          r.outcome === 'response-received',
      ),
      'CONFIRMED_PROFILE_REQUIRED',
    );
}
