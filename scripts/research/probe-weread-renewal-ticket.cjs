#!/usr/bin/env node
'use strict';

// One isolated Web init followed by one cookie renewal. No MP/list request.
// Responses are reduced to status, codes, cookie names and header booleans.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  environmentGate,
  recoveryGate,
  numericCode,
} = require('./probe-refreshed-mobile-web-health.cjs');
const { privateRootGate } = require('./probe-weread-web-mp-cover.cjs');

const ORIGIN = 'https://weread.qq.com';
const INIT = `${ORIGIN}/web/login/session/init`;
const RENEWAL = `${ORIGIN}/web/login/renewal`;
const MARKER = 'weread-renewal-ticket.attempted.json';
const RESULT = 'weread-renewal-ticket.result.json';
const LIMIT = 64 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

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
    return { mode: argv[0], dbPath: argv[2], runDir: argv[4] };
  if (
    argv.length === 6 &&
    argv[0] === '--execute' &&
    argv[1] === '--db' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--run-dir' &&
    path.isAbsolute(argv[4]) &&
    argv[5] === '--approved-online'
  )
    return { mode: argv[0], dbPath: argv[2], runDir: argv[4] };
  throw Error('usage_gate');
}

function historyGate(privateRoot) {
  const dirs = [
    privateRoot,
    ...fs
      .readdirSync(privateRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith('mobile-refresh-'),
      )
      .map((entry) => path.join(privateRoot, entry.name)),
  ];
  if (
    dirs.some((dir) =>
      [MARKER, RESULT].some((name) => fs.existsSync(path.join(dir, name))),
    )
  )
    throw Error('renewal_already_attempted');
}

function preflight(dbPath, runDir) {
  const credentials = recoveryGate(dbPath, runDir, 'present');
  const privateRoot = privateRootGate(dbPath, credentials.runDir);
  historyGate(privateRoot);
  return { privateRoot, mobile: credentials.mobile };
}

