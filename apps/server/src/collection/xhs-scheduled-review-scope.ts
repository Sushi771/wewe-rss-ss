import { createHash } from 'node:crypto';
import type { RoundTx, RoundRequest } from './xhs-unbound-round';
import { scheduledTaskId } from './xhs-scheduled-admission';
import {
  fullHistoryContext,
  fullHistoryBudgetId,
  FULL_HISTORY_KIND,
} from './xhs-full-history-scope';
import { fullHistoryLineage } from './xhs-full-history-unknown-review';
export const SCHEDULED_POLICY_KIND = 'scheduled-recurring-policy-v1';
export const SCHEDULED_REVIEW_KIND = 'scheduled-round-review-v1';
export const SCHEDULED_ROUND_KIND = SCHEDULED_REVIEW_KIND;
export const SCHEDULED_REVOKE_KIND = 'scheduled-recurring-revocation-v1';
const phases = ['profile', 'list', 'detail', 'media'] as const;
export type ScheduledPolicyInput = {
  creatorIds: string[];
  maxRequests: number;
  phaseLimits: Record<(typeof phases)[number], number>;
};
const pack = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const hash = (v: unknown) => createHash('sha256').update(pack(v)).digest('hex');
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error(code);
}
const rows = (tx: RoundTx, sql: string, ...args: unknown[]) =>
  tx.$queryRawUnsafe<any[]>(sql, ...args);
