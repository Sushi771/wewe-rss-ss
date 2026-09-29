#!/usr/bin/env node
'use strict';

// One explicitly approved mobile /login refresh. It never writes production SQLite.
// A server response carrying token fields is persisted privately before any result.
const assert = require('node:assert/strict');
const { randomBytes, randomInt } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  within, safePrivateRoot, oneAccount, integrity, sqliteApi,
  refreshShape, classifyRefreshResponse, preflight,
} = require('./probe-mobile-refresh-preflight.cjs');

const RESPONSE_LIMIT = 64 * 1024;
const TIMEOUT_MS = 30_000;
const MARKER_NAME = 'mobile-refresh-attempt.json';
const RECOVERY_NAME = 'mobile-refresh-recovery.json';

function args(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0]))
    return { mode: argv[0] };
  if (argv.length === 6 && argv[0] === '--execute' && argv[1] === '--db' &&
      path.isAbsolute(argv[2]) && argv[3] === '--run-dir' &&
      path.isAbsolute(argv[4]) && argv[5] === '--approved-online')
    return { mode: '--execute', dbPath: argv[2], runDir: argv[4] };
  throw Error('usage_gate');
}

function environmentGate(env) {
  const blocked = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy',
    'all_proxy', 'DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PWDEBUG',
    'UNDICI_DEBUG', 'DEBUG_HTTP', 'DEBUG_FETCH', 'NODE_OPTIONS', 'SSLKEYLOGFILE',
    'NODE_TLS_REJECT_UNAUTHORIZED',
  ];
  if (blocked.some((key) => typeof env[key] === 'string' && env[key].trim()))
    throw Error('environment_gate');
  if (env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== '0')
    throw Error('environment_gate');
}

function preflightGate(dbPath, inputRunDir) {
  const runDir = fs.realpathSync(inputRunDir);
  if (!fs.statSync(runDir).isDirectory() ||
      !path.basename(runDir).startsWith('mobile-refresh-'))
    throw Error('run_dir_gate');
  safePrivateRoot(path.dirname(runDir));
  if (fs.existsSync(path.join(runDir, MARKER_NAME)) ||
      fs.existsSync(path.join(runDir, RECOVERY_NAME)))
    throw Error('already_attempted');
  const sourcePath = fs.realpathSync(dbPath);
  if (!fs.statSync(sourcePath).isFile() || within(runDir, sourcePath))
    throw Error('db_gate');
  const { DatabaseSync } = sqliteApi();
  const handles = [];
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    handles.push(source);
    const original = new DatabaseSync(path.join(runDir, 'original.sqlite'),
      { readOnly: true });
    handles.push(original);
    const rehearsal = new DatabaseSync(path.join(runDir, 'rehearsal.sqlite'),
      { readOnly: true });
    handles.push(rehearsal);
    for (const db of [source, original, rehearsal])
      db.exec('PRAGMA query_only=ON');
    const current = oneAccount(source);
    const saved = oneAccount(original);
    const simulated = oneAccount(rehearsal);
    const sourceCounts = integrity(source);
    const backupCounts = integrity(original);
    const rehearsalCounts = integrity(rehearsal);
    const expectedRehearsal = structuredClone(saved.token);
    expectedRehearsal.mobile = { ...saved.mobile,
      accessToken: 'offline-fixture-rotated-access',
      refreshToken: 'offline-fixture-rotated-refresh' };
    if (current.row.id !== saved.row.id ||
        current.row.token !== saved.row.token ||
        simulated.row.id !== saved.row.id ||
        JSON.stringify(simulated.token) !== JSON.stringify(expectedRehearsal) ||
        sourceCounts.feeds !== backupCounts.feeds ||
        sourceCounts.articles !== backupCounts.articles ||
        backupCounts.feeds !== rehearsalCounts.feeds ||
        backupCounts.articles !== rehearsalCounts.articles)
      throw Error('preflight_snapshot_gate');
    return { accountId: current.row.id, mobile: current.mobile, runDir };
  } finally {
    for (const db of handles.reverse()) db.close();
  }
}

