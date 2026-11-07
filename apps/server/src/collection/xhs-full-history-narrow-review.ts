import { createHash } from 'node:crypto';
import {
  prepareFullHistoryScope,
  fullHistoryBudgetId,
} from './xhs-full-history-scope';
import {
  fullHistoryLineage,
  assertFullHistoryReviewLineage,
} from './xhs-full-history-unknown-review';
import type { RoundTx } from './xhs-unbound-round';
const packed = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const hash = (v: unknown) =>
  createHash('sha256').update(packed(v)).digest('hex');
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error(code);
}
const rows = (tx: RoundTx, sql: string, ...v: unknown[]) =>
  tx.$queryRawUnsafe<any[]>(sql, ...v);
export type FullHistoryNarrowInput = {
  reviewId: string;
  creatorId: string;
  jobId: string;
  sessionBinding: string;
};
/** Rebuild exclusions from unchanged raw evidence; only remove the proved redundant detail wildcard. */
export async function prepareFullHistoryNarrowReview(
  tx: RoundTx,
  input: FullHistoryNarrowInput,
) {
  const l = await fullHistoryLineage(tx, input.reviewId);
  await assertFullHistoryReviewLineage(tx, input.reviewId);
  check(
    l.scope.bindings.some(
      (b: any) => b.creatorId === input.creatorId && b.jobId === input.jobId,
    ),
    'CREATOR_JOB_BINDING_CHANGED',
  );
  const fresh = await prepareFullHistoryScope(tx, {
    bindings: l.scope.bindings,
    sessionBinding: input.sessionBinding,
    maxRequests: l.rootScope.maxRequests,
    phaseLimits: l.rootScope.phaseLimits,
  });
  const original = l.scope.exclusions[input.creatorId] ?? [];
  check(
    original.some((x: any) => x.phase === 'detail' && x.target === '*'),
    'REDUNDANT_WILDCARD_REQUIRED',
  );
  const rebuilt = fresh.scope.exclusions[input.creatorId] ?? [];
  check(
    !rebuilt.some((x: any) => x.phase === 'detail' && x.target === '*'),
    'UNBOUND_DETAIL_UNKNOWN_REMAINS',
  );
  const allRequests = await rows(
    tx,
    'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
  );
  const spent = allRequests.filter((r) => l.ids.includes(r.review_id));
  const remaining = l.rootScope.maxRequests - spent.length;
  const phaseLimits = Object.fromEntries(
    ['profile', 'list', 'detail', 'media'].map((p) => [
      p,
      l.rootScope.phaseLimits[p] - spent.filter((r) => r.phase === p).length,
    ]),
  );
  check(
    remaining > 0 && Object.values(phaseLimits).every((n) => n >= 0),
    'FULL_SCOPE_LIMIT_REACHED',
  );
  const exclusions = structuredClone(l.scope.exclusions);
  exclusions[input.creatorId] = [
    ...new Map(
      [
        ...original.filter(
          (x: any) => !(x.phase === 'detail' && x.target === '*'),
        ),
        ...rebuilt,
      ].map((x: any) => [packed(x), x]),
    ).values(),
  ];
  const localBudgets: {
    jobId: string;
    remaining: number;
    nextAt: unknown;
    intervalMs: unknown;
  }[] = [];
  for (const b of l.scope.bindings) {
    const prior = fresh.budgetSnapshot.find(
      (r: any) => r.id === fullHistoryBudgetId(input.reviewId, b.jobId),
    );
    check(
      prior &&
        Number(prior.used) <= Number(prior.request_limit) &&
        Number(prior.interval_ms) >= 1000,
      'FULL_LOCAL_BUDGET_REQUIRED',
    );
    localBudgets.push({
      jobId: b.jobId,
      remaining: Number(prior.request_limit) - Number(prior.used),
      nextAt: prior.next_at,
      intervalMs: prior.interval_ms,
    });
  }
  const scope = {
    ...l.scope,
    sessionBinding: input.sessionBinding,
    maxRequests: remaining,
    phaseLimits,
    exclusions,
    authorizationRootReviewId: l.rootId,
    lineageReviewIds: l.ids,
    continuationOfReviewId: input.reviewId,
    narrowedCreatorId: input.creatorId,
    narrowing: 'parent-receipt-marker-phase-identity',
    authenticationVerified: false,
  };
  const plan = {
    kind: 'whole-history-proved-narrow-review-v1',
    originalRisk: fresh.originalRisk,
    originalOutcome: 'unknown',
    oldTaskIds: fresh.oldTaskIds,
    oldJobIds: fresh.oldJobIds,
    creatorBindings: fresh.creatorBindings,
    budgetSnapshot: fresh.budgetSnapshot,
    scope,
    localBudgets,
    stateDigest: hash({
      fresh: fresh.stateDigest,
      lineage: l.all.filter((r) => l.ids.includes(r.id)),
      allRequests,
    }),
  };
  return { ...plan, digest: hash(plan), sourceRequestsSent: 0 };
}
export async function confirmFullHistoryNarrowReview(
  tx: RoundTx,
  input: FullHistoryNarrowInput & {
    digest: string;
    acknowledgedUnknownExclusions: true;
    acknowledgedDuplicateDirectoryRead: true;
  },
  host: {
    assertQuiescent(): Promise<void>;
    assertSession(binding: string): void;
    authorizePlan(
      plan: Awaited<ReturnType<typeof prepareFullHistoryNarrowReview>>,
    ): Promise<void>;
    verifyProtectedSnapshot(stateDigest: string): Promise<string>;
  },
  now: bigint,
) {
  check(
    input.acknowledgedUnknownExclusions === true &&
      input.acknowledgedDuplicateDirectoryRead === true,
    'PLAN_NOT_AUTHORIZED',
  );
  await host.assertQuiescent();
  host.assertSession(input.sessionBinding);
  const plan = await prepareFullHistoryNarrowReview(tx, input);
  check(plan.digest === input.digest, 'REVIEW_STATE_CHANGED');
  await host.authorizePlan(plan);
  const backup = await host.verifyProtectedSnapshot(plan.stateDigest);
  check(/^[a-f0-9]{64}$/.test(backup), 'VERIFIED_PROTECTED_BACKUP_REQUIRED');
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
  for (const b of plan.localBudgets)
    await tx.$executeRawUnsafe(
      'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,0,?,?,?)',
      fullHistoryBudgetId(id, b.jobId),
      b.remaining,
      b.nextAt,
      b.intervalMs,
    );
  await host.assertQuiescent();
  host.assertSession(input.sessionBinding);
  return {
    reviewId: id,
    remainingRequests: plan.scope.maxRequests,
    exclusions: plan.scope.exclusions,
    sourceRequestsSent: 0,
  };
}
