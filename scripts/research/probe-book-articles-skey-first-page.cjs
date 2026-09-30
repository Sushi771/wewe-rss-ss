#!/usr/bin/env node
'use strict';

// A single legacy WeBook-shaped first-page request. It reads only the fresh,
// privately saved /login skey and never writes production SQLite.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  environmentGate,
  recoveryGate,
} = require('./probe-refreshed-mobile-web-health.cjs');

const TARGET_BOOK_ID = 'MP_WXS_3895431412';
const ARTICLE_PATH = '/book/articles';
const ARTICLE_ORIGIN = 'https://i.weread.qq.com';
const USER_AGENT = 'WeRead/5.3.4 (iPhone; iOS 14.1; Scale/2.00)';
const LOGIN_MARKER = 'mobile-login-skey-attempt.json';
const LOGIN_RECORD = 'mobile-login-skey-response.json';
const PRIOR_RECOVERY = 'mobile-refresh-recovery.json';
const ARTICLE_MARKER = 'book-articles-skey-first-page-attempt.json';
const ARTICLE_RECORD = 'book-articles-skey-first-page-structure.json';
const RESPONSE_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 30_000;

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

function readSmallPrivateJson(runDir, name, maxBytes) {
  const file = path.join(runDir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes)
    throw Error('private_record_gate');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function numericCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value))
    return Number(value);
  return null;
}

function businessCode(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const values = [body.errCode, body.errcode, body.data?.errCode, body.data?.errcode]
    .map(numericCode)
    .filter((value) => value !== null);
  return values.find((value) => value !== 0) ?? values[0] ?? null;
}

function responseHint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const container of [body, body.data]) {
    if (!container || typeof container !== 'object' || Array.isArray(container))
      continue;
    for (const key of ['errMsg', 'errmsg', 'msg', 'message']) {
      const value = container[key];
      if (typeof value !== 'string') continue;
      if (/验证码|验证|captcha|verify/i.test(value)) return 'verification';
      if (/频繁|限流|rate.?limit|too many/i.test(value)) return 'rate_limit';
    }
  }
  return null;
}

function invalidBusinessCodeShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  for (const container of [body, body.data]) {
    if (!container || typeof container !== 'object' || Array.isArray(container))
      continue;
    for (const key of ['errCode', 'errcode']) {
      if (Object.hasOwn(container, key) && numericCode(container[key]) === null)
        return true;
    }
  }
  return false;
}

function headerValueSafe(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function loginBusinessSafe(body) {
  for (const container of [body, body.data]) {
    if (!container || typeof container !== 'object' || Array.isArray(container))
      continue;
    for (const key of ['errCode', 'errcode']) {
      if (Object.hasOwn(container, key) && numericCode(container[key]) !== 0)
        return false;
    }
    if (container.success === false || container.succeed === false)
      return false;
    for (const key of ['errMsg', 'errmsg', 'msg', 'message']) {
      if (
        typeof container[key] === 'string' &&
        /验证码|验证|频繁|限流|captcha|verify|rate.?limit|auth|expired|timeout/i.test(
          container[key],
        )
      )
        return false;
    }
  }
  return true;
}

function contextGate(dbPath, inputRunDir) {
  // The reviewed gate opens production, original backup and rehearsal copies
  // readOnly/query_only, and verifies the prior refreshed mobile identity.
  const checked = recoveryGate(dbPath, inputRunDir, 'present');
  const runDir = checked.runDir;
  if (
    fs.existsSync(path.join(runDir, ARTICLE_MARKER)) ||
    fs.existsSync(path.join(runDir, ARTICLE_RECORD))
  )
    throw Error('already_attempted');
  const marker = readSmallPrivateJson(runDir, LOGIN_MARKER, 4096);
  const record = readSmallPrivateJson(runDir, LOGIN_RECORD, 256 * 1024);
  const prior = readSmallPrivateJson(runDir, PRIOR_RECOVERY, 256 * 1024);
  const markerTime = Date.parse(marker.attemptedAt);
  const recordTime = Date.parse(record.capturedAt);
  if (
    marker.kind !== 'mobile-login-skey-field-once' ||
    marker.endpoint !== '/login' ||
    !Number.isFinite(markerTime) ||
    record.formatVersion !== 1 ||
    record.kind !== 'mobile-login-skey-field-response' ||
    record.decision !== 'skey_candidate_identity_matched' ||
    record.httpStatus !== 200 ||
    !Number.isFinite(recordTime) ||
    recordTime < markerTime ||
    typeof record.responseBody !== 'string' ||
    !record.responseBody ||
    record.priorMobile?.vid !== checked.mobile.vid ||
    record.priorMobile?.accessToken !== checked.mobile.accessToken ||
    record.priorMobile?.refreshToken !== checked.mobile.refreshToken ||
    record.priorMobile?.deviceId !== prior.proposedMobile?.deviceId
  )
    throw Error('login_record_gate');
  let body;
  try {
    body = JSON.parse(record.responseBody);
  } catch {
    throw Error('login_response_gate');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !headerValueSafe(body.skey, 512) ||
    Object.hasOwn(body.data ?? {}, 'skey') ||
    String(body.vid ?? '') !== checked.mobile.vid ||
    !headerValueSafe(checked.mobile.vid, 32) ||
    !/^\d+$/.test(checked.mobile.vid) ||
    !loginBusinessSafe(body)
  )
    throw Error('login_response_gate');
  return { runDir, vid: checked.mobile.vid, skey: body.skey };
}

function requestShape(context, unixSeconds) {
  assert(Number.isSafeInteger(unixSeconds) && unixSeconds > 0);
  const url = new URL(`${ARTICLE_ORIGIN}${ARTICLE_PATH}`);
  url.searchParams.set('bookId', TARGET_BOOK_ID);
  url.searchParams.set('count', '20');
  url.searchParams.set('offset', '0');
  url.searchParams.set('synckey', String(unixSeconds));
  return {
    url,
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      // WeBook spells this custom header "Cookies", not the HTTP Cookie header.
      Cookies: 'wr_logined=1',
      skey: context.skey,
      vid: context.vid,
    },
  };
}

