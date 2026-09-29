#!/usr/bin/env node
'use strict';

// Bounded credential bridge probe. Plan and self-test never read a database or
// contact Tencent. Execute is deliberately explicit and sends at most one POST.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT = 'https://weread.qq.com/web/login/session/init';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const COOKIE_NAMES = ['wr_vid', 'wr_skey', 'wr_rt'];

function parseArgs(args) {
  const [mode, ...rest] = args;
  if (!['--plan', '--self-test', '--execute'].includes(mode))
    throw new Error('usage');
  if (mode !== '--execute') {
    if (rest.length) throw new Error('usage');
    return { mode };
  }
  if (
    rest.length !== 3 ||
    rest[0] !== '--db' ||
    !path.isAbsolute(rest[1]) ||
    rest[2] !== '--approved-online'
  )
    throw new Error('usage');
  return { mode, dbPath: rest[1] };
}

function mobileFromRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('one_account_required');
  let token;
  try {
    token = JSON.parse(rows[0].token);
  } catch {
    throw new Error('invalid_account_json');
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
    throw new Error('incomplete_mobile_credentials');
  return {
    vid,
    accessToken: mobile.accessToken,
    refreshToken: mobile.refreshToken,
  };
}

function readOnlyRows(dbPath) {
  if (!fs.statSync(dbPath).isFile()) throw new Error('database_not_file');
  // This is loaded only for --execute; Plan and SelfTest need no SQLite access.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    return db.prepare('SELECT token FROM accounts LIMIT 2').all();
  } finally {
    db.close();
  }
}

function requestOptions(mobile) {
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

async function boundedText(response) {
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
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('response_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function cookieFacts(headers, vid) {
  const values = Object.create(null);
  const conflicts = new Set();
  let otherSetCookieCount = 0;
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    if (!COOKIE_NAMES.includes(name)) {
      otherSetCookieCount += 1;
      continue;
    }
    const value = pair.slice(separator + 1);
    if (Object.hasOwn(values, name) && values[name] !== value)
      conflicts.add(name);
    values[name] = value;
  }
  return {
    namesPresent: {
      wr_vid: Boolean(values.wr_vid),
      wr_skey: Boolean(values.wr_skey),
      wr_rt: Boolean(values.wr_rt),
    },
    otherSetCookieCount,
    identityMatch:
      values.wr_vid && !conflicts.has('wr_vid') ? values.wr_vid === vid : null,
    conflict: conflicts.size > 0,
  };
}

function safeCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value))
    return Number(value);
  return null;
}

function challengeKind(text) {
  if (/验证码|captcha|人机验证|安全验证/i.test(text)) return 'verification';
  if (/请求频繁|访问频繁|限流|限频|rate.?limit|too many|throttl/i.test(text))
    return 'rate_limit';
  if (
    /登录失效|登录过期|未登录|unauthori[sz]ed|authentication failed/i.test(text)
  )
    return 'authentication';
  return null;
}

function contentTypeKind(value) {
  if (/\bjson\b/i.test(value || '')) return 'json';
  if (/\bhtml\b/i.test(value || '')) return 'html';
  return 'other_or_missing';
}

async function runProbe(readRows, fetchOnce) {
  const result = {
    requestCount: 0,
    credentialSource: 'single_accounts_token_mobile_only',
    endpoint: '/web/login/session/init',
  };
  let mobile;
  try {
    mobile = mobileFromRows(await readRows());
  } catch {
    return { ...result, decision: 'stop_local_credential_gate' };
  }

  let response;
  try {
    result.requestCount = 1;
    response = await fetchOnce(ENDPOINT, requestOptions(mobile));
  } catch {
    return { ...result, decision: 'stop_transport_or_timeout' };
  }

  result.httpStatus = response.status;
  result.contentType = contentTypeKind(response.headers.get('content-type'));
  const cookies = cookieFacts(response.headers, mobile.vid);
  result.setCookieNamesPresent = cookies.namesPresent;
  result.otherSetCookieCount = cookies.otherSetCookieCount;
  result.wrVidMatchesMobile = cookies.identityMatch;

  if (response.status !== 200) {
    return {
      ...result,
      decision:
        response.status === 401 || response.status === 403
          ? 'stop_authentication_rejected'
          : response.status === 429
            ? 'stop_rate_limit'
            : response.status >= 300 && response.status < 400
              ? 'stop_redirect'
              : 'stop_http_error',
    };
  }

  let body;
  try {
    body = await boundedText(response);
  } catch {
    return { ...result, decision: 'stop_body_limit_or_read_error' };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ...result,
      decision:
        challengeKind(body) === 'verification'
          ? 'stop_verification'
          : challengeKind(body) === 'rate_limit'
            ? 'stop_rate_limit'
            : 'stop_non_json',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ...result, decision: 'stop_response_shape' };
  result.responseShape = {
    hasErrCode: Object.hasOwn(parsed, 'errCode'),
    hasErrMsg: Object.hasOwn(parsed, 'errMsg'),
    hasRet: Object.hasOwn(parsed, 'ret'),
    hasData: Object.hasOwn(parsed, 'data'),
    hasSucc: Object.hasOwn(parsed, 'succ'),
  };
  result.businessCode = safeCode(parsed.errCode);
  result.retCode = safeCode(parsed.ret);
  const hint = challengeKind(
    typeof parsed.errMsg === 'string' ? parsed.errMsg : '',
  );
  if (hint === 'verification')
    return { ...result, decision: 'stop_verification' };
  if (hint === 'rate_limit') return { ...result, decision: 'stop_rate_limit' };
  if (
    hint === 'authentication' ||
    result.businessCode === -2012 ||
    result.retCode === -2012
  )
    return { ...result, decision: 'stop_authentication_rejected' };
  if (
    (result.responseShape.hasErrCode && result.businessCode === null) ||
    (result.responseShape.hasRet && result.retCode === null)
  )
    return { ...result, decision: 'stop_uninterpretable_business_code' };
  if (
    (result.businessCode !== null && result.businessCode !== 0) ||
    (result.retCode !== null && result.retCode !== 0)
  )
    return { ...result, decision: 'stop_business_error' };
  if (cookies.conflict)
    return { ...result, decision: 'stop_conflicting_cookies' };
  if (!cookies.namesPresent.wr_skey)
    return { ...result, decision: 'stop_missing_wr_skey' };
  if (cookies.identityMatch !== true)
    return { ...result, decision: 'stop_identity_unverified' };
  return {
    ...result,
    decision: 'candidate_web_cookie_issued',
    sessionUsabilityVerified: false,
  };
}

