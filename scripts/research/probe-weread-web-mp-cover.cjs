#!/usr/bin/env node
'use strict';

// One target cover observation. Successful bounded cover JSON and any
// reviewId stay in private-data; no body fetch or Tencent request retry.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sqliteApi } = require('./probe-mobile-refresh-preflight.cjs');
const {
  environmentGate, recoveryGate, runtime, readPayload, numericCode,
  statusStop, cookieGate, setCookieNames,
} = require('./probe-refreshed-mobile-web-health.cjs');

const ORIGIN = 'https://weread.qq.com';
const INIT = `${ORIGIN}/web/login/session/init`;
const COVER = `${ORIGIN}/web/mp/cover`;
const BOOK_ID = 'MP_WXS_3895431412';
const TARGET_NAME = '妈妈部落畅聊阁';
const MARKER = 'weread-web-mp-cover-target.attempted.json';
const RAW_COVER = 'weread-web-mp-cover-target-response.json';
const CANDIDATE = 'weread-web-mp-cover-target-candidate.json';
const PRIVATE_LIMIT = 8 * 1024;
const COVER_LIMIT = 64 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function args(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0]))
    return { mode: argv[0] };
  if (
    argv.length === 5 && argv[0] === '--preflight' && argv[1] === '--db' &&
    path.isAbsolute(argv[2]) && argv[3] === '--run-dir' &&
    path.isAbsolute(argv[4])
  ) return { mode: argv[0], dbPath: argv[2], runDir: argv[4] };
  if (
    argv.length === 10 && argv[0] === '--execute' && argv[1] === '--db' &&
    path.isAbsolute(argv[2]) && argv[3] === '--run-dir' &&
    path.isAbsolute(argv[4]) && argv[5] === '--playwright-core' &&
    path.isAbsolute(argv[6]) && argv[7] === '--browser' &&
    path.isAbsolute(argv[8]) && argv[9] === '--approved-online'
  ) return { mode: argv[0], dbPath: argv[2], runDir: argv[4],
    modulePath: argv[6], browserPath: argv[8] };
  throw Error('usage_gate');
}

function privateRootGate(dbPath, runDir) {
  const source = fs.realpathSync(dbPath);
  const projectRoot = path.resolve(path.dirname(source), '..', '..', '..');
  if (source !== path.join(projectRoot, 'apps', 'server', 'data',
    'wewe-rss.db')) throw Error('db_path_gate');
  const privateRoot = path.join(projectRoot, 'private-data');
  if (!fs.existsSync(privateRoot) || fs.lstatSync(privateRoot).isSymbolicLink() ||
      !fs.statSync(privateRoot).isDirectory() ||
      !fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8')
        .split(/\r?\n/).includes('private-data/'))
    throw Error('private_root_gate');
  if (fs.realpathSync(privateRoot) !== privateRoot ||
      fs.realpathSync(runDir) !== path.resolve(runDir) ||
      path.dirname(path.resolve(runDir)) !== privateRoot ||
      !path.basename(runDir).startsWith('mobile-refresh-') ||
      fs.lstatSync(runDir).isSymbolicLink())
    throw Error('private_root_gate');
  return privateRoot;
}

