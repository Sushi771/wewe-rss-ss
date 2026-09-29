#!/usr/bin/env node
'use strict';

// One isolated mobile-to-Web bridge followed by one first-party search.
// Plan and SelfTest never read SQLite credentials or send network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = 'https://weread.qq.com';
const INIT_PATH = '/web/login/session/init';
const SEARCH_PATH = '/web/wx_search_broker_proxy';
const QUERY = '妈妈部落畅聊阁';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INIT_MAX_BYTES = 64 * 1024;
const SEARCH_MAX_BYTES = 512 * 1024;

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!['--plan', '--self-test', '--execute'].includes(mode))
    throw Error('usage');
  if (mode !== '--execute') {
    if (rest.length) throw Error('usage');
    return { mode };
  }
  if (
    rest.length !== 3 ||
    rest[0] !== '--db' ||
    !path.isAbsolute(rest[1]) ||
    rest[2] !== '--approved-online'
  )
    throw Error('usage');
  return { mode, dbPath: rest[1] };
}

function mobileFromRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('account_gate');
  let token;
  try {
    token = JSON.parse(rows[0].token);
  } catch {
    throw Error('account_json_gate');
  }
  const mobile = token?.mobile;
  const vid =
    typeof mobile?.vid === 'string'
      ? mobile.vid
      : Number.isSafeInteger(mobile?.vid) && mobile.vid > 0
        ? String(mobile.vid)
        : '';
  if (
    !vid.trim() ||
    typeof mobile?.accessToken !== 'string' ||
    !mobile.accessToken.trim() ||
    typeof mobile?.refreshToken !== 'string' ||
    !mobile.refreshToken.trim() ||
    typeof mobile?.deviceId !== 'string' ||
    !mobile.deviceId.trim()
  )
    throw Error('mobile_gate');
  return {
    vid,
    accessToken: mobile.accessToken,
    refreshToken: mobile.refreshToken,
  };
}

function readOnlyRows(dbPath) {
  if (!fs.statSync(dbPath).isFile()) throw Error('database_gate');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    return db.prepare('SELECT token FROM accounts LIMIT 2').all();
  } finally {
    db.close();
  }
}

function initOptions(mobile) {
  return {
    method: 'POST',
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      vid: mobile.vid,
      pf: 0,
      skey: mobile.accessToken,
      rt: mobile.refreshToken,
    }),
    signal: AbortSignal.timeout(10_000),
  };
}

function searchOptions(cookie) {
  return {
    method: 'POST',
    redirect: 'manual',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': USER_AGENT,
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      cookie,
    },
    body: JSON.stringify({ query: QUERY }),
    signal: AbortSignal.timeout(20_000),
  };
}

async function boundedText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw Error('body_limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function code(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value))
    return Number(value);
  return null;
}

function hint(value) {
  if (typeof value !== 'string') return null;
  if (/验证码|captcha|人机验证|安全验证|请完成验证|环境异常/i.test(value))
    return 'verification';
  if (
    /请求频繁|访问频繁|访问过于频繁|限流|限频|rate.?limit|too many|throttl/i.test(
      value,
    )
  )
    return 'rate_limit';
  if (
    /登录失效|登录过期|未登录|unauthori[sz]ed|authentication failed/i.test(
      value,
    )
  )
    return 'authentication';
  return null;
}

function responseType(headers) {
  const value = headers.get('content-type') || '';
  if (/\bjson\b/i.test(value)) return 'json';
  if (/\bhtml\b/i.test(value)) return 'html';
  return 'other_or_missing';
}

