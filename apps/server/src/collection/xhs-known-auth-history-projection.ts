import { createHash } from 'node:crypto';
import {
  FULL_HISTORY_KIND,
  fullHistoryBudgetId,
} from './xhs-full-history-scope';

const pack = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const hash = (v: unknown) => createHash('sha256').update(pack(v)).digest('hex');
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function check(v: unknown): asserts v {
  if (!v) throw Error('OTHER_PLATFORM_RESTRICTION');
}
function time(v: unknown): bigint {
  check(typeof v === 'string' && /^\d+$/.test(v));
  return BigInt(v);
}

/** Read-only inverse of the existing full-history start annotation, not an
 * authorization or a restriction exemption. The caller MUST still run the old
 * exact-fingerprint classifier, then deep-scan the unprojected live document.
 * No generic baseline, old code or authenticationVerified=false proves login. */
export function projectKnownAuthHistoryJob(
  row: any,
  tasks: any[],
  reviews: any[],
  scope: any,
  policyApprovedAt: string,
  riskAt: bigint,
) {
  const doc = JSON.parse(row.document),
    a = doc.fullHistoryReview;
  const original = {
    id: row.id,
    state: row.state,
    document: row.document,
    updated_at: String(row.updated_at),
  };
  if (
    !a ||
    !/^XHS_SOURCE_(?:VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(
      doc.code ?? '',
    )
  )
    return original;
  check(
    doc.id === row.id &&
      doc.creatorId === row.creator_id &&
      doc.state === row.state,
  );
  check(
    pack(Object.keys(a).sort()) ===
      pack([
        'budgetId',
        'duplicateDirectoryReadAcknowledged',
        'originalBudgetPreserved',
        'originalOutcome',
        'reviewId',
        'startedAt',
        'state',
        'taskId',
      ]),
  );
  check(
    a.state === 'queued' &&
      a.originalOutcome === 'unknown' &&
      a.originalBudgetPreserved === true &&
      a.duplicateDirectoryReadAcknowledged === true &&
      a.budgetId === fullHistoryBudgetId(a.reviewId, row.id) &&
      Number.isSafeInteger(a.startedAt) &&
      Number.isSafeInteger(doc.updatedAt) &&
      doc.updatedAt > 0 &&
      doc.updatedAt < a.startedAt &&
      String(a.startedAt) === original.updated_at &&
      row.document === JSON.stringify(doc),
  );
  const policyAt = time(policyApprovedAt);
  check(BigInt(a.startedAt) < policyAt && policyAt < riskAt);

  // Match the existing scheduled policy's immutable, ordered full-row evidence.
  // Never manufacture a missing review or reinterpret an incomplete lineage.
  const evidence = scope.retainedHistoryEvidence;
  check(
    Array.isArray(evidence) &&
      evidence.length > 0 &&
      evidence.every(
        (e: any) =>
          Array.isArray(e) &&
          e.length === 2 &&
          typeof e[0] === 'string' &&
          hex(e[1]),
      ),
  );
  const ids = evidence.map((e: any) => e[0]);
  check(
    new Set(ids).size === ids.length &&
      pack(ids) === pack([...ids].sort((a, b) => a.localeCompare(b))),
  );
  const retained = evidence.map(([id, digest]: string[]) => {
    const matches = reviews.filter((r) => r.id === id);
    check(matches.length === 1 && hash(matches[0]) === digest);
    return { row: matches[0], scope: JSON.parse(matches[0].scope_json) };
  });
  const leaves = retained.filter(
    (r) =>
      r.scope.reviewKind === FULL_HISTORY_KIND &&
      r.scope.narrowing === 'parent-receipt-marker-phase-identity' &&
      Object.prototype.hasOwnProperty.call(
        scope.creatorBindings,
        r.scope.narrowedCreatorId,
      ) &&
      r.scope.bindings?.some(
        (b: any) => b.creatorId === r.scope.narrowedCreatorId,
      ) &&
      Array.isArray(r.scope.lineageReviewIds) &&
      r.scope.lineageReviewIds.includes(a.reviewId) &&
      !reviews.some(
        (next) =>
          next.id !== r.row.id &&
          (JSON.parse(next.scope_json).lineageReviewIds ?? []).includes(
            r.row.id,
          ),
      ),
  );
  check(leaves.length === 1);
  const leaf = leaves[0],
    chainIds = [...leaf.scope.lineageReviewIds, leaf.row.id];
  check(chainIds.length >= 2 && new Set(chainIds).size === chainIds.length);
  const chain = chainIds.map((id) => {
    const r = retained.find((r) => r.row.id === id);
    check(r);
    return r;
  });
  const root = chain[0],
    bindings = root.scope.bindings;
  check(
    Array.isArray(bindings) &&
      bindings.filter(
        (b: any) => b.creatorId === row.creator_id && b.jobId === row.id,
      ).length === 1,
  );
  for (let i = 0; i < chain.length; i++) {
    const { row: r, scope: s } = chain[i];
    check(
      s.reviewKind === FULL_HISTORY_KIND &&
        s.history === true &&
        s.comments === false &&
        s.replies === false &&
        s.authenticationVerified === false &&
        s.duplicateDirectoryReadPossible === true &&
        s.freshDirectoryScan === true &&
        pack(s.bindings) === pack(bindings) &&
        r.original_outcome === 'unknown' &&
        hex(r.backup_sha256) &&
        hex(r.plan_digest) &&
        r.id === 'unbound-' + r.plan_digest &&
        time(String(r.approved_at)) < policyAt &&
        (i === 0 ||
          time(String(chain[i - 1].row.approved_at)) <
            time(String(r.approved_at))),
    );
    check(
      i === 0
        ? s.lineageReviewIds === undefined &&
            s.authorizationRootReviewId === undefined &&
            s.continuationOfReviewId === undefined
        : pack(s.lineageReviewIds) === pack(chainIds.slice(0, i)) &&
            s.authorizationRootReviewId === root.row.id &&
            s.continuationOfReviewId === chainIds[i - 1],
    );
    const creatorBindings = JSON.parse(r.creator_bindings_json);
    check(
      typeof scope.creatorBindings[row.creator_id] === 'string' &&
        creatorBindings[row.creator_id] ===
          scope.creatorBindings[row.creator_id],
    );
  }
  const start = chain.find((r) => r.row.id === a.reviewId);
  check(start && time(String(start.row.approved_at)) <= BigInt(a.startedAt));
  const linked = tasks.filter(
    (t) => t.id === a.taskId && t.creator_id === row.creator_id,
  );
  check(linked.length === 1);
  const task = JSON.parse(linked[0].document);
  check(
    task.taskId === a.taskId &&
      task.creatorId === row.creator_id &&
      task.state === linked[0].state &&
      task.kind === 'list' &&
      task.collectionScope === 'all' &&
      task.scheduledContext?.authorId ===
        scope.creatorBindings[row.creator_id] &&
      time(String(linked[0].updated_at)) >= BigInt(a.startedAt),
  );
  // Only these two writer-owned changes are reversed. Any other changed byte,
  // field, code, budget or unknown source evidence will miss the old fingerprint.
  delete doc.fullHistoryReview;
  return {
    ...original,
    document: JSON.stringify(doc),
    updated_at: String(doc.updatedAt),
  };
}