function markAttempt(runDir) {
  const marker = path.join(runDir, MARKER_NAME);
  const fd = fs.openSync(marker, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ kind: 'mobile-refresh-once',
      endpoint: '/login', attemptedAt: new Date().toISOString() }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function requestOnce(shape) {
  const payload = JSON.stringify(shape.body);
  return new Promise((resolve, reject) => {
    const request = https.request(shape.url, {
      method: shape.method,
      headers: { ...shape.headers,
        'Content-Length': Buffer.byteLength(payload, 'utf8') },
      agent: false,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, (incoming) => resolve({ status: incoming.statusCode ?? 0,
      headers: incoming.headers, body: incoming }));
    request.on('error', reject);
    request.end(payload);
  });
}

async function boundedBody(response) {
  const contentLength = Number(response.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_LIMIT) {
    response.body?.destroy?.();
    throw Error('response_limit');
  }
  let total = 0;
  const parts = [];
  for await (const part of response.body ?? []) {
    const chunk = Buffer.from(part);
    total += chunk.length;
    if (total > RESPONSE_LIMIT) {
      response.body?.destroy?.();
      throw Error('response_limit');
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts, total).toString('utf8');
}

function numericCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value)) return Number(value);
  return null;
}

function tokenFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = {};
  for (const key of ['accessToken', 'refreshToken']) {
    if (typeof body[key] === 'string' && body[key].trim())
      fields[key] = body[key];
  }
  if (!Object.keys(fields).length) return null;
  if (typeof body.vid === 'string' && body.vid.trim()) fields.vid = body.vid;
  else if (Number.isSafeInteger(body.vid) && body.vid > 0)
    fields.vid = body.vid;
  return fields;
}

function privateRecord(context, status, body, fields, assessment) {
  return {
    formatVersion: 2,
    kind: 'mobile-refresh-response-tokens',
    capturedAt: new Date().toISOString(),
    accountId: context.accountId,
    httpStatus: status,
    businessCode: numericCode(body?.errCode),
    decision: assessment.decision,
    originalMobile: context.mobile,
    responseTokenFields: fields,
    proposedMobile: assessment.candidate,
  };
}

