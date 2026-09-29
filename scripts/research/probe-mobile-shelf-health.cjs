#!/usr/bin/env node
'use strict';

// One read-only mobile session health request. No refresh, article request,
// browser data, raw response logging, or production SQLite writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const ENDPOINT = 'https://i.weread.qq.com/shelf/sync';
const USER_AGENT =
  'WeRead/2.1.2 WRBrand/Onyx wr_eink Dalvik/2.1.0 (Linux; U; Android 11; BOOX Build/onyx)';
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if ((mode === '--plan' || mode === '--self-test') && rest.length === 0)
    return { mode };
  if (
    mode === '--execute' &&
    rest.length === 5 &&
    rest[0] === '--db' &&
    rest[2] === '--marker' &&
    rest[4] === '--approved-online' &&
    path.isAbsolute(rest[1]) &&
    path.isAbsolute(rest[3])
  )
    return { mode, dbPath: rest[1], markerPath: rest[3] };
  throw Error('usage_gate');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child).toLowerCase();
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function markerGate(markerPath) {
  if (fs.existsSync(markerPath)) throw Error('already_tried');
  const parent = fs.realpathSync(path.dirname(markerPath));
  if (!fs.statSync(parent).isDirectory()) throw Error('marker_gate');
  const root = fs.realpathSync(PROJECT_ROOT);
  if (isWithin(root, parent) && !isWithin(path.join(root, 'private-data'), parent))
    throw Error('marker_gate');
}

function proxyGate(env) {
  const keys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ];
  if (keys.some((key) => typeof env[key] === 'string' && env[key].trim()))
    throw Error('proxy_gate');
  if (env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== '0')
    throw Error('proxy_gate');
}

function mobileFromRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('account_gate');
  let token;
  try {
    token = JSON.parse(rows[0].token);
  } catch {
    throw Error('account_gate');
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
  return { vid, accessToken: mobile.accessToken };
}

function readMobile(dbPath) {
  if (!fs.statSync(dbPath).isFile()) throw Error('db_gate');
  // Imported only by --execute. Plan and self-test cannot access production DB.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    return mobileFromRows(db.prepare('SELECT token FROM accounts LIMIT 2').all());
  } finally {
    db.close();
  }
}

