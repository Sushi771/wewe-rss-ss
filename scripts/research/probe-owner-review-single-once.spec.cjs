'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const {
  ENDPOINT,
  DEFAULT_BODY_LIMIT,
  buildRequestUrl,
  validatePrerequisites,
  parseReviewSingle,
  probe,
} = require('./probe-owner-review-single-once.cjs');

const hash = (v) => createHash('sha256').update(v).digest('hex');

// Strictly synthetic offline test fixtures
const syntheticMpNumber = '3895431412';
const syntheticCandidateId = `WX_${syntheticMpNumber}_2247493594_1`;
const syntheticMpId = `MP_WXS_${syntheticMpNumber}`;
const syntheticReviewId = `${syntheticMpId}_mockSyntheticReviewIdSecretNone`;
const syntheticVid = '408220676';
const syntheticDeviceId = 'mock_device_1234567890';
const syntheticAccessToken = 'mock_synthetic_token_xyz';

const candidate = {
  id: syntheticCandidateId,
  mpId: syntheticMpId,
  title: '纯离线模拟测试文章标题样本',
  url: `https://mp.weixin.qq.com/s?__biz=mock&mid=2247493594&idx=1&sn=mock`,
};

const feed = {
  mpId: syntheticMpId,
  name: '纯离线模拟公众号',
  ownerVid: syntheticVid,
};

const mobile = {
  vid: syntheticVid,
  deviceId: syntheticDeviceId,
  accessToken: syntheticAccessToken,
};

const profile = {
  authHeaders: (m) => ({ vid: String(m.vid), accessToken: m.accessToken }),
  versionHeaders: {
    baseapi: '30',
    appver: '2.1.2.10245900',
    'User-Agent': 'WeRead/2.1.2 EInk',
  },
};

const sampleReviewResponse = {
  synckey: 0,
  reviewId: syntheticReviewId,
  review: {
    reviewId: syntheticReviewId,
    bookId: syntheticMpId,
    title: '纯离线模拟测试文章标题样本',
    createTime: 1700000000,
    mpInfo: {
      originalId: 'mock_original_id',
      title: '纯离线模拟测试文章标题样本',
      mp_name: '纯离线模拟公众号',
      time: 1700000000,
      doc_url: candidate.url,
    },
  },
};

async function fixture(callback) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wewe-review-single-mock-'),
  );
  try {
    await callback(root);
  } finally {
    const resolved = fs.realpathSync(root);
    const parent = fs.realpathSync(os.tmpdir());
    assert(
      path.dirname(resolved).toLowerCase() === parent.toLowerCase() &&
        path.basename(resolved).startsWith('wewe-review-single-mock-'),
    );
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function defaultOptions(root, changed = {}) {
  return {
    candidate,
    feed,
    reviewId: syntheticReviewId,
    mobile,
    profile,
    marker: path.join(root, 'review-single-attempt.json'),
    output: root,
    fetchImpl: async () =>
      new Response(JSON.stringify(sampleReviewResponse), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          server: 'test-upstream',
        },
      }),
    takeSnapshot: () => ({ db: 'mock_unchanged' }),
    protectedHashes: ['mock_hash_1'],
    bodyLimit: DEFAULT_BODY_LIMIT,
    ...changed,
  };
}

test('buildRequestUrl strictly matches pinned weread-omni review.single contract with zero guessed params', () => {
  const url = buildRequestUrl(syntheticReviewId);
  assert.equal(url.origin, 'https://i.weread.qq.com');
  assert.equal(url.pathname, '/review/single');
  assert.equal(url.searchParams.get('reviewId'), syntheticReviewId);
  assert.equal(url.searchParams.get('commentsCount'), '10');
  assert.equal(url.searchParams.get('commentsDirection'), '0');
  assert.equal(url.searchParams.get('likesCount'), '10');
  assert.equal(url.searchParams.get('likesDirection'), '0');
  assert.equal(url.searchParams.get('synckey'), '0');

  // Ensure no other unexpected/guessed query parameters exist
  const keys = Array.from(url.searchParams.keys()).sort();
  assert.deepEqual(
    keys,
    [
      'commentsCount',
      'commentsDirection',
      'likesCount',
      'likesDirection',
      'reviewId',
      'synckey',
    ].sort(),
  );

  assert.throws(() => buildRequestUrl(''), /reviewId_required/);
  assert.throws(() => buildRequestUrl('   '), /reviewId_required/);
});

