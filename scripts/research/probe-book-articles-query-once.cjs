#!/usr/bin/env node
'use strict';

// One future, explicitly approved query-auth comparison against the old
// header-auth 401. This preparation does not invoke the endpoint by default.
// Query credentials stay in process memory, never in output, errors or files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomBytes } = require('node:crypto');
const {
  environmentGate,
  recoveryGate,
} = require('./probe-refreshed-mobile-web-health.cjs');
const {
  classify,
  structure,
} = require('./probe-book-articles-skey-first-page.cjs');

const TARGET_BOOK_ID = 'MP_WXS_3895431412';
const ARTICLE_PATH = '/book/articles';
const ORIGIN = 'https://i.weread.qq.com';
const LOGIN_MARKER = 'mobile-login-skey-attempt.json';
const LOGIN_RECORD = 'mobile-login-skey-response.json';
const PRIOR_RECOVERY = 'mobile-refresh-recovery.json';
const PRIOR_ARTICLE_MARKER = 'book-articles-skey-first-page-attempt.json';
const PRIOR_ARTICLE_RECORD = 'book-articles-skey-first-page-structure.json';
const GLOBAL_ROOT = path.join(os.homedir(), '.wewe-rss-private');
const MARKER = path.join(
  GLOBAL_ROOT,
  'book-articles-query-once.attempted.json',
);
const RECORD = 'book-articles-query-once-structure.json';
const RESPONSE_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_CREDENTIAL_AGE_MS = 24 * 60 * 60 * 1000;

function args(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0])) {
    return { mode: argv[0] };
  }
  if (
    argv.length >= 5 &&
    ['--preflight', '--execute'].includes(argv[0]) &&
    argv[1] === '--db' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--run-dir' &&
    path.isAbsolute(argv[4]) &&
    ((argv[0] === '--preflight' && argv.length === 5) ||
      (argv[0] === '--execute' &&
        argv.length === 6 &&
        argv[5] === '--approved-online'))
  ) {
    return { mode: argv[0], dbPath: argv[2], runDir: argv[4] };
  }
  throw Error('usage_gate');
}

