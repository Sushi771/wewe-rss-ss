#!/usr/bin/env node
'use strict';

// One first-page search with the privately recovered mobile token. Offline by
// default; never requests an article, a later page, or a search page.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflight, within, sqliteApi } =
  require('./probe-mobile-refresh-preflight.cjs');
const { environmentGate, recoveryGate, runtime, readPayload, numericCode,
  hint, statusStop, cookieGate, setCookieNames } =
  require('./probe-refreshed-mobile-web-health.cjs');

const ORIGIN = 'https://weread.qq.com';
const SEARCH_PAGE_ORIGIN = 'https://search.weixin.qq.com';
const INIT = `${ORIGIN}/web/login/session/init`;
const SEARCH = `${ORIGIN}/web/wx_search_broker_proxy`;
const TARGET_NAME = '妈妈部落畅聊阁';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const MARKER = 'refreshed-mobile-target-search-attempt.json';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEARCH_LIMIT = 512 * 1024;
const MAX_DIGESTS = 30;

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

function markerGate(runDir) {
  if (fs.existsSync(path.join(runDir, MARKER))) throw Error('already_attempted');
}

function markAttempt(runDir) {
  const fd = fs.openSync(path.join(runDir, MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ kind: 'refreshed-mobile-target-search',
      endpoints: ['/web/login/session/init', '/web/wx_search_broker_proxy'],
      attemptedAt: new Date().toISOString() }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function initialSearchBody() {
  // The first-party PC component starts with offset=0, searchcookies="",
  // and an unset searchID. JSON.stringify omits undefined searchid.
  return JSON.stringify({ query: TARGET_NAME, offset: 0,
    searchid: undefined, searchcookies: '' });
}

function targetBiz(item) {
  try {
    const url = new URL(item.doc_url);
    return url.protocol === 'https:' &&
      url.hostname === 'mp.weixin.qq.com' &&
      url.searchParams.get('__biz') === TARGET_BIZ;
  } catch { return false; }
}

function digest(item) {
  const key = typeof item.docID === 'string' && item.docID ?
    `docID:${item.docID}` :
    typeof item.docID === 'number' && Number.isSafeInteger(item.docID) ?
      `docID:${item.docID}` :
      typeof item.doc_url === 'string' && item.doc_url ?
        `doc_url:${item.doc_url}` : null;
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : null;
}

function summarize(content) {
  const summary = { bucketCount: 0, itemCount: 0,
    sourceNameMatches: 0, explicitBizMatches: 0, bothMatches: 0,
    articleKeyDigests: [], digestTruncated: false,
    hasOffset: Object.hasOwn(content || {}, 'offset'),
    hasSearchID: Object.hasOwn(content || {}, 'searchID'),
    hasSearchCookies: Object.hasOwn(content || {}, 'cookies'),
    hasContinueFlag: Object.hasOwn(content || {}, 'continueFlag'),
    canContinue: Boolean(content?.continueFlag) };
  if (!content || !Array.isArray(content.data))
    return { stop: 'stop_search_shape', summary };
  summary.bucketCount = content.data.length;
  for (const bucket of content.data) {
    if (!bucket || !Array.isArray(bucket.items))
      return { stop: 'stop_search_shape', summary };
    for (const item of bucket.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        return { stop: 'stop_search_shape', summary };
      summary.itemCount++;
      const nameMatch = typeof item.source?.title === 'string' &&
        item.source.title.trim() === TARGET_NAME;
      const bizMatch = targetBiz(item);
      if (nameMatch) summary.sourceNameMatches++;
      if (bizMatch) summary.explicitBizMatches++;
      if (nameMatch && bizMatch) summary.bothMatches++;
      if (!nameMatch && !bizMatch) continue;
      const keyDigest = digest(item);
      if (summary.articleKeyDigests.length < MAX_DIGESTS) {
        summary.articleKeyDigests.push({ keyDigest,
          match: nameMatch && bizMatch ? 'both' :
            bizMatch ? 'biz' : 'source_name',
          hasDocID: typeof item.docID === 'string' ||
            Number.isSafeInteger(item.docID),
          hasDocUrl: typeof item.doc_url === 'string' && !!item.doc_url,
          hasTimestamp: Number.isFinite(item.timestamp),
          hasSourceDateTime: item.source != null &&
            Object.hasOwn(item.source, 'dateTime') });
      } else summary.digestTruncated = true;
    }
  }
  return { stop: null, summary };
}

async function searchPayload(response) {
  const length = Number(response.headers()['content-length']);
  if (Number.isFinite(length) && length > SEARCH_LIMIT)
    return { stop: 'stop_body_limit' };
  const buffer = await response.body();
  if (buffer.length > SEARCH_LIMIT) return { stop: 'stop_body_limit' };
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
  if (errCode === -2010 || ret === -2010)
    return { stop: 'stop_business_code_minus_2010', errCode, ret };
  if ((errCode !== null && errCode !== 0) ||
      (ret !== null && ret !== 0 && ret !== -1))
    return { stop: 'stop_business_error', errCode, ret };
  const contentRet = numericCode(data.content?.ret);
  if (Object.hasOwn(data.content || {}, 'ret') && contentRet === null)
    return { stop: 'stop_uninterpretable_business_code', errCode, ret };
  if (contentRet !== null && contentRet !== 0)
    return { stop: 'stop_content_business_error', errCode, ret, contentRet };
  return { data, errCode, ret, contentRet, stop: null };
}

async function probe(mobile, launch) {
  const out = { decision: 'stop_browser_or_context', requestCount: 0,
    initRequests: 0, searchRequests: 0, shelfRequests: 0,
    pageNavigations: 0, articleRequests: 0, continuationRequests: 0,
    credentialSource: 'private_refresh_recovery_only' };
  let browser, context;
  try {
    browser = await launch();
    context = await browser.newContext({ serviceWorkers: 'block',
      acceptDownloads: false, userAgent: USER_AGENT });
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
        timeout: 10_000, maxRedirects: 0, maxRetries: 0 });
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
    out.initRet = initData.ret ?? null;
    if (initData.stop) { out.decision = initData.stop; return out; }
    if (Object.hasOwn(initData.data, 'success') &&
        numericCode(initData.data.success) !== 1) {
      out.decision = 'stop_init_not_success'; return out;
    }
    const gate = cookieGate(await context.cookies(SEARCH), mobile.vid);
    out.searchCookieNames = gate.names;
    out.searchCookieCount = gate.count;
    out.wrVidMatchesRecovery = gate.identityMatch;
    if (!gate.ready) {
      out.decision = 'stop_cookie_scope_or_identity'; return out;
    }
    let search;
    try {
      out.searchRequests = 1;
      out.requestCount = 2;
      search = await context.request.post(SEARCH, {
        data: initialSearchBody(),
        headers: { 'content-type': 'application/json; charset=utf-8',
          origin: SEARCH_PAGE_ORIGIN },
        timeout: 20_000, maxRedirects: 0, maxRetries: 0 });
    } catch { out.decision = 'stop_search_transport_or_timeout'; return out; }
    out.searchHttp = search.status();
    if (out.searchHttp !== 200) {
      out.decision = statusStop(out.searchHttp);
      await search.dispose(); return out;
    }
    let found;
    try { found = await searchPayload(search); }
    catch { out.decision = 'stop_search_body_read'; return out; }
    finally { await search.dispose(); }
    out.searchCode = found.errCode ?? null;
    out.searchRet = found.ret ?? null;
    out.contentRet = found.contentRet ?? null;
    if (found.stop) { out.decision = found.stop; return out; }
    const observed = summarize(found.data.content);
    Object.assign(out, observed.summary);
    out.decision = observed.stop ?? 'first_page_observed';
    return out;
  } catch { out.decision = 'stop_browser_or_context'; return out; }
  finally {
    try { await context?.close(); } catch { /* No raw browser errors. */ }
    try { await browser?.close(); } catch { /* No raw browser errors. */ }
  }
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(() => environmentGate({ NODE_DEBUG: 'http' }),
    /environment_gate/);
  assert.deepEqual(JSON.parse(initialSearchBody()), { query: TARGET_NAME,
    offset: 0, searchcookies: '' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refreshed-target-test-'));
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
    const runDir = ready.privateRunDir;
    fs.writeFileSync(path.join(runDir, 'mobile-refresh-attempt.json'),
      JSON.stringify({ kind: 'mobile-refresh-once', endpoint: '/login',
        attemptedAt: new Date().toISOString() }));
    const recovery = { formatVersion: 2,
      kind: 'mobile-refresh-response-tokens',
      decision: 'candidate_identity_matched', httpStatus: 200,
      businessCode: null, accountId: 'fixture-account',
      originalMobile: oldMobile,
      responseTokenFields: { vid: 'fixture-vid', accessToken: 'new-access' },
      proposedMobile: { ...oldMobile, accessToken: 'new-access' } };
    fs.writeFileSync(path.join(runDir, 'mobile-refresh-recovery.json'),
      JSON.stringify(recovery));
    assert.throws(() => recoveryGate(dbPath, runDir, 'present'));
    fs.writeFileSync(path.join(runDir,
      'refreshed-mobile-web-health-attempt.json'), JSON.stringify({
      kind: 'refreshed-mobile-web-health',
      endpoints: ['/web/login/session/init', '/web/shelf/sync'],
      attemptedAt: new Date().toISOString() }));
    const mobile = recoveryGate(dbPath, runDir, 'present').mobile;
    assert.equal(mobile.accessToken, 'new-access');
    fs.writeFileSync(path.join(runDir, 'mobile-refresh-recovery.json'),
      JSON.stringify({ ...recovery, accountId: 'wrong-account' }));
    assert.throws(() => recoveryGate(dbPath, runDir, 'present'),
      /source_backup_gate/);
    fs.writeFileSync(path.join(runDir, 'mobile-refresh-recovery.json'),
      JSON.stringify(recovery));
    let calls = 0;
    function fakeLaunch(options = {}) {
      const cookies = [{ name: 'wr_vid', value: options.wrongVid ?
        'wrong' : 'fixture-vid' }, { name: 'wr_skey', value: 'fixture-web' },
      { name: 'wr_rt', value: 'fixture-rt' }];
      let initialized = false;
      const response = (body) => ({ status: () => options.http ?? 200,
        headers: () => ({ 'content-type': 'application/json' }),
        headersArray: () => cookies.map((cookie) => ({ name: 'Set-Cookie',
          value: `${cookie.name}=${cookie.value}; Path=/; Secure` })),
        body: async () => Buffer.from(JSON.stringify(body)),
        dispose: async () => {} });
      return async () => ({ newContext: async () => ({
        cookies: async () => initialized ? cookies : [],
        request: { post: async (url, request) => {
          calls++;
          assert.equal(request.maxRedirects, 0);
          assert.equal(request.maxRetries, 0);
          assert.equal(request.headers.cookie, undefined);
          if (url === INIT) {
            assert.equal(request.data.skey, 'new-access');
            initialized = true;
            return response(options.initBody ?? { success: 1 });
          }
          assert.equal(url, SEARCH);
          assert.equal(request.headers.origin, SEARCH_PAGE_ORIGIN);
          assert.equal(request.headers.referer, undefined);
          assert.deepEqual(JSON.parse(request.data), { query: TARGET_NAME,
            offset: 0, searchcookies: '' });
          return response(options.searchBody ?? { ret: -1, content: {
            data: [{ items: [{ docID: 'fixture-article',
              source: { title: TARGET_NAME, dateTime: 'fixture-date' },
              doc_url: `https://mp.weixin.qq.com/s?__biz=${TARGET_BIZ}&mid=1&idx=1`,
              timestamp: 1 }] }], continueFlag: true,
            offset: 1, searchID: 'private-cursor', cookies: 'private-cookie' } });
        } }, close: async () => {} }), close: async () => {} });
    }
    const good = await probe(mobile, fakeLaunch());
    assert.equal(good.decision, 'first_page_observed');
    assert.equal(good.requestCount, 2);
    assert.equal(good.bothMatches, 1);
    assert.equal(good.canContinue, true);
    assert.equal(good.articleKeyDigests.length, 1);
    assert.equal(good.articleKeyDigests[0].hasSourceDateTime, true);
    assert.equal(/fixture-article|private-cursor|private-cookie|new-access/
      .test(JSON.stringify(good)), false);
    calls = 0;
    assert.equal((await probe(mobile, fakeLaunch({ initBody: {
      errMsg: '请完成验证码' } }))).decision, 'stop_verification');
    assert.equal(calls, 1);
    calls = 0;
    assert.equal((await probe(mobile, fakeLaunch({ wrongVid: true })))
      .decision, 'stop_cookie_scope_or_identity');
    assert.equal(calls, 1);
    calls = 0;
    assert.equal((await probe(mobile, fakeLaunch({ searchBody: {
      errCode: -2012 } }))).decision, 'stop_auth_expired_candidate');
    assert.equal(calls, 2);
    calls = 0;
    assert.equal((await probe(mobile, fakeLaunch({ searchBody: {
      errMsg: '请求频繁' } }))).decision, 'stop_rate_limit');
    assert.equal(calls, 2);
    calls = 0;
    assert.equal((await probe(mobile, fakeLaunch({ searchBody: {
      content: {} } }))).decision, 'stop_search_shape');
    assert.equal(calls, 2);
    markAttempt(runDir);
    assert.throws(() => markerGate(runDir), /already_attempted/);
  } finally {
    const base = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(root);
    if (!within(base, resolved) ||
        !path.basename(resolved).startsWith('refreshed-target-test-'))
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
      queryKind: 'confirmed_exact_source_name',
      firstPageBodyKeys: ['query', 'offset', 'searchcookies'],
      omittedUnsetSearchid: true, initRequestMax: 1,
      searchRequestMax: 1, shelfRequestMax: 0,
      continuationRequests: 0, articleRequests: 0, pageNavigations: 0,
      redirects: false, retries: false, productionReads: 0,
      productionWrites: 0, requestCount: 0 }));
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
    credentials = recoveryGate(options.dbPath, options.runDir, 'present');
    markerGate(credentials.runDir);
    verified = runtime(options.modulePath, options.browserPath);
    markAttempt(credentials.runDir);
  } catch (error) {
    const safe = new Set(['already_attempted', 'run_dir_gate',
      'refresh_marker_gate', 'health_marker_gate', 'recovery_gate',
      'source_backup_gate', 'recovery_identity_gate', 'db_gate',
      'private_root_gate', 'account_gate', 'mobile_gate', 'integrity_gate',
      'sqlite_runtime_gate', 'runtime_gate']);
    console.log(JSON.stringify({ decision: safe.has(error.message) ?
      error.message : 'preflight_gate', requestCount: 0 }));
    process.exitCode = 1; return;
  }
  const launch = () => verified.chromium.launch({
    executablePath: verified.browserPath, headless: true,
    args: ['--disable-background-networking', '--no-proxy-server',
      '--no-first-run', '--no-default-browser-check'] });
  const result = await probe(credentials.mobile, launch);
  console.log(JSON.stringify(result));
  if (result.decision !== 'first_page_observed') process.exitCode = 1;
}

if (require.main === module) main();
