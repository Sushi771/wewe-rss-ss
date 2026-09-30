#!/usr/bin/env node
'use strict';

// One reviewed /login request using the privately recovered mobile session.
// Persist the complete bounded response before reporting field existence.
const assert = require('node:assert/strict');
const { randomBytes, randomInt } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { refreshShape } = require('./probe-mobile-refresh-preflight.cjs');
const {
  environmentGate,
  recoveryGate,
} = require('./probe-refreshed-mobile-web-health.cjs');

const RESPONSE_LIMIT = 64 * 1024;
const TIMEOUT_MS = 30_000;
const PRIOR_RECOVERY = 'mobile-refresh-recovery.json';
const MARKER = 'mobile-login-skey-attempt.json';
const RESPONSE_RECORD = 'mobile-login-skey-response.json';

function args(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0]))
    return { mode: argv[0] };
  if (
    argv.length === 5 &&
    argv[0] === '--preflight' &&
    argv[1] === '--db' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--run-dir' &&
    path.isAbsolute(argv[4])
  )
    return { mode: '--preflight', dbPath: argv[2], runDir: argv[4] };
  if (
    argv.length === 6 &&
    argv[0] === '--execute' &&
    argv[1] === '--db' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--run-dir' &&
    path.isAbsolute(argv[4]) &&
    argv[5] === '--approved-online'
  )
    return { mode: '--execute', dbPath: argv[2], runDir: argv[4] };
  throw Error('usage_gate');
}

function contextGate(dbPath, inputRunDir) {
  // Validates production, original backup and rehearsal as read-only/query_only;
  // checks the prior identity-matched refresh record against those snapshots.
  const checked = recoveryGate(dbPath, inputRunDir, 'present');
  const runDir = checked.runDir;
  if (
    fs.existsSync(path.join(runDir, MARKER)) ||
    fs.existsSync(path.join(runDir, RESPONSE_RECORD))
  )
    throw Error('already_attempted');
  const recovery = JSON.parse(
    fs.readFileSync(path.join(runDir, PRIOR_RECOVERY), 'utf8'),
  );
  const proposed = recovery.proposedMobile;
  if (
    proposed?.vid !== checked.mobile.vid ||
    proposed?.accessToken !== checked.mobile.accessToken ||
    proposed?.refreshToken !== checked.mobile.refreshToken ||
    typeof proposed?.deviceId !== 'string' ||
    !proposed.deviceId.trim() ||
    proposed.deviceId !== recovery.originalMobile?.deviceId
  )
    throw Error('recovery_device_gate');
  return { runDir, mobile: proposed };
}

function markAttempt(runDir) {
  const fd = fs.openSync(path.join(runDir, MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        kind: 'mobile-login-skey-field-once',
        endpoint: '/login',
        attemptedAt: new Date().toISOString(),
      }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function requestOnce(shape) {
  const payload = JSON.stringify(shape.body);
  return new Promise((resolve, reject) => {
    const request = https.request(
      shape.url,
      {
        method: shape.method,
        headers: {
          ...shape.headers,
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
        agent: false,
        maxHeaderSize: 16 * 1024,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      (incoming) =>
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: incoming,
        }),
    );
    request.on('error', reject);
    request.end(payload);
  });
}

async function boundedBody(response) {
  let total = 0;
  const parts = [];
  let truncated = false;
  let readError = false;
  try {
    for await (const part of response.body ?? []) {
      const chunk = Buffer.from(part);
      const remaining = RESPONSE_LIMIT - total;
      if (chunk.length > remaining) {
        if (remaining > 0) parts.push(chunk.subarray(0, remaining));
        total = RESPONSE_LIMIT;
        truncated = true;
        response.body?.destroy?.();
        break;
      }
      total += chunk.length;
      parts.push(chunk);
    }
  } catch {
    readError = true;
  }
  return {
    text: Buffer.concat(parts, total).toString('utf8'),
    truncated,
    readError,
  };
}

function code(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value))
    return Number(value);
  return null;
}

function lengthBand(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0) return '0';
  if (value.length <= 8) return '1-8';
  if (value.length <= 32) return '9-32';
  if (value.length <= 128) return '33-128';
  return '>128';
}

