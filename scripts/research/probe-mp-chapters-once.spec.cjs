'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const {
  TARGET_BOOK_ID,
  CHAPTERS_ENDPOINT,
  MAX_BYTES,
  OFFICIAL_READER_SCOPE,
  sanitizeLocalReason,
  buildChaptersUrl,
  classifyUpstream,
  parseChapters,
  parseCliArgs,
  verifyOwner09ScopeEvidence,
  runPreflight,
  runChaptersProbe,
} = require('./probe-mp-chapters-once.cjs');

const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-chapters-test-'));
  t.after(() => {
    const real = fs.realpathSync(rootDir);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(real).startsWith('mp-chapters-test-'));
    fs.rmSync(real, { recursive: true, force: true });
  });

  const paths = {
    session: path.join(rootDir, 'mobile-session.json'),
    loginResult: path.join(rootDir, 'result.json'),
    loginAttempt: path.join(rootDir, 'attempt.json'),
    scopeEvidence: path.join(rootDir, 'scope-evidence.json'),
    scopeSummary: path.join(rootDir, 'scope-summary.json'),
    scopeRaw: path.join(rootDir, 'scope-raw.bin'),
    baselineSession: path.join(rootDir, 'baseline-session.json'),
    baselineResult: path.join(rootDir, 'baseline-result.json'),
    cache: path.join(rootDir, 'sdk-cache'),
    chaptersMarker: path.join(rootDir, 'mp-chapters-owner09-attempt.json'),
    chaptersOutput: path.join(rootDir, 'mp-chapters'),
  };

  const accountId =
    options.accountId !== undefined ? options.accountId : '123456789';
  const vid = options.vid !== undefined ? options.vid : 123456789;
  const token = options.token || 'synth-test-token-owner09';
  const binding = digest(`${accountId}:${token}`);

  if (options.omitAttempt !== true) {
    fs.writeFileSync(
      paths.loginAttempt,
      JSON.stringify({
        requestedScope: options.attemptScope || OFFICIAL_READER_SCOPE,
      }),
    );
  }

  if (options.omitSession !== true) {
    fs.writeFileSync(
      paths.session,
      JSON.stringify({
        source: 'owner-confirmed-eink-sdk-login',
        formatVersion: 1,
        accountId: String(accountId),
        capturedAt: options.capturedAt || '2026-09-02T00:00:00.000Z',
        requestedScope: options.requestedScope || OFFICIAL_READER_SCOPE,
        mobile: {
          vid,
          deviceId: options.deviceId || 'synth-device-id-test-01',
          accessToken: token,
        },
      }),
    );
  }

  if (options.omitLoginResult !== true) {
    fs.writeFileSync(
      paths.loginResult,
      JSON.stringify({
        success:
          options.loginSuccess !== undefined ? options.loginSuccess : true,
        productionUnchanged:
          options.loginProdUnchanged !== undefined
            ? options.loginProdUnchanged
            : true,
      }),
    );
  }

  if (options.omitBaselineSession !== true) {
    fs.writeFileSync(
      paths.baselineSession,
      JSON.stringify({
        source: 'owner-confirmed-eink-sdk-login',
        formatVersion: 1,
        accountId:
          options.baselineAccountId !== undefined
            ? String(options.baselineAccountId)
            : String(accountId),
        capturedAt: options.baselineCapturedAt || '2026-09-01T00:00:00.000Z',
        mobile: {
          vid: options.baselineVid !== undefined ? options.baselineVid : vid,
          deviceId:
            options.baselineDeviceId ||
            options.deviceId ||
            'synth-device-id-test-01',
          accessToken: options.baselineToken || 'synth-baseline-token-owner07',
        },
      }),
    );
  }

  if (options.omitBaselineResult !== true) {
    fs.writeFileSync(
      paths.baselineResult,
      JSON.stringify({
        success:
          options.baselineSuccess !== undefined
            ? options.baselineSuccess
            : true,
        productionUnchanged:
          options.baselineProdUnchanged !== undefined
            ? options.baselineProdUnchanged
            : true,
      }),
    );
  }

  const rawScopeContent = JSON.stringify({
    scope: options.rawScope || OFFICIAL_READER_SCOPE,
    fris: 1,
    mps: options.mpsValue !== undefined ? options.mpsValue : 1,
  });
  const rawBytes = Buffer.from(rawScopeContent, 'utf8');

  if (options.omitScopeRaw !== true) {
    fs.writeFileSync(paths.scopeRaw, rawBytes);
  }

  if (options.omitScopeEvidence !== true) {
    fs.writeFileSync(
      paths.scopeEvidence,
      JSON.stringify({
        phase: 'scope',
        httpStatus: 200,
        requests: 1,
        responseBodyComplete: true,
        responseSha256: options.corruptHash ? 'bad-hash' : digest(rawBytes),
        sessionBinding: options.corruptBinding ? 'bad-binding' : binding,
      }),
    );
  }

  if (options.omitScopeSummary !== true) {
    fs.writeFileSync(
      paths.scopeSummary,
      JSON.stringify({
        phase: 'scope',
        status: 'success',
        weChatMpGranted: options.mpsValue !== 0,
        weChatFriendsGranted: true,
        httpStatus: 200,
      }),
    );
  }

  fs.mkdirSync(paths.cache);

  return {
    rootDir,
    paths,
    env: {},
    approvedOnline: true,
    profile: {
      authHeaders: (mobile) => ({
        'we-vid': String(mobile.vid),
        'we-access-token': mobile.accessToken,
      }),
      versionHeaders: { 'User-Agent': 'offline-test-profile' },
    },
  };
}

const mockResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

test('buildChaptersUrl strictly enforces TARGET_BOOK_ID and count 1..5', () => {
  assert.equal(
    buildChaptersUrl('MP_WXS_3895431412', 1),
    'https://i.weread.qq.com/mp/chapters?bookId=MP_WXS_3895431412&count=1',
  );
  assert.equal(
    buildChaptersUrl('MP_WXS_3895431412', 5),
    'https://i.weread.qq.com/mp/chapters?bookId=MP_WXS_3895431412&count=5',
  );

  assert.throws(
    () => buildChaptersUrl('MP_WXS_3895431412', 0),
    /count_out_of_range/,
  );
  assert.throws(
    () => buildChaptersUrl('MP_WXS_3895431412', 6),
    /count_out_of_range/,
  );
  assert.throws(
    () => buildChaptersUrl('MP_WXS_3895431412', 20),
    /count_out_of_range/,
  );
  assert.throws(() => buildChaptersUrl('OTHER_BOOK_ID', 5), /invalid_book_id/);
});

test('classifyUpstream accurately classifies HTTP 499 with -2041 as limit_stop ERRCODE_-2041', () => {
  assert.deepEqual(classifyUpstream(499, { errcode: -2041, errmsg: '-2041' }), [
    'limit_stop',
    'ERRCODE_-2041',
  ]);
  assert.deepEqual(classifyUpstream(200, { errCode: -2041 }), [
    'limit_stop',
    'ERRCODE_-2041',
  ]);
  assert.deepEqual(classifyUpstream(499, { errcode: -9999 }), [
    'upstream_stop',
    'HTTP_499',
  ]);
  assert.deepEqual(classifyUpstream(401, {}), ['auth_stop', 'HTTP_401']);
  assert.deepEqual(classifyUpstream(200, { data: [] }), null);
});

test('parseCliArgs strictly allows only verified flags and count 1..5', () => {
  assert.deepEqual(parseCliArgs(['--preflight']), { mode: 'preflight' });
  assert.deepEqual(parseCliArgs(['--chapters', '--approved-online']), {
    mode: 'execute',
    count: 5,
  });
  assert.deepEqual(
    parseCliArgs(['--chapters', '--approved-online', '--count', '3']),
    { mode: 'execute', count: 3 },
  );

  assert.throws(
    () => parseCliArgs(['--chapters', '--approved-online', '--count', '10']),
    /count_out_of_range/,
  );
  assert.throws(
    () => parseCliArgs(['--chapters', '--approved-online', '--offset', '5']),
    /usage_gate/,
  );
  assert.throws(() => parseCliArgs(['--unknown']), /usage_gate/);
});

