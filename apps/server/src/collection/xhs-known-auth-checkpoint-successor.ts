import { createHash } from 'node:crypto';

const pack = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const hash = (v: unknown) => createHash('sha256').update(pack(v)).digest('hex');
const keys = (v: any, expected: string[]) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  pack(Object.keys(v).sort()) === pack([...expected].sort());
const check = (v: unknown) => {
  if (!v) throw Error('KNOWN_PROFILE_ALREADY_CONSUMED');
};
export function knownProfileAttemptIds(eventId: string, successor = false) {
  const suffix = successor ? '-local-checkpoint-1' : '';
  return {
    reviewId: 'unbound-known-profile-' + hash(eventId) + suffix,
    taskId: 'known-profile:' + hash(eventId) + suffix,
  };
}

/** Pure proof of one rolled-back local checkpoint, never a write or a retry.
 * The original request/receipt and spent budgets remain in the successor's real
 * baseline. The inverse below only verifies their exact, already-spent delta. */
export function knownAuthCheckpointPredecessor(
  state: { schema: any[]; data: Record<string, any[]> },
  eventId: string,
  taskId: string,
  creatorId: string,
  policy: any,
  risk: any,
  recoveryPlan: any,
) {
  const ids = knownProfileAttemptIds(eventId),
    d = state.data;
  const row = d.xhs_unbound_owner_reviews.find((r) => r.id === ids.reviewId);
  if (!row) return undefined;
  const s = JSON.parse(row.scope_json);
  const author = JSON.parse(policy.creator_bindings_json)[creatorId];
  check(
    keys(s, [
      'reviewKind',
      'version',
      'verificationOrder',
      'rootHistoricalEvidence',
      'knownAuthentication',
      'session',
      'transportBinding',
      'creatorIds',
      'creatorBindings',
      'requestScope',
      'authorization',
      'controlStateDigest',
      'riskClear',
    ]) &&
      keys(s.knownAuthentication, [
        'taskId',
        'creatorId',
        'authReviewId',
        'authDigest',
        'auditDigest',
        'originalOutcome',
        'riskClearedAt',
        'committed',
      ]) &&
      keys(s.rootHistoricalEvidence, [
        'policyId',
        'policyDigest',
        'originalRiskDigest',
        'originalOutcome',
        'backupSha256',
        'inherited',
      ]),
  );
  check(
    row.plan_digest === hash(s) &&
      s.reviewKind === 'known-auth-profile-probe-v1' &&
      s.version === 1 &&
      s.verificationOrder === 'before-auth-clear' &&
      !s.localCheckpointRecovery &&
      s.knownAuthentication?.authReviewId === eventId &&
      s.knownAuthentication?.taskId === taskId &&
      s.knownAuthentication?.creatorId === creatorId &&
      s.knownAuthentication?.originalOutcome === 'response-received' &&
      s.knownAuthentication?.committed === false &&
      s.knownAuthentication?.riskClearedAt === null &&
      pack(s.riskClear) === pack(risk) &&
      s.rootHistoricalEvidence?.policyId === policy.id &&
      s.rootHistoricalEvidence?.policyDigest === policy.plan_digest &&
      s.rootHistoricalEvidence?.originalRiskDigest ===
        hash(policy.original_risk_json) &&
      s.rootHistoricalEvidence?.originalOutcome === 'unknown' &&
      s.rootHistoricalEvidence?.inherited === true &&
      typeof author === 'string' &&
      !!author &&
      pack(s.creatorBindings) === pack({ [creatorId]: author }) &&
      row.creator_bindings_json === pack({ [creatorId]: author }) &&
      s.rootHistoricalEvidence?.backupSha256 === policy.backup_sha256 &&
      row.original_risk_json === policy.original_risk_json &&
      row.original_outcome === 'unknown' &&
      row.backup_sha256 === policy.backup_sha256 &&
      pack(s.creatorIds) === pack([creatorId]) &&
      pack(s.requestScope) ===
        pack({
          taskId: ids.taskId,
          target: 'profile',
          maxRequests: 1,
          phaseLimits: { profile: 1, list: 0, detail: 0, media: 0 },
        }) &&
      pack(s.authorization) ===
        pack({
          acknowledgedOneProfile: true,
          comments: false,
          replies: false,
          automaticRetry: false,
          authenticationVerified: false,
        }),
  );
  const own = d.xhs_unbound_owner_requests.filter(
    (r) => r.review_id === ids.reviewId,
  );
  check(own.length === 1);
  const request = own[0];
  check(
    /^[a-f0-9-]{36}$/.test(request.operation_id) &&
      request.task_id === ids.taskId &&
      request.creator_id === creatorId &&
      request.phase === 'profile' &&
      request.logical_target === 'profile' &&
      request.outcome === 'response-received' &&
      request.listed_note_ids_json === null,
  );
  const receipts = d.xhs_unbound_source_receipts.filter(
    (r) => r.operation_id === request.operation_id,
  );
  check(receipts.length === 1);
  const receipt = JSON.parse(receipts[0].document);
  check(
    pack(Object.keys(receipt).sort()) ===
      pack(['code', 'events', 'outcome', 'stage', 'status', 'terminal']) &&
      receipt.stage === 'checkpoint' &&
      receipt.outcome === 'local-failure' &&
      receipt.terminal === true &&
      receipt.status === 200 &&
      receipt.code === 'XHS_STORAGE_FAILED' &&
      Array.isArray(receipt.events) &&
      receipt.events.length > 0 &&
      receipt.events.length <= 12 &&
      receipt.events.some(
        (e: any) => e.stage === 'response' && e.status === 200,
      ) &&
      receipt.events.some((e: any) => e.stage === 'storage') &&
      receipt.events.every(
        (e: any) =>
          [
            'admitted',
            'transport',
            'sent',
            'response',
            'parse',
            'storage',
          ].includes(e.stage) &&
          Object.keys(e).every((k) => ['stage', 'status'].includes(k)) &&
          (e.status === undefined || e.status === 200),
      ),
  );
  const before = JSON.parse(row.budget_snapshot_json) as any[];
  check(
    Array.isArray(before) && before.some((b) => b.id === 'xhs:source-total'),
  );
  let reservedAt: number | undefined;
  const charged = new Set([
    'xhs:source-total',
    'xhs:original-link:' + creatorId,
  ]);
  const expected = before.map((b) => {
    if (!charged.has(b.id)) return b;
    const current = d.xhs_request_budgets.find((r) => r.id === b.id);
    check(current);
    const at = Number(current.next_at) - Number(b.interval_ms);
    check(
      [
        at,
        Number(current.next_at),
        Number(b.next_at),
        Number(b.interval_ms),
        Number(b.used),
        Number(b.request_limit),
        Number(row.approved_at),
      ].every(Number.isSafeInteger) &&
        Number(b.used) >= 0 &&
        Number(b.request_limit) > 0 &&
        Number(b.next_at) >= 0 &&
        Number(row.approved_at) > 0 &&
        at >= Number(row.approved_at) &&
        at >= Number(b.next_at) &&
        Number.isSafeInteger(Number(b.used)) &&
        Number(b.used) < Number(b.request_limit) &&
        Number(b.interval_ms) >= 1000 &&
        (reservedAt === undefined || reservedAt === at),
    );
    reservedAt = at;
    return {
      ...b,
      used: Number(b.used) + 1,
      next_at: String(at + Number(b.interval_ms)),
    };
  });
  check(pack(expected) === pack(d.xhs_request_budgets));
  const prior = JSON.parse(pack(state));
  prior.data.xhs_unbound_owner_reviews =
    prior.data.xhs_unbound_owner_reviews.filter(
      (r: any) => r.id !== ids.reviewId,
    );
  prior.data.xhs_unbound_owner_requests =
    prior.data.xhs_unbound_owner_requests.filter(
      (r: any) => r.review_id !== ids.reviewId,
    );
  prior.data.xhs_unbound_source_receipts =
    prior.data.xhs_unbound_source_receipts.filter(
      (r: any) => r.operation_id !== request.operation_id,
    );
  prior.data.xhs_request_budgets = before;
  for (const table of Object.values(prior.data) as any[][])
    table.sort((a, b) => pack(a).localeCompare(pack(b)));
  check(
    hash(prior) === s.controlStateDigest &&
      row.old_task_ids_json ===
        pack(prior.data.xhs_subscription_tasks.map((r: any) => r.id)) &&
      row.old_job_ids_json ===
        pack(prior.data.xhs_whole_creator_jobs.map((r: any) => r.id)),
  );
  // Reconstruct the original server-created plan from unchanged evidence, not
  // merely a self-consistent scope hash. No saved credentials are read here.
  const oldPlan = JSON.parse(pack(recoveryPlan));
  oldPlan.replacement = s.session;
  oldPlan.stateDigest = s.controlStateDigest;
  oldPlan.evidence.budgetDigest = hash(before);
  delete oldPlan.digest;
  const oldDigest = hash(oldPlan);
  check(
    oldDigest === s.knownAuthentication.authDigest &&
      hash({ ...oldPlan, digest: oldDigest }) ===
        s.knownAuthentication.auditDigest,
  );
  return {
    attempt: 1 as const,
    reviewId: ids.reviewId,
    operationId: request.operation_id,
    reviewDigest: hash(row),
    receiptDigest: hash(receipts[0].document),
    originalOutcome: 'response-received' as const,
    failure: 'local-checkpoint-storage' as const,
    automaticRetry: false as const,
  };
}
