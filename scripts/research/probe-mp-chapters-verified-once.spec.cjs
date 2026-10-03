'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  TARGET_BOOK_ID,
  OFFICIAL_READER_SCOPE,
} = require('./probe-mp-chapters-once.cjs');
const {
  SOURCE_APP_ID,
  SESSION_NAME,
  MAX_ARTIFACT_AGE_MS,
  isValidToken,
  sanitizeVerifiedReason,
  validateArtifact,
  buildVerifiedHeaders,
  verifyOriginalStoppedState,
  parseCliArgs,
  runPreflight,
  runVerifiedChaptersProbe,
} = require('./probe-mp-chapters-verified-once.cjs');
const { createVerificationServer } = require('./serve-owner-manual-verify.cjs');

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function safeCleanup(targetDir) {
  const resolved = fs.realpathSync(targetDir);
  const tmpResolved = fs.realpathSync(os.tmpdir());
  assert(
    resolved.startsWith(tmpResolved),
    `Refusing to delete directory outside tmpdir: ${resolved}`,
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

function makeTempFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-chapters-test-'));
  const sessionDir = path.join(dir, 'session');
  const scopeDir = path.join(sessionDir, 'mp-scope');
  const originalChaptersDir = path.join(sessionDir, 'mp-chapters');
  const verifiedOutputDir = path.join(sessionDir, 'mp-chapters-verified');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(originalChaptersDir, { recursive: true });

  const syntheticAccountId = '123456789';
  const syntheticVid = '123456789';
  const syntheticDeviceId = 'synth-device-uuid-test';
  const syntheticToken = 'synth-access-token-xyz';
  const syntheticBaseToken = 'synth-access-token-abc';
  const expectedBinding = digest(`${syntheticAccountId}:${syntheticToken}`);

  // 1. Session file
  const sessionFile = path.join(sessionDir, 'mobile-session.json');
  const sessionData = {
    formatVersion: 1,
    source: 'owner-confirmed-eink-sdk-login',
    capturedAt: '2026-10-03T10:00:00.000Z',
    accountId: syntheticAccountId,
    requestedScope: OFFICIAL_READER_SCOPE,
    mobile: {
      vid: syntheticVid,
      deviceId: syntheticDeviceId,
      accessToken: syntheticToken,
      refreshToken: 'synth-refresh-token',
    },
  };
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData));

  // 1b. Login result file
  const loginResult = path.join(sessionDir, 'result.json');
  fs.writeFileSync(
    loginResult,
    JSON.stringify({
      formatVersion: 1,
      source: 'owner-confirmed-eink-sdk-login',
      capturedAt: '2026-10-03T10:00:00.000Z',
      success: true,
      productionUnchanged: true,
      mobile: {
        vid: syntheticVid,
        accessToken: syntheticToken,
      },
    }),
  );

  // 2. Login attempt file
  const loginAttempt = path.join(sessionDir, 'attempt.json');
  fs.writeFileSync(
    loginAttempt,
    JSON.stringify({
      requestedScope: OFFICIAL_READER_SCOPE,
    }),
  );

  // 3. Baseline session and result (owner-07 synthetic equivalent)
  const baselineSession = path.join(dir, 'baseline-session.json');
  const baselineSessionData = {
    formatVersion: 1,
    source: 'owner-confirmed-eink-sdk-login',
    capturedAt: '2026-10-02T10:00:00.000Z',
    accountId: syntheticAccountId,
    mobile: {
      vid: syntheticVid,
      deviceId: syntheticDeviceId,
      accessToken: syntheticBaseToken,
    },
  };
  fs.writeFileSync(baselineSession, JSON.stringify(baselineSessionData));

  const baselineResult = path.join(dir, 'baseline-result.json');
  fs.writeFileSync(
    baselineResult,
    JSON.stringify({
      success: true,
      productionUnchanged: true,
    }),
  );

  // 4. Scope evidence
  const scopeRaw = path.join(scopeDir, 'raw-response.bin');
  const scopeRawData = Buffer.from(
    JSON.stringify({
      errcode: 0,
      mps: 1,
      fris: 1,
      scope: OFFICIAL_READER_SCOPE,
    }),
  );
  fs.writeFileSync(scopeRaw, scopeRawData);

  const scopeEvidence = path.join(scopeDir, 'evidence.json');
  fs.writeFileSync(
    scopeEvidence,
    JSON.stringify({
      phase: 'scope',
      httpStatus: 200,
      requests: 1,
      responseBodyComplete: true,
      sessionBinding: expectedBinding,
      responseSha256: digest(scopeRawData),
    }),
  );

  const scopeSummary = path.join(scopeDir, 'summary.json');
  fs.writeFileSync(
    scopeSummary,
    JSON.stringify({
      phase: 'scope',
      status: 'success',
      weChatMpGranted: true,
    }),
  );

  // 5. Original stopped attempt marker
  const originalAttemptMarker = path.join(dir, 'original-attempt-marker.json');
  const markerData = {
    kind: 'official-eink-mp-chapters-once',
    phase: 'chapters',
    endpoint: 'https://i.weread.qq.com/mp/chapters',
    url: `https://i.weread.qq.com/mp/chapters?bookId=${TARGET_BOOK_ID}&count=5`,
    params: { bookId: TARGET_BOOK_ID, count: 5 },
    attemptedAt: '2026-10-03T10:05:00.000Z',
    sessionBinding: expectedBinding,
  };
  fs.writeFileSync(originalAttemptMarker, JSON.stringify(markerData));
  const markerSha = digest(fs.readFileSync(originalAttemptMarker));

  // 6. Original stopped chapters evidence (HTTP 499 / -2041)
  const originalChaptersRaw = path.join(
    originalChaptersDir,
    'raw-response.bin',
  );
  const originalChaptersRawData = Buffer.from(
    '{"errcode":-2041,"errlog":"test","errmsg":"-2041"}',
  );
  fs.writeFileSync(originalChaptersRaw, originalChaptersRawData);
  const chaptersRawSha = digest(originalChaptersRawData);
  const chaptersRawSha256 = chaptersRawSha;

  const originalChaptersEvidence = path.join(
    originalChaptersDir,
    'evidence.json',
  );
  fs.writeFileSync(
    originalChaptersEvidence,
    JSON.stringify({
      phase: 'chapters',
      httpStatus: 499,
      requests: 1,
      responseBodyComplete: true,
      sessionBinding: expectedBinding,
      responseSha256: chaptersRawSha,
    }),
  );

  const originalChaptersSummary = path.join(
    originalChaptersDir,
    'summary.json',
  );
  fs.writeFileSync(
    originalChaptersSummary,
    JSON.stringify({
      phase: 'chapters',
      status: 'upstream_stop',
      reason: 'HTTP_499',
      httpStatus: 499,
      requests: 1,
    }),
  );

  // 7. Start ledger
  const testNonce = 'synth-nonce-test-12345';
  const startLedgerFile = path.join(sessionDir, 'manual-verify-start.json');
  fs.writeFileSync(
    startLedgerFile,
    JSON.stringify({
      kind: 'owner-manual-verification-start',
      sessionName: SESSION_NAME,
      targetBookId: TARGET_BOOK_ID,
      appId: SOURCE_APP_ID,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      nonceHash: digest(testNonce),
      sessionBinding: expectedBinding,
      attemptMarkerSha256: markerSha,
      chaptersRawSha256,
      consumed: false,
    }),
  );

  // 8. Artifact file
  const artifactFile = path.join(
    sessionDir,
    'manual-verification-artifact.json',
  );
  const consumeLedgerFile = path.join(
    sessionDir,
    'manual-verification-consumed.json',
  );
  const verifiedAttemptMarker = path.join(
    dir,
    'mp-chapters-owner09-verified-attempt.json',
  );

  const paths = {
    sessionDir,
    session: sessionFile,
    loginResult,
    loginAttempt,
    baselineSession,
    baselineResult,
    scopeEvidence,
    scopeSummary,
    scopeRaw,
    originalAttemptMarker,
    originalChaptersEvidence,
    originalChaptersSummary,
    originalChaptersRaw,
    attemptMarker: originalAttemptMarker,
    chaptersEvidence: originalChaptersEvidence,
    chaptersSummary: originalChaptersSummary,
    chaptersRaw: originalChaptersRaw,
    startLedgerFile,
    artifactFile,
    consumeLedgerFile,
    verifiedAttemptMarker,
    verifiedOutput: verifiedOutputDir,
    cache: path.join(dir, 'cache'),
  };

  const createValidArtifact = (overrides = {}) => {
    return {
      kind: 'owner-manual-verification-artifact',
      sessionName: SESSION_NAME,
      targetBookId: TARGET_BOOK_ID,
      appId: SOURCE_APP_ID,
      success: true,
      ret: 0,
      errorCode: 0,
      nonceHash: digest(testNonce),
      boundAttemptMarker: originalAttemptMarker,
      attemptMarkerSha256: markerSha,
      sessionBinding: expectedBinding,
      chaptersRawSha256,
      verifiedAt: new Date().toISOString(),
      compatibility: 'UNVERIFIED_PENDING_UPSTREAM_ACCEPTANCE',
      consumed: false,
      ticket: 'synth-valid-ticket-verified-123',
      randstr: '@synth-valid-randstr-456',
      ...overrides,
    };
  };

  const syntheticProfile = {
    authHeaders: (mobile) => ({
      vid: String(mobile.vid),
      accessToken: mobile.accessToken,
    }),
    versionHeaders: {
      'base-version': '2.1.2',
    },
  };

  return {
    dir,
    paths,
    expectedBinding,
    markerSha,
    chaptersRawSha,
    testNonce,
    createValidArtifact,
    syntheticProfile,
    cleanup: () => safeCleanup(dir),
  };
}

