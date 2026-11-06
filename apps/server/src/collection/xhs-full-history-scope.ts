import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  unboundRoundContext,
  admitUnboundRequest,
  settleUnboundRequest,
  assertUnboundDispatch,
  type RoundTx,
  type RoundRequest,
} from './xhs-unbound-round';
import { reserveRoundBudgetRisk, finishRoundRisk } from './round-budget-risk';

export const FULL_HISTORY_KIND = 'whole-history-scope-v1';
export type FullHistoryInput = {
  bindings: { creatorId: string; jobId: string }[];
  sessionBinding: string;
  maxRequests: number;
  phaseLimits: Record<'profile' | 'list' | 'detail' | 'media', number>;
};
export const fullHistoryContext = new AsyncLocalStorage<{
  reviewId: string;
  creatorId: string;
  jobId: string;
  sessionBinding: string;
  authorId: string;
}>();
const packed = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v));
const hash = (value: unknown) =>
  createHash('sha256').update(packed(value)).digest('hex');
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
const rows = (tx: RoundTx, sql: string, ...args: unknown[]) =>
  tx.$queryRawUnsafe<any[]>(sql, ...args);
const phases = ['profile', 'list', 'detail', 'media'] as const;
/** Exclusions are evidence, never success receipts. Unknown profile/list requires separate review. */
function collectUnknowns(
  value: any,
  result: { phase: string; target: string }[],
) {
  if (!value || typeof value !== 'object') return;
  const unknown =
    ['started', 'unknown'].includes(value.state) ||
    ['started', 'unknown'].includes(value.outcome) ||
    value.classification === 'request-outcome-unknown';
  if (unknown && (value.marker || value.phase)) {
    const phase = value.phase === 'metrics' ? 'detail' : value.phase;
    let target = value.noteId ?? value.noteKey ?? value.logical_target;
    if (typeof target === 'string' && target.startsWith('[')) {
      try {
        const tuple = JSON.parse(target);
        target =
          tuple[0] === 'xiaohongshu' && tuple[1] === 'note'
            ? tuple[2]
            : undefined;
      } catch {
        target = undefined;
      }
    }
    if (
      typeof value.targetHash === 'string' &&
      /^[a-f0-9]{64}$/.test(value.targetHash)
    )
      target = 'sha256:' + value.targetHash;
    if (!target) target = '*';
    if (phases.includes(phase)) result.push({ phase, target });
    else {
      result.push({ phase: 'detail', target: '*' });
      result.push({ phase: 'media', target: '*' });
    }
  }
  for (const child of Object.values(value))
    if (child && typeof child === 'object') collectUnknowns(child, result);
}
function excludedTarget(
  exclusion: { phase: string; target: string },
  phase: string,
  target: string,
) {
  if (exclusion.phase !== phase || !['detail', 'media'].includes(phase))
    return false;
  const note = target.split(':')[0],
    resource = target.split(':')[1];
  return (
    exclusion.target === '*' ||
    exclusion.target === target ||
    (phase === 'media' && target.startsWith(exclusion.target + ':')) ||
    (exclusion.target.startsWith('sha256:') &&
      exclusion.target.slice(7) ===
        createHash('sha256')
          .update(phase === 'media' ? (resource ?? '') : note)
          .digest('hex'))
  );
}
export async function prepareFullHistoryScope(
  tx: RoundTx,
  input: FullHistoryInput,
) {
  check(
    input.bindings.length === 3 &&
      new Set(input.bindings.map((b) => b.creatorId)).size === 3 &&
      new Set(input.bindings.map((b) => b.jobId)).size === 3,
    'EXACT_THREE_EXISTING_JOBS_REQUIRED',
  );
  check(
    /^[a-f0-9]{64}$/.test(input.sessionBinding),
    'SESSION_INSTANCE_REQUIRED',
  );
  check(
    Number.isSafeInteger(input.maxRequests) &&
      input.maxRequests > 0 &&
      input.maxRequests <= 100000,
    'FULL_SCOPE_LIMIT_INVALID',
  );
  check(
    Object.keys(input.phaseLimits).length === 4 &&
      phases.every(
        (p) =>
          Number.isSafeInteger(input.phaseLimits[p]) &&
          input.phaseLimits[p] >= 0 &&
          input.phaseLimits[p] <= input.maxRequests,
      ),
    'FULL_SCOPE_LIMIT_INVALID',
  );
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
  const jobs = await rows(
    tx,
    'SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_whole_creator_jobs ORDER BY id',
  );
  const tasks = await rows(
    tx,
    'SELECT id,creator_id,state,document,CAST(updated_at AS TEXT) AS updated_at FROM xhs_subscription_tasks ORDER BY id',
  );
  check(
    [...jobs, ...tasks].every((r) => !['queued', 'running'].includes(r.state)),
    'SOURCE_WORK_NOT_IDLE',
  );
  const creators = await rows(
    tx,
    'SELECT id,external_author_id,enabled FROM xhs_creators ORDER BY id',
  );
  const budgets = await rows(
    tx,
    'SELECT * FROM xhs_request_budgets ORDER BY id',
  );
  const shared = budgets.find((b) => b.id === 'xhs:source-total');
  check(
    shared &&
      Number.isSafeInteger(Number(shared.used)) &&
      Number(shared.used) <= Number(shared.request_limit),
    'SOURCE_BUDGET_REQUIRED',
  );
  const exclusions: Record<string, { phase: string; target: string }[]> = {};
  for (const binding of input.bindings) {
    const job = jobs.find(
      (j) => j.id === binding.jobId && j.creator_id === binding.creatorId,
    );
    const creator = creators.find(
      (c) =>
        c.id === binding.creatorId &&
        Number(c.enabled) === 1 &&
        c.external_author_id,
    );
    check(
      job && creator && budgets.some((b) => b.id === binding.jobId),
      'CREATOR_JOB_BINDING_CHANGED',
    );
    const found: { phase: string; target: string }[] = [];
    collectUnknowns(JSON.parse(job.document), found);
    for (const task of tasks.filter((t) => t.creator_id === binding.creatorId))
      collectUnknowns(JSON.parse(task.document), found);
    const requests = await rows(
      tx,
      "SELECT phase,logical_target FROM xhs_unbound_owner_requests WHERE creator_id=? AND outcome IN ('started','unknown')",
      binding.creatorId,
    );
    for (const r of requests)
      found.push({ phase: r.phase, target: r.logical_target });
    exclusions[binding.creatorId] = [
      ...new Map(found.map((x) => [packed(x), x])).values(),
    ];
  }
  const scope = {
    reviewKind: FULL_HISTORY_KIND,
    creatorIds: input.bindings.map((b) => b.creatorId).sort(),
    bindings: [...input.bindings].sort((a, b) =>
      a.creatorId.localeCompare(b.creatorId),
    ),
    sessionBinding: input.sessionBinding,
    maxRequests: input.maxRequests,
    phaseLimits: input.phaseLimits,
    exclusions,
    history: true,
    comments: false,
    replies: false,
    authenticationVerified: false,
    duplicateDirectoryReadPossible: true,
    freshDirectoryScan: true,
  };
  const plan = {
    kind: FULL_HISTORY_KIND,
    originalRisk: risk[0],
    originalOutcome: 'unknown',
    oldTaskIds: tasks.map((t) => t.id),
    oldJobIds: jobs.map((j) => j.id),
    creatorBindings: Object.fromEntries(
      creators
        .filter((c) => scope.creatorIds.includes(c.id))
        .map((c) => [c.id, c.external_author_id]),
    ),
    budgetSnapshot: budgets,
    scope,
    stateDigest: hash({ risk, jobs, tasks, creators, budgets }),
  };
  return {
    ...plan,
    digest: hash(plan),
    availableRequests: Number(shared.request_limit) - Number(shared.used),
  };
}
export async function confirmFullHistoryScope(
  tx: RoundTx,
  input: FullHistoryInput,
  digest: string,
  host: {
    assertQuiescent(): Promise<void>;
    assertSession(binding: string): void;
    verifyBackup(stateDigest: string): Promise<string>;
  },
  now: bigint,
) {
  await host.assertQuiescent();
  host.assertSession(input.sessionBinding);
  const plan = await prepareFullHistoryScope(tx, input);
  check(plan.digest === digest, 'REVIEW_STATE_CHANGED');
  const backup = await host.verifyBackup(plan.stateDigest);
  check(/^[a-f0-9]{64}$/.test(backup), 'VERIFIED_PROTECTED_BACKUP_REQUIRED');
  const id = 'unbound-' + digest;
  await tx.$executeRawUnsafe(
    'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id,
    digest,
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
  // Append explicit newly authorized local capacity; original counters remain byte-for-byte intact.
  for (const binding of input.bindings) {
    const prior = plan.budgetSnapshot.find((b) => b.id === binding.jobId);
    check(
      prior &&
        Number.isSafeInteger(Number(prior.interval_ms)) &&
        Number(prior.interval_ms) >= 1000,
      'XHS_REQUEST_POLICY_INVALID',
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,0,?,?,?)',
      fullHistoryBudgetId(id, binding.jobId),
      input.maxRequests,
      prior.next_at,
      prior.interval_ms,
    );
  }
  // No risk, task, historical record, or original budget is changed by approval.
  await host.assertQuiescent();
  host.assertSession(input.sessionBinding);
  return {
    reviewId: id,
    sourceRequestsSent: 0,
    excludedUnknowns: plan.scope.exclusions,
    availableRequests: plan.availableRequests,
  };
}
export async function admitFullHistoryRequest(
  tx: RoundTx,
  reviewId: string,
  review: any,
  r: RoundRequest,
) {
  const scope = JSON.parse(review.scope_json);
  const binding = fullHistoryContext.getStore();
  check(
    scope.reviewKind === FULL_HISTORY_KIND &&
      binding &&
      binding.reviewId === reviewId &&
      binding.sessionBinding === scope.sessionBinding &&
      binding.creatorId === r.creatorId &&
      binding.jobId === r.taskId,
    'FULL_SCOPE_CONTEXT_REQUIRED',
  );
  check(
    scope.bindings.some(
      (b: any) => b.creatorId === r.creatorId && b.jobId === r.taskId,
    ),
    'CREATOR_JOB_BINDING_CHANGED',
  );
  check(
    /^[a-f0-9-]{36}$/.test(r.operationId) && phases.includes(r.phase),
    'REQUEST_ID_INVALID',
  );
  check(
    !(scope.exclusions[r.creatorId] ?? []).some((x: any) =>
      excludedTarget(x, r.phase, r.target),
    ),
    'HISTORICAL_UNKNOWN_TARGET_EXCLUDED',
  );
  const creator = await rows(
    tx,
    'SELECT external_author_id,enabled FROM xhs_creators WHERE id=?',
    r.creatorId,
  );
  check(
    creator.length === 1 &&
      Number(creator[0].enabled) === 1 &&
      creator[0].external_author_id === binding.authorId &&
      creator[0].external_author_id ===
        JSON.parse(review.creator_bindings_json)[r.creatorId],
    'CREATOR_BINDING_CHANGED',
  );
  const job = await rows(
    tx,
    'SELECT creator_id FROM xhs_whole_creator_jobs WHERE id=?',
    r.taskId,
  );
  check(
    job.length === 1 && job[0].creator_id === r.creatorId,
    'CREATOR_JOB_BINDING_CHANGED',
  );
  const previous = await rows(
    tx,
    'SELECT phase,creator_id,logical_target,outcome FROM xhs_unbound_owner_requests WHERE review_id=?',
    reviewId,
  );
  if (r.phase === 'profile') {
    check(
      !previous.some(
        (p) =>
          p.creator_id === r.creatorId &&
          p.phase === 'profile' &&
          p.outcome === 'unknown',
      ),
      'FULL_SCOPE_PROFILE_UNKNOWN',
    );
    check(/^profile(?::[1-9][0-9]*)?$/.test(r.target), 'PROFILE_SCOPE_INVALID');
    r.target =
      'profile:' +
      (previous.filter(
        (p) => p.creator_id === r.creatorId && p.phase === 'profile',
      ).length +
        1);
  }
  check(
    !previous.some((p) => p.outcome === 'started'),
    'ROUND_HAS_ACTIVE_REQUEST',
  );
  check(
    !previous.some(
      (p) =>
        p.creator_id === r.creatorId &&
        p.phase === r.phase &&
        p.logical_target === r.target &&
        !(r.phase === 'profile' && p.outcome === 'response-received'),
    ),
    'FULL_SCOPE_TARGET_ALREADY_ATTEMPTED',
  );
  check(
    previous.length < scope.maxRequests &&
      previous.filter((p) => p.phase === r.phase).length <
        scope.phaseLimits[r.phase],
    'FULL_SCOPE_LIMIT_REACHED',
  );
  if (r.phase === 'profile')
    check(/^profile:[1-9][0-9]*$/.test(r.target), 'PROFILE_SCOPE_INVALID');
  else if (r.phase === 'list')
    check(
      /^cursor:[a-f0-9]{64}$/.test(r.target),
      'LIST_CURSOR_BINDING_REQUIRED',
    );
  else {
    const listed = await rows(
      tx,
      "SELECT listed_note_ids_json FROM xhs_unbound_owner_requests WHERE review_id=? AND creator_id=? AND phase='list' AND outcome='response-received'",
      reviewId,
      r.creatorId,
    );
    const note = r.target.split(':')[0];
    check(
      listed.some((page) =>
        JSON.parse(page.listed_note_ids_json ?? '[]').includes(note),
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

export const fullHistoryBudgetId = (reviewId: string, jobId: string) =>
  'xhs:full:' + reviewId.slice(8) + ':' + jobId;

export type FullHistoryWriter = <T>(
  work: (tx: RoundTx) => Promise<T>,
) => Promise<T>;
/** One committed binding and budget reservation precedes one physical transport entry. */
export async function dispatchFullHistoryRequest<T>(
  write: FullHistoryWriter,
  request: RoundRequest,
  host: {
    ready(): void;
    send(): Promise<T>;
    response(value: T): {
      noteIds?: string[];
      platformCode?: string;
      status?: number;
    };
    notSent(error: unknown): boolean;
  },
): Promise<T> {
  const binding = fullHistoryContext.getStore();
  check(
    binding &&
      request.creatorId === binding.creatorId &&
      request.taskId === binding.jobId,
    'FULL_SCOPE_CONTEXT_REQUIRED',
  );
  host.ready();
  const owner = await write(async (tx) => {
    await admitUnboundRequest(tx, binding.reviewId, request);
    const owner = await reserveRoundBudgetRisk(
      tx,
      binding.reviewId,
      request,
      Date.now(),
    );
    const budget = await rows(
      tx,
      'SELECT * FROM xhs_request_budgets WHERE id=?',
      fullHistoryBudgetId(binding.reviewId, request.taskId),
    );
    check(
      budget.length === 1 &&
        Number(budget[0].used) < Number(budget[0].request_limit),
      'XHS_REQUEST_BUDGET_EXHAUSTED',
    );
    check(Number(budget[0].next_at) <= Date.now(), 'XHS_REQUEST_RATE_PAUSED');
    check(
      Number.isSafeInteger(Number(budget[0].interval_ms)) &&
        Number(budget[0].interval_ms) >= 1000,
      'XHS_REQUEST_POLICY_INVALID',
    );
    check(
      (await tx.$executeRawUnsafe(
        'UPDATE xhs_request_budgets SET used=used+1,next_at=? WHERE id=? AND used=? AND next_at=?',
        BigInt(Date.now() + Number(budget[0].interval_ms)),
        fullHistoryBudgetId(binding.reviewId, request.taskId),
        budget[0].used,
        budget[0].next_at,
      )) === 1,
      'XHS_REQUEST_BUDGET_UNAVAILABLE',
    );
    return owner;
  });
  let entered = false;
  return unboundRoundContext.run(
    { reviewId: binding.reviewId, request },
    async () => {
      try {
        host.ready();
        await write(async (tx) => {
          await assertUnboundDispatch(tx);
          const risk = await rows(
            tx,
            "SELECT owner,state FROM xhs_source_risk WHERE id='source'",
          );
          check(
            risk.length === 1 &&
              risk[0].state === 'pending' &&
              risk[0].owner === owner,
            'XHS_SOURCE_RISK_REVIEW_REQUIRED',
          );
        });
        host.ready();
        entered = true;
        const value = await host.send();
        const receipt = host.response(value);
        await write(async (tx) => {
          await settleUnboundRequest(
            tx,
            binding.reviewId,
            request.operationId,
            'response-received',
            request.phase === 'list' ? receipt.noteIds : undefined,
          );
          await finishRoundRisk(
            tx,
            owner,
            'response-received',
            receipt.platformCode,
            receipt.status,
          );
        });
        return value;
      } catch (error) {
        // A response settlement failure remains unknown. Never fabricate a success.
        try {
          await write(async (tx) => {
            const notSent = !entered || host.notSent(error);
            await settleUnboundRequest(
              tx,
              binding.reviewId,
              request.operationId,
              notSent ? 'not-sent' : 'unknown',
            );
            if (notSent) await finishRoundRisk(tx, owner, 'response-received');
            // Unknown retains source owner. Existing formal review must settle it.
          });
        } catch {
          /* Preserve uncertain binding and owner for review. */
        }
        throw error;
      }
    },
  );
}

export async function fullHistoryExcludedNoteIds(
  tx: RoundTx,
  creatorId: string,
): Promise<string[] | undefined> {
  const context = fullHistoryContext.getStore();
  if (!context || context.creatorId !== creatorId) return undefined;
  const review = await rows(
    tx,
    'SELECT scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
    context.reviewId,
  );
  check(review.length === 1, 'FULL_SCOPE_CONTEXT_REQUIRED');
  const scope = JSON.parse(review[0].scope_json);
  const notes = await rows(
    tx,
    'SELECT id FROM xhs_notes WHERE creator_id=?',
    creatorId,
  );
  return notes
    .filter((n) => {
      try {
        const tuple = JSON.parse(n.id);
        return (scope.exclusions[creatorId] ?? []).some(
          (x: any) =>
            excludedTarget(x, 'detail', tuple[2]) ||
            (x.phase === 'media' && x.target === tuple[2]),
        );
      } catch {
        return true;
      }
    })
    .map((n) => n.id);
}

export async function fullHistoryNoteExcluded(
  tx: RoundTx,
  creatorId: string,
  id: string,
) {
  const context = fullHistoryContext.getStore();
  if (!context || context.creatorId !== creatorId) return false;
  const review = await rows(
    tx,
    'SELECT scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
    context.reviewId,
  );
  check(review.length === 1, 'FULL_SCOPE_CONTEXT_REQUIRED');
  const scope = JSON.parse(review[0].scope_json);
  let note: string;
  try {
    note = JSON.parse(id)[2];
  } catch {
    return true;
  }
  return (scope.exclusions[creatorId] ?? []).some(
    (x: any) =>
      excludedTarget(x, 'detail', note) ||
      (x.phase === 'media' && (x.target === '*' || x.target === note)),
  );
}

/** Read the maximum existing throttle before any request-binding write. */
export async function fullHistoryNextDelay(
  tx: RoundTx,
  reviewId: string,
  jobId: string,
  creatorId: string,
) {
  const ids = [
    'xhs:source-total',
    'xhs:original-link:' + creatorId,
    fullHistoryBudgetId(reviewId, jobId),
  ];
  const budgets = await rows(
    tx,
    'SELECT next_at FROM xhs_request_budgets WHERE id IN (?,?,?)',
    ...ids,
  );
  return Math.max(0, ...budgets.map((b) => Number(b.next_at) - Date.now()));
}