function writeRecovery(runDir, record) {
  const serialized = JSON.stringify(record) + '\n';
  const finalPath = path.join(runDir, RECOVERY_NAME);
  if (fs.existsSync(finalPath)) {
    if (fs.readFileSync(finalPath, 'utf8') === serialized) return finalPath;
    throw Error('recovery_conflict');
  }
  const tempPath = path.join(runDir,
    `.mobile-refresh-${randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  // Same-directory hard link publishes exclusively and atomically. If it fails,
  // the fsynced temporary copy remains; the caller retains the in-memory record.
  fs.linkSync(tempPath, finalPath);
  if (fs.readFileSync(finalPath, 'utf8') !== serialized)
    throw Error('recovery_verify_gate');
  fs.unlinkSync(tempPath);
  return finalPath;
}

async function persistUntilDurable(runDir, record, options = {}) {
  const writer = options.writer ?? writeRecovery;
  const wait = options.wait ?? ((ms) => new Promise((resolve) =>
    setTimeout(resolve, ms)));
  const notify = options.notify ?? (() => {});
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      writer(runDir, record);
      return attempts;
    } catch {
      if (attempts === 1 || attempts % 12 === 0) {
        try { notify({ decision: 'local_persistence_retry_required',
          localAttempts: attempts, networkRequests: 1 }); } catch { /* Keep token. */ }
      }
      // No further network calls. Keep the candidate alive until local storage works.
      await wait(5_000);
    }
  }
}

async function runOnce(dbPath, runDir, transport = requestOnce,
  persistenceOptions = {}) {
  const context = preflightGate(dbPath, runDir);
  markAttempt(context.runDir);
  const shape = refreshShape(context.mobile, Date.now(), randomInt(1, 1001));
  let response;
  try { response = await transport(shape); }
  catch { return { decision: 'stop_transport', http: null,
    recoverySaved: false, networkRequests: 1, productionWrites: 0 }; }
  let text;
  try { text = await boundedBody(response); }
  catch { return { decision: 'stop_response_limit_or_transport',
    http: response.status, recoverySaved: false,
    networkRequests: 1, productionWrites: 0 }; }
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const fields = tokenFields(body);
  const assessment = classifyRefreshResponse(context.mobile, response.status, body);
  if (fields) {
    const record = privateRecord(context, response.status, body, fields, assessment);
    const attempts = await persistUntilDurable(context.runDir, record,
      persistenceOptions);
    return { decision: assessment.decision, http: response.status,
      businessCode: numericCode(body.errCode), recoverySaved: true,
      responseHasAccessToken: Object.hasOwn(fields, 'accessToken'),
      responseHasRefreshToken: Object.hasOwn(fields, 'refreshToken'),
      localPersistenceAttempts: attempts, networkRequests: 1,
      productionWrites: 0 };
  }
  return { decision: assessment.decision, http: response.status,
    businessCode: numericCode(body?.errCode), recoverySaved: false,
    networkRequests: 1, productionWrites: 0 };
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(() => environmentGate({ NODE_DEBUG: 'http' }),
    /environment_gate/);
  assert.throws(() => environmentGate({ HTTPS_PROXY: 'proxy' }),
    /environment_gate/);
  assert.throws(() => environmentGate({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    /environment_gate/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-refresh-runner-test-'));
  try {
    const dbPath = path.join(root, 'fixture.sqlite');
    const privateRoot = path.join(root, 'private');
    fs.mkdirSync(privateRoot);
    const { DatabaseSync } = sqliteApi();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY, token TEXT NOT NULL)');
      db.exec('CREATE TABLE feeds (id TEXT PRIMARY KEY)');
      db.exec('CREATE TABLE articles (id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO accounts (id, token) VALUES (?, ?)').run(
        'fixture-account', JSON.stringify({ mobile: { vid: 'fixture-vid',
          accessToken: 'old-access', refreshToken: 'old-refresh',
          deviceId: 'fixture-device' }, unrelated: 'preserve' }));
      db.prepare('INSERT INTO feeds (id) VALUES (?)').run('fixture-feed');
      db.prepare('INSERT INTO articles (id) VALUES (?)').run('fixture-article');
    } finally { db.close(); }
    const ready = await preflight(dbPath, privateRoot);
    let requests = 0;
    const fakeTransport = async (shape) => {
      requests++;
      assert.equal(shape.url, 'https://i.weread.qq.com/login');
      assert.equal(shape.method, 'POST');
      return { status: 429, headers: { 'content-type': 'application/json' },
        body: Readable.from([JSON.stringify({ errMsg: '请求频繁',
          refreshToken: 'new-refresh-only' })]) };
    };
    let localAttempts = 0;
    const notices = [];
    const result = await runOnce(dbPath, ready.privateRunDir, fakeTransport, {
      writer(runDir, record) {
        localAttempts++;
        if (localAttempts === 1) throw Error('synthetic disk failure');
        return writeRecovery(runDir, record);
      },
      wait: async () => {},
      notify: (notice) => notices.push(notice),
    });
    assert.equal(requests, 1);
    assert.equal(localAttempts, 2);
    assert.equal(result.decision, 'stop_rate_limit');
    assert.equal(result.recoverySaved, true);
    assert.equal(result.responseHasRefreshToken, true);
    assert.equal(result.responseHasAccessToken, false);
    assert.equal(notices.length, 1);
    const recovery = JSON.parse(fs.readFileSync(
      path.join(ready.privateRunDir, RECOVERY_NAME), 'utf8'));
    assert.equal(recovery.responseTokenFields.refreshToken,
      'new-refresh-only');
    assert.equal(recovery.originalMobile.refreshToken, 'old-refresh');
    assert.throws(() => preflightGate(dbPath, ready.privateRunDir),
      /already_attempted/);
    const mismatchReady = await preflight(dbPath, privateRoot);
    const mismatch = await runOnce(dbPath, mismatchReady.privateRunDir,
      async () => ({ status: 200, headers: {}, body: Readable.from([
        JSON.stringify({ vid: 'different-account',
          accessToken: 'new-access-only' }),
      ]) }));
    assert.equal(mismatch.decision, 'quarantine_identity_mismatch');
    assert.equal(mismatch.recoverySaved, true);
    const mismatchRecord = JSON.parse(fs.readFileSync(path.join(
      mismatchReady.privateRunDir, RECOVERY_NAME), 'utf8'));
    assert.equal(mismatchRecord.responseTokenFields.accessToken,
      'new-access-only');
    assert.equal(mismatchRecord.originalMobile.vid, 'fixture-vid');
    const verifyReady = await preflight(dbPath, privateRoot);
    const verification = await runOnce(dbPath, verifyReady.privateRunDir,
      async () => ({ status: 200, headers: {}, body: Readable.from([
        '<h1>验证码</h1>',
      ]) }));
    assert.equal(verification.decision, 'stop_verification');
    assert.equal(verification.recoverySaved, false);
    assert.equal(fs.existsSync(path.join(verifyReady.privateRunDir,
      RECOVERY_NAME)), false);
    const original = new DatabaseSync(dbPath, { readOnly: true });
    try { assert.equal(oneAccount(original).mobile.accessToken, 'old-access'); }
    finally { original.close(); }
    assert.equal(JSON.stringify(result).includes('new-refresh-only'), false);
  } finally {
    const base = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(root);
    if (!within(base, resolved) ||
        !path.basename(resolved).startsWith('mobile-refresh-runner-test-'))
      throw Error('self_test_cleanup_gate');
    fs.rmSync(resolved, { recursive: true });
  }
  return { decision: 'self_test_passed', productionReads: 0,
    productionWrites: 0, realNetworkRequests: 0 };
}

async function main() {
  let options;
  try { options = args(process.argv.slice(2)); }
  catch {
    console.log(JSON.stringify({ decision: 'usage_gate', networkRequests: 0 }));
    process.exitCode = 2;
    return;
  }
  if (options.mode === '--plan') {
    console.log(JSON.stringify({ decision: 'plan_only', endpoint: '/login',
      method: 'POST', maxNetworkRequests: 1, timeoutMs: TIMEOUT_MS,
      responseLimitBytes: RESPONSE_LIMIT,
      requires: 'matching private preflight backup and exclusive marker',
      productionReads: 0, productionWrites: 0, networkRequests: 0 }));
    return;
  }
  if (options.mode === '--self-test') {
    try { console.log(JSON.stringify(await selfTest())); }
    catch {
      console.log(JSON.stringify({ decision: 'self_test_failed',
        productionReads: 0, realNetworkRequests: 0 }));
      process.exitCode = 1;
    }
    return;
  }
  try { environmentGate(process.env); }
  catch {
    console.log(JSON.stringify({ decision: 'environment_gate',
      networkRequests: 0 }));
    process.exitCode = 1;
    return;
  }
  const signalGuard = () => {
    try { console.log(JSON.stringify({
      decision: 'signal_deferred_until_safe_exit', rawCredentials: false })); }
    catch { /* Never abandon an unpersisted response because output failed. */ }
  };
  process.on('SIGINT', signalGuard);
  process.on('SIGTERM', signalGuard);
  try {
    console.log(JSON.stringify(await runOnce(options.dbPath, options.runDir,
      requestOnce, { notify: (message) => console.log(JSON.stringify(message)) })));
  } catch (error) {
    const safe = new Set(['already_attempted', 'run_dir_gate', 'db_gate',
      'private_root_gate', 'account_gate', 'mobile_gate', 'integrity_gate',
      'preflight_snapshot_gate', 'sqlite_runtime_gate']);
    console.log(JSON.stringify({ decision: safe.has(error.message) ?
      error.message : 'preflight_or_request_failed', networkRequests: 0 }));
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', signalGuard);
    process.off('SIGTERM', signalGuard);
  }
}

if (require.main === module) main();