function fieldShape(container, key) {
  if (
    !container ||
    typeof container !== 'object' ||
    Array.isArray(container) ||
    !Object.hasOwn(container, key)
  )
    return { exists: false, type: null, lengthBand: null, nonempty: false };
  const value = container[key];
  return {
    exists: true,
    type: value === null ? 'null' : typeof value,
    lengthBand: lengthBand(value),
    nonempty: typeof value === 'string' && !!value.trim(),
  };
}

function identityMatch(body, expectedVid) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const values = [body.vid, body.data?.vid].filter(
    (value) => value !== undefined && value !== null,
  );
  if (!values.length) return null;
  return values.every(
    (value) =>
      (typeof value === 'string' && value.trim() === expectedVid) ||
      (Number.isSafeInteger(value) && String(value) === expectedVid),
  );
}

function summary(body, status, expectedVid) {
  const top = fieldShape(body, 'skey');
  const data = fieldShape(body?.data, 'skey');
  const codes = [
    body?.errCode,
    body?.errcode,
    body?.data?.errCode,
    body?.data?.errcode,
  ]
    .map(code)
    .filter((value) => value !== null);
  const businessCode = codes.find((value) => value !== 0) ?? codes[0] ?? null;
  const vidMatched = identityMatch(body, expectedVid);
  const skeyConflict =
    top.nonempty && data.nonempty && body.skey !== body.data.skey;
  let decision = 'stop_unexpected_shape';
  if (status === 429 || businessCode === -2014) decision = 'stop_rate_limit';
  else if (businessCode === -2041 || businessCode === -2063)
    decision = 'stop_verification';
  else if (status >= 300 && status < 400) decision = 'stop_redirect';
  else if (status !== 200) decision = 'stop_http';
  else if (businessCode !== null && businessCode !== 0)
    decision = 'stop_business_code';
  else if (body?.success === false || body?.succeed === false)
    decision = 'stop_business_flag';
  else if (vidMatched === false) decision = 'quarantine_identity_mismatch';
  else if (skeyConflict) decision = 'quarantine_skey_conflict';
  else if (top.nonempty || data.nonempty)
    decision =
      vidMatched === true
        ? 'skey_candidate_identity_matched'
        : 'skey_candidate_identity_unproven';
  else decision = 'no_skey_field';
  return {
    decision,
    http: status,
    businessCode,
    skeyTop: top,
    skeyData: data,
    vidMatched,
    networkRequests: 1,
    productionWrites: 0,
  };
}