function markAttempt(runDir) {
  const fd = fs.openSync(path.join(runDir, ARTICLE_MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        kind: 'book-articles-skey-first-page-once',
        endpoint: ARTICLE_PATH,
        bookId: TARGET_BOOK_ID,
        attemptedAt: new Date().toISOString(),
      }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function requestOnce(shape) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      shape.url,
      {
        method: shape.method,
        headers: shape.headers,
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
    request.end();
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
  return { text: Buffer.concat(parts, total).toString('utf8'), truncated, readError };
}

function redirectKind(location) {
  if (typeof location !== 'string' || !location) return null;
  let url;
  try {
    url = new URL(location, ARTICLE_ORIGIN);
  } catch {
    return { tencentHost: false, pathClass: 'invalid' };
  }
  const host = url.hostname.toLowerCase();
  const tencentHost =
    host === 'weread.qq.com' ||
    host === 'i.weread.qq.com' ||
    host === 'mp.weixin.qq.com';
  return {
    tencentHost,
    pathClass: /verify|captcha|login/i.test(url.pathname)
      ? 'verification_or_login'
      : 'other',
  };
}

const ARTICLE_KEYS = [
  'reviewId', 'bookId', 'belongBookId', 'originalId', 'title', 'url',
  'articleUrl', 'contentUrl', 'publishTime', 'publishedAt', 'pubTime',
  'createTime', 'time', 'biz', 'mid', 'idx', 'mp_name', 'author',
];

function pickArticleFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of ARTICLE_KEYS) {
    const item = value[key];
    if (
      (typeof item === 'string' && item.length <= 4096) ||
      (typeof item === 'number' && Number.isSafeInteger(item))
    )
      out[key] = item;
  }
  return out;
}

function projection(body) {
  const reviews = Array.isArray(body?.reviews) ? body.reviews : null;
  const projected = [];
  let remainingEntries = 200;
  if (reviews) {
    for (const outer of reviews.slice(0, 20)) {
      if (!outer || typeof outer !== 'object' || Array.isArray(outer)) continue;
      const inner = outer.review;
      const subReviews = Array.isArray(outer.subReviews)
        ? outer.subReviews.slice(0, remainingEntries)
        : [];
      remainingEntries -= subReviews.length;
      projected.push({
        outer: pickArticleFields(outer),
        review: pickArticleFields(inner),
        mpInfo: pickArticleFields(inner?.mpInfo),
        subReviews: subReviews.map((sub) => ({
          outer: pickArticleFields(sub),
          review: pickArticleFields(sub?.review),
          mpInfo: pickArticleFields(sub?.review?.mpInfo),
        })),
      });
    }
  }
  return projected;
}

function structure(body) {
  const reviews = Array.isArray(body?.reviews) ? body.reviews : null;
  const sampled = projection(body);
  const entries = sampled.flatMap((item) => [item, ...item.subReviews]);
  const hasAny = (entry, keys) =>
    [entry.outer, entry.review, entry.mpInfo].some((source) =>
      keys.some((key) => Object.hasOwn(source, key)),
    );
  return {
    reviewsKeyPresent: !!body && typeof body === 'object' && Object.hasOwn(body, 'reviews'),
    reviewsArray: reviews !== null,
    reviewsCount: reviews?.length ?? null,
    sampledEntryCount: entries.length,
    stableIdFieldEntries: entries.filter((entry) =>
      hasAny(entry, ['reviewId', 'originalId', 'mid']),
    ).length,
    bookIdentityFieldEntries: entries.filter((entry) =>
      hasAny(entry, ['bookId', 'belongBookId', 'biz']),
    ).length,
    timeFieldEntries: entries.filter((entry) =>
      hasAny(entry, ['time', 'pubTime', 'publishTime', 'publishedAt', 'createTime']),
    ).length,
    urlFieldEntries: entries.filter((entry) =>
      hasAny(entry, ['url', 'articleUrl', 'contentUrl']),
    ).length,
  };
}