function historyGate(privateRoot) {
  // The fixed root-level marker also prevents a new recovery runDir from
  // silently repeating a previous target cover request.
  for (const name of [MARKER, RAW_COVER, CANDIDATE]) {
    if (fs.existsSync(path.join(privateRoot, name)))
      throw Error('cover_already_attempted');
  }
  for (const entry of fs.readdirSync(privateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mobile-refresh-'))
      continue;
    for (const name of [MARKER, RAW_COVER, CANDIDATE]) {
      if (fs.existsSync(path.join(privateRoot, entry.name, name)))
        throw Error('cover_already_attempted');
    }
  }
}

function targetGate(dbPath, runDir) {
  const { DatabaseSync } = sqliteApi();
  const handles = [];
  try {
    const rows = [dbPath, path.join(runDir, 'original.sqlite'),
      path.join(runDir, 'rehearsal.sqlite')].map((file) => {
      const db = new DatabaseSync(file, { readOnly: true });
      handles.push(db);
      db.exec('PRAGMA query_only=ON');
      const found = db.prepare('SELECT id, mp_name, status FROM feeds WHERE id = ?')
        .all(BOOK_ID);
      if (found.length !== 1 || found[0].id !== BOOK_ID ||
          found[0].mp_name !== TARGET_NAME || found[0].status !== 1)
        throw Error('target_feed_gate');
      return found[0];
    });
    if (JSON.stringify(rows[0]) !== JSON.stringify(rows[1]) ||
        JSON.stringify(rows[0]) !== JSON.stringify(rows[2]))
      throw Error('target_backup_gate');
  } finally {
    for (const db of handles.reverse()) db.close();
  }
}

function preflight(dbPath, runDir) {
  const credentials = recoveryGate(dbPath, runDir, 'present');
  const privateRoot = privateRootGate(dbPath, credentials.runDir);
  targetGate(dbPath, credentials.runDir);
  historyGate(privateRoot);
  return { mobile: credentials.mobile, privateRoot };
}

function markAttempt(privateRoot) {
  const fd = fs.openSync(path.join(privateRoot, MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({
      kind: 'weread-web-mp-cover-target',
      endpoint: '/web/mp/cover', bookId: BOOK_ID,
      attemptedAt: new Date().toISOString(),
    }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return JSON.parse(fs.readFileSync(path.join(privateRoot, MARKER), 'utf8'));
}

function coverShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { stop: 'stop_cover_shape' };
  if (Object.hasOwn(data, 'bookId') && data.bookId !== BOOK_ID)
    return { stop: 'stop_book_identity' };
  if (data.name !== TARGET_NAME) return { stop: 'stop_source_identity' };
  const reviewId = data.reviewId;
  if (typeof reviewId !== 'string' || reviewId.length > 300 ||
      !/^MP_WXS_3895431412_[A-Za-z0-9_~-]{1,256}$/.test(reviewId))
    return { stop: 'stop_review_identity' };
  if (typeof data.title !== 'string' || !data.title.trim() ||
      data.title.length > 500 || /[\x00-\x1f\x7f]/.test(data.title))
    return { stop: 'stop_title_shape' };
  return {
    reviewId, title: data.title.trim(),
    picPresent: typeof data.pic === 'string' && !!data.pic.trim(),
  };
}

function candidateRecord(marker, data, accountVid) {
  if (marker.kind !== 'weread-web-mp-cover-target' ||
      marker.endpoint !== '/web/mp/cover' || marker.bookId !== BOOK_ID ||
      !Number.isFinite(Date.parse(marker.attemptedAt)))
    throw Error('cover_marker_gate');
  const shaped = coverShape(data);
  if (shaped.stop || typeof accountVid !== 'string' || !accountVid)
    throw Error('cover_candidate_gate');
  return {
    formatVersion: 1, kind: 'weread-web-mp-cover-candidate',
    coverAttemptedAt: marker.attemptedAt, endpoint: '/web/mp/cover',
    bookId: BOOK_ID, sourceName: TARGET_NAME, accountVid,
    reviewId: shaped.reviewId, title: shaped.title,
    picPresent: shaped.picPresent,
    articleIdentityVerified: false, publishedAtVerified: false,
  };
}

function writePrivate(privateRoot, name, body, limit) {
  const finalPath = path.join(privateRoot, name);
  if (Buffer.byteLength(body) > limit) throw Error('cover_private_limit');
  if (fs.existsSync(finalPath)) {
    if (fs.readFileSync(finalPath).equals(Buffer.from(body))) return;
    throw Error('cover_private_exists');
  }
  const tempPath = path.join(privateRoot,
    `.weread-cover-${randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // Hard link publishes the already-fsynced file without replacing history.
  fs.linkSync(tempPath, finalPath);
  if (!fs.readFileSync(finalPath).equals(Buffer.from(body)))
    throw Error('cover_private_verify_gate');
  fs.unlinkSync(tempPath);
}

function writeCandidate(privateRoot, record) {
  writePrivate(privateRoot, CANDIDATE,
    JSON.stringify(record) + '\n', PRIVATE_LIMIT);
}

function writeRawCover(privateRoot, raw) {
  if (!Buffer.isBuffer(raw)) throw Error('cover_raw_gate');
  writePrivate(privateRoot, RAW_COVER, raw, COVER_LIMIT);
}

function coverRisk(text) {
  if (/验证码|captcha|人机验证|安全验证|请完成验证|环境异常|verification|challenge|verifyurl|\/verify|"(?:verify|riskUrl)"\s*:/i.test(text))
    return 'stop_verification';
  if (/请求频繁|访问频繁|限流|限频|rate.?limit|too many|throttl/i.test(text))
    return 'stop_rate_limit';
  return null;
}

async function readCoverJson(response) {
  const length = Number(response.headers()['content-length']);
  if (Number.isFinite(length) && length > COVER_LIMIT)
    return { stop: 'stop_body_limit' };
  const raw = await response.body();
  if (raw.length > COVER_LIMIT) return { stop: 'stop_body_limit' };
  const text = raw.toString('utf8');
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { return { stop: coverRisk(text) ?? 'stop_non_json' }; }
  // Exclude JSON verification/error responses before preserving any payload.
  // Unknown successful shapes are retained so the sole request stays useful.
  const errCode = numericCode(data?.errCode);
  const ret = numericCode(data?.ret);
  const risk = coverRisk(text);
  if (risk) return { stop: risk, errCode, ret };
  // Some Tencent envelopes put a business code one level below the root.
  // Treat a nested restriction as a stop before saving raw JSON as well.
  const inner = data && typeof data === 'object' && !Array.isArray(data) ?
    [data.data, data.content] : [];
  const innerCodes = inner.flatMap((part) => part && typeof part === 'object' ?
    [numericCode(part.errCode), numericCode(part.ret)] : []);
  const codes = [errCode, ret, ...innerCodes];
  if (codes.includes(-2014))
    return { stop: 'stop_rate_limit', errCode, ret };
  if (codes.includes(-2041))
    return { stop: 'stop_access_restricted', errCode, ret };
  if (codes.includes(-2012))
    return { stop: 'stop_auth_expired_candidate', errCode, ret };
  if (data && typeof data === 'object' &&
      Object.hasOwn(data, 'success') &&
      numericCode(data.success) !== 1)
    return { stop: 'stop_business_error', errCode, ret };
  if ((data && typeof data === 'object' &&
      ((Object.hasOwn(data, 'errCode') && errCode === null) ||
       (Object.hasOwn(data, 'ret') && ret === null))) ||
      inner.some((part) => part && typeof part === 'object' &&
        ((Object.hasOwn(part, 'errCode') && numericCode(part.errCode) === null) ||
         (Object.hasOwn(part, 'ret') && numericCode(part.ret) === null))) ||
      codes.some((code) => code !== null && code !== 0))
    return { stop: 'stop_business_error', errCode, ret };
  return { raw, data, errCode, ret };
}

async function persistUntilDurable(privateRoot, record, options = {}) {
  const writer = options.writer ?? writeCandidate;
  const pause = options.pause ?? ((ms) => new Promise((resolve) =>
    setTimeout(resolve, ms)));
  const notify = options.notify ?? ((event) => console.log(JSON.stringify(event)));
  let attempts = 0;
  for (;;) {
    attempts++;
    try { writer(privateRoot, record); return attempts; }
    catch {
      // Keep the only fresh reviewId in memory. Never issue another HTTP call.
      notify({ decision: 'private_persist_retry', requestCount: 2 });
      await pause(2000);
    }
  }
}

async function probe(mobile, launch, marker, saveRaw, save) {
  const out = {
    decision: 'stop_browser_or_context', requestCount: 0,
    initRequests: 0, coverRequests: 0, articleRequests: 0,
    listRequests: 0, pageNavigations: 0, productionWrites: 0,
    credentialSource: 'private_refresh_recovery_only',
  };
  let browser, context;
  try {
    browser = await launch();
    context = await browser.newContext({
      serviceWorkers: 'block', acceptDownloads: false, userAgent: USER_AGENT,
    });
    if ((await context.cookies()).length) {
      out.decision = 'stop_nonempty_context'; return out;
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
    } catch { out.decision = 'stop_init_transport_or_timeout'; return out; }
    out.initHttp = init.status();
    out.initSetCookieNames = setCookieNames(init);
    if (out.initHttp !== 200) {
      out.decision = statusStop(out.initHttp);
      await init.dispose(); return out;
    }
    let initData;
    try { initData = await readPayload(init, 64 * 1024); }
    catch { out.decision = 'stop_init_body_read'; return out; }
    finally { await init.dispose(); }
    out.initCode = initData.errCode ?? null;
    if (initData.stop) { out.decision = initData.stop; return out; }
    if (Object.hasOwn(initData.data, 'success') &&
        numericCode(initData.data.success) !== 1) {
      out.decision = 'stop_init_not_success'; return out;
    }
    const gate = cookieGate(await context.cookies(COVER), mobile.vid);
    out.wrVidMatchesRecovery = gate.identityMatch;
    out.webCookieNames = gate.names;
    if (!gate.ready || !['wr_vid', 'wr_skey', 'wr_rt', 'wr_pf', 'wr_ql']
      .every((name) => gate.names.includes(name))) {
      out.decision = 'stop_cookie_scope_or_identity'; return out;
    }
    let cover;
    try {
      out.coverRequests = 1; out.requestCount = 2;
      cover = await context.request.get(COVER, {
        params: { bookId: BOOK_ID }, timeout: 10_000,
        maxRedirects: 0, maxRetries: 0,
      });
    } catch { out.decision = 'stop_cover_transport_or_timeout'; return out; }
    out.coverHttp = cover.status();
    if (out.coverHttp !== 200) {
      out.decision = statusStop(out.coverHttp);
      await cover.dispose(); return out;
    }
    let found;
    try { found = await readCoverJson(cover); }
    catch { out.decision = 'stop_cover_body_read'; return out; }
    finally { await cover.dispose(); }
    out.coverCode = found.errCode ?? null;
    out.coverRet = found.ret ?? null;
    if (found.stop) { out.decision = found.stop; return out; }
    // Preserve the exact bounded JSON before any cover shape or identity gate.
    // Persistence failure retries locally with the only response still in RAM.
    out.privateRawPersistAttempts = await saveRaw(found.raw);
    out.privateRawSaved = true;
    const shaped = coverShape(found.data);
    if (shaped.stop) { out.decision = shaped.stop; return out; }
    out.sourceNameMatched = true;
    out.reviewIdPrefixMatched = true;
    out.titlePresent = true;
    out.picPresent = shaped.picPresent;
    const record = candidateRecord(marker, found.data, mobile.vid);
    // A failed disk write may be the only chance to preserve this ID. Retry
    // only local persistence while retaining record in memory.
    out.privatePersistAttempts = await save(record);
    out.privateCandidateSaved = true;
    out.decision = 'cover_candidate_private_saved';
    return out;
  } catch {
    out.decision = 'stop_browser_or_context'; return out;
  } finally {
    try { await context?.close(); } catch { /* no raw errors */ }
    try { await browser?.close(); } catch { /* no raw errors */ }
  }
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(() => environmentGate({ DEBUG: 'http' }), /environment_gate/);
  assert.equal(coverShape({ name: TARGET_NAME, title: 'x',
    reviewId: `${BOOK_ID}_abc~def` }).reviewId, `${BOOK_ID}_abc~def`);
  assert.equal(coverShape({ name: 'wrong', title: 'x',
    reviewId: `${BOOK_ID}_abc` }).stop, 'stop_source_identity');
  assert.equal(coverShape({ name: TARGET_NAME, title: 'x',
    reviewId: 'MP_WXS_1_abc' }).stop, 'stop_review_identity');
  const fakeRaw = (value) => ({
    headers: () => ({}), body: async () => Buffer.from(value),
  });
  assert.equal((await readCoverJson(fakeRaw('<html>验证码</html>'))).stop,
    'stop_verification');
  assert.equal((await readCoverJson(fakeRaw('<html>other</html>'))).stop,
    'stop_non_json');
  assert.equal((await readCoverJson(fakeRaw('{"data":{"ret":-2041}}'))).stop,
    'stop_access_restricted');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-fixture-'));
  try {
    const marker = { kind: 'weread-web-mp-cover-target',
      endpoint: '/web/mp/cover', bookId: BOOK_ID,
      attemptedAt: new Date().toISOString() };
    const data = { name: TARGET_NAME, title: 'fixture-private-title',
      reviewId: `${BOOK_ID}_fixture-private-review`, pic: 'fixture-private-pic' };
    const record = candidateRecord(marker, data, 'fixture-vid');
    writeCandidate(scratch, record);
    assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, CANDIDATE),
      'utf8')).reviewId, data.reviewId);
    assert.throws(() => historyGate(scratch), /cover_already_attempted/);
    assert.doesNotThrow(() => writeCandidate(scratch, record));
    assert.throws(() => writeCandidate(scratch,
      { ...record, reviewId: `${BOOK_ID}_other` }), /cover_private_exists/);
    fs.unlinkSync(path.join(scratch, CANDIDATE));
    const rawFixture = Buffer.from('{"unexpected":{"field":"fixture-private-raw"}}');
    writeRawCover(scratch, rawFixture);
    assert.deepEqual(fs.readFileSync(path.join(scratch, RAW_COVER)), rawFixture);
    assert.throws(() => writeRawCover(scratch,
      Buffer.from('{"different":true}')), /cover_private_exists/);
    fs.unlinkSync(path.join(scratch, RAW_COVER));
    markAttempt(scratch);
    assert.throws(() => markAttempt(scratch), /EEXIST/);
    assert.throws(() => historyGate(scratch), /cover_already_attempted/);
    let localWrites = 0;
    const retries = await persistUntilDurable(scratch, record, {
      writer: (root, candidate) => {
        if (++localWrites === 1) throw Error('disk_fixture');
        writeCandidate(root, candidate);
      }, pause: async () => {}, notify: () => {},
    });
    assert.equal(retries, 2);
    let calls = 0;
    const mobile = { vid: 'fixture-vid', accessToken: 'fixture-secret-access',
      refreshToken: 'fixture-secret-refresh' };
    function fakeResponse(body, status = 200) {
      return { status: () => status, headers: () => ({ 'content-type':
        'application/json' }), headersArray: () => [],
      body: async () => Buffer.from(JSON.stringify(body)),
      dispose: async () => {} };
    }
    const fakeLaunch = (scenario = {}) => async () => ({
      newContext: async () => {
        let initialized = false;
        return { cookies: async () => initialized ? [
          { name: 'wr_vid', value: 'fixture-vid' },
          { name: 'wr_skey', value: 'fixture-web' },
          { name: 'wr_rt', value: 'fixture-rt' },
          { name: 'wr_pf', value: 'fixture-pf' },
          { name: 'wr_ql', value: 'fixture-ql' },
        ] : [], request: {
          post: async (url, requestOptions) => {
            calls++;
            assert.equal(url, INIT);
            assert.equal(requestOptions.data.skey, mobile.accessToken);
            assert.equal(requestOptions.data.rt, mobile.refreshToken);
            assert.equal(requestOptions.maxRetries, 0);
            initialized = true;
            return fakeResponse({ success: 1 }, scenario.initStatus ?? 200);
          },
          get: async (url, requestOptions) => {
            calls++;
            assert.equal(url, COVER);
            assert.equal(requestOptions.params.bookId, BOOK_ID);
            assert.equal(requestOptions.maxRedirects, 0);
            assert.equal(requestOptions.maxRetries, 0);
            return fakeResponse(scenario.coverBody ?? data,
              scenario.coverStatus ?? 200);
          },
        }, close: async () => {} };
      }, close: async () => {},
    });
    const result = await probe(mobile, fakeLaunch(), marker,
      async (raw) => { assert.equal(JSON.parse(raw).reviewId, data.reviewId);
        return 1; }, async (candidate) => {
      assert.equal(candidate.reviewId, data.reviewId); return 1;
    });
    assert.equal(calls, 2);
    assert.equal(result.decision, 'cover_candidate_private_saved');
    assert.equal(result.articleRequests, 0);
    assert.equal(result.listRequests, 0);
    assert.equal(result.privateRawSaved, true);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private|fixture-secret/);
    calls = 0;
    const initRejected = await probe(mobile,
      fakeLaunch({ initStatus: 401 }), marker,
      async () => { throw Error('raw_save_must_not_run'); },
      async () => { throw Error('save_must_not_run'); });
    assert.equal(calls, 1);
    assert.equal(initRejected.decision, 'stop_authentication_rejected');
    calls = 0;
    const rateLimited = await probe(mobile,
      fakeLaunch({ coverBody: { errCode: -2014 } }), marker,
      async () => { throw Error('raw_save_must_not_run'); },
      async () => { throw Error('save_must_not_run'); });
    assert.equal(calls, 2);
    assert.equal(rateLimited.decision, 'stop_rate_limit');
    calls = 0;
    const unknown = await probe(mobile,
      fakeLaunch({ coverBody: { unexpected: { field: 'fixture-private-raw' } } }),
      marker, async (raw) => { writeRawCover(scratch, raw); return 1; },
      async () => { throw Error('candidate_save_must_not_run'); });
    assert.equal(calls, 2);
    assert.equal(unknown.decision, 'stop_source_identity');
    assert.equal(unknown.privateRawSaved, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, RAW_COVER),
      'utf8')).unexpected.field, 'fixture-private-raw');
    assert.doesNotMatch(JSON.stringify(unknown), /fixture-private-raw/);
    fs.unlinkSync(path.join(scratch, RAW_COVER));
    calls = 0;
    let rawWrites = 0;
    const rawRetry = await probe(mobile,
      fakeLaunch({ coverBody: { unexpected: 'fixture-private-raw' } }),
      marker, (raw) => persistUntilDurable(scratch, raw, {
        writer: (root, value) => {
          if (++rawWrites === 1) throw Error('disk_fixture');
          writeRawCover(root, value);
        }, pause: async () => {}, notify: () => {},
      }), async () => { throw Error('candidate_save_must_not_run'); });
    assert.equal(calls, 2);
    assert.equal(rawWrites, 2);
    assert.equal(rawRetry.privateRawPersistAttempts, 2);
    assert.equal(rawRetry.decision, 'stop_source_identity');
    assert.doesNotMatch(JSON.stringify(rawRetry), /fixture-private-raw/);
  } finally {
    for (const name of fs.readdirSync(scratch))
      fs.unlinkSync(path.join(scratch, name));
    fs.rmdirSync(scratch);
  }
  return { decision: 'self_test_passed', realNetworkRequests: 0,
    productionWrites: 0 };
}

async function main() {
  let options;
  try { options = args(process.argv.slice(2)); }
  catch { console.log(JSON.stringify({ decision: 'usage_gate',
    requestCount: 0 })); process.exitCode = 2; return; }
  if (options.mode === '--plan') {
    console.log(JSON.stringify({ decision: 'plan_only',
      credentialSource: 'private_refresh_recovery_only',
      endpoint: '/web/mp/cover', bookId: BOOK_ID,
      initRequestMax: 1, coverRequestMax: 1, articleRequests: 0,
      listRequests: 0, redirects: false, retries: false,
      privateOutput: 'repo_ignored_private_data', productionWrites: 0,
      boundedJsonSavedBeforeIdentityGate: true,
      requestCount: 0 })); return;
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
  let ready, verified;
  try {
    ready = preflight(options.dbPath, options.runDir);
    if (options.mode === '--execute')
      verified = runtime(options.modulePath, options.browserPath);
  } catch (error) {
    const safe = new Set(['cover_already_attempted', 'db_path_gate',
      'private_root_gate', 'target_feed_gate', 'target_backup_gate',
      'run_dir_gate', 'refresh_marker_gate', 'health_marker_gate',
      'recovery_gate', 'source_backup_gate', 'recovery_identity_gate',
      'db_gate', 'account_gate', 'mobile_gate', 'integrity_gate',
      'sqlite_runtime_gate', 'runtime_gate']);
    console.log(JSON.stringify({ decision: safe.has(error.message) ?
      error.message : 'preflight_gate', requestCount: 0 }));
    process.exitCode = 1; return;
  }
  if (options.mode === '--preflight') {
    console.log(JSON.stringify({ decision: 'preflight_ready',
      sourceAndBackupMatched: true, targetFeedMatched: true,
      existingCoverHistory: false, credentialSource:
      'private_refresh_recovery_only', networkRequests: 0,
      productionWrites: 0 })); return;
  }
  let marker;
  try { marker = markAttempt(ready.privateRoot); }
  catch { console.log(JSON.stringify({ decision: 'cover_marker_gate',
    requestCount: 0 })); process.exitCode = 1; return; }
  const launch = () => verified.chromium.launch({
    executablePath: verified.browserPath, headless: true,
    args: ['--disable-background-networking', '--no-proxy-server',
      '--no-first-run', '--no-default-browser-check'],
  });
  const result = await probe(ready.mobile, launch, marker,
    (raw) => persistUntilDurable(ready.privateRoot, raw,
      { writer: writeRawCover }),
    (record) => persistUntilDurable(ready.privateRoot, record));
  console.log(JSON.stringify(result));
  if (result.decision !== 'cover_candidate_private_saved') process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { args, privateRootGate, historyGate, targetGate,
  coverShape, candidateRecord, writeCandidate, writeRawCover, readCoverJson,
  persistUntilDurable,
  probe, selfTest };