async function reviews(tx: RoundTx) {
  return rows(
    tx,
    'SELECT id,plan_digest,original_risk_json,original_outcome,old_task_ids_json,old_job_ids_json,creator_bindings_json,budget_snapshot_json,scope_json,backup_sha256,CAST(approved_at AS TEXT) AS approved_at FROM xhs_unbound_owner_reviews ORDER BY xhs_unbound_owner_reviews.approved_at,xhs_unbound_owner_reviews.id',
  );
}
async function baseline(tx: RoundTx, excludedOperation?: string) {
  const ledger = await rows(
    tx,
    "SELECT * FROM xhs_unbound_owner_requests WHERE outcome IN ('started','unknown') ORDER BY operation_id",
  );
  const fences = await rows(
    tx,
    "SELECT * FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' ORDER BY id",
  );
  const tasks = await rows(
    tx,
    'SELECT id,creator_id,document FROM xhs_subscription_tasks ORDER BY id',
  );
  const jobs = await rows(
    tx,
    'SELECT id,creator_id,document FROM xhs_whole_creator_jobs ORDER BY id',
  );
  const unknowns = [...tasks, ...jobs].flatMap((r) => {
    const d = JSON.parse(r.document);
    const evidence = {
      sourceActive: d.sourceActive ?? null,
      sourceUnknowns: d.sourceUnknowns ?? [],
      sourceFence: d.sourceFence ?? null,
    };
    return evidence.sourceActive ||
      evidence.sourceUnknowns.length ||
      evidence.sourceFence
      ? [{ id: r.id, creatorId: r.creator_id, ...evidence }]
      : [];
  });
  return {
    ledger: ledger.filter((r) => r.operation_id !== excludedOperation),
    fences,
    unknowns,
  };
}
async function activePolicy(tx: RoundTx) {
  const all = await reviews(tx),
    revoked = new Set(
      all
        .filter(
          (r) => JSON.parse(r.scope_json).reviewKind === SCHEDULED_REVOKE_KIND,
        )
        .map((r) => JSON.parse(r.scope_json).policyId),
    );
  return all
    .reverse()
    .find(
      (r) =>
        JSON.parse(r.scope_json).reviewKind === SCHEDULED_POLICY_KIND &&
        !revoked.has(r.id),
    );
}
async function currentBindings(tx: RoundTx, ids: string[]) {
  const found = await rows(
    tx,
    'SELECT id,external_author_id,enabled FROM xhs_creators ORDER BY id',
  );
  check(
    ids.every((id) =>
      found.some(
        (r) => r.id === id && Number(r.enabled) === 1 && r.external_author_id,
      ),
    ),
    'SCHEDULED_CREATOR_BINDING_CHANGED',
  );
  return Object.fromEntries(
    ids.map((id) => [id, found.find((r) => r.id === id).external_author_id]),
  );
}
/** Retained exclusions are evidence only, never reusable full-history capacity. */
async function retainedNarrowExclusions(
  tx: RoundTx,
  creatorBindings: Record<string, string>,
) {
  const all = await reviews(tx);
  const candidates = all.filter((r) => {
    const s = JSON.parse(r.scope_json);
    return (
      s.reviewKind === FULL_HISTORY_KIND &&
      s.narrowing === 'parent-receipt-marker-phase-identity' &&
      Object.prototype.hasOwnProperty.call(
        creatorBindings,
        s.narrowedCreatorId,
      ) &&
      !all.some(
        (next) =>
          next.id !== r.id &&
          (JSON.parse(next.scope_json).lineageReviewIds ?? []).includes(r.id),
      )
    );
  });
  const exclusions: Record<string, { phase: string; target: string }[]> = {};
  const evidence = new Map<string, string>();
  for (const row of candidates) {
    const lineage = await fullHistoryLineage(tx, row.id);
    for (const id of lineage.ids) {
      const original = all.find((r) => r.id === id);
      check(
        original &&
          /^[a-f0-9]{64}$/.test(original.backup_sha256) &&
          /^\d+$/.test(original.approved_at),
        'FULL_REVIEW_LINEAGE_INVALID',
      );
      const bindings = JSON.parse(original.creator_bindings_json);
      for (const binding of lineage.scope.bindings) {
        if (
          !Object.prototype.hasOwnProperty.call(
            creatorBindings,
            binding.creatorId,
          )
        )
          continue;
        check(
          bindings[binding.creatorId] === creatorBindings[binding.creatorId],
          'SCHEDULED_CREATOR_BINDING_CHANGED',
        );
      }
      evidence.set(id, hash(original));
    }
    for (const binding of lineage.scope.bindings) {
      if (
        !Object.prototype.hasOwnProperty.call(
          creatorBindings,
          binding.creatorId,
        )
      )
        continue;
      for (const x of lineage.scope.exclusions[binding.creatorId] ?? []) {
        if (!['detail', 'media'].includes(x.phase)) continue;
        check(
          typeof x.target === 'string' && x.target.length > 0,
          'FULL_REVIEW_LINEAGE_INVALID',
        );
        (exclusions[binding.creatorId] ??= []).push({
          phase: x.phase,
          target: x.target,
        });
      }
    }
  }
  return {
    exclusions,
    evidence: [...evidence].sort(([a], [b]) => a.localeCompare(b)),
  };
}
async function assertBaseline(tx: RoundTx, scope: any, operation?: string) {
  check(
    hash(await baseline(tx, operation)) === scope.baselineDigest,
    'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
  );
  const all = await reviews(tx);
  for (const [id, digest] of scope.retainedHistoryEvidence ?? []) {
    const original = all.find((r) => r.id === id);
    check(original && hash(original) === digest, 'REVIEW_STATE_CHANGED');
  }
  check(
    !all.some((r) => {
      const s = JSON.parse(r.scope_json);
      return (
        s.reviewKind === SCHEDULED_REVOKE_KIND && s.policyId === scope.policyId
      );
    }),
    'SCHEDULED_POLICY_REVOKED',
  );
  check(
    pack(await currentBindings(tx, scope.creatorIds)) ===
      pack(scope.creatorBindings),
    'SCHEDULED_CREATOR_BINDING_CHANGED',
  );
}
export async function prepareScheduledPolicy(
  tx: RoundTx,
  input: ScheduledPolicyInput,
) {
  check(
    input.creatorIds.length === 3 && new Set(input.creatorIds).size === 3,
    'EXACT_THREE_CREATORS_REQUIRED',
  );
  check(
    Number.isSafeInteger(input.maxRequests) &&
      input.maxRequests > 0 &&
      input.maxRequests <= 100000 &&
      Object.keys(input.phaseLimits).sort().join(',') ===
        'detail,list,media,profile' &&
      phases.every(
        (p) =>
          Number.isSafeInteger(input.phaseLimits[p]) &&
          input.phaseLimits[p] >= 0 &&
          input.phaseLimits[p] <= input.maxRequests,
      ),
    'SCHEDULED_POLICY_LIMIT_INVALID',
  );
  const creatorIds = [...input.creatorIds].sort(),
    creatorBindings = await currentBindings(tx, creatorIds),
    retained = await baseline(tx);
  const risk = await rows(
    tx,
    "SELECT * FROM xhs_source_risk WHERE id='source'",
  );
  check(
    risk.length === 1 &&
      risk[0].state === 'clear' &&
      ['code', 'owner', 'http_status', 'endpoint'].every(
        (k) => risk[0][k] === null,
      ),
    'XHS_SOURCE_RISK_REVIEW_REQUIRED',
  );
  const exclusions = Object.fromEntries(
    creatorIds.map((id) => [
      id,
      [
        ...retained.ledger
          .filter((r) => r.creator_id === id)
          .map((r) => ({ phase: r.phase, target: r.logical_target })),
        ...retained.unknowns
          .filter((u) => u.creatorId === id)
          .flatMap((u) =>
            [...(u.sourceUnknowns ?? []), u.sourceActive, u.sourceFence]
              .filter(Boolean)
              .map((v) => ({
                phase: v.phase === 'metrics' ? 'detail' : v.phase,
                target: v.targetHash
                  ? 'sha256:' + v.targetHash
                  : (v.noteId ?? v.logical_target ?? '*'),
              })),
          ),
      ],
    ]),
  );
  const retainedHistory = await retainedNarrowExclusions(tx, creatorBindings);
  for (const id of creatorIds) {
    exclusions[id] = [
      ...new Map(
        [...exclusions[id], ...(retainedHistory.exclusions[id] ?? [])].map(
          (x) => [pack(x), x],
        ),
      ).values(),
    ];
  }
  const scope = {
    exclusions,
    retainedHistoryEvidence: retainedHistory.evidence,
    reviewKind: SCHEDULED_POLICY_KIND,
    creatorIds,
    creatorBindings,
    maxRequests: input.maxRequests,
    phaseLimits: input.phaseLimits,
    baseline: retained,
    baselineDigest: hash(retained),
    comments: false,
    replies: false,
    authenticationVerified: false,
    recurring: true,
  };
  return {
    scope,
    originalRisk: risk[0],
    digest: hash({ scope, risk: risk[0] }),
  };
}
async function insertReview(
  tx: RoundTx,
  id: string,
  digest: string,
  scope: any,
  risk: unknown,
  bindings: unknown,
  budgets: unknown,
  backup: string,
  now: bigint,
) {
  await tx.$executeRawUnsafe(
    'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id,
    digest,
    pack(risk),
    'unknown',
    '[]',
    '[]',
    pack(bindings),
    pack(budgets),
    pack(scope),
    backup,
    now,
  );
}
export async function confirmScheduledPolicy(
  tx: RoundTx,
  input: ScheduledPolicyInput,
  digest: string,
  host: {
    assertQuiescent(): Promise<void>;
    verifyBackup(stateDigest: string): Promise<string>;
  },
  now: bigint,
) {
  await host.assertQuiescent();
  const plan = await prepareScheduledPolicy(tx, input);
  check(plan.digest === digest, 'REVIEW_STATE_CHANGED');
  const backup = await host.verifyBackup(plan.digest);
  check(/^[a-f0-9]{64}$/.test(backup), 'VERIFIED_PROTECTED_BACKUP_REQUIRED');
  await host.assertQuiescent();
  check(
    (await prepareScheduledPolicy(tx, input)).digest === digest,
    'REVIEW_STATE_CHANGED',
  );
  const policyId = 'scheduled-policy-' + digest;
  const budgets = await rows(
    tx,
    'SELECT * FROM xhs_request_budgets ORDER BY id',
  );
  await insertReview(
    tx,
    policyId,
    digest,
    { ...plan.scope, policyId },
    plan.originalRisk,
    plan.scope.creatorBindings,
    budgets,
    backup,
    now,
  );
  return { policyId };
}
export type ScheduledTaskReviewInput = {
  round: string;
  creatorId: string;
  phase: 'basic' | 'media';
  batch?: number;
  taskId: string;
  sessionBinding: string;
  authorId: string;
};
export async function prepareScheduledTaskReview(
  tx: RoundTx,
  input: ScheduledTaskReviewInput,
  now: bigint,
) {
  const policy = await activePolicy(tx);
  if (!policy) return undefined;
  const approved = JSON.parse(policy.scope_json);
  await assertBaseline(tx, approved);
  check(
    approved.creatorIds.includes(input.creatorId) &&
      approved.creatorBindings[input.creatorId] === input.authorId,
    'SCHEDULED_CREATOR_BINDING_CHANGED',
  );
  check(
    /^[a-f0-9]{64}$/.test(input.sessionBinding),
    'SESSION_INSTANCE_REQUIRED',
  );
  check(
    input.taskId ===
      scheduledTaskId(
        input.round,
        input.creatorId,
        input.phase,
        input.batch ?? 0,
      ),
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  const busy = await rows(
    tx,
    "SELECT id FROM xhs_subscription_tasks WHERE state IN ('queued','running') UNION ALL SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') LIMIT 1",
  );
  if (busy.length) return undefined;
  const task = await rows(
    tx,
    'SELECT creator_id,state,document FROM xhs_subscription_tasks WHERE id=?',
    input.taskId,
  );
  if (task.length) {
    check(
      task.length === 1 &&
        task[0].creator_id === input.creatorId &&
        ['queued', 'running', 'completed', 'partial'].includes(task[0].state),
      'SCHEDULED_TASK_BINDING_CHANGED',
    );
    const doc = JSON.parse(task[0].document);
    check(
      doc.taskId === input.taskId &&
        doc.creatorId === input.creatorId &&
        doc.schedule?.round === input.round &&
        doc.schedule?.phase === input.phase &&
        (doc.schedule?.batch ?? 0) === (input.batch ?? 0),
      'SCHEDULED_TASK_BINDING_CHANGED',
    );
    if (['completed', 'partial'].includes(task[0].state)) {
      const completed =
        task[0].state === 'completed' &&
        doc.state === 'completed' &&
        doc.failed === 0;
      const localPartial =
        task[0].state === 'partial' &&
        doc.state === 'partial' &&
        ['XHS_DETAIL_PARSE_FAILED', 'XHS_LOCAL_PRE_DISPATCH_FAILED'].includes(
          doc.code,
        ) &&
        Number.isSafeInteger(doc.failed) &&
        doc.failed > 0 &&
        doc.remaining === 0;
      check(
        (completed || localPartial) &&
          !doc.sourceActive &&
          !doc.sourceUnknowns?.length,
        'SCHEDULED_TASK_BINDING_CHANGED',
      );
      // A clock observation of this exact settled task grants no new work,
      // session binding, review or request budget. Failed/unknown tasks stay closed.
      return undefined;
    }
  }
  const prior = (await reviews(tx)).filter((r) => {
    const s = JSON.parse(r.scope_json);
    return (
      s.reviewKind === SCHEDULED_REVIEW_KIND &&
      s.policyId === policy.id &&
      s.round === input.round
    );
  });
  check(
    prior.every(
      (r) => JSON.parse(r.scope_json).sessionBinding === input.sessionBinding,
    ),
    'SCHEDULED_ROUND_SESSION_CHANGED',
  );
  const reviewId =
    'scheduled-task-' + hash([policy.id, input.round, input.taskId]);
  const old = prior.find((r) => r.id === reviewId);
  const budgetId = fullHistoryBudgetId(reviewId, input.taskId);
  if (old) {
    check(
      JSON.parse(old.scope_json).sessionBinding === input.sessionBinding,
      'SCHEDULED_ROUND_SESSION_CHANGED',
    );
  } else {
    check(!task.length, 'SCHEDULED_EXISTING_TASK_REPLAY_FORBIDDEN');
    const base = await rows(
      tx,
      "SELECT * FROM xhs_request_budgets WHERE id='xhs:source-total'",
    );
    check(
      base.length === 1 &&
        Number.isSafeInteger(Number(base[0].interval_ms)) &&
        Number(base[0].interval_ms) >= 1000,
      'XHS_REQUEST_POLICY_INVALID',
    );
    const scope = {
      ...approved,
      reviewKind: SCHEDULED_REVIEW_KIND,
      round: input.round,
      taskBinding: {
        creatorId: input.creatorId,
        taskId: input.taskId,
        phase: input.phase,
        batch: input.batch ?? 0,
      },
      sessionBinding: input.sessionBinding,
      budgetId,
    };
    await insertReview(
      tx,
      reviewId,
      hash(scope),
      scope,
      JSON.parse(policy.original_risk_json),
      approved.creatorBindings,
      JSON.parse(policy.budget_snapshot_json),
      policy.backup_sha256,
      now,
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,0,?,?,?)',
      budgetId,
      approved.maxRequests,
      base[0].next_at,
      base[0].interval_ms,
    );
  }
  return {
    reviewId,
    creatorId: input.creatorId,
    jobId: input.taskId,
    sessionBinding: input.sessionBinding,
    authorId: input.authorId,
    budgetId,
  };
}
function excluded(scope: any, creator: string, phase: string, target: string) {
  if (!['detail', 'media'].includes(phase)) return false;
  const [note, resource] = target.split(':');
  const match = (p: string, t: string) =>
    p === phase &&
    (t === '*' ||
      t === target ||
      t === note ||
      (t.startsWith('sha256:') &&
        (phase === 'media'
          ? t.slice(7) === resource ||
            t.slice(7) ===
              createHash('sha256')
                .update(resource ?? '')
                .digest('hex')
          : t.slice(7) === createHash('sha256').update(note).digest('hex'))));
  return (scope.exclusions[creator] ?? []).some((x: any) =>
    match(x.phase, x.target),
  );
}
export async function assertScheduledRoundAdmission(
  tx: RoundTx,
  reviewId: string,
  review: any,
  r: RoundRequest,
) {
  const scope = JSON.parse(review.scope_json);
  check(
    scope.reviewKind === SCHEDULED_REVIEW_KIND && review.id === reviewId,
    'SCHEDULED_REVIEW_REQUIRED',
  );
  await assertBaseline(tx, scope);
  assertContext(reviewId, scope);
  const binding = scope.taskBinding;
  check(
    binding.creatorId === r.creatorId &&
      binding.taskId === r.taskId &&
      phases.includes(r.phase),
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  check(
    binding.phase === 'basic' ? r.phase !== 'media' : r.phase === 'media',
    'SCHEDULED_PHASE_BINDING_CHANGED',
  );
  const task = await rows(
    tx,
    'SELECT creator_id,state,document FROM xhs_subscription_tasks WHERE id=?',
    r.taskId,
  );
  check(
    task.length === 1 &&
      task[0].creator_id === r.creatorId &&
      task[0].state === 'running',
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  const d = JSON.parse(task[0].document);
  check(
    d.schedule?.round === scope.round &&
      d.schedule?.phase === binding.phase &&
      (d.schedule?.batch ?? 0) === binding.batch,
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  check(
    /^[a-f0-9-]{36}$/.test(r.operationId) && typeof r.target === 'string',
    'REQUEST_ID_INVALID',
  );
  check(
    !excluded(scope, r.creatorId, r.phase, r.target),
    'HISTORICAL_UNKNOWN_TARGET_EXCLUDED',
  );
  const all = await rows(
    tx,
    "SELECT q.* FROM xhs_unbound_owner_requests q JOIN xhs_unbound_owner_reviews v ON v.id=q.review_id WHERE json_extract(v.scope_json,'$.reviewKind')=? AND json_extract(v.scope_json,'$.policyId')=? AND json_extract(v.scope_json,'$.round')=?",
    SCHEDULED_REVIEW_KIND,
    scope.policyId,
    scope.round,
  );
  check(
    !all.some((p) => ['started', 'unknown'].includes(p.outcome)),
    'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
  );
  check(
    all.length < scope.maxRequests &&
      all.filter((p) => p.phase === r.phase).length <
        scope.phaseLimits[r.phase],
    'SCHEDULED_ROUND_LIMIT_REACHED',
  );
  if (r.phase === 'profile') {
    check(/^profile(?::[1-9][0-9]*)?$/.test(r.target), 'PROFILE_SCOPE_INVALID');
    r.target =
      'profile:' +
      (all.filter((p) => p.creator_id === r.creatorId && p.phase === 'profile')
        .length +
        1);
  } else if (r.phase === 'list')
    check(
      /^cursor:[a-f0-9]{64}$/.test(r.target),
      'LIST_CURSOR_BINDING_REQUIRED',
    );
  else {
    const note = r.target.split(':')[0];
    check(
      all.some(
        (p) =>
          p.creator_id === r.creatorId &&
          p.phase === 'list' &&
          p.outcome === 'response-received' &&
          JSON.parse(p.listed_note_ids_json ?? '[]').includes(note),
      ),
      'NOTE_NOT_CONFIRMED_IN_NEW_LIST',
    );
    check(
      r.phase === 'detail'
        ? r.target === note
        : /^[A-Za-z0-9_-]+:[a-f0-9]{64}$/.test(r.target),
      'REQUEST_TARGET_INVALID',
    );
  }
  check(
    !all.some(
      (p) =>
        p.creator_id === r.creatorId &&
        p.phase === r.phase &&
        p.logical_target === r.target,
    ),
    'FULL_SCOPE_TARGET_ALREADY_ATTEMPTED',
  );
  await tx.$executeRawUnsafe(
    "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,'started',NULL)",
    r.operationId,
    reviewId,
    r.taskId,
    r.creatorId,
    r.phase,
    r.target,
  );
}

function assertContext(reviewId: string, scope: any) {
  const c = fullHistoryContext.getStore();
  check(
    c &&
      c.reviewId === reviewId &&
      c.creatorId === scope.taskBinding.creatorId &&
      c.jobId === scope.taskBinding.taskId &&
      c.sessionBinding === scope.sessionBinding &&
      c.authorId === scope.creatorBindings[c.creatorId],
    'SCHEDULED_CONTEXT_CHANGED',
  );
}
export async function scheduledReviewedMarkers(
  tx: RoundTx,
  input: Omit<ScheduledTaskReviewInput, 'sessionBinding' | 'authorId'>,
) {
  const c = fullHistoryContext.getStore();
  if (!c) return undefined;
  const found = (await reviews(tx)).find((r) => r.id === c.reviewId);
  if (!found) return undefined;
  const s = JSON.parse(found.scope_json);
  if (s.reviewKind !== SCHEDULED_ROUND_KIND) return undefined;
  assertContext(found.id, s);
  check(
    s.round === input.round &&
      s.taskBinding.creatorId === input.creatorId &&
      s.taskBinding.taskId === input.taskId &&
      s.taskBinding.phase === input.phase &&
      s.taskBinding.batch === (input.batch ?? 0),
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  await assertBaseline(tx, s);
  return s.baseline.fences.map((f: any) => f.id) as string[];
}
export async function assertScheduledDispatch(
  tx: RoundTx,
  reviewId: string,
  r: RoundRequest,
) {
  const review = (await reviews(tx)).find((v) => v.id === reviewId);
  check(review, 'SCHEDULED_REVIEW_REQUIRED');
  const s = JSON.parse(review.scope_json);
  check(s.reviewKind === SCHEDULED_ROUND_KIND, 'SCHEDULED_REVIEW_REQUIRED');
  assertContext(reviewId, s);
  await assertBaseline(tx, s, r.operationId);
  check(
    s.taskBinding.creatorId === r.creatorId &&
      s.taskBinding.taskId === r.taskId &&
      (s.taskBinding.phase === 'basic'
        ? r.phase !== 'media'
        : r.phase === 'media'),
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  const tasks = await rows(
    tx,
    'SELECT creator_id,state,document FROM xhs_subscription_tasks WHERE id=?',
    r.taskId,
  );
  check(
    tasks.length === 1 &&
      tasks[0].state === 'running' &&
      tasks[0].creator_id === r.creatorId,
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  const d = JSON.parse(tasks[0].document);
  check(
    d.taskId === r.taskId &&
      d.creatorId === r.creatorId &&
      d.schedule?.round === s.round &&
      d.schedule?.phase === s.taskBinding.phase &&
      (d.schedule?.batch ?? 0) === s.taskBinding.batch,
    'SCHEDULED_TASK_BINDING_CHANGED',
  );
  const started = await rows(
    tx,
    'SELECT * FROM xhs_unbound_owner_requests WHERE operation_id=?',
    r.operationId,
  );
  check(
    started.length === 1 &&
      started[0].review_id === reviewId &&
      started[0].outcome === 'started' &&
      started[0].task_id === r.taskId &&
      started[0].creator_id === r.creatorId &&
      started[0].phase === r.phase &&
      started[0].logical_target === r.target,
    'SCHEDULED_STARTED_RECEIPT_REQUIRED',
  );
  check(
    !excluded(s, r.creatorId, r.phase, r.target),
    'HISTORICAL_UNKNOWN_TARGET_EXCLUDED',
  );
}
