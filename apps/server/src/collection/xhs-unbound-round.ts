import {
  admitFullHistoryRequest,
  FULL_HISTORY_KIND,
} from './xhs-full-history-scope';
import {
  SCHEDULED_ROUND_KIND,
  assertScheduledRoundAdmission,
  assertScheduledDispatch,
} from './xhs-scheduled-review-scope';
import {
  prepareRemainingScope,
  assertRemainingAdmission,
} from './round-continuation';
import { classifyReviewedRestrictions } from './xhs-reviewed-restrictions';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Prisma TransactionClient structural subset; caller owns protected transaction. */
export interface RoundTx {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}
export type Phase = 'profile' | 'list' | 'detail' | 'media';
export type RoundRequest = {
  operationId: string;
  taskId: string;
  creatorId: string;
  phase: Phase;
  target: string;
};
const check = (value: unknown, code: string): void => {
  if (!value) throw new Error(code);
};
const packed = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const hash = (v: unknown): string =>
  createHash('sha256').update(packed(v)).digest('hex');
const rows = (tx: RoundTx, sql: string, ...values: unknown[]) =>
  tx.$queryRawUnsafe<any[]>(sql, ...values);
const restricted = (v: any): boolean => {
  if (!v || typeof v !== 'object') return false;
  if (
    /^XHS_SOURCE_(AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(
      v.code ?? '',
    )
  )
    return true;
  if (
    [v.status, v.httpStatus, v.http_status].some((x) =>
      [401, 403, 406, 429, 461, 471].includes(x),
    )
  )
    return true;
  return Object.values(v).some((x) => typeof x === 'object' && restricted(x));
};

export async function prepareUnboundRound(
  tx: RoundTx,
  creatorIds: string[],
  continuation?: { rootReviewId: string; sessionBinding: string },
) {
  const remaining = continuation
    ? await prepareRemainingScope(
        tx,
        creatorIds,
        continuation.rootReviewId,
        continuation.sessionBinding,
      )
    : undefined;
  check(
    creatorIds.length === 3 &&
      new Set(creatorIds).size === 3 &&
      creatorIds.every((x) => /^[A-Za-z0-9_-]{1,128}$/.test(x)),
    'EXACT_THREE_EXISTING_CREATORS_REQUIRED',
  );
  const risk = await rows(
    tx,
    "SELECT * FROM xhs_source_risk WHERE id='source'",
  );
  check(
    risk.length === 1 &&
      risk[0].state === 'pending' &&
      /^[a-f0-9-]{36}$/.test(risk[0].owner ?? '') &&
      ['code', 'http_status', 'endpoint'].every((k) => risk[0][k] === null),
    'UNBOUND_PENDING_REQUIRED',
  );
  const tasks = await rows(
    tx,
    'SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_subscription_tasks ORDER BY id',
  );
  const jobs = await rows(
    tx,
    'SELECT id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_whole_creator_jobs ORDER BY id',
  );
  check(
    tasks.every((r) =>
      ['completed', 'partial', 'blocked', 'failed', 'cancelled'].includes(
        r.state,
      ),
    ) &&
      jobs.every((r) =>
        ['completed', 'partial', 'paused', 'failed', 'cancelled'].includes(
          r.state,
        ),
      ),
    'SOURCE_WORK_NOT_IDLE',
  );
  for (const r of [...tasks, ...jobs]) {
    check(
      !r.document.includes(risk[0].owner),
      'OWNER_IS_BOUND_USE_EXISTING_REVIEW',
    );
    check(
      !(
        BigInt(r.updated_at) >= BigInt(risk[0].updated_at) &&
        restricted(JSON.parse(r.document))
      ),
      'LATER_PLATFORM_RESTRICTION',
    );
  }
  const creators = await rows(
    tx,
    'SELECT id,external_author_id,enabled FROM xhs_creators ORDER BY id',
  );
  check(
    creatorIds.every((id) =>
      creators.some(
        (r) => r.id === id && Number(r.enabled) === 1 && r.external_author_id,
      ),
    ),
    'CREATOR_BINDING_CHANGED',
  );
  const budgets = await rows(
    tx,
    'SELECT * FROM xhs_request_budgets ORDER BY id',
  );
  check(
    budgets.some((r) => r.id === 'xhs:source-total'),
    'SOURCE_BUDGET_REQUIRED',
  );
  const historicalRestrictions = remaining
    ? classifyReviewedRestrictions(tasks, jobs, BigInt(risk[0].updated_at))
    : undefined;
  const plan = {
    kind: 'unbound-owner-new-round-v1',
    originalRisk: risk[0],
    originalOutcome: 'unknown',
    oldTaskIds: tasks.map((r) => r.id),
    oldJobIds: jobs.map((r) => r.id),
    creatorBindings: Object.fromEntries(
      creators
        .filter((r) => creatorIds.includes(r.id))
        .map((r) => [r.id, r.external_author_id]),
    ),
    budgetSnapshot: budgets,
    scope: {
      creatorIds: remaining
        ? remaining.creatorIdsRemaining
        : [...creatorIds].sort(),
      ...(remaining
        ? {
            reviewKind: 'remaining-creators-review-v1',
            continuationRootReviewId: remaining.rootReviewId,
            originalCreatorIds: [...creatorIds].sort(),
            originalRequests: remaining.lineage.allRequests,
            sessionBinding: remaining.sessionBinding,
            historicalRestrictions,
            authenticationVerified: false,
          }
        : {}),
      maxListPages: 1,
      maxNotesPerCreator: 30,
      maxMediaPerNote: 20,
      history: false,
      comments: false,
      replies: false,
    },
    stateDigest: hash({
      risk,
      tasks,
      jobs,
      creators,
      budgets,
      ...(remaining ? { remaining } : {}),
    }),
  };
  return { ...plan, digest: hash(plan) };
}
export interface RoundHost {
  assertQuiescent(): Promise<void>;
  authorizePlan(
    plan: Awaited<ReturnType<typeof prepareUnboundRound>>,
  ): Promise<void>;
  assertPolicyInstalled(): Promise<void>;
  verifyBackup(stateDigest: string): Promise<string>;
}
export async function confirmUnboundRound(
  tx: RoundTx,
  creatorIds: string[],
  digest: string,
  host: RoundHost,
  now: bigint,
  continuation?: { rootReviewId: string; sessionBinding: string },
) {
  await host.assertQuiescent();
  const plan = await prepareUnboundRound(tx, creatorIds, continuation);
  check(plan.digest === digest, 'REVIEW_STATE_CHANGED');
  await host.authorizePlan(plan);
  await host.assertPolicyInstalled();
  const backup = await host.verifyBackup(plan.stateDigest);
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
  check(
    packed(await rows(tx, 'SELECT * FROM xhs_request_budgets ORDER BY id')) ===
      packed(plan.budgetSnapshot),
    'BUDGET_CHANGED',
  );
  return { reviewId: id, originalOutcome: 'unknown', sourceRequestsSent: 0 };
}

export async function admitUnboundRequest(
  tx: RoundTx,
  reviewId: string,
  r: RoundRequest,
) {
  const reviews = await rows(
    tx,
    'SELECT scope_json,old_task_ids_json,old_job_ids_json,creator_bindings_json FROM xhs_unbound_owner_reviews WHERE id=?',
    reviewId,
  );
  check(reviews.length === 1, 'APPROVED_NEW_ROUND_REQUIRED');
  const review = reviews[0],
    scope = JSON.parse(review.scope_json);
  if (scope.reviewKind === FULL_HISTORY_KIND)
    return admitFullHistoryRequest(tx, reviewId, review, r);
  if (scope.reviewKind === SCHEDULED_ROUND_KIND)
    return assertScheduledRoundAdmission(tx, reviewId, review, r);
  if (scope.reviewKind === 'remaining-creators-review-v1')
    await assertRemainingAdmission(tx, reviewId, scope, r);
  check(
    (
      await rows(
        tx,
        "SELECT 1 FROM xhs_unbound_owner_requests WHERE review_id=? AND outcome IN ('started','unknown') LIMIT 1",
        reviewId,
      )
    ).length === 0,
    'ROUND_HAS_UNRESOLVED_REQUEST',
  );
  check(
    /^[a-f0-9-]{36}$/.test(r.operationId) &&
      /^[A-Za-z0-9:_-]{1,160}$/.test(r.taskId),
    'REQUEST_ID_INVALID',
  );
  check(
    ![
      ...JSON.parse(review.old_task_ids_json),
      ...JSON.parse(review.old_job_ids_json),
    ].includes(r.taskId),
    'HISTORICAL_TASK_REPLAY_FORBIDDEN',
  );
  check(
    scope.creatorIds.includes(r.creatorId) &&
      ['profile', 'list', 'detail', 'media'].includes(r.phase),
    'READ_SCOPE_EXCEEDED',
  );
  const creator = await rows(
    tx,
    'SELECT external_author_id,enabled FROM xhs_creators WHERE id=?',
    r.creatorId,
  );
  check(
    creator.length === 1 &&
      Number(creator[0].enabled) === 1 &&
      creator[0].external_author_id ===
        JSON.parse(review.creator_bindings_json)[r.creatorId],
    'CREATOR_BINDING_CHANGED',
  );
  if (r.phase === 'profile')
    check(r.target === 'profile', 'PROFILE_SCOPE_INVALID');
  else if (r.phase === 'list') check(r.target === 'page:1', 'LIST_PAGE_LIMIT');
  else {
    const listed = await rows(
      tx,
      "SELECT listed_note_ids_json FROM xhs_unbound_owner_requests WHERE review_id=? AND creator_id=? AND phase='list' AND outcome='response-received'",
      reviewId,
      r.creatorId,
    );
    const ids = listed.flatMap((x) =>
        JSON.parse(x.listed_note_ids_json ?? '[]'),
      ),
      note = r.target.split(':')[0];
    check(ids.includes(note), 'NOTE_NOT_CONFIRMED_IN_NEW_LIST');
    if (r.phase === 'detail') check(r.target === note, 'DETAIL_TARGET_INVALID');
    else {
      check(
        /^[A-Za-z0-9_-]+:[a-f0-9]{64}$/.test(r.target),
        'MEDIA_MANIFEST_KEY_REQUIRED',
      );
      const count = await rows(
        tx,
        "SELECT COUNT(*) AS n FROM xhs_unbound_owner_requests WHERE review_id=? AND creator_id=? AND phase='media' AND substr(logical_target,1,?)=?",
        reviewId,
        r.creatorId,
        note.length + 1,
        note + ':',
      );
      check(Number(count[0].n) < scope.maxMediaPerNote, 'MEDIA_LIMIT');
    }
  }
  await tx.$executeRawUnsafe(
    "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?, 'started',NULL)",
    r.operationId,
    reviewId,
    r.taskId,
    r.creatorId,
    r.phase,
    r.target,
  );
}

/** Bind server-created context at the common dispatch boundary, never from UI JSON. */
export const unboundRoundContext = new AsyncLocalStorage<{
  reviewId: string;
  request: RoundRequest;
}>();
export async function assertUnboundDispatch(tx: RoundTx) {
  if (
    !(
      await rows(
        tx,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='xhs_unbound_owner_reviews'",
      )
    ).length
  )
    return;
  if (
    !(await rows(tx, 'SELECT 1 FROM xhs_unbound_owner_reviews LIMIT 1')).length
  )
    return;
  const context = unboundRoundContext.getStore();
  check(context, 'APPROVED_NEW_ROUND_REQUIRED');
  const r = context!.request;
  const admitted = await rows(
    tx,
    "SELECT * FROM xhs_unbound_owner_requests WHERE review_id=? AND operation_id=? AND outcome='started'",
    context!.reviewId,
    r.operationId,
  );
  check(
    admitted.length === 1 &&
      admitted[0].creator_id === r.creatorId &&
      admitted[0].task_id === r.taskId &&
      admitted[0].phase === r.phase &&
      admitted[0].logical_target === r.target,
    'DURABLE_REQUEST_BINDING_REQUIRED',
  );
  const reviews = await rows(
    tx,
    'SELECT scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
    context!.reviewId,
  );
  if (
    reviews.length === 1 &&
    JSON.parse(reviews[0].scope_json).reviewKind === SCHEDULED_ROUND_KIND
  )
    await assertScheduledDispatch(tx, context!.reviewId, r);
}

export async function settleUnboundRequest(
  tx: RoundTx,
  reviewId: string,
  operationId: string,
  outcome: 'response-received' | 'not-sent' | 'unknown',
  noteIds?: string[],
) {
  const request = await rows(
    tx,
    "SELECT phase FROM xhs_unbound_owner_requests WHERE review_id=? AND operation_id=? AND outcome='started'",
    reviewId,
    operationId,
  );
  check(request.length === 1, 'REQUEST_ALREADY_SETTLED');
  let notes: string | null = null;
  if (request[0].phase === 'list' && outcome === 'response-received') {
    const reviews = await rows(
      tx,
      'SELECT scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
      reviewId,
    );
    const pageLimit =
      reviews.length === 1 &&
      [FULL_HISTORY_KIND, SCHEDULED_ROUND_KIND].includes(
        JSON.parse(reviews[0].scope_json).reviewKind,
      )
        ? 60
        : 30;
    check(
      Array.isArray(noteIds) &&
        noteIds.length <= pageLimit &&
        new Set(noteIds).size === noteIds.length &&
        noteIds.every((x) => /^[A-Za-z0-9_-]{1,128}$/.test(x)),
      'LIST_RESULT_SCOPE_INVALID',
    );
    notes = packed(noteIds);
  }
  check(
    (await tx.$executeRawUnsafe(
      "UPDATE xhs_unbound_owner_requests SET outcome=?,listed_note_ids_json=? WHERE review_id=? AND operation_id=? AND outcome='started'",
      outcome,
      notes,
      reviewId,
      operationId,
    )) === 1,
    'REQUEST_ALREADY_SETTLED',
  );
}

/** Only unchanged markers in the immutable approved snapshot may be retained.
 * Return these to existing hasPendingDispatch/reserveTotal alongside existing
 * readHistoryHandoffs markers. Never delete a row or refund its used count.
 */
export async function reviewedUnboundMarkers(
  tx: RoundTx,
  reviewId: string,
): Promise<string[]> {
  const reviews = await rows(
    tx,
    'SELECT budget_snapshot_json FROM xhs_unbound_owner_reviews WHERE id=?',
    reviewId,
  );
  check(reviews.length === 1, 'APPROVED_NEW_ROUND_REQUIRED');
  const approved: any[] = JSON.parse(reviews[0].budget_snapshot_json);
  const result: string[] = [];
  for (const expected of approved.filter((x) =>
    x.id.startsWith('xhs:dispatch-pending:'),
  )) {
    const current = await rows(
      tx,
      'SELECT * FROM xhs_request_budgets WHERE id=?',
      expected.id,
    );
    check(
      current.length === 1 &&
        Object.keys(expected).every(
          (k) => String(current[0][k]) === String(expected[k]),
        ),
      'RETAINED_BUDGET_CHANGED',
    );
    check(
      Number(expected.used) === 1 && Number(expected.request_limit) === 1,
      'RETAINED_BUDGET_INVALID',
    );
    result.push(expected.id);
  }
  return result;
}

export interface DurableRoundHost {
  /** Must COMMIT before resolving, using existing incremental-write coordinator. */
  transaction<T>(work: (tx: RoundTx) => Promise<T>): Promise<T>;
  /** Existing budget/source policy remains active; server binds exact target. */
  dispatchWithExistingBudget<T>(
    context: {
      reviewId: string;
      request: RoundRequest;
      retainedMarkers: string[];
    },
    operation: () => Promise<T>,
  ): Promise<T>;
}

/** The started row commits in a SEPARATE transaction BEFORE transport is entered.
 * All failures retain started or unknown; a caller cannot automatically retry.
 */
export async function dispatchDurableUnbound<T>(
  host: DurableRoundHost,
  reviewId: string,
  request: RoundRequest,
  operation: () => Promise<T>,
  listNotes?: (response: T) => string[],
): Promise<T> {
  const retainedMarkers = await host.transaction(async (tx) => {
    const retained = await reviewedUnboundMarkers(tx, reviewId);
    await admitUnboundRequest(tx, reviewId, request);
    return retained;
  });
  try {
    const result = await unboundRoundContext.run({ reviewId, request }, () =>
      host.dispatchWithExistingBudget(
        { reviewId, request, retainedMarkers },
        operation,
      ),
    );
    await host.transaction((tx) =>
      settleUnboundRequest(
        tx,
        reviewId,
        request.operationId,
        'response-received',
        listNotes?.(result),
      ),
    );
    return result;
  } catch (error) {
    try {
      await host.transaction((tx) =>
        settleUnboundRequest(tx, reviewId, request.operationId, 'unknown'),
      );
    } catch {
      /* started remains durable when settlement itself fails. */
    }
    throw error;
  }
}
