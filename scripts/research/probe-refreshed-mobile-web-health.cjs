#!/usr/bin/env node
'use strict';

// One mobile->Web init and, only after healthy init, one Web shelf read.
// Uses the privately recovered mobile token. No search or article request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  within, safePrivateRoot, oneAccount, integrity, sqliteApi, preflight,
} = require('./probe-mobile-refresh-preflight.cjs');

const ORIGIN = 'https://weread.qq.com';
const INIT = `${ORIGIN}/web/login/session/init`;
const SHELF = `${ORIGIN}/web/shelf/sync?userVid=&synckey=0&lectureSynckey=0`;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PLAYWRIGHT_VERSION = '1.58.2';
const INIT_LIMIT = 64 * 1024;
const SHELF_LIMIT = 128 * 1024;
const RECOVERY_NAME = 'mobile-refresh-recovery.json';
const REFRESH_MARKER = 'mobile-refresh-attempt.json';
const HEALTH_MARKER = 'refreshed-mobile-web-health-attempt.json';
const KNOWN_COOKIE_NAMES = new Set(['wr_pf', 'wr_ql', 'wr_rt',
  'wr_skey', 'wr_vid']);

function args(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0]))
    return { mode: argv[0] };
  if (argv.length === 10 && argv[0] === '--execute' &&
      argv[1] === '--db' && path.isAbsolute(argv[2]) &&
      argv[3] === '--run-dir' && path.isAbsolute(argv[4]) &&
      argv[5] === '--playwright-core' && path.isAbsolute(argv[6]) &&
      argv[7] === '--browser' && path.isAbsolute(argv[8]) &&
      argv[9] === '--approved-online')
    return { mode: '--execute', dbPath: argv[2], runDir: argv[4],
      modulePath: argv[6], browserPath: argv[8] };
  throw Error('usage_gate');
}

function environmentGate(env) {
  const keys = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy',
    'all_proxy', 'DEBUG', 'PWDEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE',
    'UNDICI_DEBUG', 'DEBUG_HTTP', 'DEBUG_FETCH', 'NODE_OPTIONS',
    'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED',
  ];
  if (keys.some((key) => typeof env[key] === 'string' && env[key].trim()))
    throw Error('environment_gate');
  if (env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== '0')
    throw Error('environment_gate');
}

function recoveryGate(dbPath, inputRunDir) {
  const runDir = fs.realpathSync(inputRunDir);
  if (!fs.statSync(runDir).isDirectory() ||
      !path.basename(runDir).startsWith('mobile-refresh-'))
    throw Error('run_dir_gate');
  safePrivateRoot(path.dirname(runDir));
  if (fs.existsSync(path.join(runDir, HEALTH_MARKER)))
    throw Error('already_attempted');
  const marker = JSON.parse(fs.readFileSync(path.join(runDir,
    REFRESH_MARKER), 'utf8'));
  if (marker.kind !== 'mobile-refresh-once' || marker.endpoint !== '/login' ||
      !Number.isFinite(Date.parse(marker.attemptedAt)))
    throw Error('refresh_marker_gate');
  const record = JSON.parse(fs.readFileSync(path.join(runDir,
    RECOVERY_NAME), 'utf8'));
  if (record.formatVersion !== 2 ||
      record.kind !== 'mobile-refresh-response-tokens' ||
      record.decision !== 'candidate_identity_matched' ||
      record.httpStatus !== 200 ||
      ![null, 0].includes(record.businessCode) ||
      !record.responseTokenFields ||
      typeof record.responseTokenFields.accessToken !== 'string' ||
      !record.responseTokenFields.accessToken.trim() ||
      typeof record.accountId !== 'string' ||
      !record.accountId)
    throw Error('recovery_gate');
  const sourcePath = fs.realpathSync(dbPath);
  if (!fs.statSync(sourcePath).isFile() || within(runDir, sourcePath))
    throw Error('db_gate');
  const { DatabaseSync } = sqliteApi();
  const handles = [];
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    handles.push(source);
    const backup = new DatabaseSync(path.join(runDir, 'original.sqlite'),
      { readOnly: true });
    handles.push(backup);
    const rehearsal = new DatabaseSync(path.join(runDir, 'rehearsal.sqlite'),
      { readOnly: true });
    handles.push(rehearsal);
    for (const db of handles) db.exec('PRAGMA query_only=ON');
    const current = oneAccount(source);
    const original = oneAccount(backup);
    const simulated = oneAccount(rehearsal);
    const currentCounts = integrity(source);
    const backupCounts = integrity(backup);
    const rehearsalCounts = integrity(rehearsal);
    const expectedRehearsal = structuredClone(original.token);
    expectedRehearsal.mobile = { ...original.mobile,
      accessToken: 'offline-fixture-rotated-access',
      refreshToken: 'offline-fixture-rotated-refresh' };
    if (current.row.id !== record.accountId ||
        original.row.id !== record.accountId ||
        simulated.row.id !== record.accountId ||
        current.row.token !== original.row.token ||
        JSON.stringify(simulated.token) !==
          JSON.stringify(expectedRehearsal) ||
        JSON.stringify(current.mobile) !==
          JSON.stringify(record.originalMobile) ||
        currentCounts.feeds !== backupCounts.feeds ||
        currentCounts.articles !== backupCounts.articles ||
        backupCounts.feeds !== rehearsalCounts.feeds ||
        backupCounts.articles !== rehearsalCounts.articles)
      throw Error('source_backup_gate');
    const response = record.responseTokenFields;
    const next = record.proposedMobile;
    if (!next || typeof next !== 'object' || Array.isArray(next) ||
        next.vid !== current.mobile.vid ||
        next.deviceId !== current.mobile.deviceId ||
        next.accessToken !== response.accessToken ||
        !next.accessToken.trim() ||
        typeof next.refreshToken !== 'string' ||
        !next.refreshToken.trim() ||
        next.refreshToken !== (typeof response.refreshToken === 'string' ?
          response.refreshToken : current.mobile.refreshToken) ||
        response.vid === undefined ||
        String(response.vid) !== current.mobile.vid ||
        next.accessToken === current.mobile.accessToken)
      throw Error('recovery_identity_gate');
    return { mobile: { vid: next.vid, accessToken: next.accessToken,
      refreshToken: next.refreshToken }, runDir };
  } finally {
    for (const db of handles.reverse()) db.close();
  }
}

