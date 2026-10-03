'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  SOURCE_APP_ID,
  TARGET_BOOK_ID,
  SESSION_NAME,
  CANONICAL_SDK_URL,
  OFFICIAL_READER_SCOPE,
  assertSafePath,
  validatePreflight,
  sanitizeErrorReason,
  renderHtml,
  createVerificationServer,
  parseCliArgs,
} = require('./serve-owner-manual-verify.cjs');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-verify-test-'));
  const sessionDir = path.join(dir, 'session');
  const scopeDir = path.join(sessionDir, 'mp-scope');
  const chaptersDir = path.join(sessionDir, 'mp-chapters');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

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

  // 5. Attempt marker
  const attemptMarker = path.join(dir, 'attempt-marker.json');
  const markerData = {
    kind: 'official-eink-mp-chapters-once',
    phase: 'chapters',
    endpoint: 'https://i.weread.qq.com/mp/chapters',
    url: `https://i.weread.qq.com/mp/chapters?bookId=${TARGET_BOOK_ID}&count=5`,
    params: { bookId: TARGET_BOOK_ID, count: 5 },
    attemptedAt: '2026-10-03T10:05:00.000Z',
    sessionBinding: expectedBinding,
  };
  fs.writeFileSync(attemptMarker, JSON.stringify(markerData));

  // 6. Chapters evidence (HTTP 499 / -2041)
  const chaptersRaw = path.join(chaptersDir, 'raw-response.bin');
  const chaptersRawData = Buffer.from(
    '{"errcode":-2041,"errlog":"test","errmsg":"-2041"}',
  );
  fs.writeFileSync(chaptersRaw, chaptersRawData);

  const chaptersEvidence = path.join(chaptersDir, 'evidence.json');
  fs.writeFileSync(
    chaptersEvidence,
    JSON.stringify({
      phase: 'chapters',
      httpStatus: 499,
      requests: 1,
      responseBodyComplete: true,
      sessionBinding: expectedBinding,
      responseSha256: digest(chaptersRawData),
    }),
  );

  const chaptersSummary = path.join(chaptersDir, 'summary.json');
  fs.writeFileSync(
    chaptersSummary,
    JSON.stringify({
      phase: 'chapters',
      status: 'upstream_stop',
      reason: 'HTTP_499',
      httpStatus: 499,
      requests: 1,
    }),
  );

  const startLedgerFile = path.join(sessionDir, 'manual-verify-start.json');
  const artifactFile = path.join(
    sessionDir,
    'manual-verification-artifact.json',
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
    attemptMarker,
    chaptersEvidence,
    chaptersSummary,
    chaptersRaw,
    startLedgerFile,
    artifactFile,
  };

  return {
    dir,
    sessionDir,
    paths,
    rootDir: dir,
    cleanup: () => safeCleanup(dir),
  };
}

const CLEAN_ENV = {};

test('parseCliArgs strictly enforces actions, duplicate detection, and port validation', () => {
  assert.deepEqual(parseCliArgs(['--plan']), {
    plan: true,
    preflight: false,
    serve: false,
    port: 4355,
  });

  assert.deepEqual(parseCliArgs(['--preflight']), {
    plan: false,
    preflight: true,
    serve: false,
    port: 4355,
  });

  assert.deepEqual(parseCliArgs(['--serve', '--port', '8080']), {
    plan: false,
    preflight: false,
    serve: true,
    port: 8080,
  });

  assert.throws(
    () => parseCliArgs(['--plan', '--preflight']),
    /must_specify_exactly_one_action/,
  );
  assert.throws(() => parseCliArgs([]), /must_specify_exactly_one_action/);
  assert.throws(() => parseCliArgs(['--plan', '--plan']), /duplicate_flag/);
  assert.throws(() => parseCliArgs(['--invalid']), /unknown_flag/);
  assert.throws(() => parseCliArgs(['--serve', '--port', '0']), /invalid_port/);
  assert.throws(
    () => parseCliArgs(['--serve', '--port', 'notaport']),
    /invalid_port/,
  );
});

