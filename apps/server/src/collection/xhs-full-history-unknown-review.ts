import { createHash } from 'node:crypto';
import {
  prepareUnboundRound,
  type RoundTx,
  type RoundRequest,
} from './xhs-unbound-round';
import {
  FULL_HISTORY_KIND,
  fullHistoryBudgetId,
} from './xhs-full-history-scope';

const packed = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const digest = (v: unknown) =>
  createHash('sha256').update(packed(v)).digest('hex');
const rows = (tx: RoundTx, sql: string, ...v: unknown[]) =>
  tx.$queryRawUnsafe<any[]>(sql, ...v);
function check(v: unknown, code: string): asserts v {
  if (!v) throw new Error(code);
}
const phases = ['profile', 'list', 'detail', 'media'] as const;
export type FullHistoryUnknownInput = {
  reviewId: string;
  operationId: string;
  creatorId: string;
  jobId: string;
  expectedTarget: string;
  sessionBinding: string;
};
function mediaNote(target: string) {
  const m = /^([A-Za-z0-9_-]{1,128}):[a-f0-9]{64}$/.exec(target);
  check(m, 'EXACT_UNKNOWN_MEDIA_TARGET_REQUIRED');
  return m[1];
}
async function lineage(tx: RoundTx, reviewId: string) {
  const all = await rows(
    tx,
    'SELECT id,scope_json,creator_bindings_json,backup_sha256 FROM xhs_unbound_owner_reviews ORDER BY id',
  );
  const current = all.find((r) => r.id === reviewId);
  check(current, 'FULL_REVIEW_REQUIRED');
  const scope = JSON.parse(current.scope_json);
  check(scope.reviewKind === FULL_HISTORY_KIND, 'FULL_REVIEW_REQUIRED');
  const ids: string[] = [
    ...new Set<string>([...(scope.lineageReviewIds ?? []), reviewId]),
  ];
  check(
    ids.every((id) =>
      all.some(
        (r) =>
          r.id === id &&
          JSON.parse(r.scope_json).reviewKind === FULL_HISTORY_KIND,
      ),
    ),
    'FULL_REVIEW_LINEAGE_INVALID',
  );
  const rootId = scope.authorizationRootReviewId ?? ids[0];
  const root = all.find((r) => r.id === rootId);
  check(root && ids.includes(rootId), 'FULL_REVIEW_LINEAGE_INVALID');
  const rootScope = JSON.parse(root.scope_json);
  check(
    ids.every(
      (id) =>
        packed(
          JSON.parse(all.find((r) => r.id === id)!.scope_json).bindings,
        ) === packed(rootScope.bindings),
    ),
    'FULL_REVIEW_LINEAGE_INVALID',
  );
  return { all, current, scope, ids, rootId, rootScope };
}
/** Required at common full admission. Approval of a successor never revives old capacity. */
export async function assertFullHistoryReviewLineage(
  tx: RoundTx,
  reviewId: string,
  request?: RoundRequest,
) {
  const l = await lineage(tx, reviewId);
  check(
    !l.all.some(
      (r) =>
        r.id !== reviewId &&
        (JSON.parse(r.scope_json).lineageReviewIds ?? []).includes(reviewId),
    ),
    'FULL_REVIEW_SUPERSEDED',
  );
  const requests = await rows(
    tx,
    'SELECT review_id,phase FROM xhs_unbound_owner_requests',
  );
  const spent = requests.filter((r) => l.ids.includes(r.review_id));
  check(spent.length < l.rootScope.maxRequests, 'FULL_SCOPE_LIMIT_REACHED');
  if (request)
    check(
      spent.filter((r) => r.phase === request.phase).length <
        l.rootScope.phaseLimits[request.phase],
      'FULL_SCOPE_LIMIT_REACHED',
    );
}
/** Read-only unbound-owner review. No claim that pending owner belongs to selected operation. */
export async function prepareFullHistoryUnknownReview(
  tx: RoundTx,
  input: FullHistoryUnknownInput,
) {
  check(
    /^[a-f0-9]{64}$/.test(input.sessionBinding),
    'SESSION_INSTANCE_REQUIRED',
  );
  const l = await lineage(tx, input.reviewId);
  await assertFullHistoryReviewLineage(tx, input.reviewId);
  check(
    l.scope.bindings.some(
      (b: any) => b.creatorId === input.creatorId && b.jobId === input.jobId,
    ),
    'CREATOR_JOB_BINDING_CHANGED',
  );
  const operation = await rows(
    tx,
    'SELECT * FROM xhs_unbound_owner_requests WHERE operation_id=?',
    input.operationId,
  );
  check(
    operation.length === 1 &&
      operation[0].review_id === input.reviewId &&
      operation[0].creator_id === input.creatorId &&
      operation[0].task_id === input.jobId &&
      operation[0].phase === 'media' &&
      operation[0].logical_target === input.expectedTarget &&
      operation[0].outcome === 'unknown',
    'EXACT_UNKNOWN_MEDIA_OPERATION_REQUIRED',
  );
  mediaNote(input.expectedTarget);
  const creatorIds = l.scope.bindings.map((b: any) => b.creatorId);
  // Existing gate proves source is idle and its pending owner is unbound; current restrictions remain closed.
  const pendingPlan = await prepareUnboundRound(tx, creatorIds);
  const allRequests = await rows(
    tx,
    'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
  );
  const spent = allRequests.filter((r) => l.ids.includes(r.review_id));
  const remaining = l.rootScope.maxRequests - spent.length;
  const phaseLimits = Object.fromEntries(
    phases.map((p) => [
      p,
      l.rootScope.phaseLimits[p] - spent.filter((r) => r.phase === p).length,
    ]),
  );
  check(
    remaining > 0 &&
      phases.every(
        (p) => Number.isSafeInteger(phaseLimits[p]) && phaseLimits[p] >= 0,
      ),
    'FULL_SCOPE_LIMIT_REACHED',
  );
  const exclusions: Record<string, { phase: string; target: string }[]> =
    structuredClone(l.scope.exclusions ?? {});
  const incomplete: Record<string, string[]> = structuredClone(
    l.scope.excludedIncompleteNoteIds ?? {},
  );
  const unresolved = allRequests.filter((r) =>
    ['started', 'unknown'].includes(r.outcome),
  );
  for (const r of unresolved.filter((r) => creatorIds.includes(r.creator_id))) {
    const list = (exclusions[r.creator_id] ??= []);
    if (['detail', 'media'].includes(r.phase))
      list.push({ phase: r.phase, target: r.logical_target });
    if (r.phase === 'media') {
      const note = mediaNote(r.logical_target);
      // Existing saver cannot produce a complete note while excluding a required image.
      list.push({ phase: 'detail', target: note });
      (incomplete[r.creator_id] ??= []).push(
        JSON.stringify(['xiaohongshu', 'note', note]),
      );
    }
  }
  for (const id of creatorIds) {
    exclusions[id] = [
      ...new Map((exclusions[id] ?? []).map((x) => [packed(x), x])).values(),
    ];
    incomplete[id] = [...new Set(incomplete[id] ?? [])];
  }
  const localBudgets: {
    creatorId: string;
    jobId: string;
    remaining: number;
    nextAt: unknown;
    intervalMs: unknown;
  }[] = [];
  for (const b of l.scope.bindings) {
    const found = pendingPlan.budgetSnapshot.find(
      (row: any) => row.id === fullHistoryBudgetId(input.reviewId, b.jobId),
    );
    check(
      found &&
        Number.isSafeInteger(Number(found.used)) &&
        Number(found.used) <= Number(found.request_limit),
      'FULL_LOCAL_BUDGET_REQUIRED',
    );
    localBudgets.push({
      creatorId: b.creatorId,
      jobId: b.jobId,
      remaining: Number(found.request_limit) - Number(found.used),
      nextAt: found.next_at,
      intervalMs: found.interval_ms,
    });
  }
  const scope = {
    ...l.scope,
    sessionBinding: input.sessionBinding,
    maxRequests: remaining,
    phaseLimits,
    exclusions,
    excludedIncompleteNoteIds: incomplete,
    authorizationRootReviewId: l.rootId,
    lineageReviewIds: l.ids,
    originalMaxRequests: l.rootScope.maxRequests,
    originalPhaseLimits: l.rootScope.phaseLimits,
    continuationOfReviewId: input.reviewId,
    unknownOwnerBinding: 'unproved',
    unknownOperationId: input.operationId,
    duplicateDirectoryReadPossible: true,
    freshDirectoryScan: true,
    authenticationVerified: false,
  };
  const plan = {
    kind: 'whole-history-unknown-owner-review-v1',
    originalRisk: pendingPlan.originalRisk,
    originalOutcome: 'unknown',
    operation: operation[0],
    allUnresolvedRequests: unresolved,
    ownerOperationBinding: 'unproved',
    oldTaskIds: pendingPlan.oldTaskIds,
    oldJobIds: pendingPlan.oldJobIds,
    creatorBindings: pendingPlan.creatorBindings,
    budgetSnapshot: pendingPlan.budgetSnapshot,
    scope,
    localBudgets,
    stateDigest: digest({
      pendingState: pendingPlan.stateDigest,
      lineage: l.all.filter((r) => l.ids.includes(r.id)),
      allRequests,
    }),
  };
  return { ...plan, digest: digest(plan), sourceRequestsSent: 0 };
}
export async function confirmFullHistoryUnknownReview(
  tx: RoundTx,
  input: FullHistoryUnknownInput & {
    digest: string;
    acknowledgedUnknownOwner: true;
    acknowledgedIncompleteNoteExclusion: true;
    acknowledgedDuplicateDirectoryRead: true;
  },
  host: {
    assertQuiescent(): Promise<void>;
    assertSession(binding: string): void;
    authorizePlan(
      plan: Awaited<ReturnType<typeof prepareFullHistoryUnknownReview>>,
    ): Promise<void>;
    verifyProtectedSnapshot(stateDigest: string): Promise<string>;
  },
  now: bigint,
) {
  check(
    input.acknowledgedUnknownOwner === true &&
      input.acknowledgedIncompleteNoteExclusion === true &&
      input.acknowledgedDuplicateDirectoryRead === true,
    'PLAN_NOT_AUTHORIZED',
  );
  await host.assertQuiescent();
  host.assertSession(input.sessionBinding);
  const plan = await prepareFullHistoryUnknownReview(tx, input);
  check(plan.digest === input.digest, 'REVIEW_STATE_CHANGED');
  await host.authorizePlan(plan);
  const backup = await host.verifyProtectedSnapshot(plan.stateDigest);
  check(/^[a-f0-9]{64}$/.test(backup), 'VERIFIED_PROTECTED_BACKUP_REQUIRED');
  check(now >= BigInt(plan.originalRisk.updated_at), 'APPROVAL_TIME_INVALID');
  const id = 'unbound-' + plan.digest;
  await tx.$executeRawUnsafe(
    'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id,
    plan.digest,
    packed(plan.originalRisk),
    'unknown',
    packed(plan.oldTaskIds),
    packed(plan.oldJobIds),
    packed(plan.creatorBindings),
    packed(plan.budgetSnapshot),
    packed(plan.scope),
    backup,
    now,
  );
  for (const b of plan.localBudgets) {
    check(
      b.remaining >= 0 &&
        Number.isSafeInteger(Number(b.intervalMs)) &&
        Number(b.intervalMs) >= 1000,
      'FULL_LOCAL_BUDGET_REQUIRED',
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,0,?,?,?)',
      fullHistoryBudgetId(id, b.jobId),
      b.remaining,
      b.nextAt,
      b.intervalMs,
    );
  }
  check(
    (await tx.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='clear',owner=NULL,code=NULL,http_status=NULL,endpoint=NULL,updated_at=? WHERE id='source' AND state='pending' AND owner=? AND updated_at=?",
      now,
      plan.originalRisk.owner,
      plan.originalRisk.updated_at,
    )) === 1,
    'PENDING_COMPARE_AND_SWAP_FAILED',
  );
  await host.assertQuiescent();
  host.assertSession(input.sessionBinding);
  return {
    reviewId: id,
    originalOutcome: 'unknown',
    excludedIncompleteNoteIds: plan.scope.excludedIncompleteNoteIds,
    allUnresolvedRequests: plan.allUnresolvedRequests,
    remainingRequests: plan.scope.maxRequests,
    sourceRequestsSent: 0,
  };
}