function markAttempt(runDir) {
  const fd = fs.openSync(path.join(runDir, HEALTH_MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ kind: 'refreshed-mobile-web-health',
      endpoints: ['/web/login/session/init', '/web/shelf/sync'],
      attemptedAt: new Date().toISOString() }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function runtime(modulePath, browserPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(modulePath,
    'package.json'), 'utf8'));
  if (manifest.name !== 'playwright-core' ||
      manifest.version !== PLAYWRIGHT_VERSION ||
      !fs.statSync(browserPath).isFile() ||
      !/^(?:msedge|chrome)\.exe$/i.test(path.basename(browserPath)))
    throw Error('runtime_gate');
  const { chromium } = require(modulePath);
  if (typeof chromium?.launch !== 'function') throw Error('runtime_gate');
  return { chromium, browserPath };
}

function numericCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value))
    return Number(value);
  return null;
}

function hint(value) {
  if (typeof value !== 'string') return null;
  if (/验证码|captcha|人机验证|安全验证|请完成验证|环境异常/i.test(value))
    return 'stop_verification';
  if (/请求频繁|访问频繁|限流|限频|rate.?limit|too many|throttl/i.test(value))
    return 'stop_rate_limit';
  return null;
}

function statusStop(status) {
  if (status === 429) return 'stop_rate_limit';
  if (status === 401 || status === 403) return 'stop_authentication_rejected';
  if (status >= 300 && status < 400) return 'stop_redirect';
  return 'stop_http_status';
}

