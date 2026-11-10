import { projectKnownAuthHistoryJob } from './xhs-known-auth-history-projection';
import { classifyReviewedRestrictions } from './xhs-reviewed-restrictions';
import {
  knownAuthLineageFixture,
  lineageHash,
} from '../../test/redbook-isolated/known-auth-lineage.fixture';

function classify(f: ReturnType<typeof knownAuthLineageFixture>) {
  const jobs = f.jobs.map((r) =>
    projectKnownAuthHistoryJob(
      r,
      f.tasks,
      f.reviews,
      f.scope,
      f.policyApprovedAt,
      f.riskAt,
    ),
  );
  return classifyReviewedRestrictions([], jobs, f.riskAt);
}
it('only reverses the two formal annotation changes before the unchanged classifier', () => {
  const f = knownAuthLineageFixture(),
    before = JSON.stringify(f, (_, x) =>
      typeof x === 'bigint' ? String(x) : x,
    );
  expect(
    projectKnownAuthHistoryJob(
      f.jobs[0],
      f.tasks,
      f.reviews,
      f.scope,
      f.policyApprovedAt,
      f.riskAt,
    ),
  ).toEqual(f.old);
  expect(classify(f)[0].fingerprint).toBe(lineageHash(f.old));
  expect(
    JSON.stringify(f, (_, x) => (typeof x === 'bigint' ? String(x) : x)),
  ).toBe(before);
});
it('retains the full binding chain when its later narrowing concerns another approved creator', () => {
  const f = knownAuthLineageFixture(true);
  expect(classify(f)[0].fingerprint).toBe(lineageHash(f.old));
});

it.each([
  'missing-evidence',
  'wrong-digest',
  'duplicate-proof',
  'reordered-proof',
  'missing-link',
  'duplicate-link',
  'wrong-parent',
  'wrong-root',
  'wrong-binding',
  'verified',
  'after-policy',
  'before-approval',
  'sql-time',
  'old-time',
  'annotation-extra',
  'annotation-state',
  'annotation-budget',
  'annotation-outcome',
  'missing-task',
  'task-creator',
  'task-author',
  'task-time',
  'task-kind',
  'new-code',
  'new-field',
  'new-restriction',
  'new-unknown',
  'changed-generic-proof',
  'missing-generic-proof',
  'noncanonical-document',
  'wrong-review-id',
  'wrong-backup',
  'superseded-leaf',
  'unbound-narrowing',
])('fails closed: %s', (mode) => {
  const f = knownAuthLineageFixture();
  const job = JSON.parse(f.jobs[0].document),
    a = job.fullHistoryReview;
  const task = JSON.parse(f.tasks[0].document);
  const scopes = f.reviews.map((r) => JSON.parse(r.scope_json));
  if (mode === 'missing-evidence') f.scope.retainedHistoryEvidence = [];
  if (mode === 'wrong-digest')
    f.scope.retainedHistoryEvidence[0][1] = '0'.repeat(64);
  if (mode === 'duplicate-proof')
    f.scope.retainedHistoryEvidence.push(f.scope.retainedHistoryEvidence[0]);
  if (mode === 'reordered-proof') f.scope.retainedHistoryEvidence.reverse();
  if (mode === 'missing-link') f.reviews.splice(0, 1);
  if (mode === 'duplicate-link')
    scopes[2].lineageReviewIds.push(scopes[2].lineageReviewIds[0]);
  if (mode === 'wrong-parent')
    scopes[2].continuationOfReviewId = f.reviews[0].id;
  if (mode === 'wrong-root')
    scopes[2].authorizationRootReviewId = f.reviews[1].id;
  if (mode === 'unbound-narrowing')
    scopes[2].narrowedCreatorId = 'unapproved-creator';
  if (mode === 'wrong-binding') scopes[1].bindings[0].jobId = 'other-job';
  if (mode === 'verified') scopes[1].authenticationVerified = true;
  if (mode === 'after-policy') f.reviews[2].approved_at = '11';
  if (mode === 'before-approval') a.startedAt = 5;
  if (mode === 'sql-time') f.jobs[0].updated_at = '8';
  if (mode === 'old-time') job.updatedAt = 7;
  if (mode === 'annotation-extra') a.unknown = false;
  if (mode === 'annotation-state') a.state = 'running';
  if (mode === 'annotation-budget') a.budgetId += '-other';
  if (mode === 'annotation-outcome') a.originalOutcome = 'success';
  if (mode === 'missing-task') f.tasks = [];
  if (mode === 'task-creator') f.tasks[0].creator_id = 'other';
  if (mode === 'task-author') task.scheduledContext.authorId = 'other-author';
  if (mode === 'task-time') f.tasks[0].updated_at = '6';
  if (mode === 'task-kind') task.collectionScope = 'latest';
  if (mode === 'new-code') job.code = 'XHS_SOURCE_RATE_LIMIT_BLOCKED';
  if (mode === 'new-field') job.extra = 'not-part-of-old-reviewed-row';
  if (mode === 'new-restriction') job.receipt = { httpStatus: 429 };
  if (mode === 'new-unknown') job.sourceUnknowns = [{ phase: 'detail' }];
  if (mode === 'changed-generic-proof' || mode === 'missing-generic-proof') {
    const host = JSON.parse(f.jobs[1].document);
    if (mode === 'changed-generic-proof')
      host.genericRiskReviews[0].historicalRestrictions[0].fingerprint =
        '0'.repeat(64);
    else delete host.genericRiskReviews;
    f.jobs[1].document = JSON.stringify(host);
  }
  if (mode === 'wrong-review-id') f.reviews[0].plan_digest = 'f'.repeat(64);
  if (mode === 'wrong-backup') f.reviews[0].backup_sha256 = 'not-a-hash';
  if (mode === 'superseded-leaf')
    f.reviews.push({
      ...f.reviews[2],
      id: 'successor',
      scope_json: JSON.stringify({ lineageReviewIds: [f.reviews[2].id] }),
    });
  f.jobs[0].document = JSON.stringify(
    job,
    null,
    mode === 'noncanonical-document' ? 2 : undefined,
  );
  if (f.tasks.length) f.tasks[0].document = JSON.stringify(task);
  // For structural attacks, refresh the synthetic immutable evidence as if the
  // policy retained those rows: a hash alone must not bypass lineage semantics.
  if (
    ![
      'missing-evidence',
      'wrong-digest',
      'duplicate-proof',
      'reordered-proof',
      'missing-link',
      'superseded-leaf',
    ].includes(mode)
  ) {
    f.reviews.forEach((r, i) => (r.scope_json = JSON.stringify(scopes[i])));
    f.scope.retainedHistoryEvidence = f.reviews
      .map((r) => [r.id, lineageHash(r)])
      .sort(([a], [b]) => a.localeCompare(b));
  }
  expect(() => classify(f)).toThrow('OTHER_PLATFORM_RESTRICTION');
});