test('parseChapters retains upstreamCreateTime and rejects wrong-target rows', () => {
  const validData = {
    synckey: 1727700000,
    clearAll: false,
    data: [
      {
        reviewId: 'MP_WXS_3895431412_2247493594_1',
        createTime: 1727600000,
        mpInfo: {
          title: '文章1标题',
          picUrl: 'https://pic.example.test/1.jpg',
          payType: 0,
        },
      },
    ],
  };

  const parsed = parseChapters(validData, TARGET_BOOK_ID);
  assert.equal(parsed.targetArticleCount, 1);
  assert.equal(parsed.first5[0].upstreamCreateTime, 1727600000);
  assert.equal(parsed.first5[0].publishedTime, undefined); // NOT named publishedTime!
  assert.equal(parsed.first5[0].reviewId, 'MP_WXS_3895431412_2247493594_1');

  // Wrong-target row rejection
  const mixedData = {
    data: [
      {
        reviewId: 'MP_WXS_9999999999_1234567890_1',
        createTime: 1727400000,
        mpInfo: { title: '其他号文章' },
      },
    ],
  };
  assert.throws(
    () => parseChapters(mixedData, TARGET_BOOK_ID),
    /wrong_target_row_detected/,
  );
});

test('verifyOwner09ScopeEvidence verifies hash, binding, mps=1 and mandatory baseline', (t) => {
  const f = fixture(t);
  const session = JSON.parse(fs.readFileSync(f.paths.session, 'utf8'));
  const binding = digest(`${session.accountId}:${session.mobile.accessToken}`);

  // Valid fixture passes cleanly
  assert.doesNotThrow(() =>
    verifyOwner09ScopeEvidence(f.paths, session, binding),
  );

  // Missing login attempt fails
  const fNoAttempt = fixture(t, { omitAttempt: true });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fNoAttempt.paths, session, binding),
    /attempt_scope_missing/,
  );

  // Login attempt scope mismatch fails
  const fBadAttemptScope = fixture(t, { attemptScope: 'snsapi_base' });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fBadAttemptScope.paths, session, binding),
    /attempt_scope_mismatch/,
  );

  // Session requested scope mismatch fails
  const fBadSessionScope = fixture(t, { requestedScope: 'snsapi_base' });
  const badSession = JSON.parse(
    fs.readFileSync(fBadSessionScope.paths.session, 'utf8'),
  );
  assert.throws(
    () =>
      verifyOwner09ScopeEvidence(fBadSessionScope.paths, badSession, binding),
    /requested_scope_mismatch/,
  );

  // Missing baseline session fails
  const fNoBaseline = fixture(t, { omitBaselineSession: true });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fNoBaseline.paths, session, binding),
    /baseline_missing/,
  );

  // Baseline result not verified fails
  const fBadBaselineRes = fixture(t, { baselineSuccess: false });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fBadBaselineRes.paths, session, binding),
    /baseline_result_not_verified/,
  );

  // Baseline account mismatch fails
  const fAccountMismatch = fixture(t, { baselineAccountId: '999999999' });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fAccountMismatch.paths, session, binding),
    /baseline_account_mismatch/,
  );

  // Baseline vid mismatch fails
  const fVidMismatch = fixture(t, { baselineVid: 999999999 });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fVidMismatch.paths, session, binding),
    /baseline_vid_mismatch/,
  );

  // Baseline device mismatch fails
  const fDeviceMismatch = fixture(t, { baselineDeviceId: 'other-device-id' });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fDeviceMismatch.paths, session, binding),
    /baseline_device_mismatch/,
  );

  // Baseline token not new fails
  const fTokenSame = fixture(t, { baselineToken: 'synth-test-token-owner09' });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fTokenSame.paths, session, binding),
    /baseline_token_not_new/,
  );

  // Baseline captured not later fails
  const fDateNotLater = fixture(t, {
    baselineCapturedAt: '2026-09-10T00:00:00.000Z',
    capturedAt: '2026-09-02T00:00:00.000Z',
  });
  const dateNotLaterSession = JSON.parse(
    fs.readFileSync(fDateNotLater.paths.session, 'utf8'),
  );
  assert.throws(
    () =>
      verifyOwner09ScopeEvidence(
        fDateNotLater.paths,
        dateNotLaterSession,
        binding,
      ),
    /baseline_captured_not_later/,
  );

  // Missing mps=1 in raw fails
  const fMpsZero = fixture(t, { mpsValue: 0 });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fMpsZero.paths, session, binding),
    /mp_scope_not_granted/,
  );

  // Corrupted hash fails
  const fCorruptHash = fixture(t, { corruptHash: true });
  assert.throws(
    () => verifyOwner09ScopeEvidence(fCorruptHash.paths, session, binding),
    /scope_hash_mismatch/,
  );
});