function readPrivate(runDir, name, maxBytes) {
  const file = path.join(runDir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
    throw Error('private_record_gate');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeAscii(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function privateRootGate() {
  const stat = fs.lstatSync(GLOBAL_ROOT);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(GLOBAL_ROOT).toLowerCase() !==
      path.resolve(GLOBAL_ROOT).toLowerCase()
  ) {
    throw Error('private_root_gate');
  }
  if (fs.existsSync(MARKER)) throw Error('query_shape_already_attempted');
}

function contextGate(dbPath, inputRunDir, now = Date.now()) {
  privateRootGate();
  // This established gate opens production SQLite, the original backup and
  // rehearsal copy readOnly/query_only and confirms one recovered account.
  const checked = recoveryGate(dbPath, inputRunDir, 'present');
  const runDir = checked.runDir;
  if (fs.existsSync(path.join(runDir, RECORD))) {
    throw Error('query_shape_already_attempted');
  }
  const loginMarker = readPrivate(runDir, LOGIN_MARKER, 4096);
  const loginRecord = readPrivate(runDir, LOGIN_RECORD, 256 * 1024);
  const recovery = readPrivate(runDir, PRIOR_RECOVERY, 256 * 1024);
  const priorMarker = readPrivate(runDir, PRIOR_ARTICLE_MARKER, 4096);
  const priorArticle = readPrivate(
    runDir,
    PRIOR_ARTICLE_RECORD,
    2 * 1024 * 1024,
  );
  const loginTime = Date.parse(loginRecord.capturedAt);
  if (
    loginMarker.kind !== 'mobile-login-skey-field-once' ||
    loginMarker.endpoint !== '/login' ||
    loginRecord.formatVersion !== 1 ||
    loginRecord.kind !== 'mobile-login-skey-field-response' ||
    loginRecord.decision !== 'skey_candidate_identity_matched' ||
    loginRecord.httpStatus !== 200 ||
    !Number.isFinite(loginTime) ||
    !Number.isFinite(Date.parse(loginMarker.attemptedAt)) ||
    loginTime > now ||
    now - loginTime > MAX_CREDENTIAL_AGE_MS ||
    loginTime < Date.parse(loginMarker.attemptedAt) ||
    loginRecord.priorMobile?.vid !== checked.mobile.vid ||
    loginRecord.priorMobile?.accessToken !== checked.mobile.accessToken ||
    loginRecord.priorMobile?.refreshToken !== checked.mobile.refreshToken ||
    loginRecord.priorMobile?.deviceId !== recovery.proposedMobile?.deviceId ||
    typeof loginRecord.responseBody !== 'string' ||
    priorMarker.kind !== 'book-articles-skey-first-page-once' ||
    priorMarker.endpoint !== ARTICLE_PATH ||
    priorMarker.bookId !== TARGET_BOOK_ID ||
    priorArticle.kind !== 'book-articles-skey-first-page-structure' ||
    priorArticle.formatVersion !== 1 ||
    priorArticle.endpoint !== ARTICLE_PATH ||
    priorArticle.bookId !== TARGET_BOOK_ID ||
    priorArticle.http !== 401 ||
    priorArticle.businessCode !== -2012
  ) {
    throw Error('source_provenance_gate');
  }
  let login;
  try {
    login = JSON.parse(loginRecord.responseBody);
  } catch {
    throw Error('login_response_gate');
  }
  if (
    !login ||
    typeof login !== 'object' ||
    Array.isArray(login) ||
    !safeAscii(login.skey, 512) ||
    Object.hasOwn(login.data ?? {}, 'skey') ||
    String(login.vid ?? '') !== checked.mobile.vid ||
    !/^\d{1,32}$/.test(checked.mobile.vid) ||
    [login.errCode, login.errcode].some(
      (value) => value !== undefined && Number(value) !== 0,
    )
  ) {
    throw Error('login_response_gate');
  }
  return { runDir, skey: login.skey, vid: checked.mobile.vid };
}

// syfun/main.py passes int(pendulum.yesterday().timestamp()). Fix the local
// timezone to this project's Asia/Shanghai user so a server TZ cannot drift.
function yesterdayShanghai(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const part = (type) =>
    Number(parts.find((item) => item.type === type)?.value);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (![year, month, day].every(Number.isSafeInteger)) {
    throw Error('clock_gate');
  }
  return Math.floor((Date.UTC(year, month - 1, day - 1) - 8 * 3600000) / 1000);
}

function requestShape(context, synckey) {
  if (!Number.isSafeInteger(synckey) || synckey < 1) {
    throw Error('clock_gate');
  }
  const url = new URL(`${ORIGIN}${ARTICLE_PATH}`);
  for (const [name, value] of [
    ['bookId', TARGET_BOOK_ID],
    ['version', '2'],
    ['vid', context.vid],
    ['skey', context.skey],
    ['offset', '0'],
    ['count', '1'],
    ['synckey', String(synckey)],
  ]) {
    url.searchParams.set(name, value);
  }
  return {
    url,
    method: 'GET',
    headers: {
      'User-Agent': 'python-httpx/0.28.1',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    },
  };
}

function markAttempt() {
  const fd = fs.openSync(MARKER, 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        kind: 'book-articles-query-shape-once',
        endpoint: ARTICLE_PATH,
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
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        }),
    );
    request.on('error', reject);
    request.end();
  });
}

async function boundedBody(response) {
  let size = 0;
  const chunks = [];
  let truncated = false;
  let readError = false;
  try {
    for await (const part of response.body ?? []) {
      const chunk = Buffer.from(part);
      const remaining = RESPONSE_LIMIT - size;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        size = RESPONSE_LIMIT;
        truncated = true;
        response.body?.destroy?.();
        break;
      }
      size += chunk.length;
      chunks.push(chunk);
    }
  } catch {
    readError = true;
  }
  return {
    text: Buffer.concat(chunks, size).toString('utf8'),
    truncated,
    readError,
  };
}