function markAttempt(markerPath) {
  const fd = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(
      fd,
      JSON.stringify({
        kind: 'mobile-shelf-health',
        endpoint: '/shelf/sync',
        attemptedAt: new Date().toISOString(),
      }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function requestOptions(mobile) {
  return {
    method: 'GET',
    headers: {
      baseapi: '30',
      appver: '2.1.2.10245900',
      basever: '2.1.2.10245900',
      osver: '11',
      channelId: '900',
      'User-Agent': USER_AGENT,
      vid: mobile.vid,
      accessToken: mobile.accessToken,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

// Direct HTTPS with agent:false has no proxy, Cookie jar, cache, or redirect logic.
function directGet(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      agent: false,
    }, (incoming) => {
      resolve({
        status: incoming.statusCode ?? 0,
        headers: {
          get(name) {
            const value = incoming.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value ?? null;
          },
        },
        body: Readable.toWeb(incoming),
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function boundedText(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
    return { oversize: true };
  if (!response.body) return { text: '' };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return { oversize: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { text: Buffer.concat(chunks, total).toString('utf8') };
}

function numericCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value)) return Number(value);
  return null;
}

function responseHint(value) {
  if (typeof value !== 'string') return null;
  if (/captcha|验证码|安全验证|verifycenter|请完成验证/i.test(value))
    return 'stop_verification';
  if (/访问过于频繁|请求频繁|限流|限频|rate.?limit|too many|throttl/i.test(value))
    return 'stop_rate_limit';
  return null;
}

function classify(status, contentType, text) {
  const base = { http: status, businessCode: null, hasBooks: false, hasSynckey: false };
  if (status >= 300 && status < 400) return { ...base, decision: 'stop_redirect' };
  if (status === 429) return { ...base, decision: 'stop_rate_limit' };
  if (status === 401 || status === 403)
    return { ...base, decision: 'stop_auth_or_access' };
  if (status !== 200) return { ...base, decision: 'stop_http' };
  if (!/json/i.test(contentType))
    return { ...base, decision: responseHint(text) ?? 'stop_non_json' };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...base, decision: responseHint(text) ?? 'stop_invalid_json' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ...base, decision: 'stop_unexpected_shape' };
  const rawCode = body.errCode ?? body.errcode;
  const businessCode = rawCode === undefined ? null : numericCode(rawCode);
  const result = {
    ...base,
    businessCode,
    hasBooks: Array.isArray(body.books),
    hasSynckey: Object.hasOwn(body, 'synckey'),
  };
  if (rawCode !== undefined && businessCode === null)
    return { ...result, decision: 'stop_unexpected_shape' };
  const hint = [body.msg, body.message, body.errMsg, body.err_message]
    .map(responseHint).find(Boolean);
  if (hint) return { ...result, decision: hint };
  if (businessCode === -2012)
    return { ...result, decision: 'stop_mobile_session_rejected_candidate' };
  if (businessCode !== null && businessCode !== 0)
    return { ...result, decision: 'stop_business_code' };
  if (!result.hasBooks)
    return { ...result, decision: 'stop_unexpected_shape' };
  return { ...result, decision: 'mobile_shelf_accepted' };
}

async function probe(mobile, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ENDPOINT, requestOptions(mobile));
  } catch {
    return { requestCount: 1, decision: 'stop_transport' };
  }
  const status = response.status;
  if (status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { requestCount: 1, ...classify(status, '', '') };
  }
  let bounded;
  try {
    bounded = await boundedText(response);
  } catch {
    return { requestCount: 1, http: status, decision: 'stop_transport' };
  }
  if (bounded.oversize)
    return { requestCount: 1, http: status, decision: 'stop_oversize' };
  return {
    requestCount: 1,
    ...classify(status, response.headers.get('content-type') ?? '', bounded.text),
  };
}

async function selfTest() {
  assert.equal(parseArgs(['--plan']).mode, '--plan');
  assert.throws(() => parseArgs(['--execute']), /usage_gate/);
  assert.throws(() => mobileFromRows([]), /account_gate/);
  const fakeRows = [{ token: JSON.stringify({ mobile: {
    vid: 'fixture-vid', accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh', deviceId: 'fixture-device',
  } }) }];
  const mobile = mobileFromRows(fakeRows);
  assert.deepEqual(mobile, { vid: 'fixture-vid', accessToken: 'fixture-access' });
  const options = requestOptions(mobile);
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.vid, 'fixture-vid');
  assert.equal(options.headers.accessToken, 'fixture-access');
  assert.equal(options.headers.basever, '2.1.2.10245900');
  assert.equal('skey' in options.headers, false);
  let calls = 0;
  const fakeFetch = async (url, init) => {
    calls++;
    assert.equal(url, ENDPOINT);
    assert.equal(init.method, 'GET');
    return new Response(JSON.stringify({ books: [], synckey: 5 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  assert.equal((await probe(mobile, fakeFetch)).decision, 'mobile_shelf_accepted');
  assert.equal(calls, 1);
  assert.equal(classify(200, 'application/json', '{"errCode":-2012}').decision,
    'stop_mobile_session_rejected_candidate');
  assert.equal(classify(200, 'text/html', '<h1>验证码</h1>').decision,
    'stop_verification');
  assert.equal(classify(200, 'application/json', '{"errCode":0,"books":[{"title":"验证码"}]}').decision,
    'mobile_shelf_accepted');
  assert.equal(classify(200, 'application/json', '{"errCode":0,"msg":"访问过于频繁"}').decision,
    'stop_rate_limit');
  assert.equal(classify(429, '', '').decision, 'stop_rate_limit');
  assert.equal(classify(302, '', '').decision, 'stop_redirect');
  assert.equal(classify(200, 'application/json', '{"books":[]}').hasBooks, true);
  assert.equal((await probe(mobile, async () => { throw Error('private detail'); })).decision,
    'stop_transport');
  assert.throws(() => proxyGate({ HTTPS_PROXY: 'http://proxy.invalid' }), /proxy_gate/);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-shelf-probe-'));
  const marker = path.join(tempDir, 'attempt.json');
  try {
    markerGate(marker);
    markAttempt(marker);
    assert.throws(() => markerGate(marker), /already_tried/);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(marker, 'utf8'))).sort(),
      ['attemptedAt', 'endpoint', 'kind']);
  } finally {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    fs.rmdirSync(tempDir);
  }
  return { decision: 'self_test_passed', scenarios: 'offline_gates_and_response_classes', dbReads: 0, networkRequests: 0 };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    console.log(JSON.stringify({ decision: 'usage_gate', requestCount: 0 }));
    process.exitCode = 2;
    return;
  }
  if (options.mode === '--plan') {
    console.log(JSON.stringify({
      decision: 'plan_only', endpoint: '/shelf/sync', method: 'GET',
      maxRequests: 1, timeoutMs: TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
      credentialSource: 'one read-only SQLite mobile object',
      marker: 'private, exclusive-create before request', refreshRequests: 0,
      articleRequests: 0, dbReads: 0, networkRequests: 0,
    }));
    return;
  }
  if (options.mode === '--self-test') {
    try {
      console.log(JSON.stringify(await selfTest()));
    } catch {
      console.log(JSON.stringify({ decision: 'self_test_failed', dbReads: 0, networkRequests: 0 }));
      process.exitCode = 1;
    }
    return;
  }
  try {
    proxyGate(process.env);
    markerGate(options.markerPath);
    const mobile = readMobile(options.dbPath);
    markAttempt(options.markerPath);
    console.log(JSON.stringify(await probe(mobile, directGet)));
  } catch (error) {
    const safe = new Set(['already_tried', 'proxy_gate', 'marker_gate', 'account_gate', 'mobile_gate', 'db_gate']);
    const decision = safe.has(error.message) ? error.message : 'preflight_gate';
    console.log(JSON.stringify({ decision, requestCount: 0 }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();