test('assertSafePath allows valid roots and blocks path traversal', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-test-'));
  try {
    const subFile = path.join(tmpDir, 'sub/file.json');
    assert.equal(assertSafePath(subFile, tmpDir), path.resolve(subFile));
    assert.throws(
      () => assertSafePath('C:/other/root/file.json', tmpDir),
      /escapes boundary/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('renderHtml serves zero external requests on initial load and presents minimal UI', () => {
  const nonce = 'test-nonce-12345';
  const html = renderHtml(nonce, 'http://127.0.0.1:4355');

  // Verify NO external <script src=...> in the initial HTML markup
  const scriptSrcMatches = html.match(/<script[^>]+src=['"][^'"]+['"]/gi);
  assert.equal(
    scriptSrcMatches,
    null,
    'Initial HTML must contain ZERO external script tags',
  );

  // Verify NO external img tags
  const imgMatches = html.match(/<img/gi);
  assert.equal(imgMatches, null, 'Initial HTML must contain ZERO img tags');

  // Verify minimal UI without internal implementation details in visible body
  assert(html.includes('开始安全验证'), 'Must have user-facing start button');
  const visibleBody = html.substring(
    html.indexOf('<body>'),
    html.indexOf('<script'),
  );
  assert(
    !visibleBody.includes('2044038556'),
    'Visible body markup must NOT show internal AppID details',
  );
  assert(
    !visibleBody.includes('0o600'),
    'Visible body markup must NOT show internal file mode details',
  );
  assert(
    html.includes(`nonce="${nonce}"`),
    'Script tag must have strict nonce',
  );
  assert(
    html.includes(CANONICAL_SDK_URL),
    'Dynamic injection target must be canonical TCaptcha.js',
  );
});

test('validatePreflight succeeds on synthetic fixture with full proof chain', () => {
  const fixture = makeTempFixtureDir();
  try {
    const res = validatePreflight(fixture.paths, {
      env: CLEAN_ENV,
      rootDir: fixture.rootDir,
    });
    assert.equal(res.status, 'preflight_ok');
    assert.equal(res.appId, SOURCE_APP_ID);
    assert.equal(res.targetBookId, TARGET_BOOK_ID);
    assert.equal(res.sessionName, SESSION_NAME);
    assert.equal(res.attemptMarkerBound, true);
    assert.equal(res.compatibility, 'UNVERIFIED');
    assert.equal(res.upstreamRequests, 0);
    assert.equal(res.productionWrites, 0);
    assert.equal(res.chaptersErrCode, -2041);
  } finally {
    fixture.cleanup();
  }
});

test('validatePreflight rejects when start ledger or artifact already exists', () => {
  const fixture = makeTempFixtureDir();
  try {
    fs.writeFileSync(fixture.paths.startLedgerFile, '{}');
    assert.throws(
      () =>
        validatePreflight(fixture.paths, {
          env: CLEAN_ENV,
          rootDir: fixture.rootDir,
        }),
      /start_ledger_already_exists/,
    );

    fs.unlinkSync(fixture.paths.startLedgerFile);
    fs.writeFileSync(fixture.paths.artifactFile, '{}');
    assert.throws(
      () =>
        validatePreflight(fixture.paths, {
          env: CLEAN_ENV,
          rootDir: fixture.rootDir,
        }),
      /artifact_already_exists/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('validatePreflight rejects when chapters evidence or hash is missing/corrupted', () => {
  const fixture = makeTempFixtureDir();
  try {
    fs.writeFileSync(fixture.paths.chaptersRaw, Buffer.from('tampered-bytes'));
    assert.throws(
      () =>
        validatePreflight(fixture.paths, {
          env: CLEAN_ENV,
          rootDir: fixture.rootDir,
        }),
      /chapters_hash_mismatch/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('validatePreflight rejects when chapters raw errcode is not -2041 or raw is invalid JSON', () => {
  const fixture = makeTempFixtureDir();
  try {
    // Non-2041 errcode
    const non2041Raw = Buffer.from('{"errcode":0,"data":[]}');
    fs.writeFileSync(fixture.paths.chaptersRaw, non2041Raw);
    const evidenceData = JSON.parse(
      fs.readFileSync(fixture.paths.chaptersEvidence, 'utf8'),
    );
    evidenceData.responseSha256 = digest(non2041Raw);
    fs.writeFileSync(
      fixture.paths.chaptersEvidence,
      JSON.stringify(evidenceData),
    );

    assert.throws(
      () =>
        validatePreflight(fixture.paths, {
          env: CLEAN_ENV,
          rootDir: fixture.rootDir,
        }),
      /chapters_errcode_not_2041/,
    );

    // Invalid JSON
    const invalidJsonRaw = Buffer.from('not-json-content');
    fs.writeFileSync(fixture.paths.chaptersRaw, invalidJsonRaw);
    evidenceData.responseSha256 = digest(invalidJsonRaw);
    fs.writeFileSync(
      fixture.paths.chaptersEvidence,
      JSON.stringify(evidenceData),
    );

    assert.throws(
      () =>
        validatePreflight(fixture.paths, {
          env: CLEAN_ENV,
          rootDir: fixture.rootDir,
        }),
      /chapters_raw_invalid_json/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('validatePreflight rejects when loginResult indicates failure or not verified', () => {
  const fixture = makeTempFixtureDir();
  try {
    fs.writeFileSync(
      fixture.paths.loginResult,
      JSON.stringify({
        formatVersion: 1,
        source: 'owner-confirmed-eink-sdk-login',
        success: false,
        productionUnchanged: true,
      }),
    );
    assert.throws(
      () =>
        validatePreflight(fixture.paths, {
          env: CLEAN_ENV,
          rootDir: fixture.rootDir,
        }),
      /Login source result indicates failure or is missing/,
    );

    fs.writeFileSync(
      fixture.paths.loginResult,
      JSON.stringify({
        formatVersion: 1,
        source: 'owner-confirmed-eink-sdk-login',
        success: true,
        productionUnchanged: false,
      }),
    );
    assert.throws(
      () =>
        validatePreflight(fixture.paths, {
          env: CLEAN_ENV,
          rootDir: fixture.rootDir,
        }),
      /login_source_not_verified/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('createVerificationServer enforces CSP, Origin, Host, and rejects non-JSON or invalid tokens', async () => {
  const fixture = makeTempFixtureDir();
  const server = createVerificationServer({
    port: 0,
    customPaths: fixture.paths,
    rootDir: fixture.rootDir,
    env: CLEAN_ENV,
  });

  const { base, close } = await server.start();
  try {
    // 1. Verify start ledger was written with wx mode
    assert(fs.existsSync(fixture.paths.startLedgerFile));

    // 2. Check CSP header on GET /
    const rootRes = await fetch(base);
    assert.equal(rootRes.status, 200);
    const csp = rootRes.headers.get('content-security-policy');
    assert(csp.includes('https://ssl.captcha.qq.com'));
    assert(csp.includes('https://turing.captcha.qcloud.com'));
    assert(csp.includes('https://captcha.gtimg.com'));

    // 3. /status does NOT expose nonce
    const statusRes = await fetch(`${base}/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.state, 'idle');
    assert.equal(statusJson.compatibility, 'UNVERIFIED');
    assert.equal(statusJson.nonce, undefined);

    // 4. Reject Origin mismatch
    const badOriginRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.attacker.com',
      },
      body: JSON.stringify({ nonce: 'any' }),
    });
    assert.equal(badOriginRes.status, 403);
    const badOriginJson = await badOriginRes.json();
    assert.equal(badOriginJson.reason, 'ORIGIN_MISMATCH');

    // 5. Reject Host mismatch via http.request
    const badHostStatus = await new Promise((resolve) => {
      const req = http.request(
        `${base}/status`,
        { headers: { Host: 'evil.attacker.com' } },
        (res) => resolve(res.statusCode),
      );
      req.end();
    });
    assert.equal(badHostStatus, 403);

    // 6. Reject non-JSON content-type
    const badCtRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: base,
      },
      body: 'plain-text',
    });
    assert.equal(badCtRes.status, 415);

    // 7. Reject null or array JSON payload
    const nullPayloadRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: 'null',
    });
    assert.equal(nullPayloadRes.status, 400);
    const nullPayloadJson = await nullPayloadRes.json();
    assert.equal(nullPayloadJson.reason, 'INVALID_JSON_OBJECT');

    const arrayPayloadRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: '[]',
    });
    assert.equal(arrayPayloadRes.status, 400);
    const arrayPayloadJson = await arrayPayloadRes.json();
    assert.equal(arrayPayloadJson.reason, 'INVALID_JSON_OBJECT');

    // 8. Reject invalid ret type (not an integer)
    const nonce = server.getNonce();
    const badRetRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ nonce, ret: 'not_an_int' }),
    });
    assert.equal(badRetRes.status, 400);
    const badRetJson = await badRetRes.json();
    assert.equal(badRetJson.reason, 'RET_TYPE_INVALID');

    // 9. Reject invalid errorCode type (must NOT parseInt || 0 into success)
    const badErrRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ nonce, ret: 0, errorCode: 'corrupt_string' }),
    });
    assert.equal(badErrRes.status, 400);
    const badErrJson = await badErrRes.json();
    assert.equal(badErrJson.reason, 'ERROR_CODE_TYPE_INVALID');
  } finally {
    await close();
    fixture.cleanup();
  }
});

test('createVerificationServer successfully records artifact, rejects CR/LF, and enforces one-use ledger', async () => {
  const fixture = makeTempFixtureDir();
  let artifactReceived = null;

  const server = createVerificationServer({
    port: 0,
    customPaths: fixture.paths,
    rootDir: fixture.rootDir,
    env: CLEAN_ENV,
    onArtifactWritten: (art) => {
      artifactReceived = art;
    },
  });

  const { base, close } = await server.start();
  const nonce = server.getNonce();

  try {
    // 1. Reject CRLF injection in ticket
    const crlfRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        nonce,
        ret: 0,
        ticket: 'bad\r\nticket',
        randstr: '@valid',
      }),
    });
    assert.equal(crlfRes.status, 400);
    const crlfJson = await crlfRes.json();
    assert.equal(crlfJson.reason, 'TICKET_INVALID');

    // 2. Submit valid verification callback
    const cbRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        nonce,
        ret: 0,
        ticket: 'synthetic-test-ticket-abc',
        randstr: '@synthetic-randstr-xyz',
      }),
    });
    assert.equal(cbRes.status, 200);
    const cbJson = await cbRes.json();
    assert.equal(cbJson.success, true);
    assert.equal(cbJson.state, 'verified');

    // 3. Verify artifact was written with wx mode
    assert(fs.existsSync(fixture.paths.artifactFile));
    const saved = JSON.parse(
      fs.readFileSync(fixture.paths.artifactFile, 'utf8'),
    );
    assert.equal(saved.kind, 'owner-manual-verification-artifact');
    assert.equal(saved.sessionName, SESSION_NAME);
    assert.equal(saved.targetBookId, TARGET_BOOK_ID);
    assert.equal(saved.appId, SOURCE_APP_ID);
    assert.equal(saved.ticket, 'synthetic-test-ticket-abc');
    assert.equal(saved.randstr, '@synthetic-randstr-xyz');
    assert.equal(saved.compatibility, 'UNVERIFIED_PENDING_UPSTREAM_ACCEPTANCE');
    assert.equal(saved.consumed, false);

    // 4. Verify one-use ledger: replay is rejected with 409
    const replayRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        nonce,
        ret: 0,
        ticket: 'replay-ticket',
        randstr: '@replay',
      }),
    });
    assert.equal(replayRes.status, 409);
    const replayJson = await replayRes.json();
    assert.equal(replayJson.reason, 'LEDGER_ALREADY_CONSUMED');

    const state = server.getState();
    assert.equal(state.state, 'verified');
    assert.equal(state.hasArtifact, true);
  } finally {
    await close();
    fixture.cleanup();
  }
});

test('createVerificationServer records refusal/cancellation and stops immediately without retrying', async () => {
  const fixture = makeTempFixtureDir();
  let artifactReceived = null;

  const server = createVerificationServer({
    port: 0,
    customPaths: fixture.paths,
    rootDir: fixture.rootDir,
    env: CLEAN_ENV,
    onArtifactWritten: (art) => {
      artifactReceived = art;
    },
  });

  const { base, close } = await server.start();
  const nonce = server.getNonce();

  try {
    // User cancelled (ret = 2)
    const cancelRes = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        nonce,
        ret: 2,
        message: 'USER_CANCELLED',
      }),
    });

    assert.equal(cancelRes.status, 200);
    const cancelJson = await cancelRes.json();
    assert.equal(cancelJson.success, false);
    assert.equal(cancelJson.state, 'stopped');

    assert(fs.existsSync(fixture.paths.artifactFile));
    const saved = JSON.parse(
      fs.readFileSync(fixture.paths.artifactFile, 'utf8'),
    );
    assert.equal(saved.success, false);
    assert.equal(saved.refusalReason, 'USER_CANCELLED');
    assert.equal(saved.consumed, true);

    const state = server.getState();
    assert.equal(state.state, 'stopped');
  } finally {
    await close();
    fixture.cleanup();
  }
});

test('createVerificationServer regression: strictly rejects ret0 with trerror_ fallback ticket or errorCode=1006, never fetches upstream', async () => {
  const fixture = makeTempFixtureDir();
  let artifactReceived = null;

  const server = createVerificationServer({
    port: 0,
    customPaths: fixture.paths,
    rootDir: fixture.rootDir,
    env: CLEAN_ENV,
    onArtifactWritten: (art) => {
      artifactReceived = art;
    },
  });

  const { base, close } = await server.start();
  const nonce = server.getNonce();

  try {
    // Send callback with ret: 0 but disaster ticket trerror_1006_... and errorCode: 1006
    const res = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        nonce,
        ret: 0,
        errorCode: 1006,
        ticket: 'trerror_1006_domain_not_match',
        randstr: '@fallback_rand',
        appid: SOURCE_APP_ID,
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.state, 'stopped');
    assert.equal(json.reason, 'FALLBACK_TICKET_REJECTED_1006');

    // Verify artifact saved with failure metadata only and NO accepted ticket
    assert(fs.existsSync(fixture.paths.artifactFile));
    const saved = JSON.parse(
      fs.readFileSync(fixture.paths.artifactFile, 'utf8'),
    );
    assert.equal(saved.kind, 'owner-manual-verification-artifact');
    assert.equal(saved.success, false);
    assert.equal(saved.refusalReason, 'FALLBACK_TICKET_REJECTED_1006');
    assert.equal(saved.errorCode, 1006);
    assert.equal(saved.ticketPrefix, 'trerror_');
    assert.equal(saved.ticket, undefined, 'Must NOT store accepted ticket');
    assert.equal(saved.randstr, undefined, 'Must NOT store accepted randstr');
    assert.equal(saved.consumed, true);

    // Verify server state stopped and zero upstream requests
    const state = server.getState();
    assert.equal(state.state, 'stopped');
    assert.equal(state.upstreamRequests, 0);

    // Verify one-use ledger: further callback attempts rejected as consumed
    const secondCall = await fetch(`${base}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        nonce,
        ret: 0,
        ticket: 'some-ticket',
        randstr: '@rand',
      }),
    });
    assert.equal(secondCall.status, 409);
    const secondJson = await secondCall.json();
    assert.equal(secondJson.reason, 'LEDGER_ALREADY_CONSUMED');
  } finally {
    await close();
    fixture.cleanup();
  }
});