function privateArticles(body, context) {
  const groups = Array.isArray(body?.reviews) ? body.reviews.slice(0, 1) : [];
  const values = Array.isArray(groups[0]?.subReviews)
    ? groups[0].subReviews.slice(0, 100)
    : [];
  const safeString = (value, max = 1024) =>
    typeof value === 'string' &&
    value.length <= max &&
    !value.includes(context.skey) &&
    !value.includes(context.vid) &&
    !/[?&](?:skey|vid|accessToken)=/i.test(value)
      ? value
      : null;
  const safeNumber = (value) =>
    Number.isSafeInteger(value) &&
    !String(value).includes(context.skey) &&
    !String(value).includes(context.vid)
      ? value
      : null;
  return values.map((item) => {
    const review = item?.review;
    const mp = review?.mpInfo;
    return {
      reviewId: safeString(review?.reviewId, 512),
      belongBookId: safeString(review?.belongBookId, 128),
      originalId: safeString(mp?.originalId, 512),
      title: safeString(mp?.title),
      mpName: safeString(mp?.mp_name),
      time: safeNumber(mp?.time),
      createTime: safeNumber(review?.createTime),
    };
  });
}

function writePrivate(runDir, record) {
  const file = path.join(runDir, RECORD);
  const temp = path.join(
    runDir,
    `.book-articles-query-${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.linkSync(temp, file);
  fs.unlinkSync(temp);
}

async function runOnce(dbPath, runDir, options = {}) {
  const context = (options.contextGate ?? contextGate)(dbPath, runDir);
  const shape = requestShape(
    context,
    options.synckey ?? yesterdayShanghai(new Date()),
  );
  (options.marker ?? markAttempt)();
  let response;
  try {
    response = await (options.transport ?? requestOnce)(shape);
  } catch {
    return {
      decision: 'stop_transport',
      networkRequests: 1,
      productionWrites: 0,
    };
  }
  const read = await boundedBody(response);
  let body = null;
  if (!read.truncated && !read.readError) {
    try {
      body = JSON.parse(read.text);
    } catch {
      /* Never expose raw response text or error snippets. */
    }
  }
  const result = classify(response.status, body, read, response.headers);
  const record = {
    formatVersion: 1,
    kind: 'book-articles-query-shape-structure',
    endpoint: ARTICLE_PATH,
    capturedAt: new Date().toISOString(),
    http: response.status,
    businessCode: result.businessCode,
    decision: result.decision,
    responseBytesWithinLimit: Buffer.byteLength(read.text, 'utf8'),
    bodyTruncated: read.truncated,
    bodyReadError: read.readError,
    structure: structure(body),
    projectedArticles: privateArticles(body, context),
  };
  try {
    (options.writer ?? writePrivate)(context.runDir, record);
  } catch {
    return { ...result, privateStructureSaved: false };
  }
  return { ...result, privateStructureSaved: true };
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(
    () => environmentGate({ NODE_DEBUG: 'http' }),
    /environment_gate/,
  );
  const context = { vid: '12345', skey: 'secret-skey', runDir: 'fake' };
  const shape = requestShape(context, 1790000000);
  assert.equal(shape.url.hostname, 'i.weread.qq.com');
  assert.deepEqual(
    [...shape.url.searchParams.keys()],
    ['bookId', 'version', 'vid', 'skey', 'offset', 'count', 'synckey'],
  );
  assert.equal(shape.url.searchParams.get('count'), '1');
  assert.equal(shape.url.searchParams.get('version'), '2');
  assert.equal(shape.url.searchParams.get('skey'), context.skey);
  assert.equal(Object.hasOwn(shape.headers, 'skey'), false);
  assert.equal(Object.hasOwn(shape.headers, 'Cookie'), false);
  assert.equal(
    yesterdayShanghai(new Date('2026-09-30T03:00:00Z')),
    Date.UTC(2026, 8, 29, -8) / 1000,
  );
  const cases = [
    [
      200,
      {
        reviews: [
          {
            subReviews: [
              {
                review: {
                  reviewId: 'id',
                  mpInfo: { originalId: 'orig', title: 'title', time: 123 },
                },
              },
            ],
          },
        ],
      },
      'reviews_returned_unverified',
    ],
    [200, { reviews: [] }, 'empty_reviews_unverified'],
    [401, { errCode: -2012 }, 'stop_http'],
    [302, null, 'stop_redirect'],
    [429, { errCode: -2014 }, 'stop_rate_limit'],
    [200, { errCode: -2041 }, 'stop_verification'],
  ];
  let requests = 0;
  for (const [status, body, expected] of cases) {
    let saved;
    let marked = 0;
    const result = await runOnce('', '', {
      contextGate: () => context,
      marker: () => {
        marked++;
      },
      synckey: 1790000000,
      transport: async (request) => {
        requests++;
        assert.equal(marked, 1);
        assert.equal(request.url.searchParams.get('skey'), context.skey);
        return {
          status,
          headers: status === 302 ? { location: '/verify?secret=ignored' } : {},
          body: Readable.from(body === null ? [] : [JSON.stringify(body)]),
        };
      },
      writer: (_dir, record) => {
        saved = record;
      },
    });
    assert.equal(result.decision, expected);
    assert.equal(result.networkRequests, 1);
    assert.equal(marked, 1);
    assert.equal(JSON.stringify(result).includes(context.skey), false);
    assert.equal(JSON.stringify(saved).includes(context.skey), false);
    assert.equal(JSON.stringify(saved).includes(context.vid), false);
    if (expected === 'reviews_returned_unverified') {
      assert.equal(saved.projectedArticles.length, 1);
      assert.equal(saved.projectedArticles[0].originalId, 'orig');
    }
  }
  const redacted = privateArticles(
    {
      reviews: [
        {
          subReviews: [
            {
              review: {
                reviewId: context.skey,
                mpInfo: { originalId: `x${context.vid}y` },
              },
            },
          ],
        },
      ],
    },
    context,
  );
  assert.equal(redacted[0].reviewId, null);
  assert.equal(redacted[0].originalId, null);
  return {
    decision: 'self_test_passed',
    fakeNetworkRequests: requests,
    productionWrites: 0,
  };
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
    console.log(
      JSON.stringify({
        decision: 'plan_only',
        endpoint: ARTICLE_PATH,
        queryShape: 'syfun_2026_version2_count1',
        maxRequests: 1,
        responseLimit: RESPONSE_LIMIT,
        productionWrites: 0,
        approvedOnlineFlagRequired: true,
      }),
    );
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
    const safe = new Set([
      'environment_gate',
      'run_dir_gate',
      'private_root_gate',
      'query_shape_already_attempted',
      'private_record_gate',
      'source_provenance_gate',
      'login_response_gate',
      'refresh_marker_gate',
      'health_marker_gate',
      'recovery_gate',
      'source_backup_gate',
      'recovery_identity_gate',
      'db_gate',
      'account_gate',
      'mobile_gate',
      'integrity_gate',
      'sqlite_runtime_gate',
    ]);
    console.log(
      JSON.stringify({
        decision: safe.has(error.message) ? error.message : 'preflight_gate',
        networkRequests: 0,
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (options.mode === '--preflight') {
    console.log(
      JSON.stringify({
        decision: 'preflight_ready',
        networkRequests: 0,
        productionWrites: 0,
      }),
    );
    return;
  }
  try {
    const result = await runOnce(options.dbPath, options.runDir);
    console.log(JSON.stringify(result));
    if (result.decision !== 'reviews_returned_unverified') process.exitCode = 1;
  } catch (error) {
    const safe = new Set(['query_shape_already_attempted', 'clock_gate']);
    console.log(
      JSON.stringify({
        decision: safe.has(error.message) ? error.message : 'execution_gate',
        networkRequests: fs.existsSync(MARKER) ? null : 0,
      }),
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  args,
  contextGate,
  yesterdayShanghai,
  requestShape,
  privateArticles,
  runOnce,
  selfTest,
};