function writePrivate(runDir, record) {
  const serialized = JSON.stringify(record) + '\n';
  const finalPath = path.join(runDir, RESPONSE_RECORD);
  if (fs.existsSync(finalPath)) {
    if (fs.readFileSync(finalPath, 'utf8') === serialized) return finalPath;
    throw Error('recovery_conflict');
  }
  const tempPath = path.join(
    runDir,
    `.mobile-login-skey-${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.linkSync(tempPath, finalPath);
  if (fs.readFileSync(finalPath, 'utf8') !== serialized)
    throw Error('recovery_verify_gate');
  fs.unlinkSync(tempPath);
  return finalPath;
}

async function persistUntilDurable(runDir, record, options = {}) {
  const writer = options.writer ?? writePrivate;
  const wait =
    options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const notify = options.notify ?? (() => {});
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      writer(runDir, record);
      return attempts;
    } catch {
      if (attempts === 1 || attempts % 12 === 0) {
        try {
          notify({
            decision: 'local_persistence_retry_required',
            localAttempts: attempts,
            networkRequests: 1,
          });
        } catch {
          /* Preserve the only in-memory response. */
        }
      }
      // A received refresh token may have rotated. Never leave or issue another
      // network request until a verified private copy has been saved.
      await wait(5_000);
    }
  }
}

async function runOnce(dbPath, runDir, options = {}) {
  const context = (options.contextGate ?? contextGate)(dbPath, runDir);
  markAttempt(context.runDir);
  const shape = refreshShape(context.mobile, Date.now(), randomInt(1, 1001));
  let response;
  try {
    response = await (options.transport ?? requestOnce)(shape);
  } catch {
    return {
      decision: 'stop_transport',
      http: null,
      networkRequests: 1,
      productionWrites: 0,
    };
  }
  const received = await boundedBody(response);
  const rawBody = received.text;
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = null;
  }
  const result = summary(body, response.status, context.mobile.vid);
  if (received.truncated || received.readError)
    result.decision = 'stop_response_limit_or_transport';
  const record = {
    formatVersion: 1,
    kind: 'mobile-login-skey-field-response',
    capturedAt: new Date().toISOString(),
    priorMobile: context.mobile,
    httpStatus: response.status,
    responseHeaders: response.headers,
    responseBody: rawBody,
    bodyTruncated: received.truncated,
    bodyReadError: received.readError,
    decision: result.decision,
  };
  const attempts = await persistUntilDurable(
    context.runDir,
    record,
    options.persistence,
  );
  return {
    ...result,
    privateResponseSaved: true,
    localPersistenceAttempts: attempts,
  };
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(
    () => environmentGate({ NODE_DEBUG: 'http' }),
    /environment_gate/,
  );
  assert.throws(
    () => environmentGate({ HTTPS_PROXY: 'proxy' }),
    /environment_gate/,
  );
  const secret = 'fixture-do-not-log-rotated-token';
  const body = {
    vid: '123',
    accessToken: secret,
    refreshToken: 'new-rt',
    data: { skey: 'new-skey' },
  };
  assert.equal(
    summary(body, 200, '123').decision,
    'skey_candidate_identity_matched',
  );
  assert.equal(
    summary({ vid: '999', data: { skey: 's' } }, 200, '123').decision,
    'quarantine_identity_mismatch',
  );
  assert.equal(
    summary({ vid: '123', data: { skey: 's' } }, 200, '123').skeyData
      .lengthBand,
    '1-8',
  );
  assert.equal(
    summary({ vid: '123', skey: 's' }, 200, '123').skeyTop.exists,
    true,
  );
  assert.equal(summary({ data: { skey: 's' } }, 200, '123').vidMatched, null);
  assert.equal(
    summary({ data: { skey: 's' } }, 429, '123').decision,
    'stop_rate_limit',
  );
  assert.equal(
    summary({ data: { errCode: -2041, skey: 's' } }, 200, '123').decision,
    'stop_verification',
  );
  assert.equal(
    summary({ vid: '123', skey: 'a', data: { skey: 'b' } }, 200, '123')
      .decision,
    'quarantine_skey_conflict',
  );
  const bounded = await boundedBody({
    headers: {},
    body: Readable.from([Buffer.alloc(RESPONSE_LIMIT + 1, 65)]),
  });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.text.length, RESPONSE_LIMIT);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mobile-skey-field-test-'),
  );
  let transportCalls = 0;
  let localCalls = 0;
  const notices = [];
  try {
    const result = await runOnce('', root, {
      contextGate: () => ({
        runDir: root,
        mobile: {
          vid: '123',
          deviceId: 'device',
          refreshToken: 'old-rt',
          accessToken: 'old',
        },
      }),
      transport: async (shape) => {
        transportCalls++;
        assert.equal(shape.url, 'https://i.weread.qq.com/login');
        return {
          status: 200,
          headers: {},
          body: Readable.from([JSON.stringify(body)]),
        };
      },
      persistence: {
        writer: (dir, record) => {
          localCalls++;
          if (localCalls === 1) throw Error('disk temporarily unavailable');
          return writePrivate(dir, record);
        },
        wait: async () => {},
        notify: (notice) => notices.push(notice),
      },
    });
    assert.equal(transportCalls, 1);
    assert.equal(localCalls, 2);
    assert.equal(notices[0].decision, 'local_persistence_retry_required');
    assert.equal(result.privateResponseSaved, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const record = JSON.parse(
      fs.readFileSync(path.join(root, RESPONSE_RECORD), 'utf8'),
    );
    assert.equal(JSON.parse(record.responseBody).accessToken, secret);
    assert.equal(JSON.parse(record.responseBody).refreshToken, 'new-rt');
    assert.equal(fs.existsSync(path.join(root, MARKER)), true);
    assert.throws(
      () => writePrivate(root, { other: secret }),
      /recovery_conflict/,
    );
    assert.throws(() => markAttempt(root), /EEXIST/);
    const errorDir = path.join(root, 'error-case');
    fs.mkdirSync(errorDir);
    const errorResult = await runOnce('', errorDir, {
      contextGate: () => ({
        runDir: errorDir,
        mobile: {
          vid: '123',
          deviceId: 'device',
          refreshToken: 'old-rt',
          accessToken: 'old',
        },
      }),
      transport: async () => {
        transportCalls++;
        return {
          status: 401,
          headers: {},
          body: Readable.from([
            JSON.stringify({ refreshToken: 'rotated-despite-error' }),
          ]),
        };
      },
    });
    assert.equal(errorResult.decision, 'stop_http');
    assert.equal(transportCalls, 2);
    const errorRecord = JSON.parse(
      fs.readFileSync(path.join(errorDir, RESPONSE_RECORD), 'utf8'),
    );
    assert.equal(
      JSON.parse(errorRecord.responseBody).refreshToken,
      'rotated-despite-error',
    );
  } finally {
    const resolved = fs.realpathSync(root);
    if (
      path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith('mobile-skey-field-test-')
    )
      throw Error('self_test_cleanup_gate');
    for (const name of [MARKER, RESPONSE_RECORD]) {
      const item = path.join(resolved, name);
      if (fs.existsSync(item)) fs.unlinkSync(item);
    }
    const errorDir = path.join(resolved, 'error-case');
    if (fs.existsSync(errorDir)) {
      for (const name of [MARKER, RESPONSE_RECORD]) {
        const item = path.join(errorDir, name);
        if (fs.existsSync(item)) fs.unlinkSync(item);
      }
      fs.rmdirSync(errorDir);
    }
    fs.rmdirSync(resolved);
  }
  return {
    decision: 'self_test_passed',
    fakeNetworkRequests: transportCalls,
    productionWrites: 0,
  };
}

async function main() {
  let options;
  try {
    options = args(process.argv.slice(2));
  } catch {
    console.log(JSON.stringify({ decision: 'usage_gate', networkRequests: 0 }));
    process.exitCode = 1;
    return;
  }
  if (options.mode === '--plan') {
    console.log(
      JSON.stringify({
        decision: 'plan_only',
        endpoint: '/login',
        maxRequests: 1,
        responseLimit: RESPONSE_LIMIT,
        productionWrites: 0,
        approvedOnlineFlagRequired: true,
      }),
    );
    return;
  }
  if (options.mode === '--self-test') {
    console.log(JSON.stringify(await selfTest()));
    return;
  }
  try {
    environmentGate(process.env);
    contextGate(options.dbPath, options.runDir);
  } catch (error) {
    const safe = new Set([
      'already_attempted',
      'run_dir_gate',
      'refresh_marker_gate',
      'health_marker_gate',
      'recovery_gate',
      'source_backup_gate',
      'recovery_identity_gate',
      'recovery_device_gate',
      'db_gate',
      'private_root_gate',
      'account_gate',
      'mobile_gate',
      'integrity_gate',
      'sqlite_runtime_gate',
      'environment_gate',
    ]);
    console.log(
      JSON.stringify({
        decision: safe.has(error.message) ? error.message : 'preflight_gate',
        networkRequests: 0,
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (options.mode === '--preflight') {
    console.log(
      JSON.stringify({
        decision: 'preflight_ready',
        networkRequests: 0,
        productionWrites: 0,
      }),
    );
    return;
  }
  const result = await runOnce(options.dbPath, options.runDir, {
    persistence: { notify: (notice) => console.log(JSON.stringify(notice)) },
  });
  console.log(JSON.stringify(result));
  if (result.decision !== 'skey_candidate_identity_matched')
    process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  args,
  contextGate,
  summary,
  fieldShape,
  identityMatch,
  runOnce,
  selfTest,
};