async function selfTest() {
  let simulatedFetches = 0;
  const fake = {
    vid: '12345',
    accessToken: 'fixture-mobile-access-secret',
    refreshToken: 'fixture-mobile-refresh-secret',
    deviceId: 'fixture-device',
  };
  const rows = () => [
    {
      token: JSON.stringify({
        mobile: fake,
        accessToken: 'fixture-top-level-must-never-send',
      }),
    },
  ];
  const success = async (url, options) => {
    simulatedFetches += 1;
    assert.equal(url, ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(options.body), {
      vid: '12345',
      pf: 0,
      skey: fake.accessToken,
      rt: fake.refreshToken,
    });
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', 'wr_vid=12345; Path=/; Secure');
    headers.append('Set-Cookie', 'wr_skey=fixture-web-secret; Path=/; Secure');
    return new Response(JSON.stringify({ errCode: 0 }), {
      status: 200,
      headers,
    });
  };
  const observed = await runProbe(rows, success);
  assert.equal(observed.decision, 'candidate_web_cookie_issued');
  assert.equal(observed.wrVidMatchesMobile, true);
  assert.equal(observed.requestCount, 1);
  assert.equal(simulatedFetches, 1);
  assert.equal(
    /fixture-.*secret|fixture-top-level/.test(JSON.stringify(observed)),
    false,
  );
  const rejected = await runProbe(rows, async () => {
    simulatedFetches += 1;
    return new Response(JSON.stringify({ errCode: -2012 }), { status: 200 });
  });
  assert.equal(rejected.decision, 'stop_authentication_rejected');
  let blockedFetches = 0;
  const twoAccounts = await runProbe(
    () => [...rows(), ...rows()],
    async () => {
      blockedFetches += 1;
      throw new Error('must_not_run');
    },
  );
  assert.equal(twoAccounts.requestCount, 0);
  assert.equal(blockedFetches, 0);
  const wrongIdentity = await runProbe(rows, async () => {
    simulatedFetches += 1;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', 'wr_vid=999; Path=/');
    headers.append('Set-Cookie', 'wr_skey=fixture-web-secret; Path=/');
    return new Response('{}', { status: 200, headers });
  });
  assert.equal(wrongIdentity.decision, 'stop_identity_unverified');
  const verification = await runProbe(rows, async () => {
    simulatedFetches += 1;
    return new Response(JSON.stringify({ errCode: 0, errMsg: '验证码' }), {
      status: 200,
    });
  });
  assert.equal(verification.decision, 'stop_verification');
  const rateLimit = await runProbe(rows, async () => {
    simulatedFetches += 1;
    return new Response('', { status: 429 });
  });
  assert.equal(rateLimit.decision, 'stop_rate_limit');
  const badCode = await runProbe(rows, async () => {
    simulatedFetches += 1;
    return new Response(JSON.stringify({ errCode: 'unreadable' }), {
      status: 200,
    });
  });
  assert.equal(badCode.decision, 'stop_uninterpretable_business_code');
  assert.equal(simulatedFetches, 6);
  return {
    selfTest: 'passed',
    scenarios: 7,
    sqliteReads: 0,
    networkRequests: 0,
    simulatedFetches,
    productionWrites: 0,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    process.stdout.write(
      JSON.stringify({ decision: 'stop_usage', networkRequests: 0 }) + '\n',
    );
    process.exitCode = 2;
    return;
  }
  if (args.mode === '--plan') {
    process.stdout.write(
      JSON.stringify({
        decision: 'offline_plan_only',
        credentialSource: 'single_accounts_token_mobile_only',
        endpoint: '/web/login/session/init',
        liveRequestLimit: 1,
        redirects: false,
        retries: false,
        refreshes: false,
        followupRequests: 0,
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
  // Explicit execution is reserved for the reviewed online experiment.
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
  if (result.decision !== 'candidate_web_cookie_issued') process.exitCode = 1;
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: 'stop_unexpected' }) + '\n');
  process.exitCode = 1;
});
