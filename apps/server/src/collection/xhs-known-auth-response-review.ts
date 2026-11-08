import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RoundTx } from './xhs-unbound-round';
import { readScheduledKnownAuthProof } from './xhs-scheduled-review-scope';
import { classifyReviewedRestrictions } from './xhs-reviewed-restrictions';
import { readLegacyXhsSourceFence } from './xhs-legacy-source-fence';

const KIND = 'known-auth-response-review-v1';
const AUTH = 'XHS_SOURCE_AUTHENTICATION_BLOCKED';
const pack = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const hash = (v: unknown) => createHash('sha256').update(pack(v)).digest('hex');
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error(code);
}
const rows = (tx: RoundTx, sql: string, ...args: unknown[]) =>
  tx.$queryRawUnsafe<any[]>(sql, ...args);
export type KnownAuthTarget = {
  taskId: string;
  creatorId: string;
};
type Session = {
  binding: string;
  connectedAt: number;
  origin?: 'fresh-replacement' | 'user-confirmed-restored-saved-session';
  restorePolicy?: { autoRestore: boolean; needsReconnect: boolean };
};
/** Only a server-owned runtime supplies this object. Never bind it to request JSON.
 * Existing runtime.knownAuthSessionForReview() satisfies the read contract. */
export interface KnownAuthSessionHost {
  knownAuthSessionForReview(): Session;
}
export interface KnownAuthReviewHost extends KnownAuthSessionHost {
  /** Own exclusive write coordination, incremental durability checks and real SQLite
   * transaction. Resolve only AFTER commit; roll back every callback exception. */
  protectedTransaction<T>(work: (tx: RoundTx) => Promise<T>): Promise<T>;
  assertQuiescent(): Promise<void>;
  authorizePlan(plan: KnownAuthPlan): Promise<void>;
  assertPolicyInstalled(policyId: string, policyDigest: string): Promise<void>;
  /** Must prove a restart/manual restore cannot silently load pre-risk credentials.
   * Fail closed if the existing vault policy cannot establish this proof. */
  assertSafeRestorePolicy(): Promise<void>;
}
function session(
  host: KnownAuthSessionHost,
  after: bigint,
  expected?: Session,
) {
  const raw = host.knownAuthSessionForReview();
  const s = {
    binding: raw.binding,
    connectedAt: raw.connectedAt,
    origin: raw.origin ?? ('fresh-replacement' as const),
    ...(raw.restorePolicy
      ? {
          restorePolicy: {
            autoRestore: raw.restorePolicy.autoRestore,
            needsReconnect: raw.restorePolicy.needsReconnect,
          },
        }
      : {}),
  };
  check(
    /^[a-f0-9]{64}$/.test(s.binding) &&
      Number.isSafeInteger(s.connectedAt) &&
      s.connectedAt > 0 &&
      (s.origin === 'user-confirmed-restored-saved-session' ||
        (s.origin === 'fresh-replacement' && BigInt(s.connectedAt) > after)),
    'FRESH_RUNTIME_SESSION_REQUIRED',
  );
  check(
    s.origin !== 'user-confirmed-restored-saved-session' ||
      (typeof s.restorePolicy?.autoRestore === 'boolean' &&
        s.restorePolicy.needsReconnect === false),
    'RESTORED_POLICY_PROOF_REQUIRED',
  );
  check(!expected || pack(s) === pack(expected), 'SESSION_CHANGED');
  return s;
}
const controlTables = [
  'xhs_source_risk',
  'xhs_subscription_tasks',
  'xhs_whole_creator_jobs',
  'xhs_unbound_owner_reviews',
  'xhs_unbound_owner_requests',
  'xhs_unbound_source_receipts',
  'xhs_request_budgets',
  'xhs_limited_recovery',
  'xhs_limited_recovery_append',
  'xhs_refresh_jobs',
  'xhs_refresh_failures',
  'xhs_refresh_batches',
  'xhs_refresh_batch_items',
  'xhs_creators',
];
/** Only admission/recovery control rows. Never read note bodies, video blobs,
 * comments or media. Only these two control rows may change; a SQLite rollback
 * journal protects atomicity, not a JS serialization or copy of the archive. */
