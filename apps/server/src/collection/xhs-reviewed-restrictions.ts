import { createHash } from 'node:crypto';
import { restrictionEvidence } from './xhs-history-handoff';

type HistoricalRow = {
  id: string;
  state: string;
  document: string;
  updated_at: string;
  creator_id?: string;
};
const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const blocked = () => {
  throw new Error('OTHER_PLATFORM_RESTRICTION');
};

/** Inspect live evidence using the established structured traversal, never audit text. */
export function classifyReviewedRestrictions(
  tasks: HistoricalRow[],
  jobs: HistoricalRow[],
  riskAt: bigint,
) {
  const documents = jobs.map((row) => ({
    row,
    document: JSON.parse(row.document),
  }));
  const acknowledgements = documents.flatMap(({ row, document }) => {
    if (document.id !== row.id || document.state !== row.state)
      return blocked();
    return (
      Array.isArray(document.genericRiskReviews)
        ? document.genericRiskReviews
        : []
    ).map((review) => ({ review, document }));
  });
  const historical: Array<{
    code: string;
    updatedAt: string;
    fingerprint: string;
    reviewDigest: string;
  }> = [];
  for (const row of [...tasks, ...jobs]) {
    const document = JSON.parse(row.document);
    if (
      (document.id && document.id !== row.id) ||
      (document.taskId && document.taskId !== row.id) ||
      document.state !== row.state
    )
      return blocked();
    const { code, ...rest } = document;
    if (restrictionEvidence(rest)) return blocked();
    // Authentication is the separate, exact global risk admitted by this review.
    if (
      !restrictionEvidence({ code }) ||
      code === 'XHS_SOURCE_AUTHENTICATION_BLOCKED'
    )
      continue;
    if (
      !/^\d+$/.test(row.updated_at) ||
      BigInt(row.updated_at) >= riskAt ||
      !['paused', 'partial', 'failed', 'cancelled', 'blocked'].includes(
        row.state,
      ) ||
      [
        'sourceReceipt',
        'lastSourceReceipt',
        'receipt',
        'sourceFence',
        'activeFence',
        'lastSourceOwnerReceipt',
        'sourceActive',
      ].some((k) => document[k]) ||
      document.generation?.activeFence ||
      document.sourceUnknowns?.length
    )
      return blocked();
    const fingerprint = sha(row);
    const proof = acknowledgements.find(
      ({ review: r, document: host }) =>
        host.historyHandoff &&
        Number.isSafeInteger(host.historyHandoff.confirmedAt) &&
        r?.version === 1 &&
        /^[a-f0-9]{64}$/.test(r.digest ?? '') &&
        r.acknowledgedLoginAndVerification === true &&
        r.outcome === 'unknown' &&
        r.requestIdentity === 'unknown' &&
        Number.isSafeInteger(r.confirmedAt) &&
        BigInt(r.confirmedAt) > BigInt(row.updated_at) &&
        BigInt(r.confirmedAt) < riskAt &&
        r.risk?.state === 'blocked' &&
        r.risk.code === 'XHS_SOURCE_RISK_REVIEW_REQUIRED' &&
        r.risk.owner === null &&
        r.risk.http_status === null &&
        r.risk.endpoint === null &&
        /^\d+$/.test(r.risk.updated_at ?? '') &&
        BigInt(r.risk.updated_at) > BigInt(row.updated_at) &&
        BigInt(r.risk.updated_at) <= BigInt(r.confirmedAt) &&
        r.historicalRestrictions?.some(
          (h) =>
            h.code === code &&
            h.updatedAt === row.updated_at &&
            h.fingerprint === fingerprint,
        ),
    );
    if (!proof) return blocked();
    historical.push({
      code,
      updatedAt: row.updated_at,
      fingerprint,
      reviewDigest: proof.review.digest,
    });
  }
  return historical;
}