test('validatePrerequisites requires valid resolution, matching candidate, feed and owner-06 mobile session', () => {
  const resolution = {
    candidateId: candidate.id,
    mpId: candidate.mpId,
    reviewId: syntheticReviewId,
    requestedUrl: candidate.url,
    originalVerified: false,
  };
  const resolverResult = {
    success: true,
    stage: 'parsed',
    status: 200,
    requests: 1,
    productionUnchanged: true,
    candidateId: candidate.id,
    originalVerified: false,
  };
  const loginResult = { success: true, productionUnchanged: true };
  const mobileSession = {
    source: 'owner-confirmed-eink-sdk-login',
    formatVersion: 1,
    accountId: syntheticVid,
    mobile: {
      vid: syntheticVid,
      accessToken: syntheticAccessToken,
      deviceId: syntheticDeviceId,
    },
  };

  assert.equal(
    validatePrerequisites({
      resolution,
      resolverResult,
      loginResult,
      mobileSession,
      feed,
      candidate,
    }),
    true,
  );

  // Rejects altered resolution format
  assert.throws(() =>
    validatePrerequisites({
      resolution: { ...resolution, mpId: 'INVALID' },
      resolverResult,
      loginResult,
      mobileSession,
      feed,
      candidate,
    }),
  );

  // Rejects failed resolver result
  assert.throws(() =>
    validatePrerequisites({
      resolution,
      resolverResult: { ...resolverResult, success: false },
      loginResult,
      mobileSession,
      feed,
      candidate,
    }),
  );

  // Rejects unconfirmed login
  assert.throws(() =>
    validatePrerequisites({
      resolution,
      resolverResult,
      loginResult: { ...loginResult, success: false },
      mobileSession,
      feed,
      candidate,
    }),
  );

  // Rejects mismatched mobile session source or token
  assert.throws(() =>
    validatePrerequisites({
      resolution,
      resolverResult,
      loginResult,
      mobileSession: {
        ...mobileSession,
        source: 'owner-confirmed-native-web-login',
      },
      feed,
      candidate,
    }),
  );

  // Rejects mismatched ownerVid
  assert.throws(() =>
    validatePrerequisites({
      resolution,
      resolverResult,
      loginResult,
      mobileSession: { ...mobileSession, accountId: '99999999' },
      feed,
      candidate,
    }),
  );

  // Rejects candidate mismatch
  assert.throws(() =>
    validatePrerequisites({
      resolution,
      resolverResult,
      loginResult,
      mobileSession,
      feed,
      candidate: { ...candidate, id: 'WX_other_id' },
    }),
  );
});

test('parseReviewSingle extracts article metadata and source URL without claiming body', () => {
  // Successful parse
  const parsed = parseReviewSingle(sampleReviewResponse, {
    candidate,
    feed,
    reviewId: syntheticReviewId,
  });
  assert.equal(parsed.candidateId, candidate.id);
  assert.equal(parsed.mpId, candidate.mpId);
  assert.equal(parsed.reviewId, syntheticReviewId);
  assert.equal(parsed.title, '纯离线模拟测试文章标题样本');
  assert.equal(parsed.accountName, '纯离线模拟公众号');
  assert.equal(parsed.publishTime, 1700000000);
  assert.equal(parsed.publishTimeSource, 'mpInfo.time');
  assert.equal(parsed.docUrl, candidate.url);
  assert.equal(parsed.hasSourceUrl, true);
  assert.equal(parsed.sourceIdentityMatched, true);
  assert.equal(parsed.metadataVerified, true);
  assert.equal(parsed.bodyVerified, false);

  // Empty response
  assert.throws(
    () =>
      parseReviewSingle({}, { candidate, feed, reviewId: syntheticReviewId }),
    /empty_response/,
  );

  // Empty review
  assert.throws(
    () =>
      parseReviewSingle(
        { synckey: 0 },
        { candidate, feed, reviewId: syntheticReviewId },
      ),
    /empty_review/,
  );

  // Auth expired (-2012)
  assert.throws(
    () =>
      parseReviewSingle(
        { errCode: -2012, errMsg: '登录超时' },
        { candidate, feed, reviewId: syntheticReviewId },
      ),
    /auth_expired/,
  );

  // Human challenge (-2041)
  assert.throws(
    () =>
      parseReviewSingle(
        { errCode: -2041, errMsg: '安全验证' },
        { candidate, feed, reviewId: syntheticReviewId },
      ),
    /challenge_required/,
  );

  // Challenge / captcha text
  assert.throws(
    () =>
      parseReviewSingle(
        { errMsg: '操作过于频繁，请稍后再试' },
        { candidate, feed, reviewId: syntheticReviewId },
      ),
    /challenge_or_rate_limit/,
  );

  // ReviewId mismatch
  assert.throws(
    () =>
      parseReviewSingle(
        { ...sampleReviewResponse, reviewId: 'different_review_id' },
        { candidate, feed, reviewId: syntheticReviewId },
      ),
    /review_id_mismatch/,
  );

  // Title mismatch
  assert.throws(
    () =>
      parseReviewSingle(
        {
          ...sampleReviewResponse,
          review: {
            ...sampleReviewResponse.review,
            title: '完全不一致的标题',
            mpInfo: {
              ...sampleReviewResponse.review.mpInfo,
              title: '完全不一致的标题',
            },
          },
        },
        { candidate, feed, reviewId: syntheticReviewId },
      ),
    /title_mismatch/,
  );
});