async function readPayload(response, limit) {
  const headers = response.headers();
  const length = Number(headers['content-length']);
  if (Number.isFinite(length) && length > limit)
    return { stop: 'stop_body_limit' };
  const buffer = await response.body();
  if (buffer.length > limit) return { stop: 'stop_body_limit' };
  const text = buffer.toString('utf8');
  let data;
  try { data = JSON.parse(text); }
  catch { return { stop: hint(text) ?? 'stop_non_json' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { stop: 'stop_response_shape' };
  const errCode = numericCode(data.errCode);
  const ret = numericCode(data.ret);
  const risk = hint(data.errMsg) ?? hint(data.msg) ?? hint(data.message);
  if (risk) return { stop: risk, errCode, ret };
  if ((Object.hasOwn(data, 'errCode') && errCode === null) ||
      (Object.hasOwn(data, 'ret') && ret === null))
    return { stop: 'stop_uninterpretable_business_code', errCode, ret };
  if (errCode === -2012 || ret === -2012)
    return { stop: 'stop_auth_expired_candidate', errCode, ret };
  if ((errCode !== null && errCode !== 0) ||
      (ret !== null && ret !== 0))
    return { stop: 'stop_business_error', errCode, ret };
  return { data, errCode, ret, stop: null };
}

function setCookieNames(response) {
  return [...new Set(response.headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value.split(';', 1)[0]
      .split('=', 1)[0].trim())
    .filter((name) => KNOWN_COOKIE_NAMES.has(name)))].sort();
}

function cookieGate(cookies, vid) {
  const named = (name) => cookies.filter((cookie) =>
    cookie.name === name && typeof cookie.value === 'string' && cookie.value);
  const wrVid = named('wr_vid');
  const wrSkey = named('wr_skey');
  return { names: [...new Set(cookies.map((cookie) => cookie.name))]
    .filter((name) => KNOWN_COOKIE_NAMES.has(name)).sort(),
    count: cookies.length,
    identityMatch: wrVid.length === 1 && wrVid[0].value === vid,
    ready: wrVid.length === 1 && wrVid[0].value === vid &&
      wrSkey.length === 1 };
}

async function probe(mobile, launch) {
  const out = { decision: 'stop_browser_or_context',
    requestCount: 0, initRequests: 0, shelfRequests: 0,
    searchRequests: 0, pageNavigations: 0,
    credentialSource: 'private_refresh_recovery_only' };
  let browser, context;
  try {
    browser = await launch();
    context = await browser.newContext({ serviceWorkers: 'block',
      acceptDownloads: false, userAgent: USER_AGENT });
    if ((await context.cookies()).length) {
      out.decision = 'stop_nonempty_context';
      return out;
    }
    let init;
    try {
      out.initRequests = out.requestCount = 1;
      init = await context.request.post(INIT, {
        data: { vid: mobile.vid, pf: 0,
          skey: mobile.accessToken, rt: mobile.refreshToken },
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        timeout: 10_000, maxRedirects: 0, maxRetries: 0,
      });
    } catch {
      out.decision = 'stop_init_transport_or_timeout';
      return out;
    }
    out.initHttp = init.status();
    out.initSetCookieNames = setCookieNames(init);
    if (out.initHttp !== 200) {
      out.decision = statusStop(out.initHttp);
      await init.dispose();
      return out;
    }
    let initData;
    try { initData = await readPayload(init, INIT_LIMIT); }
    catch { out.decision = 'stop_init_body_read'; return out; }
    finally { await init.dispose(); }
    out.initCode = initData.errCode ?? null;
    out.initRet = initData.ret ?? null;
    if (initData.stop) { out.decision = initData.stop; return out; }
    if (Object.hasOwn(initData.data, 'success') &&
        numericCode(initData.data.success) !== 1) {
      out.decision = 'stop_init_not_success';
      return out;
    }
    const gate = cookieGate(await context.cookies(SHELF), mobile.vid);
    out.shelfCookieNames = gate.names;
    out.shelfCookieCount = gate.count;
    out.wrVidMatchesRecovery = gate.identityMatch;
    if (!gate.ready) {
      out.decision = 'stop_cookie_scope_or_identity';
      return out;
    }
    let shelf;
    try {
      out.shelfRequests = 1;
      out.requestCount = 2;
      shelf = await context.request.get(SHELF, {
        headers: { accept: 'application/json, text/plain, */*',
          referer: `${ORIGIN}/` },
        timeout: 10_000, maxRedirects: 0, maxRetries: 0,
      });
    } catch {
      out.decision = 'stop_shelf_transport_or_timeout';
      return out;
    }
    out.shelfHttp = shelf.status();
    if (out.shelfHttp !== 200) {
      out.decision = statusStop(out.shelfHttp);
      await shelf.dispose();
      return out;
    }
    let shelfData;
    try { shelfData = await readPayload(shelf, SHELF_LIMIT); }
    catch { out.decision = 'stop_shelf_body_read'; return out; }
    finally { await shelf.dispose(); }
    out.shelfCode = shelfData.errCode ?? null;
    out.shelfRet = shelfData.ret ?? null;
    if (shelfData.stop) { out.decision = shelfData.stop; return out; }
    out.shelfHasBooks = Array.isArray(shelfData.data.books);
    out.shelfHasSyncKey = Object.hasOwn(shelfData.data, 'synckey');
    out.decision = out.shelfHasBooks || out.shelfHasSyncKey ?
      'web_shelf_accepted' : 'stop_shelf_health_unknown';
    return out;
  } catch {
    out.decision = 'stop_browser_or_context';
    return out;
  } finally {
    try { await context?.close(); } catch { /* No raw errors. */ }
    try { await browser?.close(); } catch { /* No raw errors. */ }
  }
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(() => environmentGate({ NODE_DEBUG: 'http' }),
    /environment_gate/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refreshed-web-health-test-'));
  try {
    const dbPath = path.join(root, 'fixture.sqlite');
    const privateRoot = path.join(root, 'private');
    fs.mkdirSync(privateRoot);
    const { DatabaseSync } = sqliteApi();
    const db = new DatabaseSync(dbPath);
    const oldMobile = { vid: 'fixture-vid', accessToken: 'old-access',
      refreshToken: 'old-refresh', deviceId: 'fixture-device' };
    try {
      db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY, token TEXT NOT NULL)');
      db.exec('CREATE TABLE feeds (id TEXT PRIMARY KEY)');
      db.exec('CREATE TABLE articles (id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO accounts (id, token) VALUES (?, ?)').run(
        'fixture-account', JSON.stringify({ mobile: oldMobile }));
    } finally { db.close(); }
    const ready = await preflight(dbPath, privateRoot);
    fs.writeFileSync(path.join(ready.privateRunDir, REFRESH_MARKER),
      JSON.stringify({ kind: 'mobile-refresh-once', endpoint: '/login',
        attemptedAt: new Date().toISOString() }));
    const recovery = { formatVersion: 2,
      kind: 'mobile-refresh-response-tokens',
      decision: 'candidate_identity_matched', httpStatus: 200,
      businessCode: null, accountId: 'fixture-account',
      originalMobile: oldMobile,
      responseTokenFields: { vid: 'fixture-vid',
        accessToken: 'new-access' },
      proposedMobile: { ...oldMobile, accessToken: 'new-access' } };
    fs.writeFileSync(path.join(ready.privateRunDir, RECOVERY_NAME),
      JSON.stringify(recovery));
    const mobile = recoveryGate(dbPath, ready.privateRunDir).mobile;
    assert.equal(mobile.accessToken, 'new-access');
    assert.equal(mobile.refreshToken, 'old-refresh');
    fs.writeFileSync(path.join(ready.privateRunDir, RECOVERY_NAME),
      JSON.stringify({ ...recovery, accountId: 'wrong-account' }));
    assert.throws(() => recoveryGate(dbPath, ready.privateRunDir),
      /source_backup_gate/);
    fs.writeFileSync(path.join(ready.privateRunDir, RECOVERY_NAME),
      JSON.stringify({ ...recovery, proposedMobile: {
        ...recovery.proposedMobile, vid: 'wrong-account' } }));
    assert.throws(() => recoveryGate(dbPath, ready.privateRunDir),
      /recovery_identity_gate/);
    fs.writeFileSync(path.join(ready.privateRunDir, RECOVERY_NAME),
      JSON.stringify(recovery));
    let calls = 0;
    function fakeLaunch(options = {}) {
      const cookies = [
        { name: 'wr_vid', value: options.wrongVid ? 'wrong' : 'fixture-vid' },
        { name: 'wr_skey', value: 'fixture-web' },
        { name: 'wr_rt', value: 'fixture-rt' },
        { name: 'wr_pf', value: 'fixture-pf' },
        { name: 'wr_ql', value: 'fixture-ql' },
      ];
      let initialized = false;
      const response = (body) => ({ status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
        headersArray: () => cookies.map((cookie) => ({ name: 'Set-Cookie',
          value: `${cookie.name}=${cookie.value}; Path=/; Secure` })),
        body: async () => Buffer.from(JSON.stringify(body)),
        dispose: async () => {} });
      return async () => ({ newContext: async () => ({
        cookies: async () => initialized ? cookies : [],
        request: {
          post: async (url, init) => {
            calls++;
            assert.equal(url, INIT);
            assert.equal(init.data.skey, 'new-access');
            assert.equal(init.data.rt, 'old-refresh');
            assert.equal(init.headers.cookie, undefined);
            assert.equal(init.maxRedirects, 0);
            assert.equal(init.maxRetries, 0);
            initialized = true;
            return response(options.initBody ?? { success: 1 });
          },
          get: async (url, init) => {
            calls++;
            assert.equal(url, SHELF);
            assert.equal(init.headers.cookie, undefined);
            return response(options.shelfBody ?? { books: [], synckey: 1 });
          },
        }, close: async () => {} }), close: async () => {} });
    }
    markAttempt(ready.privateRunDir);
    const good = await probe(mobile, fakeLaunch());
    assert.equal(good.decision, 'web_shelf_accepted');
    assert.equal(good.requestCount, 2);
    assert.equal(good.searchRequests, 0);
    assert.equal(calls, 2);
    calls = 0;
    const verification = await probe(mobile, fakeLaunch({ initBody: {
      errMsg: '请完成验证码' } }));
    assert.equal(verification.decision, 'stop_verification');
    assert.equal(calls, 1);
    calls = 0;
    const unsuccessful = await probe(mobile, fakeLaunch({ initBody: {
      success: 0 } }));
    assert.equal(unsuccessful.decision, 'stop_init_not_success');
    assert.equal(calls, 1);
    calls = 0;
    const mismatch = await probe(mobile, fakeLaunch({ wrongVid: true }));
    assert.equal(mismatch.decision, 'stop_cookie_scope_or_identity');
    assert.equal(calls, 1);
    calls = 0;
    const expired = await probe(mobile, fakeLaunch({ shelfBody: {
      errCode: -2012 } }));
    assert.equal(expired.decision, 'stop_auth_expired_candidate');
    assert.equal(calls, 2);
    assert.throws(() => recoveryGate(dbPath, ready.privateRunDir),
      /already_attempted/);
    assert.equal(/old-access|new-access|fixture-web/.test(
      JSON.stringify(good)), false);
  } finally {
    const base = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(root);
    if (!within(base, resolved) ||
        !path.basename(resolved).startsWith('refreshed-web-health-test-'))
      throw Error('self_test_cleanup_gate');
    fs.rmSync(resolved, { recursive: true });
  }
  return { decision: 'self_test_passed', productionReads: 0,
    productionWrites: 0, realNetworkRequests: 0 };
}

async function main() {
  let options;
  try { options = args(process.argv.slice(2)); }
  catch { console.log(JSON.stringify({ decision: 'usage_gate', requestCount: 0 }));
    process.exitCode = 2; return; }
  if (options.mode === '--plan') {
    console.log(JSON.stringify({ decision: 'plan_only',
      credentialSource: 'private_refresh_recovery_only',
      initRequestMax: 1, shelfRequestMax: 1, searchRequestMax: 0,
      pageNavigations: 0, redirects: false, retries: false,
      productionReads: 0, productionWrites: 0, requestCount: 0 }));
    return;
  }
  if (options.mode === '--self-test') {
    try { console.log(JSON.stringify(await selfTest())); }
    catch { console.log(JSON.stringify({ decision: 'self_test_failed',
      realNetworkRequests: 0 })); process.exitCode = 1; }
    return;
  }
  try { environmentGate(process.env); }
  catch { console.log(JSON.stringify({ decision: 'environment_gate',
    requestCount: 0 })); process.exitCode = 1; return; }
  let credentials, verified;
  try {
    credentials = recoveryGate(options.dbPath, options.runDir);
    verified = runtime(options.modulePath, options.browserPath);
    markAttempt(credentials.runDir);
  } catch (error) {
    const safe = new Set(['already_attempted', 'run_dir_gate',
      'refresh_marker_gate', 'recovery_gate', 'source_backup_gate',
      'recovery_identity_gate', 'db_gate', 'private_root_gate',
      'account_gate', 'mobile_gate', 'integrity_gate',
      'sqlite_runtime_gate', 'runtime_gate']);
    console.log(JSON.stringify({ decision: safe.has(error.message) ?
      error.message : 'preflight_gate', requestCount: 0 }));
    process.exitCode = 1;
    return;
  }
  const launch = () => verified.chromium.launch({
    executablePath: verified.browserPath, headless: true,
    args: ['--disable-background-networking', '--no-proxy-server',
      '--no-first-run', '--no-default-browser-check'],
  });
  const result = await probe(credentials.mobile, launch);
  console.log(JSON.stringify(result));
  if (result.decision !== 'web_shelf_accepted') process.exitCode = 1;
}

if (require.main === module) main();