test('runChaptersProbe enforces environmentGate and sanitizes reasons', async (t) => {
  const f = fixture(t);

  // Test environmentGate blocked
  const resultBlocked = await runChaptersProbe({
    rootDir: f.rootDir,
    paths: f.paths,
    profile: f.profile,
    approvedOnline: true,
    env: { HTTP_PROXY: 'http://127.0.0.1:8888' },
  });
  assert.equal(resultBlocked.status, 'local_gate_stop');
  assert.equal(resultBlocked.reason, 'ENVIRONMENT_GATE_BLOCKED');
  assert.equal(resultBlocked.requests, 0);

  // Test offset rejected
  const resultOffset = await runChaptersProbe({
    rootDir: f.rootDir,
    paths: f.paths,
    profile: f.profile,
    approvedOnline: true,
    offset: 10,
    env: {},
  });
  assert.equal(resultOffset.status, 'local_gate_stop');
  assert.equal(resultOffset.reason, 'FIRST_PAGE_ONLY_NO_OFFSET');
});

test('runChaptersProbe succeeds with upstreamCreateTime and publicationVerified=false', async (t) => {
  const f = fixture(t);
  const sampleArticles = Array.from({ length: 3 }, (_, i) => ({
    reviewId: `MP_WXS_3895431412_22474935${i}_1`,
    createTime: 1727600000 + i * 100,
    mpInfo: {
      title: `测试文章 ${i + 1}`,
      picUrl: `https://pic.example.test/${i}.jpg`,
      payType: 0,
    },
  }));

  const fetchFn = async (url, init) => {
    assert.equal(
      url,
      'https://i.weread.qq.com/mp/chapters?bookId=MP_WXS_3895431412&count=3',
    );
    assert.equal(init.method, 'GET');
    return mockResponse({
      synckey: 123456,
      clearAll: false,
      data: sampleArticles,
    });
  };

  const result = await runChaptersProbe({
    rootDir: f.rootDir,
    paths: f.paths,
    profile: f.profile,
    approvedOnline: true,
    fetchFn,
    count: 3,
    env: {},
  });

  assert.equal(result.status, 'success');
  assert.equal(result.reason, 'CHAPTERS_LIST_PARSED');
  assert.equal(result.requests, 1);
  assert.equal(result.productionWrites, 0);
  assert.equal(result.publicationVerified, false); // MUST remain false!
  assert.equal(result.subscriptionRecovered, false);
  assert.equal(result.first5.length, 3);
  assert.equal(result.first5[0].upstreamCreateTime, 1727600000);

  // Check marker
  assert.ok(fs.existsSync(f.paths.chaptersMarker));
});

test('runChaptersProbe handles empty list as NO_VERIFIED_ARTICLES', async (t) => {
  const f = fixture(t);
  const fetchFn = async () =>
    mockResponse({ synckey: 0, clearAll: false, data: [] });

  const result = await runChaptersProbe({
    rootDir: f.rootDir,
    paths: f.paths,
    profile: f.profile,
    approvedOnline: true,
    fetchFn,
    count: 5,
    env: {},
  });

  assert.equal(result.status, 'empty_list_stop');
  assert.equal(result.reason, 'NO_VERIFIED_ARTICLES');
  assert.equal(result.requests, 1);
  assert.equal(result.publicationVerified, false);
  assert.equal(result.subscriptionRecovered, false);
});

test('runChaptersProbe rejects wrong-target rows with WRONG_TARGET_ROW_DETECTED', async (t) => {
  const f = fixture(t);
  const fetchFn = async () =>
    mockResponse({
      data: [
        {
          reviewId: 'MP_WXS_9999999999_0000_1',
          createTime: 1727600000,
          mpInfo: { title: 'Wrong account' },
        },
      ],
    });

  const result = await runChaptersProbe({
    rootDir: f.rootDir,
    paths: f.paths,
    profile: f.profile,
    approvedOnline: true,
    fetchFn,
    count: 5,
    env: {},
  });

  assert.equal(result.status, 'shape_stop');
  assert.equal(result.reason, 'WRONG_TARGET_ROW_DETECTED');
  assert.equal(result.requests, 1);
  assert.equal(result.publicationVerified, false);
});
