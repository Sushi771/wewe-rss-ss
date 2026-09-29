#!/usr/bin/env node
'use strict';

// Offline-reviewable, one-shot BrowserContext.request experiment. It never
// opens a page, observes browser traffic, or writes a session snapshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = 'https://weread.qq.com';
const INIT = `${ORIGIN}/web/login/session/init`;
const SHELF = `${ORIGIN}/web/shelf/sync?userVid=&synckey=0&lectureSynckey=0`;
const SEARCH = `${ORIGIN}/web/wx_search_broker_proxy`;
const TARGET_NAME = '妈妈部落畅聊阁';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VERSION = '1.58.2';
const LIMITS = { init: 64 * 1024, shelf: 128 * 1024, search: 512 * 1024 };

function args(argv) {
  const [mode, ...rest] = argv;
  if (mode === '--plan' || mode === '--self-test') {
    if (rest.length) throw Error('usage');
    return { mode };
  }
  if (mode === '--runtime-check' && rest.length === 4 &&
      rest[0] === '--playwright-core' && rest[2] === '--browser' &&
      path.isAbsolute(rest[1]) && path.isAbsolute(rest[3]))
    return { mode, modulePath: rest[1], browserPath: rest[3] };
  if (mode === '--execute' && rest.length === 7 &&
      rest[0] === '--db' && rest[2] === '--playwright-core' &&
      rest[4] === '--browser' && rest[6] === '--approved-online' &&
      [rest[1], rest[3], rest[5]].every(path.isAbsolute))
    return { mode, dbPath: rest[1], modulePath: rest[3], browserPath: rest[5] };
  throw Error('usage');
}

function mobileFromRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('account_gate');
  let token;
  try { token = JSON.parse(rows[0].token); } catch { throw Error('account_gate'); }
  const mobile = token?.mobile;
  const vid = typeof mobile?.vid === 'string' ? mobile.vid :
    Number.isSafeInteger(mobile?.vid) && mobile.vid > 0 ? String(mobile.vid) : '';
  if (!vid.trim() || typeof mobile?.accessToken !== 'string' || !mobile.accessToken.trim() ||
      typeof mobile?.refreshToken !== 'string' || !mobile.refreshToken.trim() ||
      typeof mobile?.deviceId !== 'string' || !mobile.deviceId.trim())
    throw Error('mobile_gate');
  return { vid, accessToken: mobile.accessToken, refreshToken: mobile.refreshToken };
}

function readOnlyRows(dbPath) {
  if (!fs.statSync(dbPath).isFile()) throw Error('db_gate');
  // Never loaded by --plan, --self-test, or --runtime-check.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    return db.prepare('SELECT token FROM accounts LIMIT 2').all();
  } finally { db.close(); }
}

function runtime(modulePath, browserPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json'), 'utf8'));
  if (manifest.name !== 'playwright-core' || manifest.version !== VERSION ||
      !fs.statSync(browserPath).isFile() ||
      !/^(?:msedge|chrome)\.exe$/i.test(path.basename(browserPath)))
    throw Error('runtime_gate');
  const { chromium } = require(modulePath);
  if (typeof chromium?.launch !== 'function') throw Error('runtime_gate');
  return { chromium, browserPath };
}

function code(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value)) return Number(value);
  return null;
}

function hint(value) {
  if (typeof value !== 'string') return null;
  if (/验证码|captcha|人机验证|安全验证|请完成验证|环境异常/i.test(value)) return 'verification';
  if (/请求频繁|访问频繁|限流|限频|rate.?limit|too many|throttl/i.test(value)) return 'rate_limit';
  if (/登录失效|登录过期|未登录|unauthori[sz]ed|authentication failed/i.test(value)) return 'authentication';
  return null;
}

function non200(status) {
  if (status === 401 || status === 403) return 'stop_authentication_rejected';
  if (status === 429) return 'stop_rate_limit';
  if (status >= 300 && status < 400) return 'stop_redirect';
  return 'stop_http_status';
}

function contentType(response) {
  const header = response.headers()['content-type'] || '';
  if (/\bjson\b/i.test(header)) return 'json';
  if (/\bhtml\b/i.test(header)) return 'html';
  return 'other_or_missing';
}

