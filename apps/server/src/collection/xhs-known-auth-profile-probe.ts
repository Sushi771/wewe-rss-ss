import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertKnownAuthCommittedSession,
  readKnownAuthControlState,
} from './xhs-known-auth-response-review';
import {
  admitUnboundRequest,
  settleUnboundRequest,
  unboundRoundContext,
  type RoundTx,
  type RoundRequest,
} from './xhs-unbound-round';
import { reserveRoundBudgetRisk, finishRoundRisk } from './round-budget-risk';
import { createRoundSourceReceipt } from './round-source-receipt';
import { dispatchUnboundContext } from './xhs-reviewed-dispatch';
import type { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { saveXhsMetrics } from './xhs-engagement-store';
import { safeXhsAvatarUrl } from './xhs-profile';

export const KNOWN_AUTH_PROFILE_KIND = 'known-auth-profile-probe-v1';
const pack = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const hash = (v: unknown) => createHash('sha256').update(pack(v)).digest('hex');
function check(v: unknown, message: string): asserts v {
  if (!v) throw Error(message);
}
const rows = (tx: RoundTx, sql: string, ...args: unknown[]) =>
  tx.$queryRawUnsafe<any[]>(sql, ...args);
export type KnownProfileInput = {
  taskId: string;
  creatorId: string;
  authReviewId: string;
  authDigest: string;
};
type Writer = <T>(work: (tx: RoundTx) => Promise<T>) => Promise<T>;
// In-process capability only, never populated from an HTTP body.
const activeProbe = new AsyncLocalStorage<{
  reviewId: string;
  owner?: string;
  reservedAt?: number;
  dispatchRejected?: boolean;
  expectedReview?: Record<string, unknown>;
  admittedReceipt?: string;
  ready: () => Promise<void>;
}>();

/** Only the exact unchanged post-auth state can authorize this one profile. */
export async function prepareKnownAuthProfile(
  tx: RoundTx,
  input: KnownProfileInput,
  runtime: XhsSubscriptionRuntime,
  ownedProfileActive = false,
) {
  runtime.assertUnboundPolicyInstalled();
  input = {
    taskId: input.taskId,
    creatorId: input.creatorId,
    authReviewId: input.authReviewId,
    authDigest: input.authDigest,
  };
  const session = runtime.knownAuthSessionForReview(ownedProfileActive);
  await runtime.assertSafeKnownAuthSession(session.binding, ownedProfileActive);
  const transportBinding = runtime.fullScopeSessionBinding();
  const state = await readKnownAuthControlState(tx);
  const task = state.data.xhs_subscription_tasks.find(
    (r) => r.id === input.taskId && r.creator_id === input.creatorId,
  );
  const audits = task && JSON.parse(task.document).knownResponseAuthReviews;
  check(audits?.length === 1, 'KNOWN_AUTH_COMMITTED_REVIEW_REQUIRED');
  const audit = audits[0];
  check(
    audit.id === input.authReviewId &&
      audit.digest === input.authDigest &&
      audit.originalOutcome === 'response-received',
    'KNOWN_AUTH_COMMITTED_REVIEW_REQUIRED',
  );
  const commit = {
    reviewId: audit.id,
    taskId: task.id,
    auditDigest: hash(audit),
    digest: audit.digest,
    session: audit.session,
    riskClearedAt: audit.confirmedAt,
    originalOutcome: 'response-received' as const,
    authenticationVerified: false as const,
    sourceRequestsSent: 0 as const,
    newGrant: false as const,
  };
  await assertKnownAuthCommittedSession(tx, commit, {
    knownAuthSessionForReview: () =>
      runtime.knownAuthSessionForReview(ownedProfileActive),
  });
  const policy = state.data.xhs_unbound_owner_reviews.find(
    (r) => r.id === audit.policyId,
  );
  check(
    policy &&
      policy.original_outcome === 'unknown' &&
      /^[a-f0-9]{64}$/.test(policy.backup_sha256),
    'PROFILE_ROOT_PROVENANCE_REQUIRED',
  );
  const reviewId = 'unbound-known-profile-' + hash(audit.id);
  check(
    !state.data.xhs_unbound_owner_reviews.some(
      (r) =>
        r.id === reviewId ||
        (JSON.parse(r.scope_json).reviewKind === KNOWN_AUTH_PROFILE_KIND &&
          JSON.parse(r.scope_json).knownAuthentication?.authReviewId ===
            audit.id),
    ),
    'KNOWN_PROFILE_ALREADY_CONSUMED',
  );
  const creator = state.data.xhs_creators.find((r) => r.id === input.creatorId);
  const authorId = JSON.parse(policy.creator_bindings_json)[input.creatorId];
  check(
    creator &&
      Number(creator.enabled) === 1 &&
      creator.external_author_id === authorId,
    'CREATOR_BINDING_CHANGED',
  );
  // Normalize only the already-committed auth append/clear. All other controls
  // must still equal its approved snapshot; no new unknown or restriction bypass.
  const original = JSON.parse(pack(state));
  original.data.xhs_subscription_tasks.find(
    (r: any) => r.id === task.id,
  ).document = audit.originalTaskRaw;
  original.data.xhs_source_risk = [audit.originalRisk];
  for (const table of Object.values(original.data) as any[][])
    table.sort((a, b) => pack(a).localeCompare(pack(b)));
  check(
    hash(original) === audit.stateDigest,
    'KNOWN_PROFILE_CONTROL_STATE_CHANGED',
  );
  const scope = {
    reviewKind: KNOWN_AUTH_PROFILE_KIND,
    version: 1,
    rootHistoricalEvidence: {
      policyId: policy.id,
      policyDigest: policy.plan_digest,
      originalRiskDigest: hash(policy.original_risk_json),
      originalOutcome: 'unknown',
      backupSha256: policy.backup_sha256,
      inherited: true,
    },
    knownAuthentication: {
      ...input,
      auditDigest: hash(audit),
      originalOutcome: 'response-received',
      riskClearedAt: audit.confirmedAt,
    },
    session: commit.session,
    transportBinding,
    creatorIds: [input.creatorId],
    creatorBindings: { [input.creatorId]: authorId },
    requestScope: {
      taskId: 'known-profile:' + hash(audit.id),
      target: 'profile',
      maxRequests: 1,
      phaseLimits: { profile: 1, list: 0, detail: 0, media: 0 },
    },
    authorization: {
      acknowledgedOneProfile: true,
      comments: false,
      replies: false,
      automaticRetry: false,
      authenticationVerified: false,
    },
    controlStateDigest: hash(state),
    riskClear: state.data.xhs_source_risk[0],
  };
  runtime.assertFullScopeSession(transportBinding);
  return { reviewId, digest: hash(scope), scope, policy, state };
}

async function checkedRow(
  tx: RoundTx,
  reviewId: string,
  request: RoundRequest,
) {
  const found = await rows(
    tx,
    'SELECT id,plan_digest,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,CAST(approved_at AS TEXT) AS approved_at FROM xhs_unbound_owner_reviews WHERE id=?',
    reviewId,
  );
  check(found.length === 1, 'KNOWN_PROFILE_REVIEW_REQUIRED');
  const row = found[0],
    s = JSON.parse(row.scope_json),
    c = activeProbe.getStore();
  check(
    c?.reviewId === reviewId &&
      s.reviewKind === KNOWN_AUTH_PROFILE_KIND &&
      row.plan_digest === hash(s),
    'KNOWN_PROFILE_CONTEXT_REQUIRED',
  );
  check(pack(row) === pack(c.expectedReview), 'KNOWN_PROFILE_REVIEW_CHANGED');
  await c.ready();
  check(
    reviewId ===
      'unbound-known-profile-' + hash(s.knownAuthentication.authReviewId) &&
      request.taskId === s.requestScope.taskId &&
      request.taskId ===
        'known-profile:' + hash(s.knownAuthentication.authReviewId) &&
      s.creatorIds.length === 1 &&
      request.creatorId === s.creatorIds[0] &&
      request.phase === 'profile' &&
      request.target === 'profile' &&
      /^[a-f0-9-]{36}$/.test(request.operationId),
    'KNOWN_PROFILE_SCOPE_EXCEEDED',
  );
  check(
    pack(s.requestScope.phaseLimits) ===
      pack({ profile: 1, list: 0, detail: 0, media: 0 }) &&
      s.requestScope.maxRequests === 1 &&
      s.authorization.acknowledgedOneProfile === true &&
      s.authorization.comments === false &&
      s.authorization.replies === false &&
      s.authorization.automaticRetry === false,
    'KNOWN_PROFILE_SCOPE_EXCEEDED',
  );
  const policy = (
    await rows(
      tx,
      'SELECT id,plan_digest,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,CAST(approved_at AS TEXT) AS approved_at FROM xhs_unbound_owner_reviews WHERE id=?',
      s.rootHistoricalEvidence.policyId,
    )
  )[0];
  check(
    policy &&
      policy.plan_digest === s.rootHistoricalEvidence.policyDigest &&
      row.original_risk_json === policy.original_risk_json &&
      row.original_outcome === 'unknown' &&
      row.backup_sha256 === policy.backup_sha256 &&
      hash(policy.original_risk_json) ===
        s.rootHistoricalEvidence.originalRiskDigest &&
      s.rootHistoricalEvidence.inherited === true &&
      s.rootHistoricalEvidence.originalOutcome === 'unknown' &&
      s.rootHistoricalEvidence.backupSha256 === row.backup_sha256 &&
      s.knownAuthentication.originalOutcome === 'response-received' &&
      s.authorization.authenticationVerified === false,
    'PROFILE_ROOT_PROVENANCE_REQUIRED',
  );
  return { row, s, c };
}
async function unchanged(
  tx: RoundTx,
  reviewId: string,
  request: RoundRequest,
  dispatched: boolean,
) {
  const { row, s, c } = await checkedRow(tx, reviewId, request);
  const state = await readKnownAuthControlState(tx),
    d = state.data;
  d.xhs_unbound_owner_reviews = d.xhs_unbound_owner_reviews.filter(
    (r) => r.id !== reviewId,
  );
  const own = d.xhs_unbound_owner_requests.filter(
    (r) => r.review_id === reviewId,
  );
  if (dispatched) {
    check(
      own.length === 1 &&
        own[0].operation_id === request.operationId &&
        own[0].outcome === 'started' &&
        own[0].task_id === request.taskId &&
        own[0].creator_id === request.creatorId &&
        own[0].phase === 'profile' &&
        own[0].logical_target === 'profile' &&
        own[0].listed_note_ids_json === null,
      'KNOWN_PROFILE_ALREADY_CONSUMED',
    );
    const receipts = d.xhs_unbound_source_receipts.filter(
      (r) => r.operation_id === request.operationId,
    );
    check(
      receipts.length === 1 &&
        c.admittedReceipt &&
        receipts[0].document === c.admittedReceipt,
      'KNOWN_PROFILE_RECEIPT_CHANGED',
    );
    check(
      c.owner &&
        c.reservedAt &&
        pack(d.xhs_source_risk) ===
          pack([
            {
              ...s.riskClear,
              state: 'pending',
              owner: c.owner,
              updated_at: String(c.reservedAt),
            },
          ]),
      'KNOWN_PROFILE_OWNER_CHANGED',
    );
    const budgets = JSON.parse(row.budget_snapshot_json);
    const expected = budgets.map((b: any) =>
      ['xhs:source-total', 'xhs:original-link:' + request.creatorId].includes(
        b.id,
      )
        ? {
            ...b,
            used: Number(b.used) + 1,
            next_at: String(c.reservedAt! + Number(b.interval_ms)),
          }
        : b,
    );
    check(
      pack(d.xhs_request_budgets) === pack(expected),
      'KNOWN_PROFILE_BUDGET_CHANGED',
    );
    d.xhs_request_budgets = budgets;
    d.xhs_source_risk = [s.riskClear];
    d.xhs_unbound_owner_requests = d.xhs_unbound_owner_requests.filter(
      (r) => r.review_id !== reviewId,
    );
    d.xhs_unbound_source_receipts = d.xhs_unbound_source_receipts.filter(
      (r) => r.operation_id !== request.operationId,
    );
  } else check(own.length === 0, 'KNOWN_PROFILE_ALREADY_CONSUMED');
  for (const table of Object.values(d))
    table.sort((a, b) => pack(a).localeCompare(pack(b)));
  check(
    hash(state) === s.controlStateDigest,
    'KNOWN_PROFILE_CONTROL_STATE_CHANGED',
  );
}
export async function admitKnownAuthProfile(
  tx: RoundTx,
  reviewId: string,
  request: RoundRequest,
) {
  await unchanged(tx, reviewId, request, false);
  await tx.$executeRawUnsafe(
    "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,'started',NULL)",
    request.operationId,
    reviewId,
    request.taskId,
    request.creatorId,
    'profile',
    'profile',
  );
}
export async function assertKnownAuthProfileDispatch(
  tx: RoundTx,
  reviewId: string,
  request: RoundRequest,
) {
  try {
    await unchanged(tx, reviewId, request, true);
  } catch (error) {
    const c = activeProbe.getStore();
    if (c) c.dispatchRejected = true;
    throw error;
  }
}

/** Explicit one-profile authorization. Every durable outcome consumes this ID. */
export async function runKnownAuthProfile(
  write: Writer,
  runtime: XhsSubscriptionRuntime,
  input: KnownProfileInput,
  digest: string,
  acknowledgedOneProfile: true,
) {
  check(acknowledgedOneProfile === true, 'PROFILE_AUTHORIZATION_REQUIRED');
  // Read through a transaction but never acquire/create a full-database backup.
  const plan = await write((tx) => prepareKnownAuthProfile(tx, input, runtime));
  check(plan.digest === digest, 'REVIEW_STATE_CHANGED');
  const request: RoundRequest = {
    operationId: randomUUID(),
    taskId: plan.scope.requestScope.taskId,
    creatorId: input.creatorId,
    phase: 'profile',
    target: 'profile',
  };
  const binding = {
    jobId: plan.reviewId,
    id: request.operationId,
    authorId: plan.scope.creatorBindings[input.creatorId],
    noteId: '',
    phase: 'profile' as const,
  };
  const context = {
    reviewId: plan.reviewId,
    owner: undefined as string | undefined,
    reservedAt: undefined as number | undefined,
    dispatchRejected: false,
    expectedReview: undefined as Record<string, unknown> | undefined,
    admittedReceipt: undefined as string | undefined,
    ready: async () => {
      runtime.assertUnboundPolicyInstalled();
      await runtime.assertSafeKnownAuthSession(
        plan.scope.session.binding,
        true,
      );
      runtime.assertFullScopeSession(plan.scope.transportBinding);
    },
  };
  const receipt = createRoundSourceReceipt(write, plan.reviewId, request);
  try {
    const author = await activeProbe.run(context, () =>
      dispatchUnboundContext(
        binding,
        async (operation) => {
          context.owner = await write(async (tx) => {
            const current = await prepareKnownAuthProfile(
              tx,
              input,
              runtime,
              true,
            );
            check(current.digest === digest, 'REVIEW_STATE_CHANGED');
            const p = current.policy,
              d = current.state.data;
            context.expectedReview = {
              id: plan.reviewId,
              plan_digest: digest,
              original_risk_json: p.original_risk_json,
              original_outcome: 'unknown',
              old_task_ids_json: pack(
                d.xhs_subscription_tasks.map((r) => r.id),
              ),
              old_job_ids_json: pack(d.xhs_whole_creator_jobs.map((r) => r.id)),
              creator_bindings_json: pack(plan.scope.creatorBindings),
              budget_snapshot_json: pack(d.xhs_request_budgets),
              scope_json: pack(plan.scope),
              backup_sha256: p.backup_sha256,
              approved_at: String(Date.now()),
            };
            await tx.$executeRawUnsafe(
              'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
              ...Object.values(context.expectedReview).slice(0, -1),
              BigInt(context.expectedReview.approved_at as string),
            );
            await admitUnboundRequest(tx, plan.reviewId, request);
            context.reservedAt = Date.now();
            const owner = await reserveRoundBudgetRisk(
              tx,
              plan.reviewId,
              request,
              context.reservedAt,
            );
            await receipt.persist(tx);
            return owner;
          });
          await runtime.assertSafeKnownAuthSession(
            plan.scope.session.binding,
            true,
          );
          await context.ready();
          await receipt.start();
          context.admittedReceipt = pack(receipt.snapshot());
          // One coherent SQLite read snapshot before the existing physical guard.
          await write((tx) =>
            assertKnownAuthProfileDispatch(tx, plan.reviewId, request),
          );
          return receipt.run(() =>
            unboundRoundContext.run(
              { reviewId: plan.reviewId, request },
              operation,
            ),
          );
        },
        (permit) => runtime.resolveReviewedContextAuthor(binding, permit),
      ),
    );
    check(context.owner, 'KNOWN_PROFILE_OWNER_CHANGED');
    receipt.observe('parse');
    await receipt.drain();
    receipt.observe('storage');
    await receipt.drain();
    await write(async (tx) => {
      await context.ready();
      const creator = (
        await rows(
          tx,
          'SELECT external_author_id,enabled FROM xhs_creators WHERE id=?',
          input.creatorId,
        )
      )[0];
      check(
        Number(creator?.enabled) === 1 &&
          creator.external_author_id === binding.authorId &&
          author.id === binding.authorId &&
          author.name?.trim() &&
          author.profileUrl ===
            'https://www.xiaohongshu.com/user/profile/' + binding.authorId &&
          Number.isSafeInteger(author.collectedAt) &&
          author.collectedAt > 0,
        'CREATOR_BINDING_CHANGED',
      );
      check(
        (await tx.$executeRawUnsafe(
          'UPDATE xhs_creators SET display_name=?,last_checked_at=? WHERE id=? AND external_author_id=? AND enabled=1',
          author.name,
          Math.floor(author.collectedAt / 1000),
          input.creatorId,
          binding.authorId,
        )) === 1,
        'CREATOR_BINDING_CHANGED',
      );
      await saveXhsMetrics(
        tx as any,
        'creator',
        input.creatorId,
        author.metrics,
      );
      const avatar = safeXhsAvatarUrl(author.avatarUrl);
      if (avatar)
        await tx.$executeRawUnsafe(
          "INSERT INTO xhs_metric_snapshots VALUES('creator-avatar',?,?) ON CONFLICT(owner_kind,owner_id) DO UPDATE SET document=excluded.document",
          input.creatorId,
          pack({ avatarUrl: avatar }),
        );
      receipt.complete();
      await receipt.persist(tx);
      await settleUnboundRequest(
        tx,
        plan.reviewId,
        request.operationId,
        'response-received',
      );
      await finishRoundRisk(tx, context.owner!, 'response-received');
    });
    return {
      reviewId: plan.reviewId,
      state: 'profile-saved' as const,
      profileRequests: 1,
      notesCollected: 0,
      imagesCollected: 0,
      automaticRetry: false,
    };
  } catch (error) {
    const failureCode = runtime.reviewedFailureCode();
    if (
      receipt.snapshot().status !== undefined &&
      !failureCode &&
      receipt.snapshot().stage === 'response'
    )
      receipt.observe('parse');
    receipt.fail(
      error,
      receipt.snapshot().status !== undefined && !failureCode,
    );
    try {
      await receipt.drain();
    } catch {
      /* Final transaction remains best effort. */
    }
    const observed = receipt.snapshot();
    const outcome =
      observed.status !== undefined
        ? 'response-received'
        : observed.stage === 'admitted' || observed.outcome === 'not-sent'
          ? 'not-sent'
          : 'unknown';
    if (context.owner && !context.dispatchRejected) {
      try {
        await write(async (tx) => {
          await receipt.persist(tx);
          await settleUnboundRequest(
            tx,
            plan.reviewId,
            request.operationId,
            outcome,
          );
          // Local parse/storage failures retain pending. Only an explicit new
          // platform restriction replaces it; never clear an uncertain owner.
          await finishRoundRisk(
            tx,
            context.owner!,
            'unknown',
            failureCode,
            observed.status,
            'profile',
          );
        });
      } catch {
        /* Keep durable pending/started when terminal storage is uncertain. */
      }
    }
    return {
      reviewId: plan.reviewId,
      state: 'profile-not-confirmed' as const,
      outcome,
      checkpointConfirmed: false,
      doNotRetryConfirmation: true,
      automaticRetry: false,
    };
  }
}