test('probe performs exactly one GET request with exact mobile headers, writes marker first, never retries', async () => {
  await fixture(async (root) => {
    let callCount = 0;
    let markerExistedBeforeNetwork = false;

    const opts = defaultOptions(root, {
      fetchImpl: async (url, init) => {
        callCount++;
        markerExistedBeforeNetwork = fs.existsSync(
          path.join(root, 'review-single-attempt.json'),
        );

        assert.equal(
          url,
          `https://i.weread.qq.com/review/single?reviewId=${syntheticReviewId}&commentsCount=10&commentsDirection=0&likesCount=10&likesDirection=0&synckey=0`,
        );
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');

        // Headers check
        assert.equal(init.headers.vid, syntheticVid);
        assert.equal(init.headers.accessToken, syntheticAccessToken);
        assert.equal(init.headers.baseapi, '30');
        assert(!('Cookie' in init.headers) && !('cookie' in init.headers));
        assert(
          !('Authorization' in init.headers) &&
            !('authorization' in init.headers),
        );

        return new Response(JSON.stringify(sampleReviewResponse), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(
              Buffer.byteLength(JSON.stringify(sampleReviewResponse)),
            ),
            server: 'test-upstream',
          },
        });
      },
    });

    const result = await probe(opts);
    assert.equal(result.success, true);
    assert.equal(result.requests, 1);
    assert.equal(result.productionUnchanged, true);
    assert.equal(result.candidateId, candidate.id);
    assert.equal(result.reviewId, syntheticReviewId);
    assert.equal(result.hasSourceUrl, true);
    assert.equal(result.metadataVerified, true);
    assert.equal(result.bodyVerified, false);
    assert.equal(callCount, 1);
    assert.equal(markerExistedBeforeNetwork, true);

    // Verify saved files
    assert(fs.existsSync(path.join(root, 'response-body.bin')));
    assert(fs.existsSync(path.join(root, 'response-metadata.json')));
    assert(fs.existsSync(path.join(root, 'review-single.json')));
    assert(fs.existsSync(path.join(root, 'result.json')));

    // Verify marker contents contain session hash, not raw secret
    const markerData = JSON.parse(
      fs.readFileSync(path.join(root, 'review-single-attempt.json'), 'utf8'),
    );
    assert.equal(markerData.sessionHash, hash(syntheticAccessToken));
    assert(!JSON.stringify(markerData).includes(syntheticAccessToken));

    // Second probe execution must fail on existing marker without issuing network requests
    await assert.rejects(probe(opts));
    assert.equal(callCount, 1); // Still 1 call, second attempt blocked before network
  });
});

test('HTTP 401, 500, challenge and upstream rejection stop cleanly after one request without publish', async () => {
  for (const [status, body] of [
    [401, JSON.stringify({ errCode: -2012, errMsg: '登录超时' })],
    [500, 'Internal Server Error'],
    [200, JSON.stringify({ errCode: -2041, errMsg: '验证码' })],
    [200, JSON.stringify({ errMsg: 'captcha challenge' })],
    [200, '{}'],
  ]) {
    await fixture(async (root) => {
      let callCount = 0;
      const opts = defaultOptions(root, {
        fetchImpl: async () => {
          callCount++;
          return new Response(body, {
            status,
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      const result = await probe(opts);
      assert.equal(result.success, false);
      assert.equal(result.requests, 1);
      assert.equal(callCount, 1);
      assert(fs.existsSync(path.join(root, 'response-body.bin')));
      assert(fs.existsSync(path.join(root, 'response-metadata.json')));
      assert(!fs.existsSync(path.join(root, 'review-single.json')));
    });
  }
});

test('oversize response and changed production snapshot block publication', async () => {
  // Test oversize limit
  await fixture(async (root) => {
    let callCount = 0;
    const largeData = 'A'.repeat(2000);
    const opts = defaultOptions(root, {
      bodyLimit: 1000,
      fetchImpl: async () => {
        callCount++;
        return new Response(largeData, { status: 200 });
      },
    });

    const result = await probe(opts);
    assert.equal(result.success, false);
    assert.equal(callCount, 1);
    assert(!fs.existsSync(path.join(root, 'review-single.json')));
  });

  // Test production snapshot changed
  await fixture(async (root) => {
    let snapshotCall = 0;
    const opts = defaultOptions(root, {
      takeSnapshot: () => {
        snapshotCall++;
        return { db: snapshotCall === 1 ? 'before_state' : 'altered_state' };
      },
    });

    const result = await probe(opts);
    assert.equal(result.success, false);
    assert.equal(result.productionUnchanged, false);
    assert(!fs.existsSync(path.join(root, 'review-single.json')));
  });
});
