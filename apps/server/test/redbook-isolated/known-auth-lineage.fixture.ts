// Synthetic control metadata only. No session, network or production identifiers.
import { createHash } from 'node:crypto';
export const lineageHash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function knownAuthLineageFixture(crossCreator = false) {
  const ids = ['1', '2', '3'].map((x) => 'unbound-' + x.repeat(64));
  const old = {
    id: 'historical-job',
    state: 'paused',
    document: JSON.stringify({
      id: 'historical-job',
      creatorId: 'b',
      state: 'paused',
      code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
      updatedAt: 1,
    }),
    updated_at: '1',
  };
  const annotation = {
    reviewId: ids[1],
    budgetId: 'xhs:full:' + ids[1].slice(8) + ':' + old.id,
    originalBudgetPreserved: true,
    taskId: 'full-task',
    state: 'queued',
    originalOutcome: 'unknown',
    duplicateDirectoryReadAcknowledged: true,
    startedAt: 7,
  };
  const jobs = [
    {
      ...old,
      creator_id: 'b',
      document: JSON.stringify({
        ...JSON.parse(old.document),
        fullHistoryReview: annotation,
      }),
      updated_at: '7',
    },
    {
      id: 'review-host',
      creator_id: 'c',
      state: 'partial',
      updated_at: '4',
      document: JSON.stringify({
        id: 'review-host',
        state: 'partial',
        historyHandoff: { confirmedAt: 2 },
        genericRiskReviews: [
          {
            version: 1,
            digest: 'd'.repeat(64),
            confirmedAt: 4,
            acknowledgedLoginAndVerification: true,
            outcome: 'unknown',
            requestIdentity: 'unknown',
            risk: {
              state: 'blocked',
              code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
              owner: null,
              http_status: null,
              endpoint: null,
              updated_at: '3',
            },
            historicalRestrictions: [
              {
                code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
                updatedAt: '1',
                fingerprint: lineageHash(old),
              },
            ],
          },
        ],
      }),
    },
  ];
  const tasks = [
    {
      id: 'full-task',
      creator_id: 'b',
      state: 'partial',
      updated_at: '8',
      document: JSON.stringify({
        taskId: 'full-task',
        creatorId: 'b',
        state: 'partial',
        kind: 'list',
        collectionScope: 'all',
        code: 'HISTORY_REVIEW_REQUIRED',
        scheduledContext: { authorId: 'author-b', used: 1, state: 'confirmed' },
      }),
    },
  ];
  const reviews = ids.map((id, i) => ({
    id,
    plan_digest: id.slice(8),
    original_risk_json: '{}',
    original_outcome: 'unknown',
    old_task_ids_json: '[]',
    old_job_ids_json: '[]',
    creator_bindings_json: JSON.stringify({
      b: 'author-b',
      ...(crossCreator ? { c: 'author-c' } : {}),
    }),
    budget_snapshot_json: '[]',
    scope_json: JSON.stringify({
      reviewKind: 'whole-history-scope-v1',
      creatorIds: crossCreator ? ['b', 'c'] : ['b'],
      bindings: [
        { creatorId: 'b', jobId: old.id },
        ...(crossCreator
          ? [{ creatorId: 'c', jobId: 'other-history-job' }]
          : []),
      ],
      sessionBinding: 'a'.repeat(64),
      maxRequests: 10,
      phaseLimits: { profile: 1, list: 1, detail: 4, media: 4 },
      exclusions: {},
      history: true,
      comments: false,
      replies: false,
      authenticationVerified: false,
      duplicateDirectoryReadPossible: true,
      freshDirectoryScan: true,
      ...(i
        ? {
            lineageReviewIds: ids.slice(0, i),
            authorizationRootReviewId: ids[0],
            continuationOfReviewId: ids[i - 1],
          }
        : {}),
      ...(i === 2
        ? {
            narrowing: 'parent-receipt-marker-phase-identity',
            narrowedCreatorId: crossCreator ? 'c' : 'b',
          }
        : {}),
    }),
    backup_sha256: 'b'.repeat(64),
    approved_at: String([5, 6, 8][i]),
  }));
  const scope = {
    creatorBindings: {
      b: 'author-b',
      ...(crossCreator ? { c: 'author-c' } : {}),
    },
    retainedHistoryEvidence: reviews
      .map((r) => [r.id, lineageHash(r)])
      .sort(([a], [b]) => a.localeCompare(b)),
  };
  return {
    old,
    jobs,
    tasks,
    reviews,
    scope,
    policyApprovedAt: '10',
    riskAt: 100n,
  };
}
