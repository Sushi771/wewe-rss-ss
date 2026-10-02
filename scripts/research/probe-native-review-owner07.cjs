'use strict';

// Official EInk 2.1.2 MpRemoteService.getReviewMpInfo: one GET, reviewId only.
// Fresh owner-07 authorization is a distinct condition from expired owner-06.
// Metadata determines inner/outer article handling; it is not an article/RSS write.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const {
  PATHS,
  validateCredentials,
  loadProfile,
  buildHeaders,
  assertSafePath,
} = require('./discovery-eink-storyfeed.cjs');
const {
  boundedBody,
  publish,
} = require('./probe-owner-review-single-once.cjs');
const ROOT = path.resolve(__dirname, '../..');
const PRIVATE = path.join(ROOT, 'private-data');
const DISCOVERY = path.join(PRIVATE, 'list-discovery-20261002');
const OWNER = path.join(DISCOVERY, 'sdk-login-owner-07');
const MARKER = path.join(DISCOVERY, 'review-native-owner07-attempt.json');
const OUTPUT = path.join(OWNER, 'review-native');
const ENDPOINT = 'https://i.weread.qq.com/review/single';
const TARGET = 'MP_WXS_3895431412';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function requestUrl(reviewId) {
  assert(typeof reviewId === 'string' && reviewId.startsWith(TARGET + '_'));
  assert(reviewId.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(reviewId));
  const url = new URL(ENDPOINT);
  url.searchParams.set('reviewId', reviewId);
  return url;
}

function prerequisites() {
  environmentGate(process.env);
  for (const p of [OWNER, MARKER, OUTPUT, PATHS.cache])
    assertSafePath(p, PRIVATE);
  const sessionFile = path.join(OWNER, 'mobile-session.json');
  const loginFile = path.join(OWNER, 'result.json');
  for (const p of [sessionFile, loginFile]) assertSafePath(p, PRIVATE);
  const session = read(sessionFile);
  validateCredentials(session, read(loginFile));
  const old = read(PATHS.session);
  assert.equal(session.accountId, old.accountId);
  assert.equal(session.mobile.deviceId, old.mobile.deviceId);
  assert.notEqual(session.mobile.accessToken, old.mobile.accessToken);
  assert(Date.parse(session.capturedAt) > Date.parse(old.capturedAt));
  const resolution = read(
    path.join(DISCOVERY, 'sdk-login-owner-06/resolver/resolution.json'),
  );
  const resolverResult = read(
    path.join(DISCOVERY, 'sdk-login-owner-06/resolver/result.json'),
  );
  assert.equal(resolution.mpId, TARGET);
  assert.equal(resolverResult.success, true);
  assert.equal(resolverResult.candidateId, resolution.candidateId);
  const url = requestUrl(resolution.reviewId);
  const profile = loadProfile(ROOT, PATHS.cache);
  assert(!fs.existsSync(MARKER) && !fs.existsSync(OUTPUT), 'already_attempted');
  return { session, resolution, url, profile };
}

function metadata(data, expectedId) {
  const code = data?.errCode ?? data?.errcode;
  if (code !== undefined && code !== 0) throw Error('upstream_stop');
  const r = data?.review;
  assert(r && typeof r === 'object' && !Array.isArray(r), 'review_missing');
  const returnedId = data.reviewId ?? r.reviewId;
  assert.equal(returnedId, expectedId, 'review_id_mismatch');
  const mp = r.mpInfo;
  assert(mp && typeof mp === 'object', 'mp_info_missing');
  const title =
    typeof mp.title === 'string'
      ? mp.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500)
      : null;
  return {
    reviewId: returnedId,
    type: Number.isInteger(r.type) ? r.type : null,
    bookId: typeof r.bookId === 'string' ? r.bookId : null,
    belongBookId: typeof r.belongBookId === 'string' ? r.belongBookId : null,
    // The actual native response encodes the APK's Boolean as numeric 0/1.
    // Preserve unknown values instead of treating every nonzero value as true.
    inner:
      typeof mp.inner === 'boolean'
        ? mp.inner
        : mp.inner === 0
          ? false
          : mp.inner === 1
            ? true
            : null,
    innerWireType: typeof mp.inner,
    title,
    docUrlPresent: typeof mp.doc_url === 'string' && mp.doc_url.length > 0,
    mpInfoTimePresent: typeof mp.time === 'number' && Number.isFinite(mp.time),
    payType: Number.isInteger(mp.payType) ? mp.payType : null,
    publicationVerified: false,
    bodyVerified: false,
    subscriptionRecovered: false,
  };
}

async function execute() {
  const { session, resolution, url, profile } = prerequisites();
  publish(MARKER, {
    kind: 'native-review-owner07',
    endpoint: ENDPOINT,
    startedAt: new Date().toISOString(),
  });
  fs.mkdirSync(OUTPUT, { mode: 0o700 });
  let httpStatus = null;
  let bytes = 0;
  let state = 'transport_stop';
  let details = {};
  let upstreamCode = null;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(profile, session.mobile),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    httpStatus = response.status;
    const raw = await boundedBody(response, 2 * 1024 * 1024);
    bytes = raw.length;
    fs.writeFileSync(path.join(OUTPUT, 'raw-response.bin'), raw, {
      flag: 'wx',
      mode: 0o600,
    });
    const data = JSON.parse(raw.toString('utf8'));
    const code = data?.errCode ?? data?.errcode;
    upstreamCode = typeof code === 'number' ? code : null;
    if ([401, 403].includes(httpStatus) || [-2012, -2013].includes(code))
      state = 'auth_stop';
    else if (httpStatus === 429 || code === -2041)
      state = 'challenge_or_limit_stop';
    else if (httpStatus !== 200 || (code !== undefined && code !== 0))
      state = 'upstream_stop';
    else {
      state = 'shape_stop';
      details = metadata(data, resolution.reviewId);
      state = 'metadata_received';
    }
  } catch {
    /* Raw errors and private credentials never reach stdout. */
  }
  const result = {
    state,
    requestCount: 1,
    httpStatus,
    upstreamCode,
    bytes,
    ...details,
    publicationVerified: false,
    bodyVerified: false,
    subscriptionRecovered: false,
    productionWrites: 0,
  };
  publish(path.join(OUTPUT, 'summary.json'), result);
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--preflight') {
    try {
      prerequisites();
      console.log(
        JSON.stringify({
          state: 'preflight_ready',
          requestCount: 0,
          markerWritten: false,
        }),
      );
    } catch {
      console.log(
        JSON.stringify({ state: 'local_gate_stop', requestCount: 0 }),
      );
      process.exitCode = 1;
    }
  } else if (
    args.length === 2 &&
    args[0] === '--execute' &&
    args[1] === '--approved-online'
  ) {
    execute()
      .then((r) => console.log(JSON.stringify(r)))
      .catch(() => {
        console.log(JSON.stringify({ state: 'local_gate_stop' }));
        process.exitCode = 1;
      });
  } else {
    process.exitCode = 1;
  }
}
module.exports = { requestUrl, metadata };