const CLEAN_ENV = {};

test('parseCliArgs parses plan, preflight, and approved-online count options strictly', () => {
  assert.deepEqual(parseCliArgs(['--plan']), { mode: 'plan' });
  assert.deepEqual(parseCliArgs(['--preflight']), { mode: 'preflight' });
  assert.deepEqual(parseCliArgs(['--chapters', '--approved-online']), {
    mode: 'execute',
    count: 5,
  });
  assert.deepEqual(
    parseCliArgs(['--chapters', '--approved-online', '--count', '3']),
    { mode: 'execute', count: 3 },
  );

  assert.throws(() => parseCliArgs([]), /usage_gate/);
  assert.throws(() => parseCliArgs(['--chapters']), /usage_gate/);
  assert.throws(
    () => parseCliArgs(['--chapters', '--approved-online', '--count', '0']),
    /count_out_of_range/,
  );
  assert.throws(
    () => parseCliArgs(['--chapters', '--approved-online', '--count', '6']),
    /count_out_of_range/,
  );
  assert.throws(
    () =>
      parseCliArgs([
        '--chapters',
        '--approved-online',
        '--count',
        'notanumber',
      ]),
    /count_out_of_range/,
  );
});

test('isValidToken allows safe tokens and rejects control characters/CRLF', () => {
  assert.equal(isValidToken('valid-token-123_abc', 100), true);
  assert.equal(isValidToken('@valid_randstr', 100), true);
  assert.equal(isValidToken('has\r\ninjection', 100), false);
  assert.equal(isValidToken('has\x00null', 100), false);
  assert.equal(isValidToken('', 100), false);
  assert.equal(isValidToken('toolong', 3), false);
});