function markAttempt(privateRoot) {
  const fd = fs.openSync(path.join(privateRoot, MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        kind: 'weread-renewal-ticket-once',
        endpoints: ['/web/login/session/init', '/web/login/renewal'],
        attemptedAt: new Date().toISOString(),
      }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function saveSanitized(privateRoot, result) {
  const fd = fs.openSync(path.join(privateRoot, RESULT), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(result) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function cookieJar(headers) {
  const jar = new Map();
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';', 1)[0];
    const split = pair.indexOf('=');
    if (split < 1) continue;
    const name = pair.slice(0, split).trim();
    const value = pair.slice(split + 1).trim();
    if (!COOKIE_NAME.test(name) || !value || /[\r\n;]/.test(value)) continue;
    if (jar.has(name) && jar.get(name) !== value)
      throw Error('conflicting_set_cookie');
    jar.set(name, value);
  }
  return jar;
}

function cookieNames(headers) {
  return [...cookieJar(headers).keys()].sort();
}

function headerPresent(headers, name) {
  const value = headers.get(name);
  return typeof value === 'string' && value.trim() !== '';
}

async function boundedJson(response) {
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > LIMIT)
    return { stop: 'stop_body_limit' };
  if (!response.body) return { stop: 'stop_missing_body' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMIT) {
        await reader.cancel();
        return { stop: 'stop_body_limit' };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      stop: /验证码|captcha|人机验证|安全验证/i.test(text)
        ? 'stop_verification'
        : 'stop_non_json',
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { stop: 'stop_response_shape' };
  const errCode = numericCode(data.errCode);
  if (Object.hasOwn(data, 'errCode') && errCode === null)
    return { stop: 'stop_unknown_error_code' };
  const message = [data.errMsg, data.msg, data.message]
    .filter((value) => typeof value === 'string')
    .join(' ');
  if (/验证码|captcha|人机验证|安全验证|请完成验证|环境异常/i.test(message))
    return { stop: 'stop_verification', errCode };
  if (/请求频繁|访问频繁|限流|限频|rate.?limit|too many|throttl/i.test(message))
    return { stop: 'stop_rate_limit', errCode };
  if (
    /登录失效|登录超时|登录过期|未登录|unauthori[sz]ed/i.test(message) ||
    [-2010, -2012].includes(errCode)
  )
    return { stop: 'stop_authentication_rejected', errCode };
  if (errCode === -2041)
    return { stop: 'stop_verification_or_restriction', errCode };
  if (errCode !== null && errCode !== 0)
    return { stop: 'stop_business_error', errCode };
  return { data, errCode: errCode ?? null, stop: null };
}

function httpStop(status) {
  if (status === 401 || status === 403) return 'stop_authentication_rejected';
  if (status === 429) return 'stop_rate_limit';
  if (status >= 300 && status < 400) return 'stop_redirect';
  return 'stop_http_status';
}

function post(url, body, extraHeaders = {}) {
  return {
    method: 'POST',
    redirect: 'manual',
    cache: 'no-store',
    credentials: 'omit',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json; charset=UTF-8',
      'user-agent': USER_AGENT,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  };
}

async function probe(mobile, fetchOnce) {
  const out = {
    decision: 'stop_before_request',
    credentialSource: 'private_refresh_recovery_only',
    requestCount: 0,
    initRequests: 0,
    renewalRequests: 0,
    listRequests: 0,
    productionWrites: 0,
  };
  let init;
  try {
    out.initRequests = out.requestCount = 1;
    init = await fetchOnce(
      INIT,
      post(INIT, {
        vid: mobile.vid,
        pf: 0,
        skey: mobile.accessToken,
        rt: mobile.refreshToken,
      }),
    );
  } catch {
    out.decision = 'stop_init_transport_or_timeout';
    return out;
  }
  out.initHttp = init.status;
  let jar;
  try {
    jar = cookieJar(init.headers);
    out.initSetCookieNames = [...jar.keys()].sort();
  } catch {
    out.decision = 'stop_init_cookie_shape';
    return out;
  }
  if (init.status !== 200) {
    out.decision = httpStop(init.status);
    return out;
  }
  let initJson;
  try {
    initJson = await boundedJson(init);
  } catch {
    out.decision = 'stop_init_body_read';
    return out;
  }
  out.initErrCode = initJson.errCode ?? null;
  if (initJson.stop) {
    out.decision = initJson.stop;
    return out;
  }
  if (
    Object.hasOwn(initJson.data, 'success') &&
    numericCode(initJson.data.success) !== 1
  ) {
    out.decision = 'stop_init_not_success';
    return out;
  }
  if (
    !['wr_vid', 'wr_skey', 'wr_rt', 'wr_pf', 'wr_ql'].every((name) =>
      jar.has(name),
    ) ||
    jar.get('wr_vid') !== mobile.vid
  ) {
    out.decision = 'stop_cookie_scope_or_identity';
    return out;
  }
  out.webIdentityMatched = true;
  const cookieHeader = [...jar]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  let renewal;
  try {
    out.renewalRequests = 1;
    out.requestCount = 2;
    renewal = await fetchOnce(
      RENEWAL,
      post(
        RENEWAL,
        { rq: '%2Fweb%2Fbook%2Fread', ql: false },
        {
          cookie: cookieHeader,
          origin: ORIGIN,
          referer: `${ORIGIN}/`,
        },
      ),
    );
  } catch {
    out.decision = 'stop_renewal_transport_or_timeout';
    return out;
  }
  out.renewalHttp = renewal.status;
  try {
    out.renewalSetCookieNames = cookieNames(renewal.headers);
  } catch {
    out.decision = 'stop_renewal_cookie_shape';
    return out;
  }
  out.ticketPresent = headerPresent(renewal.headers, 'x-wr-ticket');
  out.wrpaPresent = headerPresent(renewal.headers, 'x-wrpa-0');
  if (renewal.status !== 200) {
    out.decision = httpStop(renewal.status);
    return out;
  }
  let renewalJson;
  try {
    renewalJson = await boundedJson(renewal);
  } catch {
    out.decision = 'stop_renewal_body_read';
    return out;
  }
  out.renewalErrCode = renewalJson.errCode ?? null;
  if (renewalJson.stop) {
    out.decision = renewalJson.stop;
    return out;
  }
  const succ = renewalJson.data.succ;
  out.renewalSucc =
    succ === true || succ === 1 || succ === '1'
      ? 1
      : succ === false || succ === 0 || succ === '0'
        ? 0
        : null;
  out.decision =
    out.renewalSucc === 1 ? 'renewal_observed' : 'stop_renewal_not_success';
  return out;
}

async function selfTest() {
  const mobile = {
    vid: '12345',
    accessToken: 'fixture-mobile-secret',
    refreshToken: 'fixture-refresh-secret',
  };
  const makeInit = () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const [name, value] of [
      ['wr_vid', mobile.vid],
      ['wr_skey', 'fixture-web-secret'],
      ['wr_rt', 'fixture-web-refresh'],
      ['wr_pf', '0'],
      ['wr_ql', '0'],
    ])
      headers.append('set-cookie', `${name}=${value}; Path=/; Secure`);
    return new Response(JSON.stringify({ errCode: 0, success: 1 }), {
      status: 200,
      headers,
    });
  };
  let calls = 0;
  const success = await probe(mobile, async (url, options) => {
    calls += 1;
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    if (calls === 1) {
      assert.equal(url, INIT);
      assert.equal(options.headers.cookie, undefined);
      return makeInit();
    }
    assert.equal(url, RENEWAL);
    assert.deepEqual(JSON.parse(options.body), {
      rq: '%2Fweb%2Fbook%2Fread',
      ql: false,
    });
    assert.match(options.headers.cookie, /wr_skey=fixture-web-secret/);
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'wr_skey=fixture-new-secret; Path=/');
    headers.set('x-wr-ticket', 'fixture-ticket-secret');
    return new Response(JSON.stringify({ succ: 1 }), {
      status: 200,
      headers,
    });
  });
  assert.equal(calls, 2);
  assert.equal(success.decision, 'renewal_observed');
  assert.equal(success.ticketPresent, true);
  assert.equal(success.wrpaPresent, false);
  assert.equal(success.renewalSucc, 1);
  assert.equal(JSON.stringify(success).includes('fixture'), false);
  calls = 0;
  const blocked = await probe(mobile, async () => {
    calls += 1;
    return new Response(JSON.stringify({ errCode: -2041 }), { status: 200 });
  });
  assert.equal(calls, 1);
  assert.equal(blocked.renewalRequests, 0);
  assert.equal(blocked.decision, 'stop_verification_or_restriction');
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'weread-renewal-selftest-'),
  );
  try {
    historyGate(tempDir);
    markAttempt(tempDir);
    assert.throws(() => historyGate(tempDir), /renewal_already_attempted/);
    saveSanitized(tempDir, success);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(tempDir, RESULT), 'utf8')),
      success,
    );
  } finally {
    for (const name of [MARKER, RESULT]) {
      const file = path.join(tempDir, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(tempDir);
  }
  return { decision: 'self_test_passed', realNetworkRequests: 0 };
}

async function main() {
  let options;
  try {
    options = args(process.argv.slice(2));
  } catch {
    console.log(JSON.stringify({ decision: 'usage_gate', requestCount: 0 }));
    process.exitCode = 1;
    return;
  }
  if (options.mode === '--plan') {
    console.log(
      JSON.stringify({
        decision: 'plan_only',
        credentialSource: 'private_refresh_recovery_only',
        initRequestMax: 1,
        renewalRequestMax: 1,
        listRequestMax: 0,
        redirects: false,
        retries: false,
        productionReads: 0,
        productionWrites: 0,
        requestCount: 0,
      }),
    );
    return;
  }
  if (options.mode === '--self-test') {
    try {
      console.log(JSON.stringify(await selfTest()));
    } catch {
      console.log(
        JSON.stringify({ decision: 'self_test_failed', requestCount: 0 }),
      );
      process.exitCode = 1;
    }
    return;
  }
  let ready;
  try {
    environmentGate(process.env);
    ready = preflight(options.dbPath, options.runDir);
  } catch (error) {
    const safe = new Set([
      'environment_gate',
      'renewal_already_attempted',
      'run_dir_gate',
      'refresh_marker_gate',
      'health_marker_gate',
      'recovery_gate',
      'source_backup_gate',
      'recovery_identity_gate',
      'db_gate',
      'db_path_gate',
      'private_root_gate',
      'account_gate',
      'mobile_gate',
      'integrity_gate',
      'sqlite_runtime_gate',
    ]);
    console.log(
      JSON.stringify({
        decision: safe.has(error.message) ? error.message : 'preflight_gate',
        requestCount: 0,
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (options.mode === '--preflight') {
    console.log(
      JSON.stringify({
        decision: 'preflight_ready',
        recoveryAndBackupMatched: true,
        sameShapeAttemptAbsent: true,
        requestCount: 0,
        productionWrites: 0,
      }),
    );
    return;
  }
  try {
    markAttempt(ready.privateRoot);
  } catch (error) {
    console.log(
      JSON.stringify({
        decision:
          error?.code === 'EEXIST'
            ? 'renewal_already_attempted'
            : 'marker_persist_gate',
        requestCount: 0,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const result = await probe(ready.mobile, fetch);
  try {
    saveSanitized(ready.privateRoot, result);
    result.sanitizedResultSaved = true;
  } catch {
    result.sanitizedResultSaved = false;
  }
  console.log(JSON.stringify(result));
  if (result.decision !== 'renewal_observed' || !result.sanitizedResultSaved)
    process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { args, cookieJar, boundedJson, preflight, probe, selfTest };
