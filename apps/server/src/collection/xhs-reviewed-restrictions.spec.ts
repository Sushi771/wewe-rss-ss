import { createHash } from 'node:crypto';
import { classifyReviewedRestrictions } from './xhs-reviewed-restrictions';
import { readFileSync } from 'node:fs';

(process.env.XHS_RESTRICTION_REVIEW_FIXTURE ? it : it.skip)(
  'classifies the explicitly supplied read-only audit snapshot',
  () => {
    const data = JSON.parse(
      readFileSync(process.env.XHS_RESTRICTION_REVIEW_FIXTURE!, 'utf8'),
    );
    const result = classifyReviewedRestrictions(
      data.tasks,
      data.jobs,
      BigInt(data.riskAt),
    );
    expect(result.map((r) => r.fingerprint)).toEqual(data.expectedFingerprints);
  },
);

function fixture() {
  const old = {
    id: 'old',
    state: 'paused',
    document: JSON.stringify({
      id: 'old',
      state: 'paused',
      code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
    }),
    updated_at: '100',
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(old))
    .digest('hex');
  const proof = {
    version: 1,
    digest: 'd'.repeat(64),
    confirmedAt: 300,
    acknowledgedLoginAndVerification: true,
    outcome: 'unknown',
    requestIdentity: 'unknown',
    risk: {
      state: 'blocked',
      code: 'XHS_SOURCE_RISK_REVIEW_REQUIRED',
      owner: null,
      http_status: null,
      endpoint: null,
      updated_at: '200',
    },
    historicalRestrictions: [
      {
        code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
        updatedAt: '100',
        fingerprint,
      },
    ],
  };
  const host = {
    id: 'host',
    state: 'partial',
    document: JSON.stringify({
      id: 'host',
      state: 'partial',
      historyHandoff: { confirmedAt: 150 },
      genericRiskReviews: [proof],
    }),
    updated_at: '300',
  };
  return { old, host, proof };
}
it('recognizes exact acknowledged history once, without treating audit references as fresh challenges', () => {
  const { old, host } = fixture();
  const result = classifyReviewedRestrictions([], [old, host], 400n);
  expect(result).toHaveLength(1);
  expect(result[0].code).toBe('XHS_SOURCE_VERIFICATION_BLOCKED');
  expect(classifyReviewedRestrictions([], [host], 400n)).toEqual([]);
});
it.each([
  'no-proof',
  'fingerprint',
  'identity',
  'time',
  'acknowledgement',
  'outcome',
  'current-challenge',
  'source-receipt',
  'active-fence',
  'unknown-dispatch',
  'source-status',
  'handoff',
])('blocks unsafe classification: %s', (kind) => {
  const { old, host } = fixture();
  const original = JSON.parse(old.document),
    audit = JSON.parse(host.document);
  switch (kind) {
    case 'no-proof':
      audit.genericRiskReviews = [];
      break;
    case 'fingerprint':
      audit.genericRiskReviews[0].historicalRestrictions[0].fingerprint =
        '0'.repeat(64);
      break;
    case 'identity':
      original.id = 'other';
      break;
    case 'time':
      old.updated_at = '400';
      break;
    case 'acknowledgement':
      audit.genericRiskReviews[0].acknowledgedLoginAndVerification = false;
      break;
    case 'outcome':
      audit.genericRiskReviews[0].outcome = 'success';
      break;
    case 'current-challenge':
      audit.code = 'XHS_SOURCE_VERIFICATION_BLOCKED';
      host.updated_at = '400';
      break;
    case 'source-receipt':
      original.sourceReceipt = { status: 200 };
      break;
    case 'active-fence':
      original.activeFence = { state: 'started' };
      break;
    case 'unknown-dispatch':
      original.sourceUnknowns = [{ state: 'unknown' }];
      break;
    case 'source-status':
      audit.sourceReceipt = { status: 461 };
      break;
    case 'handoff':
      delete audit.historyHandoff;
      break;
  }
  old.document = JSON.stringify(original);
  host.document = JSON.stringify(audit);
  expect(() => classifyReviewedRestrictions([], [old, host], 400n)).toThrow(
    'OTHER_PLATFORM_RESTRICTION',
  );
});