function cookieFromInit(headers, vid) {
  const allowed = new Set(['wr_vid', 'wr_skey', 'wr_rt']);
  const values = Object.create(null);
  let conflict = false;
  let otherCount = 0;
  for (const line of headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(';');
    const at = pair.indexOf('=');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim();
    if (!allowed.has(name)) {
      otherCount += 1;
      continue;
    }
    const value = pair.slice(at + 1);
    if (!value || /[\x00-\x20\x7f;,]/.test(value))
      return { decision: 'stop_cookie_shape' };
    let cookiePath = '/web/login/session'; // Default path for the init URL.
    for (const raw of attributes) {
      const [key, ...tail] = raw.trim().split('=');
      const attributeValue = tail.join('=').trim();
      if (
        key.toLowerCase() === 'domain' &&
        attributeValue.toLowerCase().replace(/^\./, '') !== 'weread.qq.com'
      )
        return { decision: 'stop_cookie_scope' };
      if (key.toLowerCase() === 'path') cookiePath = attributeValue;
    }
    if (
      !cookiePath.startsWith('/') ||
      !(
        SEARCH_PATH === cookiePath ||
        (SEARCH_PATH.startsWith(cookiePath) &&
          (cookiePath.endsWith('/') || SEARCH_PATH[cookiePath.length] === '/'))
      )
    )
      return { decision: 'stop_cookie_scope' };
    if (Object.hasOwn(values, name) && values[name] !== value) conflict = true;
    values[name] = value;
  }
  const namesPresent = {
    wr_vid: Boolean(values.wr_vid),
    wr_skey: Boolean(values.wr_skey),
    wr_rt: Boolean(values.wr_rt),
  };
  const identityMatch = values.wr_vid ? values.wr_vid === vid : null;
  if (conflict)
    return {
      decision: 'stop_cookie_conflict',
      namesPresent,
      otherCount,
      identityMatch,
    };
  if (!namesPresent.wr_skey || identityMatch !== true)
    return {
      decision: 'stop_cookie_identity_or_key',
      namesPresent,
      otherCount,
      identityMatch,
    };
  const cookie = ['wr_vid', 'wr_skey', 'wr_rt']
    .filter((name) => values[name])
    .map((name) => `${name}=${values[name]}`)
    .join('; ');
  return {
    decision: 'cookie_ready',
    namesPresent,
    otherCount,
    identityMatch,
    cookie,
  };
}

function non200Decision(status) {
  if (status === 401 || status === 403) return 'stop_authentication_rejected';
  if (status === 429) return 'stop_rate_limit';
  if (status >= 300 && status < 400) return 'stop_redirect';
  return 'stop_http_error';
}

function parseEnvelope(body, phase) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return {
      decision:
        hint(body) === 'verification'
          ? 'stop_verification'
          : hint(body) === 'rate_limit'
            ? 'stop_rate_limit'
            : 'stop_non_json',
    };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { decision: 'stop_response_shape' };
  const shape = {
    hasErrCode: Object.hasOwn(payload, 'errCode'),
    hasRet: Object.hasOwn(payload, 'ret'),
    hasContent: Object.hasOwn(payload, 'content'),
  };
  const errCode = code(payload.errCode);
  const retCode = code(payload.ret);
  const text = typeof payload.errMsg === 'string' ? payload.errMsg : '';
  const risk = hint(text);
  let decision = null;
  if (risk === 'verification') decision = 'stop_verification';
  else if (risk === 'rate_limit') decision = 'stop_rate_limit';
  else if (errCode === -2012 || retCode === -2012)
    decision = 'stop_auth_expired_candidate';
  else if (phase === 'search' && errCode === -2010)
    decision = 'stop_business_code_minus_2010';
  else if (risk === 'authentication') decision = 'stop_authentication_rejected';
  else if (
    (shape.hasErrCode && errCode === null) ||
    (shape.hasRet && retCode === null)
  )
    decision = 'stop_uninterpretable_business_code';
  else if (
    (errCode !== null && errCode !== 0) ||
    (retCode !== null &&
      retCode !== 0 &&
      !(phase === 'search' && retCode === -1))
  )
    decision = 'stop_business_error';
  return { payload, shape, errCode, retCode, decision };
}