function classify(status, body, read, headers) {
  const code = businessCode(body);
  const hint = responseHint(body);
  const fields = structure(body);
  let decision;
  if (status === 429 || code === -2014 || hint === 'rate_limit')
    decision = 'stop_rate_limit';
  else if (code === -2041 || code === -2063 || hint === 'verification')
    decision = 'stop_verification';
  else if (status >= 300 && status < 400) decision = 'stop_redirect';
  else if (status !== 200) decision = 'stop_http';
  else if (read.truncated || read.readError) decision = 'stop_response_limit_or_transport';
  else if (!body || typeof body !== 'object' || Array.isArray(body))
    decision = 'stop_non_json';
  else if (invalidBusinessCodeShape(body)) decision = 'stop_business_code_shape';
  else if (code !== null && code !== 0) decision = 'stop_business_code';
  else if (body.success === false || body.succeed === false)
    decision = 'stop_business_flag';
  else if (!fields.reviewsArray) decision = 'no_reviews_array_unverified';
  else if (fields.reviewsCount === 0) decision = 'empty_reviews_unverified';
  else decision = 'reviews_returned_unverified';
  return {
    decision,
    http: status,
    businessCode: code,
    redirect: status >= 300 && status < 400
      ? redirectKind(headers?.location)
      : null,
    ...fields,
    networkRequests: 1,
    productionWrites: 0,
  };
}

function writePrivate(runDir, record) {
  const serialized = JSON.stringify(record) + '\n';
  const finalPath = path.join(runDir, ARTICLE_RECORD);
  if (fs.existsSync(finalPath)) {
    if (fs.readFileSync(finalPath, 'utf8') === serialized) return finalPath;
    throw Error('record_conflict');
  }
  const tempPath = path.join(
    runDir,
    `.book-articles-${randomBytes(8).toString('hex')}.tmp`,
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
    throw Error('record_verify_gate');
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
          notify({ decision: 'local_persistence_retry_required', localAttempts: attempts, networkRequests: 1 });
        } catch {
          /* Retain the private projection in memory. */
        }
      }
      await wait(5_000);
    }
  }
}