async function payload(response, phase) {
  const buffer = await response.body();
  if (buffer.length > LIMITS[phase]) return { stop: 'stop_body_limit' };
  const text = buffer.toString('utf8');
  let data;
  try { data = JSON.parse(text); } catch {
    const risk = hint(text);
    return { stop: risk === 'verification' ? 'stop_verification' :
      risk === 'rate_limit' ? 'stop_rate_limit' : 'stop_non_json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { stop: 'stop_response_shape' };
  const shape = {
    hasErrCode: Object.hasOwn(data, 'errCode'),
    hasRet: Object.hasOwn(data, 'ret'),
    hasContent: Object.hasOwn(data, 'content'),
  };
  const errCode = code(data.errCode), ret = code(data.ret);
  const risk = hint(typeof data.errMsg === 'string' ? data.errMsg : '');
  let stop = null;
  if (risk === 'verification') stop = 'stop_verification';
  else if (risk === 'rate_limit') stop = 'stop_rate_limit';
  else if (errCode === -2012 || ret === -2012) stop = 'stop_auth_expired_candidate';
  else if (errCode === -2010 || ret === -2010) stop = 'stop_business_code_minus_2010';
  else if (risk === 'authentication') stop = 'stop_authentication_rejected';
  else if ((shape.hasErrCode && errCode === null) || (shape.hasRet && ret === null))
    stop = 'stop_uninterpretable_business_code';
  else if ((errCode !== null && errCode !== 0) ||
           (ret !== null && ret !== 0 && !(phase === 'search' && ret === -1)))
    stop = 'stop_business_error';
  return { data, shape, errCode, ret, stop };
}

function cookieNames(response) {
  return [...new Set(response.headersArray()
    .filter(h => h.name.toLowerCase() === 'set-cookie')
    .map(h => h.value.split(';', 1)[0].split('=', 1)[0].trim())
    .filter(name => /^[A-Za-z0-9_]{1,64}$/.test(name)))].sort();
}

function cookieSnapshot(cookies) {
  return new Map(cookies.map(c => [`${c.name}\0${c.domain}\0${c.path}`, c.value]));
}

function rotated(before, after) {
  const older = cookieSnapshot(before);
  const newer = cookieSnapshot(after);
  return older.size !== newer.size || [...older].some(([key, value]) => newer.get(key) !== value);
}

function cookieGate(cookies, vid) {
  const key = name => cookies.filter(c => c.name === name && c.value);
  const wrVid = key('wr_vid'), wrSkey = key('wr_skey');
  return {
    names: [...new Set(cookies.map(c => c.name))].sort(),
    count: cookies.length,
    wrVidMatchesMobile: wrVid.length === 1 ? wrVid[0].value === vid : false,
    wrSkeyPresent: wrSkey.length === 1,
    ready: wrVid.length === 1 && wrVid[0].value === vid && wrSkey.length === 1,
  };
}

function summarizeSearch(content) {
  const summary = {
    hasDataArray: Array.isArray(content?.data),
    hasContinueFlag: Object.hasOwn(content || {}, 'continueFlag'),
    hasOffset: Object.hasOwn(content || {}, 'offset'),
    hasSearchID: Object.hasOwn(content || {}, 'searchID'),
    hasSearchCookies: Object.hasOwn(content || {}, 'cookies'),
    bucketCount: 0, itemCount: 0, sourceTitlePresent: 0, docUrlPresent: 0,
    timestampPresent: 0, sourceDateTimePresent: 0,
    targetNameMatches: 0, explicitBizMatches: 0, targetNameAndBizMatches: 0,
  };
  if (!summary.hasDataArray) return { stop: 'stop_search_shape', summary };
  summary.bucketCount = content.data.length;
  for (const bucket of content.data) {
    if (!bucket || !Array.isArray(bucket.items)) return { stop: 'stop_search_shape', summary };
    for (const item of bucket.items) {
      if (!item || typeof item !== 'object') return { stop: 'stop_search_shape', summary };
      summary.itemCount++;
      const name = item.source?.title;
      const namePresent = typeof name === 'string' && Boolean(name);
      const nameMatch = namePresent && name.trim() === TARGET_NAME;
      const urlPresent = typeof item.doc_url === 'string' && Boolean(item.doc_url);
      if (namePresent) summary.sourceTitlePresent++;
      if (urlPresent) summary.docUrlPresent++;
      if (typeof item.timestamp === 'number' && Number.isFinite(item.timestamp)) summary.timestampPresent++;
      if (item.source && Object.hasOwn(item.source, 'dateTime')) summary.sourceDateTimePresent++;
      if (nameMatch) summary.targetNameMatches++;
      if (!urlPresent) continue;
      try {
        const u = new URL(item.doc_url);
        if (u.protocol === 'https:' && u.hostname === 'mp.weixin.qq.com' &&
            u.searchParams.get('__biz') === TARGET_BIZ) {
          summary.explicitBizMatches++;
          if (nameMatch) summary.targetNameAndBizMatches++;
        }
      } catch { /* Malformed URL is not account evidence. */ }
    }
  }
  return { stop: null, summary };
}

async function runProbe(readRows, launch) {
  const out = {
    decision: 'stop_local_gate', requestCount: 0, initRequests: 0,
    shelfRequests: 0, searchRequests: 0, pageNavigations: 0,
    credentialSource: 'single_accounts_token_mobile_only',
  };
  let mobile;
  try { mobile = mobileFromRows(await readRows()); }
  catch { return out; }
  let browser, context;
  try {
    browser = await launch();
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,
      userAgent: USER_AGENT });
    if ((await context.cookies()).length) { out.decision = 'stop_nonempty_context'; return out; }
    let init;
    try {
      out.initRequests = out.requestCount = 1;
      init = await context.request.post(INIT, {
        data: { vid: mobile.vid, pf: 0, skey: mobile.accessToken, rt: mobile.refreshToken },
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        timeout: 10_000, maxRedirects: 0, maxRetries: 0,
      });
    } catch { out.decision = 'stop_init_transport_or_timeout'; return out; }
    out.initHttp = init.status();
    out.initType = contentType(init);
    out.initSetCookieNames = cookieNames(init);
    if (out.initHttp !== 200) { out.decision = non200(out.initHttp); return out; }
    let initData;
    try { initData = await payload(init, 'init'); }
    catch { out.decision = 'stop_init_body_read'; return out; }
    finally { await init.dispose(); }
    out.initShape = initData.shape || null;
    out.initCode = initData.errCode ?? null;
    out.initRet = initData.ret ?? null;
    if (initData.stop) { out.decision = initData.stop; return out; }
    const shelfCookies = await context.cookies(SHELF);
    const searchCookies = await context.cookies(SEARCH);
    const shelfGate = cookieGate(shelfCookies, mobile.vid);
    const searchGate = cookieGate(searchCookies, mobile.vid);
    out.shelfCookieNames = shelfGate.names;
    out.searchCookieNames = searchGate.names;
    out.shelfCookieCount = shelfGate.count;
    out.searchCookieCount = searchGate.count;
    out.wrVidMatchesMobile = shelfGate.wrVidMatchesMobile && searchGate.wrVidMatchesMobile;
    out.wrSkeyApplicable = shelfGate.wrSkeyPresent && searchGate.wrSkeyPresent;
    if (!shelfGate.ready || !searchGate.ready) {
      out.decision = 'stop_cookie_scope_or_identity'; return out;
    }
    let shelf;
    try {
      out.shelfRequests = 1; out.requestCount = 2;
      shelf = await context.request.get(SHELF, {
        headers: { accept: 'application/json, text/plain, */*', referer: `${ORIGIN}/` },
        timeout: 10_000, maxRedirects: 0, maxRetries: 0,
      });
    } catch { out.decision = 'stop_shelf_transport_or_timeout'; return out; }
    out.shelfHttp = shelf.status();
    out.shelfType = contentType(shelf);
    if (out.shelfHttp !== 200) { out.decision = non200(out.shelfHttp); return out; }
    let shelfData;
    try { shelfData = await payload(shelf, 'shelf'); }
    catch { out.decision = 'stop_shelf_body_read'; return out; }
    finally { await shelf.dispose(); }
    out.shelfShape = shelfData.shape || null;
    out.shelfCode = shelfData.errCode ?? null;
    out.shelfRet = shelfData.ret ?? null;
    if (shelfData.stop) { out.decision = shelfData.stop; return out; }
    out.shelfHasBooks = Array.isArray(shelfData.data.books);
    out.shelfHasSyncKey = Object.hasOwn(shelfData.data, 'synckey');
    out.shelfHealth = out.shelfHasBooks || out.shelfHasSyncKey ? 'valid' : 'unknown';
    if (out.shelfHealth !== 'valid') { out.decision = 'stop_shelf_health_unknown'; return out; }
    const searchCookiesAfterShelf = await context.cookies(SEARCH);
    out.cookiesRotatedAfterShelf = rotated(searchCookies, searchCookiesAfterShelf);
    if (!cookieGate(searchCookiesAfterShelf, mobile.vid).ready) {
      out.decision = 'stop_cookie_changed_or_missing'; return out;
    }
    let search;
    try {
      out.searchRequests = 1; out.requestCount = 3;
      search = await context.request.post(SEARCH, {
        data: { query: TARGET_NAME },
        headers: { 'content-type': 'application/json; charset=utf-8', origin: ORIGIN, referer: `${ORIGIN}/` },
        timeout: 20_000, maxRedirects: 0, maxRetries: 0,
      });
    } catch { out.decision = 'stop_search_transport_or_timeout'; return out; }
    out.searchHttp = search.status();
    out.searchType = contentType(search);
    out.cookiesRotatedAfterSearch = rotated(searchCookiesAfterShelf, await context.cookies(SEARCH));
    if (out.searchHttp !== 200) { out.decision = non200(out.searchHttp); return out; }
    let searchData;
    try { searchData = await payload(search, 'search'); }
    catch { out.decision = 'stop_search_body_read'; return out; }
    finally { await search.dispose(); }
    out.searchShape = searchData.shape || null;
    out.searchCode = searchData.errCode ?? null;
    out.searchRet = searchData.ret ?? null;
    if (searchData.stop) { out.decision = searchData.stop; return out; }
    const content = searchData.data.content;
    out.searchContentRet = code(content?.ret);
    if (Object.hasOwn(content || {}, 'ret') && out.searchContentRet === null) {
      out.decision = 'stop_uninterpretable_business_code'; return out;
    }
    if (out.searchContentRet === -2010) { out.decision = 'stop_business_code_minus_2010'; return out; }
    if (out.searchContentRet === -2012) { out.decision = 'stop_auth_expired_candidate'; return out; }
    if (out.searchContentRet !== null && out.searchContentRet !== 0) {
      out.decision = 'stop_business_error'; return out;
    }
    const observed = summarizeSearch(content);
    Object.assign(out, observed.summary);
    out.decision = observed.stop || 'first_page_observed';
    return out;
  } catch {
    out.decision = 'stop_browser_or_context'; return out;
  } finally {
    try { await context?.close(); } catch { /* No raw browser errors. */ }
    try { await browser?.close(); } catch { /* No raw browser errors. */ }
  }
}