function summarizeSearch(content) {
  const summary = {
    hasDataArray: Array.isArray(content?.data),
    hasContinueFlag: Object.hasOwn(content || {}, 'continueFlag'),
    hasOffset: Object.hasOwn(content || {}, 'offset'),
    hasSearchID: Object.hasOwn(content || {}, 'searchID'),
    hasSearchCookies: Object.hasOwn(content || {}, 'cookies'),
    bucketCount: 0,
    itemCount: 0,
    sourceTitlePresent: 0,
    docUrlPresent: 0,
    timestampPresent: 0,
    sourceDateTimePresent: 0,
    targetNameMatches: 0,
    explicitBizMatches: 0,
    targetNameAndBizMatches: 0,
  };
  if (!summary.hasDataArray) return { decision: 'stop_search_shape', summary };
  summary.bucketCount = content.data.length;
  for (const bucket of content.data) {
    if (!bucket || !Array.isArray(bucket.items))
      return { decision: 'stop_search_shape', summary };
    for (const item of bucket.items) {
      if (!item || typeof item !== 'object')
        return { decision: 'stop_search_shape', summary };
      summary.itemCount += 1;
      const sourceName = item.source?.title;
      const namePresent =
        typeof sourceName === 'string' && sourceName.length > 0;
      const nameMatch = namePresent && sourceName.trim() === QUERY;
      const urlPresent =
        typeof item.doc_url === 'string' && item.doc_url.length > 0;
      if (namePresent) summary.sourceTitlePresent += 1;
      if (urlPresent) summary.docUrlPresent += 1;
      if (typeof item.timestamp === 'number' && Number.isFinite(item.timestamp))
        summary.timestampPresent += 1;
      if (item.source && Object.hasOwn(item.source, 'dateTime'))
        summary.sourceDateTimePresent += 1;
      if (nameMatch) summary.targetNameMatches += 1;
      if (!urlPresent) continue;
      try {
        const url = new URL(item.doc_url);
        const bizMatch =
          url.protocol === 'https:' &&
          url.hostname === 'mp.weixin.qq.com' &&
          url.searchParams.get('__biz') === TARGET_BIZ;
        if (bizMatch) {
          summary.explicitBizMatches += 1;
          if (nameMatch) summary.targetNameAndBizMatches += 1;
        }
      } catch {
        // A malformed link is not evidence of the target account.
      }
    }
  }
  return { decision: 'first_page_observed', summary };
}

async function runProbe(readRows, fetchOnce) {
  const result = {
    requestCount: 0,
    initRequests: 0,
    searchRequests: 0,
    credentialSource: 'single_accounts_token_mobile_only',
    endpointPaths: [INIT_PATH, SEARCH_PATH],
  };
  let mobile;
  try {
    mobile = mobileFromRows(await readRows());
  } catch {
    return { ...result, decision: 'stop_local_credential_gate' };
  }

  let init;
  try {
    result.initRequests = result.requestCount = 1;
    init = await fetchOnce(`${ORIGIN}${INIT_PATH}`, initOptions(mobile));
  } catch {
    return { ...result, decision: 'stop_init_transport_or_timeout' };
  }
  result.initHttpStatus = init.status;
  result.initContentType = responseType(init.headers);
  if (init.status !== 200)
    return { ...result, decision: non200Decision(init.status) };
  let initBody;
  try {
    initBody = await boundedText(init, INIT_MAX_BYTES);
  } catch {
    return { ...result, decision: 'stop_init_body_limit_or_read_error' };
  }
  const initEnvelope = parseEnvelope(initBody, 'init');
  result.initResponseShape = initEnvelope.shape || null;
  result.initBusinessCode = initEnvelope.errCode ?? null;
  result.initRetCode = initEnvelope.retCode ?? null;
  if (initEnvelope.decision)
    return { ...result, decision: initEnvelope.decision };
  const cookieState = cookieFromInit(init.headers, mobile.vid);
  result.initSetCookieNamesPresent = cookieState.namesPresent || null;
  result.initOtherSetCookieCount = cookieState.otherCount ?? null;
  result.wrVidMatchesMobile = cookieState.identityMatch ?? null;
  if (cookieState.decision !== 'cookie_ready')
    return { ...result, decision: cookieState.decision };

  let search;
  try {
    result.searchRequests = 1;
    result.requestCount = 2;
    search = await fetchOnce(
      `${ORIGIN}${SEARCH_PATH}`,
      searchOptions(cookieState.cookie),
    );
  } catch {
    return { ...result, decision: 'stop_search_transport_or_timeout' };
  }
  result.searchHttpStatus = search.status;
  result.searchContentType = responseType(search.headers);
  if (search.status !== 200)
    return { ...result, decision: non200Decision(search.status) };
  let searchBody;
  try {
    searchBody = await boundedText(search, SEARCH_MAX_BYTES);
  } catch {
    return { ...result, decision: 'stop_search_body_limit_or_read_error' };
  }
  const envelope = parseEnvelope(searchBody, 'search');
  result.searchResponseShape = envelope.shape || null;
  result.searchBusinessCode = envelope.errCode ?? null;
  result.searchRetCode = envelope.retCode ?? null;
  if (envelope.decision) return { ...result, decision: envelope.decision };
  const content = envelope.payload.content;
  result.searchContentRet = code(content?.ret);
  if (Object.hasOwn(content || {}, 'ret') && result.searchContentRet === null)
    return { ...result, decision: 'stop_uninterpretable_business_code' };
  if (result.searchContentRet === -2010)
    return { ...result, decision: 'stop_business_code_minus_2010' };
  if (result.searchContentRet === -2012)
    return { ...result, decision: 'stop_auth_expired_candidate' };
  if (result.searchContentRet !== null && result.searchContentRet !== 0)
    return { ...result, decision: 'stop_business_error' };
  const observed = summarizeSearch(content);
  return { ...result, ...observed.summary, decision: observed.decision };
}