async function runOnce(dbPath, runDir, options = {}) {
  const context = (options.contextGate ?? contextGate)(dbPath, runDir);
  markAttempt(context.runDir);
  const shape = requestShape(context, Math.floor(Date.now() / 1000));
  let response;
  try {
    response = await (options.transport ?? requestOnce)(shape);
  } catch {
    return { decision: 'stop_transport', http: null, networkRequests: 1, productionWrites: 0 };
  }
  const read = await boundedBody(response);
  let body = null;
  if (!read.truncated && !read.readError) {
    try {
      body = JSON.parse(read.text);
    } catch {
      /* No raw body is printed or retained. */
    }
  }
  const result = classify(response.status, body, read, response.headers);
  const record = {
    formatVersion: 1,
    kind: 'book-articles-skey-first-page-structure',
    capturedAt: new Date().toISOString(),
    endpoint: ARTICLE_PATH,
    bookId: TARGET_BOOK_ID,
    http: response.status,
    businessCode: result.businessCode,
    decision: result.decision,
    responseBytesWithinLimit: Buffer.byteLength(read.text, 'utf8'),
    bodyTruncated: read.truncated,
    bodyReadError: read.readError,
    structure: structure(body),
    projectedArticles: projection(body),
  };
  const attempts = await persistUntilDurable(context.runDir, record, options.persistence);
  return { ...result, privateStructureSaved: true, localPersistenceAttempts: attempts };
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(() => environmentGate({ NODE_DEBUG: 'http' }), /environment_gate/);
  const source = { vid: '123', skey: 'fixture-private-skey' };
  const shape = requestShape(source, 1790000000);
  assert.equal(shape.url.hostname, 'i.weread.qq.com');
  assert.equal(shape.url.searchParams.get('bookId'), TARGET_BOOK_ID);
  assert.equal(shape.url.searchParams.get('count'), '20');
  assert.equal(shape.url.searchParams.get('offset'), '0');
  assert.equal(shape.url.searchParams.get('synckey'), '1790000000');
  assert.equal(shape.headers.Cookies, 'wr_logined=1');
  assert.equal(headerValueSafe('abcd1234', 512), true);
  assert.equal(headerValueSafe('a\r\nb', 512), false);
  assert.equal(headerValueSafe('x'.repeat(513), 512), false);
  assert.equal(loginBusinessSafe({ errCode: -2041 }), false);
  assert.equal(loginBusinessSafe({ errCode: 0, msg: '需要验证码' }), false);
  assert.equal(Object.hasOwn(shape.headers, 'Cookie'), false);
  assert.equal(shape.url.searchParams.has('skey'), false);
  const body = {
    reviews: [{ review: { reviewId: 'private-id', belongBookId: TARGET_BOOK_ID, mpInfo: { originalId: 'private-article-id', time: 1790000000, title: 'private-title' }, content: 'private-body' } }],
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'book-articles-skey-test-'));
  let requests = 0;
  let writes = 0;
  try {
    const result = await runOnce('', root, {
      contextGate: () => ({ runDir: root, ...source }),
      transport: async () => {
        requests++;
        return { status: 200, headers: {}, body: Readable.from([JSON.stringify(body)]) };
      },
      persistence: {
        writer: (dir, record) => {
          writes++;
          if (writes === 1) throw Error('fake disk failure');
          return writePrivate(dir, record);
        },
        wait: async () => {},
      },
    });
    assert.equal(result.decision, 'reviews_returned_unverified');
    assert.equal(result.reviewsCount, 1);
    assert.equal(result.stableIdFieldEntries, 1);
    assert.equal(requests, 1);
    assert.equal(writes, 2);
    assert.equal(JSON.stringify(result).includes('private-'), false);
    const saved = readSmallPrivateJson(root, ARTICLE_RECORD, RESPONSE_LIMIT);
    assert.equal(saved.projectedArticles[0].review.reviewId, 'private-id');
    assert.equal(JSON.stringify(saved).includes('private-body'), false);
    assert.throws(() => markAttempt(root), /EEXIST/);
    assert.equal(classify(200, { reviews: [] }, { truncated: false, readError: false }, {}).decision, 'empty_reviews_unverified');
    assert.equal(classify(200, {}, { truncated: false, readError: false }, {}).decision, 'no_reviews_array_unverified');
    assert.equal(classify(200, { errCode: -2041 }, { truncated: false, readError: false }, {}).decision, 'stop_verification');
    assert.equal(classify(200, { errCode: 'bad' }, { truncated: false, readError: false }, {}).decision, 'stop_business_code_shape');
    assert.equal(classify(200, { message: '请完成验证码' }, { truncated: false, readError: false }, {}).decision, 'stop_verification');
    assert.equal(classify(302, null, { truncated: false, readError: false }, { location: 'https://i.weread.qq.com/verify?a=private' }).redirect.pathClass, 'verification_or_login');
  } finally {
    const resolved = fs.realpathSync(root);
    if (
      path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith('book-articles-skey-test-')
    )
      throw Error('self_test_cleanup_gate');
    for (const name of [ARTICLE_MARKER, ARTICLE_RECORD]) {
      const item = path.join(resolved, name);
      if (fs.existsSync(item)) fs.unlinkSync(item);
    }
    fs.rmdirSync(resolved);
  }
  return { decision: 'self_test_passed', fakeNetworkRequests: requests, productionWrites: 0 };
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
    console.log(JSON.stringify({ decision: 'plan_only', endpoint: ARTICLE_PATH, bookId: TARGET_BOOK_ID, maxRequests: 1, responseLimit: RESPONSE_LIMIT, productionWrites: 0, approvedOnlineFlagRequired: true }));
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
    const safe = new Set(['already_attempted', 'run_dir_gate', 'refresh_marker_gate', 'health_marker_gate', 'recovery_gate', 'source_backup_gate', 'recovery_identity_gate', 'login_record_gate', 'login_response_gate', 'private_record_gate', 'db_gate', 'private_root_gate', 'account_gate', 'mobile_gate', 'integrity_gate', 'sqlite_runtime_gate', 'environment_gate']);
    console.log(JSON.stringify({ decision: safe.has(error.message) ? error.message : 'preflight_gate', networkRequests: 0 }));
    process.exitCode = 1;
    return;
  }
  if (options.mode === '--preflight') {
    console.log(JSON.stringify({ decision: 'preflight_ready', networkRequests: 0, productionWrites: 0 }));
    return;
  }
  const result = await runOnce(options.dbPath, options.runDir, {
    persistence: { notify: (notice) => console.log(JSON.stringify(notice)) },
  });
  console.log(JSON.stringify(result));
  if (result.decision !== 'reviews_returned_unverified') process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { args, contextGate, requestShape, structure, projection, classify, runOnce, selfTest };
