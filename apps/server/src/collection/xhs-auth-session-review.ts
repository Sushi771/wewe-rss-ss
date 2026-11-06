import { classifyReviewedRestrictions } from './xhs-reviewed-restrictions';
import { createHash } from 'node:crypto';
import type { RoundTx } from './xhs-unbound-round';

const packed = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const hash = (v: unknown) =>
  createHash('sha256').update(packed(v)).digest('hex');
function requireReview(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

/** Server-generated opaque session generation binding; never a cookie or its hash. */
export interface AuthSessionReviewHost {
  assertQuiescent(): Promise<void>;
  assertReplacementSession(binding: string, blockedAt?: bigint): Promise<void>;
  assertPolicyInstalled(): Promise<void>;
  authorizePlan(plan: AuthSessionReviewPlan): Promise<void>;
  verifyBackup(stateDigest: string): Promise<string>;
}
export type AuthSessionReviewPlan = Awaited<
  ReturnType<typeof prepareAuthSessionReview>
>;

/** Read-only preparation. No authentication probe or claim that the new login works. */
export async function prepareAuthSessionReview(
  tx: RoundTx,
  creatorIds: string[],
  sessionBinding: string,
) {
  requireReview(
    /^[a-f0-9]{64}$/.test(sessionBinding),
    'SERVER_SESSION_BINDING_REQUIRED',
  );
  requireReview(
    creatorIds.length === 3 && new Set(creatorIds).size === 3,
    'EXACT_THREE_CREATORS_REQUIRED',
  );
  const risk = await tx.$queryRawUnsafe<any[]>(
    "SELECT * FROM xhs_source_risk WHERE id='source'",
  );
  requireReview(
    risk.length === 1 &&
      risk[0].state === 'blocked' &&
      risk[0].code === 'XHS_SOURCE_AUTHENTICATION_BLOCKED' &&
      risk[0].owner === null &&
      [null, 401].includes(risk[0].http_status) &&
      risk[0].endpoint === 'profile',
    'AUTHENTICATION_REVIEW_ONLY',
  );
  const requests = await tx.$queryRawUnsafe<any[]>(
    'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
  );
  requireReview(
    requests.some((r) => r.phase === 'profile' && r.outcome === 'unknown') &&
      requests.every((r) =>
        ['unknown', 'response-received', 'not-sent'].includes(r.outcome),
      ),
    'UNKNOWN_REQUEST_REVIEW_REQUIRED',
  );
  const tasks = await tx.$queryRawUnsafe<any[]>(
    'SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_subscription_tasks ORDER BY id',
  );
  const jobs = await tx.$queryRawUnsafe<any[]>(
    'SELECT id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_whole_creator_jobs ORDER BY id',
  );
  requireReview(
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
  const historicalRestrictions = classifyReviewedRestrictions(
    tasks,
    jobs,
    BigInt(risk[0].updated_at),
  );
  const creators = await tx.$queryRawUnsafe<any[]>(
    'SELECT id,external_author_id,enabled FROM xhs_creators ORDER BY id',
  );
  requireReview(
    creatorIds.every(
      (id) =>
        /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
        creators.some(
          (r) => r.id === id && Number(r.enabled) === 1 && r.external_author_id,
        ),
    ),
    'CREATOR_BINDING_CHANGED',
  );
  const budgets = await tx.$queryRawUnsafe<any[]>(
    'SELECT * FROM xhs_request_budgets ORDER BY id',
  );
  requireReview(
    budgets.some((r) => r.id === 'xhs:source-total'),
    'SOURCE_BUDGET_REQUIRED',
  );
  const scope = {
    creatorIds: [...creatorIds].sort(),
    maxListPages: 1,
    maxNotesPerCreator: 30,
    maxMediaPerNote: 20,
    history: false,
    comments: false,
    replies: false,
    reviewKind: 'replacement-session-authentication-review-v1',
    sessionBinding,
    originalRequests: requests,
    historicalRestrictions,
    authenticationVerified: false,
  };
  const plan = {
    kind: 'replacement-session-authentication-review-v1',
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
    scope,
    stateDigest: hash({
      risk,
      requests,
      tasks,
      jobs,
      creators,
      budgets,
      sessionBinding,
    }),
  };
  return { ...plan, digest: hash(plan) };
}

/** Caller must own a protected transaction and roll back every thrown error. */
export async function confirmAuthSessionReview(
  tx: RoundTx,
  creatorIds: string[],
  binding: string,
  digest: string,
  host: AuthSessionReviewHost,
  now: bigint,
) {
  await host.assertQuiescent();
  await host.assertReplacementSession(binding);
  const p = await prepareAuthSessionReview(tx, creatorIds, binding);
  requireReview(p.digest === digest, 'REVIEW_STATE_CHANGED');
  await host.assertReplacementSession(
    binding,
    BigInt(p.originalRisk.updated_at),
  );
  await host.authorizePlan(p);
  await host.assertPolicyInstalled();
  const backup = await host.verifyBackup(p.stateDigest);
  requireReview(
    /^[a-f0-9]{64}$/.test(backup),
    'VERIFIED_PROTECTED_BACKUP_REQUIRED',
  );
  requireReview(
    now >= BigInt(p.originalRisk.updated_at),
    'APPROVAL_TIME_INVALID',
  );
  await host.assertReplacementSession(binding);
  const id = 'unbound-' + p.digest;
  await tx.$executeRawUnsafe(
    'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id,
    p.digest,
    packed(p.originalRisk),
    'unknown',
    packed(p.oldTaskIds),
    packed(p.oldJobIds),
    packed(p.creatorBindings),
    packed(p.budgetSnapshot),
    packed(p.scope),
    backup,
    now,
  );
  requireReview(
    (await tx.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='clear',owner=NULL,code=NULL,http_status=NULL,endpoint=NULL,updated_at=? WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_AUTHENTICATION_BLOCKED' AND owner IS NULL AND updated_at=?",
      now,
      p.originalRisk.updated_at,
    )) === 1,
    'AUTHENTICATION_COMPARE_AND_SWAP_FAILED',
  );
  await host.assertQuiescent();
  await host.assertReplacementSession(binding);
  requireReview(
    packed(
      await tx.$queryRawUnsafe('SELECT * FROM xhs_request_budgets ORDER BY id'),
    ) === packed(p.budgetSnapshot),
    'BUDGET_CHANGED',
  );
  requireReview(
    packed(
      await tx.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
      ),
    ) === packed(p.scope.originalRequests),
    'UNKNOWN_HISTORY_CHANGED',
  );
  return {
    reviewId: id,
    originalOutcome: 'unknown',
    authenticationVerified: false,
    sourceRequestsSent: 0,
  };
}