async function selfTest() {
  const fake = {
    vid: '12345',
    accessToken: 'fixture-mobile-access',
    refreshToken: 'fixture-mobile-refresh',
    deviceId: 'fixture-device',
  };
  const rows = () => [
    { token: JSON.stringify({ mobile: fake, accessToken: 'top-level-decoy' }) },
  ];
  const initResponse = () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'wr_vid=12345; Path=/; Secure');
    headers.append('set-cookie', 'wr_skey=fixture-web; Path=/; Secure');
    headers.append('set-cookie', 'wr_rt=fixture-rt; Path=/; Secure');
    return new Response(JSON.stringify({ errCode: 0 }), {
      status: 200,
      headers,
    });
  };
  const fakeArticle = new URL('/s', 'https://mp.weixin.qq.com');
  fakeArticle.searchParams.set('__biz', TARGET_BIZ);
  fakeArticle.searchParams.set('mid', '1');
  fakeArticle.searchParams.set('idx', '1');
  let calls = 0;
  const success = await runProbe(rows, async (url, options) => {
    calls += 1;
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'POST');
    if (calls === 1) {
      assert.equal(url, `${ORIGIN}${INIT_PATH}`);
      assert.equal(options.headers.cookie, undefined);
      assert.deepEqual(JSON.parse(options.body), {
        vid: fake.vid,
        pf: 0,
        skey: fake.accessToken,
        rt: fake.refreshToken,
      });
      return initResponse();
    }
    assert.equal(url, `${ORIGIN}${SEARCH_PATH}`);
    assert.equal(options.credentials, 'include');
    assert.deepEqual(JSON.parse(options.body), { query: QUERY });
    assert.equal(options.headers.origin, ORIGIN);
    assert.equal(options.headers.referer, `${ORIGIN}/`);
    assert.equal(
      options.headers.cookie,
      'wr_vid=12345; wr_skey=fixture-web; wr_rt=fixture-rt',
    );
    return new Response(
      JSON.stringify({
        errCode: 0,
        ret: -1,
        content: {
          ret: 0,
          data: [
            {
              items: [
                {
                  source: { title: QUERY, dateTime: 'fixture' },
                  doc_url: fakeArticle.href,
                  timestamp: 1,
                },
              ],
            },
            { items: [{ source: { title: 'unrelated' }, timestamp: 2 }] },
          ],
          continueFlag: 1,
          offset: 2,
          searchID: 'fixture',
          cookies: 'fixture',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  assert.equal(calls, 2);
  assert.equal(success.decision, 'first_page_observed');
  assert.equal(success.searchRetCode, -1);
  assert.equal(success.targetNameMatches, 1);
  assert.equal(success.explicitBizMatches, 1);
  assert.equal(success.searchRequests, 1);
  assert.equal(
    /fixture-|top-level-decoy|mp\.weixin\.qq\.com|妈妈部落/.test(
      JSON.stringify(success),
    ),
    false,
  );

  let stoppedCalls = 0;
  const expired = await runProbe(rows, async () => {
    stoppedCalls += 1;
    return new Response(JSON.stringify({ errCode: -2012 }), { status: 200 });
  });
  assert.equal(stoppedCalls, 1);
  assert.equal(expired.searchRequests, 0);
  assert.equal(expired.decision, 'stop_auth_expired_candidate');
  const twoAccounts = await runProbe(
    () => [...rows(), ...rows()],
    async () => {
      throw Error('must_not_fetch');
    },
  );
  assert.equal(twoAccounts.requestCount, 0);
  let mismatchCalls = 0;
  const mismatch = await runProbe(rows, async () => {
    mismatchCalls += 1;
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'wr_vid=999; Path=/');
    headers.append('set-cookie', 'wr_skey=fixture-web; Path=/');
    return new Response('{}', { status: 200, headers });
  });
  assert.equal(mismatchCalls, 1);
  assert.equal(mismatch.searchRequests, 0);
  assert.equal(mismatch.decision, 'stop_cookie_identity_or_key');
  let limitedCalls = 0;
  const limited = await runProbe(rows, async () => {
    limitedCalls += 1;
    return limitedCalls === 1
      ? initResponse()
      : new Response('', { status: 429 });
  });
  assert.equal(limitedCalls, 2);
  assert.equal(limited.decision, 'stop_rate_limit');
  let verificationCalls = 0;
  const verification = await runProbe(rows, async () => {
    verificationCalls += 1;
    return verificationCalls === 1
      ? initResponse()
      : new Response(JSON.stringify({ errCode: 0, errMsg: '请完成验证' }), {
          status: 200,
        });
  });
  assert.equal(verificationCalls, 2);
  assert.equal(verification.decision, 'stop_verification');
  let narrowCookieCalls = 0;
  const narrowCookie = await runProbe(rows, async () => {
    narrowCookieCalls += 1;
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'wr_vid=12345; Path=/web/login; Secure');
    headers.append(
      'set-cookie',
      'wr_skey=fixture-web; Path=/web/login; Secure',
    );
    return new Response('{}', { status: 200, headers });
  });
  assert.equal(narrowCookieCalls, 1);
  assert.equal(narrowCookie.decision, 'stop_cookie_scope');
  let unknownCodeCalls = 0;
  const unknownCode = await runProbe(rows, async () => {
    unknownCodeCalls += 1;
    return unknownCodeCalls === 1
      ? initResponse()
      : new Response(JSON.stringify({ errCode: -2010 }), { status: 200 });
  });
  assert.equal(unknownCodeCalls, 2);
  assert.equal(unknownCode.decision, 'stop_business_code_minus_2010');
  let emptyDataCalls = 0;
  const emptyData = await runProbe(rows, async () => {
    emptyDataCalls += 1;
    return emptyDataCalls === 1
      ? initResponse()
      : new Response(JSON.stringify({ ret: -1, content: {} }), { status: 200 });
  });
  assert.equal(emptyDataCalls, 2);
  assert.equal(emptyData.decision, 'stop_search_shape');
  let contentErrorCalls = 0;
  const contentError = await runProbe(rows, async () => {
    contentErrorCalls += 1;
    return contentErrorCalls === 1
      ? initResponse()
      : new Response(
          JSON.stringify({ ret: -1, content: { ret: -2, data: [] } }),
          { status: 200 },
        );
  });
  assert.equal(contentErrorCalls, 2);
  assert.equal(contentError.decision, 'stop_business_error');
  return {
    selfTest: 'passed',
    scenarios: 10,
    sqliteReads: 0,
    networkRequests: 0,
    productionWrites: 0,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    process.stdout.write(
      JSON.stringify({ decision: 'stop_usage', requestCount: 0 }) + '\n',
    );
    process.exitCode = 2;
    return;
  }
  if (args.mode === '--plan') {
    process.stdout.write(
      JSON.stringify({
        decision: 'offline_plan_only',
        credentialSource: 'single_accounts_token_mobile_only',
        endpointPaths: [INIT_PATH, SEARCH_PATH],
        initRequestLimit: 1,
        searchRequestLimit: 1,
        paginationRequests: 0,
        articleRequests: 0,
        redirects: false,
        retries: false,
        refreshes: false,
        sqliteReads: 0,
        networkRequests: 0,
      }) + '\n',
    );
    return;
  }
  if (args.mode === '--self-test') {
    try {
      process.stdout.write(JSON.stringify(await selfTest()) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ selfTest: 'failed' }) + '\n');
      process.exitCode = 1;
    }
    return;
  }
  if (process.env.NODE_USE_ENV_PROXY === '1') {
    process.stdout.write(
      JSON.stringify({ decision: 'stop_proxy_environment', requestCount: 0 }) +
        '\n',
    );
    process.exitCode = 1;
    return;
  }
  const result = await runProbe(() => readOnlyRows(args.dbPath), fetch);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.decision !== 'first_page_observed') process.exitCode = 1;
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: 'stop_unexpected' }) + '\n');
  process.exitCode = 1;
});