test('validateArtifact verifies provenance, nonces, and conservative age window', () => {
  const fixture = makeTempFixtureDir();
  try {
    const startLedger = JSON.parse(
      fs.readFileSync(fixture.paths.startLedgerFile, 'utf8'),
    );
    const validArt = fixture.createValidArtifact();

    // Valid artifact passes
    assert.equal(
      validateArtifact(
        validArt,
        startLedger,
        fixture.expectedBinding,
        fixture.markerSha,
        fixture.chaptersRawSha,
      ),
      true,
    );

    // Rejects non-success / ret != 0
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, success: false },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_not_success/,
    );
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, ret: 2 },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_not_success/,
    );

    // Rejects nonzero errorCode
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, errorCode: 1006 },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_nonzero_error/,
    );

    // Rejects trerror_ fallback ticket
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, ticket: 'trerror_1006_domain_mismatch' },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_fallback_ticket/,
    );

    // Rejects CRLF in ticket
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, ticket: 'bad\r\nticket' },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /ticket_token_invalid/,
    );

    // Rejects AppID mismatch
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, appId: 'wrong-appid' },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_appid_mismatch/,
    );

    // Rejects binding mismatch
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, sessionBinding: 'wrong-binding' },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_binding_mismatch/,
    );

    // Rejects marker SHA mismatch
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, attemptMarkerSha256: 'tampered-sha' },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_marker_sha_mismatch/,
    );

    // Rejects chapters raw SHA mismatch
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, chaptersRawSha256: 'tampered-sha' },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_chapters_sha_mismatch/,
    );

    // Rejects stale artifact (> 5 minutes old)
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, verifiedAt: staleTime },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /artifact_expired/,
    );

    // Rejects nonceHash mismatch with start ledger
    assert.throws(
      () =>
        validateArtifact(
          { ...validArt, nonceHash: 'mismatched-nonce-hash' },
          startLedger,
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /start_ledger_mismatch/,
    );

    // Rejects missing or mismatched attemptMarkerSha256 in startLedger
    assert.throws(
      () =>
        validateArtifact(
          validArt,
          { ...startLedger, attemptMarkerSha256: undefined },
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /start_ledger_mismatch/,
    );
    assert.throws(
      () =>
        validateArtifact(
          validArt,
          { ...startLedger, attemptMarkerSha256: 'mismatched-marker-sha' },
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /start_ledger_mismatch/,
    );

    // Rejects missing or mismatched chaptersRawSha256 in startLedger
    assert.throws(
      () =>
        validateArtifact(
          validArt,
          { ...startLedger, chaptersRawSha256: undefined },
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /start_ledger_mismatch/,
    );
    assert.throws(
      () =>
        validateArtifact(
          validArt,
          { ...startLedger, chaptersRawSha256: 'mismatched-raw-sha' },
          fixture.expectedBinding,
          fixture.markerSha,
          fixture.chaptersRawSha,
        ),
      /start_ledger_mismatch/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('buildVerifiedHeaders wraps authHeaders adding ONLY wr_ticket and wr_randstr', () => {
  const fixture = makeTempFixtureDir();
  try {
    const artifact = fixture.createValidArtifact();
    const mobile = { vid: '123456789', accessToken: 'test-token' };
    const headers = buildVerifiedHeaders(
      fixture.syntheticProfile,
      mobile,
      artifact,
    );

    assert.equal(headers.vid, '123456789');
    assert.equal(headers.accessToken, 'test-token');
    assert.equal(headers['base-version'], '2.1.2');
    assert.equal(headers.wr_ticket, artifact.ticket);
    assert.equal(headers.wr_randstr, artifact.randstr);

    // Confirm NO extra fields injected
    const keys = Object.keys(headers).sort();
    assert.deepEqual(keys, [
      'accessToken',
      'base-version',
      'vid',
      'wr_randstr',
      'wr_ticket',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('verifyOriginalStoppedState requires original attempt marker and raw response with -2041', () => {
  const fixture = makeTempFixtureDir();
  try {
    const res = verifyOriginalStoppedState(
      fixture.paths,
      fixture.expectedBinding,
    );
    assert.equal(res.markerSha256, fixture.markerSha);
    assert.equal(res.chaptersRawSha256, fixture.chaptersRawSha);

    // Tampered raw response
    fs.writeFileSync(
      fixture.paths.originalChaptersRaw,
      Buffer.from('tampered'),
    );
    assert.throws(
      () => verifyOriginalStoppedState(fixture.paths, fixture.expectedBinding),
      /chapters_hash_mismatch/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('runPreflight reports artifactPending=true and zero requests when no artifact exists yet', async () => {
  const fixture = makeTempFixtureDir();
  try {
    // Note: fixture.paths.artifactFile does NOT exist initially
    const res = await runPreflight({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      profile: fixture.syntheticProfile,
    });

    assert.equal(res.status, 'preflight_ok');
    assert.equal(res.requests, 0);
    assert.equal(res.markerWritten, false);
    assert.equal(res.credentialValid, true);
    assert.equal(res.profileValid, true);
    assert.equal(res.artifactReady, false);
    assert.equal(res.artifactPending, true);
    assert.equal(res.verifiedChaptersReady, false);
    assert.equal(res.targetBookId, TARGET_BOOK_ID);
    assert.equal(res.sessionBinding, fixture.expectedBinding);
    assert.equal(res.ticketHeaderBound, true);
    assert.equal(res.publicationVerified, false);
    assert.equal(res.productionWrites, 0);
  } finally {
    fixture.cleanup();
  }
});

test('runPreflight reports verifiedChaptersReady=true when valid fresh artifact is present', async () => {
  const fixture = makeTempFixtureDir();
  try {
    const validArt = fixture.createValidArtifact();
    fs.writeFileSync(fixture.paths.artifactFile, JSON.stringify(validArt));

    const res = await runPreflight({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      profile: fixture.syntheticProfile,
    });

    assert.equal(res.status, 'preflight_ok');
    assert.equal(res.requests, 0);
    assert.equal(res.artifactReady, true);
    assert.equal(res.artifactPending, false);
    assert.equal(res.verifiedChaptersReady, true);
  } finally {
    fixture.cleanup();
  }
});

test('runVerifiedChaptersProbe requires approval and fresh artifact, then executes single count=5 fetch with injected headers', async () => {
  const fixture = makeTempFixtureDir();
  try {
    // 1. Rejects without approvedOnline
    const unapproved = await runVerifiedChaptersProbe({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      approvedOnline: false,
    });
    assert.equal(unapproved.status, 'local_gate_stop');
    assert.equal(unapproved.reason, 'EXPLICIT_STAGE_APPROVAL_REQUIRED');

    // 2. Rejects if artifact is missing
    const noArtifact = await runVerifiedChaptersProbe({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      approvedOnline: true,
      profile: fixture.syntheticProfile,
    });
    assert.equal(noArtifact.status, 'local_gate_stop');
    assert.equal(noArtifact.reason, 'ARTIFACT_MISSING');

    // 3. Write valid fresh artifact and execute single mock fetch
    const validArt = fixture.createValidArtifact();
    fs.writeFileSync(fixture.paths.artifactFile, JSON.stringify(validArt));

    let fetchCalled = false;
    let requestUrl = null;
    let requestHeaders = null;

    const mockFetch = async (url, opts) => {
      fetchCalled = true;
      requestUrl = url;
      requestHeaders = opts.headers;
      return new Response(
        JSON.stringify({
          data: [
            {
              reviewId: 'MP_WXS_3895431412_test_art_1',
              createTime: 1727900000,
              mpInfo: { title: 'Test Article 1' },
            },
          ],
          synckey: 12345,
          clearAll: 0,
        }),
        { status: 200 },
      );
    };

    const res = await runVerifiedChaptersProbe({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      approvedOnline: true,
      profile: fixture.syntheticProfile,
      fetchFn: mockFetch,
    });

    assert.equal(fetchCalled, true);
    assert(requestUrl.includes('bookId=MP_WXS_3895431412'));
    assert(requestUrl.includes('count=5'));
    assert.equal(requestHeaders.wr_ticket, validArt.ticket);
    assert.equal(requestHeaders.wr_randstr, validArt.randstr);

    // Verify output contract
    assert.equal(res.status, 'success');
    assert.equal(res.requests, 1);
    assert.equal(res.publicationVerified, false);
    assert.equal(res.bodyVerified, false);
    assert.equal(res.subscriptionRecovered, false);
    assert.equal(res.productionWrites, 0);
    assert.equal(res.articles.length, 1);
    assert.equal(res.articles[0].reviewId, 'MP_WXS_3895431412_test_art_1');

    // Verify verified-attempt marker written with wx
    assert(fs.existsSync(fixture.paths.verifiedAttemptMarker));
    const savedMarker = JSON.parse(
      fs.readFileSync(fixture.paths.verifiedAttemptMarker, 'utf8'),
    );
    assert.equal(savedMarker.kind, 'official-eink-mp-chapters-once');
    assert.equal(savedMarker.ticket, undefined, 'Must NOT leak raw ticket');
    assert.equal(savedMarker.randstr, undefined, 'Must NOT leak raw randstr');

    // Verify consumption ledger written with wx
    assert(fs.existsSync(fixture.paths.consumeLedgerFile));
    const savedConsume = JSON.parse(
      fs.readFileSync(fixture.paths.consumeLedgerFile, 'utf8'),
    );
    assert.equal(savedConsume.kind, 'owner-manual-verification-consumed');
    assert.equal(savedConsume.ticketSha256, digest(validArt.ticket));
    assert.equal(savedConsume.randstrSha256, digest(validArt.randstr));
    assert.equal(savedConsume.ticket, undefined, 'Must NOT leak raw ticket');
    assert.equal(savedConsume.randstr, undefined, 'Must NOT leak raw randstr');
    assert.equal(
      savedConsume.randstrPrefix,
      undefined,
      'Must NOT store randstrPrefix',
    );

    // Verify one-use consumption enforcement: replay is strictly stopped!
    const replay = await runVerifiedChaptersProbe({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      approvedOnline: true,
      profile: fixture.syntheticProfile,
      fetchFn: mockFetch,
    });
    assert.equal(replay.status, 'ledger_already_consumed_stop');
    assert.equal(replay.reason, 'CONSUME_LEDGER_ALREADY_EXISTS');
  } finally {
    fixture.cleanup();
  }
});

test('integration: producer callback -> actual artifact -> consumer replay with preserved headers and zero external requests', async () => {
  const fixture = makeTempFixtureDir();
  // Ensure artifact does not exist initially
  if (fs.existsSync(fixture.paths.artifactFile)) {
    fs.unlinkSync(fixture.paths.artifactFile);
  }
  // Ensure start ledger does not exist initially (server creates it)
  if (fs.existsSync(fixture.paths.startLedgerFile)) {
    fs.unlinkSync(fixture.paths.startLedgerFile);
  }

  const manualServerPaths = {
    ...fixture.paths,
    attemptMarker: fixture.paths.originalAttemptMarker,
    chaptersEvidence: fixture.paths.originalChaptersEvidence,
    chaptersSummary: fixture.paths.originalChaptersSummary,
    chaptersRaw: fixture.paths.originalChaptersRaw,
  };

  const server = createVerificationServer({
    port: 0,
    customPaths: manualServerPaths,
    rootDir: fixture.dir,
    env: CLEAN_ENV,
  });

  const { base, close } = await server.start();
  const nonce = server.getNonce();

  try {
    // 1. Producer receives mock Tencent captcha callback
    const testTicket = 'synth-producer-to-consumer-ticket-999';
    const testRandstr = '@synth-producer-randstr-888';

    const callbackRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        nonce,
        ret: 0,
        errorCode: 0,
        ticket: testTicket,
        randstr: testRandstr,
      }),
    });
    assert.equal(callbackRes.status, 200);
    const cbJson = await callbackRes.json();
    assert.equal(cbJson.success, true);
    assert.equal(cbJson.state, 'verified');

    // 2. Verify artifact file and startLedger file real contract
    assert(fs.existsSync(fixture.paths.startLedgerFile));
    assert(fs.existsSync(fixture.paths.artifactFile));

    const startLedger = JSON.parse(
      fs.readFileSync(fixture.paths.startLedgerFile, 'utf8'),
    );
    const artifact = JSON.parse(
      fs.readFileSync(fixture.paths.artifactFile, 'utf8'),
    );

    assert.equal(startLedger.kind, 'owner-manual-verification-start');
    assert.equal(startLedger.appId, SOURCE_APP_ID);
    assert.equal(startLedger.sessionName, SESSION_NAME);
    assert.equal(startLedger.targetBookId, TARGET_BOOK_ID);
    assert.equal(startLedger.nonceHash, digest(nonce));
    assert.equal(startLedger.sessionBinding, fixture.expectedBinding);

    assert.equal(artifact.kind, 'owner-manual-verification-artifact');
    assert.equal(artifact.success, true);
    assert.equal(artifact.ret, 0);
    assert.equal(artifact.errorCode, 0);
    assert.equal(artifact.nonceHash, startLedger.nonceHash);
    assert.equal(artifact.sessionBinding, fixture.expectedBinding);
    assert.equal(artifact.ticket, testTicket);
    assert.equal(artifact.randstr, testRandstr);

    // 3. Consumer runs verified probe against real artifact
    let capturedHeaders = null;
    let mockFetchCalled = 0;

    const mockFetch = async (url, opts) => {
      mockFetchCalled++;
      capturedHeaders = opts.headers;
      return new Response(
        JSON.stringify({
          data: [
            {
              reviewId: 'MP_WXS_3895431412_integrated_1',
              createTime: 1727911111,
              mpInfo: { title: 'Integrated Verified Article' },
            },
          ],
          synckey: 54321,
          clearAll: 0,
        }),
        { status: 200 },
      );
    };

    const consumerResult = await runVerifiedChaptersProbe({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      approvedOnline: true,
      profile: fixture.syntheticProfile,
      fetchFn: mockFetch,
    });

    assert.equal(mockFetchCalled, 1);
    assert.equal(consumerResult.status, 'success');
    assert.equal(consumerResult.requests, 1);
    assert.equal(consumerResult.articles.length, 1);
    assert.equal(
      consumerResult.articles[0].reviewId,
      'MP_WXS_3895431412_integrated_1',
    );

    // Verify injected ticket headers and preserved original auth/version headers
    assert.equal(capturedHeaders.wr_ticket, testTicket);
    assert.equal(capturedHeaders.wr_randstr, testRandstr);
    assert.equal(capturedHeaders.vid, '123456789');
    assert.equal(capturedHeaders.accessToken, 'synth-access-token-xyz');
    assert.equal(capturedHeaders['base-version'], '2.1.2');

    // Verify consumption ledger is recorded without leaking ticket
    assert(fs.existsSync(fixture.paths.consumeLedgerFile));
    const consumeLedger = JSON.parse(
      fs.readFileSync(fixture.paths.consumeLedgerFile, 'utf8'),
    );
    assert.equal(consumeLedger.kind, 'owner-manual-verification-consumed');
    assert.equal(consumeLedger.ticketSha256, digest(testTicket));
    assert.equal(consumeLedger.randstrSha256, digest(testRandstr));
    assert.equal(consumeLedger.ticket, undefined);
    assert.equal(consumeLedger.randstr, undefined);

    // Verify subsequent call strictly stopped with zero requests
    const secondCall = await runVerifiedChaptersProbe({
      paths: fixture.paths,
      rootDir: fixture.dir,
      env: CLEAN_ENV,
      approvedOnline: true,
      profile: fixture.syntheticProfile,
      fetchFn: mockFetch,
    });
    assert.equal(secondCall.status, 'ledger_already_consumed_stop');
    assert.equal(secondCall.requests, 0);
    assert.equal(mockFetchCalled, 1, 'No additional network requests');
  } finally {
    await close();
    fixture.cleanup();
  }
});
