import { ArticleCandidate } from './article-candidate';
import { canonicalArticleUrl } from './collection-format';
import { parseOwnerReviewResolution } from './owner-review-resolution';

describe('offline mobile URL resolution evidence (no transport)', () => {
  const requestUrl =
    'http://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=100&idx=1&sn=abcd&scene=27';
  const candidate: ArticleCandidate = {
    ...canonicalArticleUrl(requestUrl),
    requestUrl,
    title: '测试文章',
    indexTimestamp: 1700000000,
    discovery: {
      source: 'owner-web-search',
      capturedAt: '2026-10-02T00:00:00Z',
      page: 1,
    },
  };
  const reviewId = `${candidate.mpId}_upstream_supplied~-`;
  const valid = () => ({ reviewIds: [{ url: requestUrl, reviewId }] });

  it('binds upstream reviewId to the exact requested URL without claiming original verification', () => {
    expect(parseOwnerReviewResolution(candidate, valid())).toEqual({
      candidateId: candidate.id,
      mpId: candidate.mpId,
      reviewId,
      requestedUrl: requestUrl,
      originalVerified: false,
    });
    expect(
      parseOwnerReviewResolution(candidate, { errCode: 0, ...valid() })
        .reviewId,
    ).toBe(reviewId);
    expect(parseOwnerReviewResolution(candidate, valid())).not.toHaveProperty(
      'publishTime',
    );
  });
  it('also accepts the canonical URL when requestUrl is absent', () => {
    const { requestUrl: omitted, ...canonicalCandidate } = candidate;
    expect(omitted).toBe(requestUrl);
    expect(
      parseOwnerReviewResolution(canonicalCandidate, {
        reviewIds: [{ url: candidate.url, reviewId }],
      }).requestedUrl,
    ).toBe(candidate.url);
  });
  it.each([
    {},
    { reviewIds: [] },
    { reviewIds: [valid().reviewIds[0], valid().reviewIds[0]] },
  ])('rejects missing or ambiguous result cardinality (%j)', (response) => {
    expect(() => parseOwnerReviewResolution(candidate, response)).toThrow(
      'RESOLVER_CARDINALITY_INVALID',
    );
  });
  it('rejects a different returned URL, even if its stable identity matches', () => {
    expect(() =>
      parseOwnerReviewResolution(candidate, {
        reviewIds: [{ url: candidate.url, reviewId }],
      }),
    ).toThrow('RESOLVER_URL_MISMATCH');
  });
  it.each([
    'MP_WXS_99999_wrong',
    `${candidate.mpId}_`,
    `${candidate.mpId}_${'a'.repeat(151)}`,
    `${candidate.mpId}_abc\n`,
    `${candidate.mpId}_abc\r`,
    `${candidate.mpId}_bad/id`,
  ])('rejects cross-account or malformed reviewId %j', (invalid) => {
    expect(() =>
      parseOwnerReviewResolution(candidate, {
        reviewIds: [{ url: requestUrl, reviewId: invalid }],
      }),
    ).toThrow('RESOLVER_REVIEW_ID_INVALID');
  });
  it.each([-2012, '0', null, undefined, 'private upstream field'])(
    'rejects business code %j without exposing it',
    (errCode) => {
      expect(() =>
        parseOwnerReviewResolution(candidate, { errCode, ...valid() }),
      ).toThrow('RESOLVER_BUSINESS_REJECTED');
    },
  );
  it.each([null, false, [], 'raw response'])(
    'rejects invalid envelope %j',
    (response) => {
      expect(() => parseOwnerReviewResolution(candidate, response)).toThrow(
        'RESOLVER_RESPONSE_INVALID',
      );
    },
  );
  it('rejects malformed resolution entries', () => {
    for (const item of [null, [], false, { url: requestUrl }])
      expect(() =>
        parseOwnerReviewResolution(candidate, { reviewIds: [item] }),
      ).toThrow();
  });
  it('rejects contradictory candidate identity or signature before trusting a resolver', () => {
    for (const changed of [
      { id: 'WX_99999_100_1' },
      { mpId: 'MP_WXS_99999' },
      { url: candidate.url.replace('sn=abcd', 'sn=ffff') },
    ])
      expect(() =>
        parseOwnerReviewResolution({ ...candidate, ...changed }, valid()),
      ).toThrow('RESOLVER_CANDIDATE_INCONSISTENT');
    expect(() =>
      parseOwnerReviewResolution(
        { ...candidate, requestUrl: requestUrl + '&mid=999' },
        valid(),
      ),
    ).toThrow('RESOLVER_CANDIDATE_INVALID');
  });
  it('does not expose raw input in native URL parser errors', () => {
    try {
      parseOwnerReviewResolution(
        { ...candidate, requestUrl: 'private-invalid-input' },
        valid(),
      );
      throw new Error('expected rejection');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toBe('RESOLVER_CANDIDATE_INVALID');
      expect(error).not.toHaveProperty('input');
    }
  });
});