async function snapshot(tx: RoundTx) {
  const schema = await rows(
    tx,
    `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (${controlTables.map(() => '?').join(',')}) ORDER BY type,name`,
    ...controlTables,
  );
  const data: Record<string, any[]> = {};
  for (const t of schema.filter((s) => s.type === 'table')) {
    check(/^xhs_[a-z0-9_]+$/.test(t.name), 'UNEXPECTED_XHS_SCHEMA');
    // Sorting packed full rows gives deterministic ordering without rowid assumptions.
    const columns =
      t.name === 'xhs_creators'
        ? 'id,external_author_id,enabled'
        : t.name === 'xhs_unbound_owner_reviews'
          ? 'id,plan_digest,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,CAST(approved_at AS TEXT) AS approved_at'
          : '*';
    data[t.name] = (await rows(tx, `SELECT ${columns} FROM "${t.name}"`)).sort(
      (a, b) => pack(a).localeCompare(pack(b)),
    );
  }
  return { schema, data };
}
export { snapshot as readKnownAuthControlState };
const list = (x: unknown) => Array.isArray(x) && x.length === 0;
function restriction(v: any): boolean {
  if (!v || typeof v !== 'object') return false;
  if (
    /^XHS_SOURCE_(?:AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(
      v.code ?? '',
    ) ||
    [v.status, v.httpStatus, v.http_status].some((x) =>
      [401, 403, 406, 429, 461, 471].includes(x),
    )
  )
    return true;
  // Deliberately inspect all live structures including taskFailure, items and
  // unknown nested fields. Historical review records are evidence, not live stops.
  return Object.values(v).some(restriction);
}
async function build(
  tx: RoundTx,
  target: KnownAuthTarget,
  host: KnownAuthSessionHost,
) {
  const state = await snapshot(tx),
    d = state.data;
  const legacy = await readLegacyXhsSourceFence({
    $queryRaw: (strings, ...args) =>
      tx.$queryRawUnsafe(strings.join('?'), ...args),
  });
  check(legacy.state !== 'blocked', 'UNRESOLVED_LEGACY_SOURCE');
  const risk = d.xhs_source_risk;
  check(
    risk.length === 1 &&
      risk[0].id === 'source' &&
      risk[0].state === 'blocked' &&
      risk[0].code === AUTH &&
      ['owner', 'http_status', 'endpoint'].every((k) => risk[0][k] === null),
    'KNOWN_AUTH_RISK_REQUIRED',
  );
  const task = d.xhs_subscription_tasks.find((t) => t.id === target.taskId);
  check(
    task && task.creator_id === target.creatorId && task.state === 'blocked',
    'KNOWN_AUTH_TASK_REQUIRED',
  );
  const doc = JSON.parse(task.document);
  check(
    doc.taskId === task.id &&
      doc.creatorId === task.creator_id &&
      doc.state === 'blocked' &&
      doc.code === AUTH &&
      doc.kind === 'list' &&
      doc.collectionStage === 'listing' &&
      doc.schedule?.phase === 'basic' &&
      (doc.schedule.batch ?? 0) === 0 &&
      ['total', 'completed', 'skipped', 'failed', 'remaining'].every(
        (k) => doc[k] === 0,
      ) &&
      ['snapshotsSaved', 'archiveConflicts', 'pages'].every(
        (k) => doc[k] === undefined || doc[k] === 0,
      ) &&
      list(doc.noteIds) &&
      doc.items &&
      typeof doc.items === 'object' &&
      !Array.isArray(doc.items) &&
      Object.keys(doc.items).length === 0 &&
      list(doc.listedIds ?? []) &&
      !doc.sourceActive &&
      !doc.sourceFence &&
      list(doc.sourceUnknowns ?? []) &&
      pack(Object.keys(doc.taskFailure ?? {}).sort()) ===
        pack(['code', 'dispatched', 'errorKind', 'phase']) &&
      doc.taskFailure.phase === 'listing' &&
      doc.taskFailure.code === AUTH &&
      doc.taskFailure.errorKind === 'Error' &&
      doc.taskFailure.dispatched === 'transport-entered' &&
      doc.genericRiskReviews === undefined &&
      doc.historyHandoff === undefined,
    'KNOWN_AUTH_TASK_EVIDENCE_REQUIRED',
  );
  const ledger = d.xhs_unbound_owner_requests.filter(
    (r) => r.task_id === task.id,
  );
  check(
    ledger.length === 1 &&
      ledger[0].creator_id === task.creator_id &&
      ledger[0].phase === 'profile' &&
      ledger[0].logical_target === 'profile:1' &&
      ledger[0].outcome === 'response-received' &&
      ledger[0].listed_note_ids_json === null,
    'EXACT_KNOWN_RESPONSE_REQUIRED',
  );
  const request = ledger[0];
  const review = d.xhs_unbound_owner_reviews.find(
    (r) => r.id === request.review_id,
  );
  check(review, 'SCHEDULED_REVIEW_REQUIRED');
  const reviewScope = JSON.parse(review.scope_json);
  const proof = await readScheduledKnownAuthProof(
    tx,
    task.id,
    review.id,
    reviewScope.policyId,
  );
  check(
    d.xhs_unbound_owner_requests.filter((r) => r.review_id === review.id)
      .length === 1 &&
      proof.scope.taskBinding.creatorId === task.creator_id &&
      doc.schedule.round === proof.scope.round &&
      doc.scheduledContext?.authorId ===
        proof.scope.creatorBindings[task.creator_id] &&
      doc.scheduledContext.used === 1 &&
      doc.scheduledContext.state === 'started' &&
      pack(Object.keys(doc.scheduledContext).sort()) ===
        pack(['authorId', 'state', 'used']),
    'KNOWN_AUTH_REVIEW_BINDING_CHANGED',
  );
  const riskAt = BigInt(risk[0].updated_at),
    taskAt = BigInt(task.updated_at);
  check(
    taskAt >= riskAt &&
      BigInt(proof.review.approved_at) < riskAt &&
      BigInt(proof.policy.approved_at) < riskAt,
    'KNOWN_AUTH_TIME_INVALID',
  );
  const blockedAt = taskAt > riskAt ? taskAt : riskAt;
  const replacement = session(host, blockedAt);
  check(
    replacement.binding !== proof.scope.sessionBinding,
    'FRESH_RUNTIME_SESSION_REQUIRED',
  );
  check(
    doc.knownResponseAuthReviews === undefined,
    'KNOWN_AUTH_ALREADY_REVIEWED',
  );
  const tasks = d.xhs_subscription_tasks,
    jobs = d.xhs_whole_creator_jobs;
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
  check(
    !d.xhs_limited_recovery.some(
      (r) =>
        ['armed', 'started', 'unknown'].includes(r.state) &&
        !d.xhs_limited_recovery_append.some(
          (a) =>
            a.id === r.id &&
            a.note_id === r.note_id &&
            a.author_id === r.author_id &&
            a.state === 'finished',
        ),
    ) &&
      !d.xhs_limited_recovery_append.some((r) =>
        ['armed', 'started', 'unknown'].includes(r.state),
      ),
    'UNRESOLVED_LEGACY_RECOVERY',
  );
  // The old classifier recognizes explicit historical generic-risk approvals.
  // It is NOT sufficient for this authentication event: inspect taskFailure and
  // all live nested structures independently below.
  const restrictionRows = (rs: any[]) =>
    rs.map((r) => {
      const live = JSON.parse(r.document);
      // Match historical SQL projection/property order. Job fingerprints never
      // included creator_id; raw document whitespace is also evidence.
      return {
        id: r.id,
        ...(tasks.includes(r) ? { creator_id: r.creator_id } : {}),
        state: r.state,
        document:
          live.knownResponseAuthReviews?.[0]?.originalTaskRaw ?? r.document,
        updated_at: String(r.updated_at),
      };
    });
  const historical = classifyReviewedRestrictions(
    restrictionRows(tasks),
    restrictionRows(jobs),
    riskAt,
  );
  for (const row of [...tasks, ...jobs]) {
    const live = JSON.parse(row.document);
    check(
      (live.taskId ?? live.id) === row.id &&
        live.state === row.state &&
        (!live.creatorId || live.creatorId === row.creator_id),
      'TASK_IDENTITY_CHANGED',
    );
    if (row === task) {
      delete live.code;
      delete live.taskFailure;
    } else if (
      historical.some((h) => h.fingerprint === hash(restrictionRows([row])[0]))
    ) {
      delete live.code;
    } else if (
      live.code === AUTH &&
      BigInt(row.updated_at) < BigInt(proof.policy.approved_at) &&
      proof.baseline.unknowns.some(
        (u: any) => u.id === row.id && u.creatorId === row.creator_id,
      )
    ) {
      // Only authentication already inside the exact retained scheduled baseline.
      // No newly created/changed event or other platform restriction is exempted.
      delete live.code;
      if (live.taskFailure?.code === AUTH) delete live.taskFailure.code;
    }
    // Historical audit roots are not live evidence. Do not skip these names at
    // arbitrary depth: an unknown nested structure must never hide a stop.
    if (row !== task) {
      delete live.genericRiskReviews;
      delete live.historyHandoff;
      delete live.knownResponseAuthReviews;
    }
    check(!restriction(live), 'OTHER_PLATFORM_RESTRICTION');
  }
  check(
    d.xhs_request_budgets.some((b) => b.id === 'xhs:source-total') &&
      d.xhs_request_budgets.some((b) => b.id === proof.scope.budgetId),
    'SOURCE_BUDGET_REQUIRED',
  );
  const evidence = {
    task,
    taskDigest: hash(task.document),
    taskUpdatedAt: String(task.updated_at),
    request,
    requestReviewDigest: hash(proof.review),
    policyDigest: hash(proof.policy),
    budgetDigest: hash(d.xhs_request_budgets),
    baselineDigest: proof.scope.baselineDigest,
    round: proof.scope.round,
  };
  const plan = {
    kind: KIND,
    version: 1,
    target,
    operationId: request.operation_id,
    requestReviewId: review.id,
    policyId: proof.policy.id,
    originalRisk: risk[0],
    originalOutcome: 'response-received' as const,
    evidence,
    replacement,
    stateDigest: hash(state),
    authenticationVerified: false as const,
    sourceRequestsSent: 0 as const,
    newGrant: false as const,
  };
  session(host, blockedAt, replacement);
  return { plan: { ...plan, digest: hash(plan) }, state, proof, blockedAt };
}
export type KnownAuthPlan = Awaited<
  ReturnType<typeof prepareKnownAuthResponseReview>
>;
/** Read-only. Caller supplies identity, never a purported session binding. */
export async function prepareKnownAuthResponseReview(
  tx: RoundTx,
  target: KnownAuthTarget,
  host: KnownAuthSessionHost,
) {
  return (await build(tx, target, host)).plan;
}

export async function confirmKnownAuthResponseReview(
  target: KnownAuthTarget,
  digest: string,
  host: KnownAuthReviewHost,
  now: bigint,
) {
  return host.protectedTransaction(async (tx) => {
    await host.assertQuiescent();
    const { plan: p, state, proof, blockedAt } = await build(tx, target, host);
    check(p.digest === digest, 'REVIEW_STATE_CHANGED');
    check(
      now >= BigInt(p.replacement.connectedAt) && now > blockedAt,
      'APPROVAL_TIME_INVALID',
    );
    await host.authorizePlan(p);
    await host.assertPolicyInstalled(p.policyId, p.evidence.policyDigest);
    await host.assertSafeRestorePolicy();
    session(host, blockedAt, p.replacement);
    await host.assertQuiescent();
    check(
      (await prepareKnownAuthResponseReview(tx, target, host)).digest ===
        digest,
      'REVIEW_STATE_CHANGED',
    );
    const id = 'known-auth-' + p.digest;
    const audit = {
      id,
      kind: KIND,
      version: 1,
      digest: p.digest,
      stateDigest: p.stateDigest,
      transactionProtection: 'incremental-sqlite-original-values-v1',
      confirmation: {
        acknowledgedKnownResponseAuth: true,
        sessionOrigin: p.replacement.origin,
      },
      taskId: target.taskId,
      creatorId: target.creatorId,
      operationId: p.operationId,
      requestReviewId: p.requestReviewId,
      policyId: p.policyId,
      originalOutcome: 'response-received',
      originalRisk: p.originalRisk,
      originalTaskRaw: p.evidence.task.document,
      evidence: p.evidence,
      session: p.replacement,
      confirmedAt: String(now),
      authenticationVerified: false,
      sourceRequestsSent: 0,
      newGrant: false,
    };
    const r = p.originalRisk,
      t = p.evidence.task,
      q = p.evidence.request;
    const nextDocument = pack({
      ...JSON.parse(t.document),
      knownResponseAuthReviews: [audit],
    });
    check(
      Buffer.byteLength(nextDocument, 'utf8') <= 2_000_000,
      'KNOWN_AUTH_AUDIT_SIZE_LIMIT',
    );
    check(
      (await tx.$executeRawUnsafe(
        'UPDATE xhs_subscription_tasks SET document=? WHERE id=? AND creator_id=? AND state=? AND document=? AND updated_at=?',
        nextDocument,
        t.id,
        t.creator_id,
        t.state,
        t.document,
        t.updated_at,
      )) === 1,
      'KNOWN_AUTH_TASK_COMPARE_AND_SWAP_FAILED',
    );
    check(
      (await tx.$executeRawUnsafe(
        `UPDATE xhs_source_risk SET state='clear',owner=NULL,code=NULL,http_status=NULL,endpoint=NULL,updated_at=?
       WHERE id=? AND state=? AND owner IS ? AND code IS ? AND http_status IS ? AND endpoint IS ? AND updated_at=?
       AND EXISTS(SELECT 1 FROM xhs_subscription_tasks WHERE id=? AND creator_id=? AND state=? AND document=? AND updated_at=?)
       AND EXISTS(SELECT 1 FROM xhs_unbound_owner_requests WHERE operation_id=? AND review_id=? AND task_id=? AND creator_id=? AND phase=? AND logical_target=? AND outcome=? AND listed_note_ids_json IS ?)
       AND EXISTS(SELECT 1 FROM xhs_unbound_owner_reviews WHERE id=? AND plan_digest=? AND scope_json=?)
       AND EXISTS(SELECT 1 FROM xhs_unbound_owner_reviews WHERE id=? AND plan_digest=? AND scope_json=?)`,
        now,
        r.id,
        r.state,
        r.owner,
        r.code,
        r.http_status,
        r.endpoint,
        r.updated_at,
        t.id,
        t.creator_id,
        t.state,
        nextDocument,
        t.updated_at,
        q.operation_id,
        q.review_id,
        q.task_id,
        q.creator_id,
        q.phase,
        q.logical_target,
        q.outcome,
        q.listed_note_ids_json,
        proof.review.id,
        proof.review.plan_digest,
        proof.review.scope_json,
        proof.policy.id,
        proof.policy.plan_digest,
        proof.policy.scope_json,
      )) === 1,
      'KNOWN_AUTH_COMPARE_AND_SWAP_FAILED',
    );
    // All post-write checks still run inside the same SQLite transaction.
    await host.assertQuiescent();
    await host.assertPolicyInstalled(p.policyId, p.evidence.policyDigest);
    await host.assertSafeRestorePolicy();
    const after = await snapshot(tx);
    const clearRisk = {
      ...r,
      state: 'clear',
      owner: null,
      code: null,
      http_status: null,
      endpoint: null,
      updated_at: now,
    };
    check(
      pack(after.data.xhs_source_risk) === pack([clearRisk]),
      'RISK_CHANGED',
    );
    const appended = after.data.xhs_subscription_tasks.find(
      (row) => row.id === t.id,
    );
    check(appended?.document === nextDocument, 'AUDIT_CHANGED');
    appended.document = t.document;
    after.data.xhs_source_risk = state.data.xhs_source_risk;
    after.data.xhs_subscription_tasks.sort((a, b) =>
      pack(a).localeCompare(pack(b)),
    );
    check(hash(after) === p.stateDigest, 'HISTORY_OR_BUDGET_CHANGED');
    session(host, blockedAt, p.replacement);
    return {
      reviewId: id,
      taskId: t.id,
      auditDigest: hash(JSON.parse(pack(audit))),
      digest: p.digest,
      session: p.replacement,
      riskClearedAt: String(now),
      originalOutcome: 'response-received' as const,
      authenticationVerified: false as const,
      sourceRequestsSent: 0 as const,
      newGrant: false as const,
    };
  });
}
type Commit = Awaited<ReturnType<typeof confirmKnownAuthResponseReview>>;

/** Read-only, post-commit proof. Not a persistent scheduling/generation gate.
 * A missing replacement binding (including a restored old vault) is not evidence
 * for this specific review. Normal safe saved-session startup is a separate
 * existing vault-policy contract, not a requirement to log in every restart. */
export async function assertKnownAuthCommittedSession(
  tx: RoundTx,
  result: Commit,
  runtime: KnownAuthSessionHost,
) {
  const all = await rows(
    tx,
    'SELECT * FROM xhs_subscription_tasks ORDER BY id',
  );
  const audits = all
    .flatMap((t) =>
      (JSON.parse(t.document).knownResponseAuthReviews ?? []).map((a: any) => ({
        a,
        t,
      })),
    )
    .sort((x, y) =>
      BigInt(x.a.confirmedAt) > BigInt(y.a.confirmedAt) ? -1 : 1,
    );
  const { a, t } = audits[0] ?? {};
  check(
    a &&
      t.id === result.taskId &&
      a.id === result.reviewId &&
      a.digest === result.digest &&
      hash(a) === result.auditDigest &&
      isDeepStrictEqual(a.session, result.session) &&
      a.confirmedAt === result.riskClearedAt,
    'KNOWN_AUTH_COMMITTED_REVIEW_REQUIRED',
  );
  const live = JSON.parse(t.document);
  delete live.knownResponseAuthReviews;
  check(
    isDeepStrictEqual(live, JSON.parse(a.originalTaskRaw)) &&
      String(t.updated_at) === a.evidence.taskUpdatedAt &&
      t.state === 'blocked',
    'KNOWN_AUTH_ORIGINAL_TASK_CHANGED',
  );
  const risk = await rows(
    tx,
    "SELECT * FROM xhs_source_risk WHERE id='source'",
  );
  check(
    risk.length === 1 &&
      risk[0].state === 'clear' &&
      ['owner', 'code', 'http_status', 'endpoint'].every(
        (k) => risk[0][k] === null,
      ) &&
      String(risk[0].updated_at) === result.riskClearedAt,
    'KNOWN_AUTH_CLEAR_VERSION_CHANGED',
  );
  const e = a.evidence,
    original = a.originalRisk;
  const request = await rows(
    tx,
    'SELECT * FROM xhs_unbound_owner_requests WHERE task_id=?',
    a.taskId,
  );
  check(
    request.length === 1 && pack(request[0]) === pack(e.request),
    'KNOWN_AUTH_REQUEST_CHANGED',
  );
  session(
    runtime,
    BigInt(e.taskUpdatedAt) > BigInt(original.updated_at)
      ? BigInt(e.taskUpdatedAt)
      : BigInt(original.updated_at),
    result.session,
  );
  const proof = await readScheduledKnownAuthProof(
    tx,
    a.taskId,
    a.requestReviewId,
    a.policyId,
  );
  check(
    hash(proof.policy) === e.policyDigest &&
      hash(proof.review) === e.requestReviewDigest,
    'SCHEDULED_POLICY_CHANGED',
  );
  session(runtime, BigInt(e.taskUpdatedAt), result.session);
}
/** Call only after protectedTransaction has resolved (commit acknowledged).
 * No refresh before commit, after failure, or for a different runtime binding.
 * Host refresh MUST atomically recheck session + exact clear version after any
 * await and before memory mutation. Outer checks cannot undo cleared memory;
 * the runtime implements the final synchronous binding/clear-version check. */
export async function refreshKnownAuthAfterCommit(
  tx: RoundTx,
  result: Commit,
  runtime: KnownAuthSessionHost & {
    refreshAfterAuthSessionReview(binding: string): Promise<void>;
  },
) {
  await assertKnownAuthCommittedSession(tx, result, runtime);
  // Final operation: the host rechecks exact version and session then clears
  // memory synchronously under the protected writer lock. No fallible DB read
  // follows that clear, so a rejected refresh still means memory stayed blocked.
  return runtime.refreshAfterAuthSessionReview(result.session.binding);
}

/** Application-level append/CAS protection, NOT database-level immutability.
 * Reviewed tasks are frozen. Missing audit in a stale snapshot is restored;
 * supplied altered/forged audit or any changed old-task field is rejected. */
export function preserveKnownAuthTaskAudit(saved: any, incoming: any): boolean {
  if (!saved?.knownResponseAuthReviews) {
    check(
      incoming.knownResponseAuthReviews === undefined,
      'KNOWN_AUTH_AUDIT_FORGED',
    );
    return false;
  }
  check(
    Array.isArray(saved.knownResponseAuthReviews) &&
      saved.knownResponseAuthReviews.length === 1,
    'KNOWN_AUTH_AUDIT_CHANGED',
  );
  check(
    incoming.knownResponseAuthReviews === undefined ||
      isDeepStrictEqual(
        incoming.knownResponseAuthReviews,
        saved.knownResponseAuthReviews,
      ),
    'KNOWN_AUTH_AUDIT_CHANGED',
  );
  const old = { ...saved },
    next = { ...incoming };
  delete old.knownResponseAuthReviews;
  delete next.knownResponseAuthReviews;
  check(isDeepStrictEqual(old, next), 'KNOWN_AUTH_TASK_FROZEN');
  incoming.knownResponseAuthReviews = saved.knownResponseAuthReviews;
  return true;
}