async function selfTest() {
  const mobile = { vid: '123', accessToken: 'fixture-mobile-access',
    refreshToken: 'fixture-mobile-refresh', deviceId: 'fixture-device' };
  const rows = () => [{ token: JSON.stringify({ mobile, accessToken: 'top-level-decoy' }) }];
  const response = (body, status = 200, setCookies = []) => ({
    status: () => status,
    headers: () => ({ 'content-type': 'application/json' }),
    headersArray: () => setCookies.map(value => ({ name: 'Set-Cookie', value })),
    body: async () => Buffer.from(JSON.stringify(body)),
    dispose: async () => {},
  });
  const cookies = [
    ['wr_vid', '123'], ['wr_skey', 'fixture-web'], ['wr_rt', 'fixture-rt'],
    ['extra_one', 'fixture-one'], ['extra_two', 'fixture-two'],
  ].map(([name, value]) => ({ name, value, domain: 'weread.qq.com', path: '/' }));
  const makeBrowser = (shelfBody, searchBody, shelfStatus = 200) => {
    const calls = [];
    let initialized = false;
    const context = {
      cookies: async () => initialized ? cookies : [],
      request: {
        post: async (url, options) => {
          calls.push({ url, options });
          assert.equal(options.maxRedirects, 0);
          assert.equal(options.maxRetries, 0);
          assert.equal(options.headers.cookie, undefined);
          if (url === INIT) {
            assert.deepEqual(options.data, {
              vid: '123', pf: 0, skey: mobile.accessToken, rt: mobile.refreshToken,
            });
            initialized = true;
            return response({}, 200, cookies.map(c => `${c.name}=${c.value}; Path=/; Secure`));
          }
          assert.equal(url, SEARCH);
          assert.deepEqual(options.data, { query: TARGET_NAME });
          return response(searchBody);
        },
        get: async (url, options) => {
          calls.push({ url, options });
          assert.equal(url, SHELF);
          assert.equal(options.maxRedirects, 0);
          assert.equal(options.maxRetries, 0);
          assert.equal(options.headers.cookie, undefined);
          return response(shelfBody, shelfStatus);
        },
      },
      close: async () => {},
    };
    return { calls, launch: async () => ({ newContext: async () => context, close: async () => {} }) };
  };
  const targetLink = new URL('/s', 'https://mp.weixin.qq.com');
  targetLink.searchParams.set('__biz', TARGET_BIZ);
  const good = makeBrowser({ books: [], synckey: 0 }, {
    ret: -1, content: { ret: 0, data: [{ items: [{ source: { title: TARGET_NAME },
      doc_url: targetLink.toString(), timestamp: 1 }] }] },
  });
  const observed = await runProbe(rows, good.launch);
  assert.equal(observed.decision, 'first_page_observed');
  assert.equal(observed.requestCount, 3);
  assert.equal(observed.searchCookieCount, 5);
  assert.equal(observed.targetNameAndBizMatches, 1);
  assert.equal(good.calls.length, 3);
  assert.equal(/fixture-|top-level-decoy/.test(JSON.stringify(observed)), false);
  const invalidShelf = makeBrowser({ errCode: -2012 }, {});
  const stopped = await runProbe(rows, invalidShelf.launch);
  assert.equal(stopped.decision, 'stop_auth_expired_candidate');
  assert.equal(stopped.searchRequests, 0);
  assert.equal(invalidShelf.calls.length, 2);
  const unknownShelf = makeBrowser({}, {});
  const unknown = await runProbe(rows, unknownShelf.launch);
  assert.equal(unknown.decision, 'stop_shelf_health_unknown');
  assert.equal(unknown.searchRequests, 0);
  const limited = makeBrowser({ books: [] }, { errCode: -2010 });
  assert.equal((await runProbe(rows, limited.launch)).decision, 'stop_business_code_minus_2010');
  const authCandidate = makeBrowser({ books: [] }, { errCode: -2012 });
  assert.equal((await runProbe(rows, authCandidate.launch)).decision, 'stop_auth_expired_candidate');
  const rateLimitedShelf = makeBrowser({}, {}, 429);
  const rateLimited = await runProbe(rows, rateLimitedShelf.launch);
  assert.equal(rateLimited.decision, 'stop_rate_limit');
  assert.equal(rateLimited.searchRequests, 0);
  const blocked = await runProbe(() => [...rows(), ...rows()], async () => { throw Error('launch_must_not_run'); });
  assert.equal(blocked.requestCount, 0);
  return { selfTest: 'passed', scenarios: 7, sqliteReads: 0,
    networkRequests: 0, pageNavigations: 0, productionWrites: 0 };
}

async function main() {
  let parsed;
  try { parsed = args(process.argv.slice(2)); }
  catch { return { decision: 'stop_usage', requestCount: 0 }; }
  if (parsed.mode === '--plan') return {
    decision: 'offline_plan_only', sqliteReads: 0, networkRequests: 0,
    credentialSource: 'single_accounts_token_mobile_only',
    context: 'nonpersistent_browser_context_request_full_cookie_jar',
    initRequestMax: 1, shelfRequestMax: 1, searchRequestMax: 1,
    pageNavigations: 0, redirects: false, retries: false,
    refreshes: false, paginationRequests: 0, articleRequests: 0,
  };
  if (parsed.mode === '--self-test') {
    try { return await selfTest(); } catch { return { selfTest: 'failed', networkRequests: 0 }; }
  }
  if (['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'DEBUG', 'PWDEBUG', 'NODE_DEBUG'].some(name => Boolean(process.env[name])))
    return { decision: 'stop_unsafe_environment', requestCount: 0 };
  let verified;
  try { verified = runtime(parsed.modulePath, parsed.browserPath); }
  catch { return { decision: 'stop_runtime_gate', requestCount: 0 }; }
  const launch = () => verified.chromium.launch({ executablePath: verified.browserPath,
    headless: true, args: ['--disable-background-networking', '--no-proxy-server',
      '--no-first-run', '--no-default-browser-check'] });
  if (parsed.mode === '--runtime-check') {
    let browser, context;
    try {
      browser = await launch();
      context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      await context.setOffline(true);
      return { runtimeCheck: 'passed', playwrightCoreVersion: VERSION,
        sqliteReads: 0, targetRequests: 0, pageNavigations: 0 };
    } catch { return { runtimeCheck: 'failed', targetRequests: 0 }; }
    finally { try { await context?.close(); } catch {} try { await browser?.close(); } catch {} }
  }
  return await runProbe(() => readOnlyRows(parsed.dbPath), launch);
}

main().then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.decision?.startsWith('stop_') || result.selfTest === 'failed' || result.runtimeCheck === 'failed')
    process.exitCode = 1;
}).catch(() => {
  // No raw exception, request, response, browser path, or credential reaches stdout.
  process.stdout.write(JSON.stringify({ decision: 'stop_unexpected' }) + '\n');
  process.exitCode = 1;
});
