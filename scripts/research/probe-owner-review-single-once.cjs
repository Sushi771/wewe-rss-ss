'use strict';

// One root-run mobile read-only probe for the resolved reviewId from owner-06 resolver.
// Pinned against weread-omni review.single (src/api/resources/review.ts and test/integration/resources.test.ts).
// Gated to one GET /review/single with the six query fields used by the pinned open-source client.
// This is a NEW mobile endpoint, not a retry of failed Web /web/mp/content.
// Uses owner-06 authorized mobile session (vid, accessToken) with E-Ink profile headers.
// Preserves exclusive marker review-single-attempt.json before network; max 1 request, 0 redirects/retries/refresh.
// This endpoint yields article metadata and a doc_url; it does not prove article body retrieval.
// No production DB writes, no photo downloads, no web cookies.
// Stores raw responses privately under mode 0o600; prints only sanitized metadata.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const {
  safePrivateRoot,
  within,
} = require('./probe-mobile-refresh-preflight.cjs');
const { snapshot } = require('./probe-recent-account-discovery.cjs');
const { verifyCache } = require('./prepare-owner-sdk-cache.cjs');

const ROOT = path.resolve(__dirname, '../..');
const ENDPOINT = 'https://i.weread.qq.com/review/single';
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const hash = (v) => createHash('sha256').update(v).digest('hex');

function publish(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function boundedBody(response, limit = DEFAULT_BODY_LIMIT) {
  const reader = response.body?.getReader();
  if (!reader) {
    if (typeof response.arrayBuffer === 'function') {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > limit) throw Error('response_body_limit');
      return buf;
    }
    throw Error('response_body_missing');
  }
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw Error('response_body_limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function buildRequestUrl(reviewId) {
  assert(
    typeof reviewId === 'string' && reviewId.trim().length > 0,
    'reviewId_required',
  );
  const url = new URL(ENDPOINT);
  url.searchParams.set('reviewId', reviewId);
  url.searchParams.set('commentsCount', '10');
  url.searchParams.set('commentsDirection', '0');
  url.searchParams.set('likesCount', '10');
  url.searchParams.set('likesDirection', '0');
  url.searchParams.set('synckey', '0');
  return url;
}

function parseReviewSingle(data, { candidate, feed, reviewId }) {
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    throw Error('empty_response');
  }

  const errCode = data?.errCode ?? data?.errcode;
  const errMsg = data?.errMsg ?? data?.errmsg ?? data?.message;
  if (typeof errCode === 'number' && errCode !== 0) {
    if (errCode === -2012) throw Error('auth_expired');
    if (errCode === -2041) throw Error('challenge_required');
    throw Error(`upstream_error_${errCode}`);
  }
  if (
    typeof errMsg === 'string' &&
    /captcha|验证码|请完成验证|安全验证|环境异常|频繁|限流|限频|rate.?limit|too many/i.test(
      errMsg,
    )
  ) {
    throw Error('challenge_or_rate_limit');
  }

  const review = data.review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw Error('empty_review');
  }

  const returnedReviewId = data.reviewId || review?.reviewId;
  if (returnedReviewId && returnedReviewId !== reviewId) {
    throw Error('review_id_mismatch');
  }

  if (review.bookId !== candidate?.mpId || review.bookId !== feed?.mpId) {
    throw Error('book_id_mismatch');
  }

  const title = (review?.mpInfo?.title || review?.title || '').trim();
  const accountName = (review?.mpInfo?.mp_name || '').trim();
  const publishTime =
    typeof review?.mpInfo?.time === 'number'
      ? review.mpInfo.time
      : typeof review?.createTime === 'number'
        ? review.createTime
        : null;

  const norm = (v) => (v || '').normalize('NFKC').replace(/\s+/gu, '');
  if (candidate?.title && title && norm(title) !== norm(candidate.title)) {
    throw Error('title_mismatch');
  }

  const docUrl = review?.mpInfo?.doc_url;
  let hasSourceUrl = false;
  let sourceIdentityMatched = null;
  if (typeof docUrl === 'string' && docUrl.length > 0) {
    const source = new URL(docUrl);
    if (
      source.protocol !== 'https:' ||
      source.hostname !== 'mp.weixin.qq.com' ||
      !/^\/s(?:\/|$)/.test(source.pathname)
    ) {
      throw Error('invalid_doc_url');
    }
    hasSourceUrl = true;
    const candidateUrl = new URL(candidate.url);
    const keys = ['__biz', 'mid', 'idx'];
    if (keys.every((key) => source.searchParams.has(key))) {
      sourceIdentityMatched = keys.every(
        (key) =>
          source.searchParams.get(key) === candidateUrl.searchParams.get(key),
      );
      if (!sourceIdentityMatched) throw Error('doc_url_identity_mismatch');
    }
  }

  return {
    candidateId: candidate?.id ?? null,
    mpId: candidate?.mpId ?? null,
    reviewId,
    title: title || candidate?.title || null,
    accountName: accountName || feed?.name || null,
    publishTime,
    publishTimeSource:
      typeof review?.mpInfo?.time === 'number'
        ? 'mpInfo.time'
        : typeof review?.createTime === 'number'
          ? 'review.createTime'
          : null,
    docUrl: hasSourceUrl ? docUrl : null,
    hasSourceUrl,
    sourceIdentityMatched,
    metadataVerified: Boolean(returnedReviewId && title),
    bodyVerified: false,
  };
}

function validatePrerequisites({
  resolution,
  resolverResult,
  loginResult,
  mobileSession,
  feed,
  candidate,
}) {
  assert(resolution && typeof resolution === 'object', 'resolution_missing');
  assert(
    typeof resolution.mpId === 'string' && /^MP_WXS_\d+$/.test(resolution.mpId),
    'invalid_resolution_mpId',
  );
  assert(
    typeof resolution.candidateId === 'string' &&
      /^WX_\d+_\d+_\d+$/.test(resolution.candidateId),
    'invalid_resolution_candidateId',
  );
  assert(
    typeof resolution.reviewId === 'string' &&
      new RegExp(`^${resolution.mpId}_[A-Za-z0-9_~-]{1,150}$`).test(
        resolution.reviewId,
      ),
    'invalid_resolution_reviewId',
  );

  assert(
    resolverResult &&
      resolverResult.success === true &&
      resolverResult.status === 200 &&
      resolverResult.requests === 1 &&
      resolverResult.productionUnchanged === true &&
      resolverResult.candidateId === resolution.candidateId,
    'resolver_result_mismatch',
  );

  assert(
    loginResult &&
      loginResult.success === true &&
      loginResult.productionUnchanged === true,
    'login_result_mismatch',
  );

  assert(
    mobileSession &&
      mobileSession.source === 'owner-confirmed-eink-sdk-login' &&
      mobileSession.formatVersion === 1 &&
      mobileSession.accountId &&
      mobileSession.mobile &&
      typeof mobileSession.mobile.accessToken === 'string' &&
      mobileSession.mobile.accessToken.length > 0 &&
      !/[\s\x00-\x1f\x7f]/.test(mobileSession.mobile.accessToken),
    'mobile_session_mismatch',
  );

  assert(feed && feed.mpId === resolution.mpId, 'feed_mpId_mismatch');
  assert(
    String(feed.ownerVid) === String(mobileSession.accountId),
    'feed_ownerVid_mismatch',
  );
  assert(
    String(mobileSession.mobile.vid) === String(feed.ownerVid),
    'mobile_vid_mismatch',
  );

  assert(
    candidate &&
      candidate.id === resolution.candidateId &&
      candidate.mpId === resolution.mpId &&
      typeof candidate.title === 'string' &&
      candidate.title.trim().length > 0,
    'candidate_mismatch',
  );

  return true;
}

async function probe({
  candidate,
  feed,
  reviewId,
  mobile,
  profile,
  marker,
  output,
  fetchImpl,
  takeSnapshot,
  protectedHashes,
  bodyLimit = DEFAULT_BODY_LIMIT,
}) {
  const fetchFn = fetchImpl || fetch;
  const before = takeSnapshot();

  // Exclusive pre-fetch marker is published BEFORE the single network call. Never clear it.
  publish(marker, {
    startedAt: new Date().toISOString(),
    candidateId: candidate.id,
    reviewId,
    endpoint: ENDPOINT,
    sessionHash: hash(mobile.accessToken),
    before,
    protectedHashes,
  });

  let status = null,
    stage = 'transport',
    reviewData = null,
    raw = Buffer.alloc(0),
    responseHeaders = {};

  try {
    const url = buildRequestUrl(reviewId);
    stage = 'network';

    const response = await fetchFn(url.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        ...profile.authHeaders(mobile),
        ...profile.versionHeaders,
      },
    });

    status = response.status;
    if (response.headers) {
      if (typeof response.headers.forEach === 'function') {
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
      } else if (typeof response.headers.entries === 'function') {
        for (const [k, v] of response.headers.entries()) {
          responseHeaders[k] = v;
        }
      } else {
        responseHeaders = { ...response.headers };
      }
    }
    stage = 'response';

    raw = await boundedBody(response, bodyLimit);

    // Save raw response body privately before parsing.
    fs.writeFileSync(path.join(output, 'response-body.bin'), raw, {
      flag: 'wx',
      mode: 0o600,
    });

    const sanitizedHeaders = {};
    for (const [k, v] of Object.entries(responseHeaders)) {
      const lk = k.toLowerCase();
      if (
        [
          'content-type',
          'content-length',
          'content-encoding',
          'transfer-encoding',
          'connection',
          'date',
          'server',
        ].includes(lk)
      ) {
        sanitizedHeaders[lk] = Array.isArray(v) ? v.join(', ') : String(v);
      }
    }

    publish(path.join(output, 'response-metadata.json'), {
      status,
      bytes: raw.length,
      headers: sanitizedHeaders,
    });

    if (status !== 200) throw Error('http_rejected');

    stage = 'parsing';
    const json = JSON.parse(raw.toString('utf8'));
    reviewData = parseReviewSingle(json, { candidate, feed, reviewId });
    stage = 'parsed';
  } catch {
    /* No raw upstream errors or secrets reach logs/public diagnostics. */
  }

  const after = takeSnapshot();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const success = stage === 'parsed' && unchanged;

  if (success && reviewData) {
    publish(path.join(output, 'review-single.json'), reviewData);
  }

  const result = {
    success,
    stage,
    status,
    requests: 1,
    productionUnchanged: unchanged,
    candidateId: candidate.id,
    mpId: candidate.mpId,
    reviewId,
    publishTime: reviewData?.publishTime ?? null,
    hasSourceUrl: reviewData?.hasSourceUrl ?? false,
    metadataVerified: reviewData?.metadataVerified ?? false,
    bodyVerified: false,
  };

  publish(path.join(output, 'result.json'), result);
  return result;
}

async function execute(sessionDirectory) {
  environmentGate(process.env);
  const source = safePrivateRoot(sessionDirectory);
  assert(
    within(path.join(ROOT, 'private-data/list-discovery-20261002'), source),
    'source_path_outside_allowed_discovery_directory',
  );

  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

  const configFile = path.join(
    ROOT,
    'private-data/update-fix-20260930/source-config.json',
  );
  const configData = read(configFile);

  const resolutionFile = path.join(source, 'resolver/resolution.json');
  const resolution = read(resolutionFile);
  const resolverResultFile = path.join(source, 'resolver/result.json');
  const resolverResult = read(resolverResultFile);

  const loginResultFile = path.join(source, 'result.json');
  const loginResult = read(loginResultFile);
  const mobileSessionFile = path.join(source, 'mobile-session.json');
  const mobileSession = read(mobileSessionFile);

  const feed = configData.feeds[resolution.mpId];

  const evidenceFile = path.join(
    ROOT,
    'private-data/list-discovery-20261002/fresh-search-result.json',
  );
  const evidence = read(evidenceFile);
  const candidate = evidence.result.candidates.find(
    (c) => c.id === resolution.candidateId,
  );

  validatePrerequisites({
    resolution,
    resolverResult,
    loginResult,
    mobileSession,
    feed,
    candidate,
  });

  const cache = verifyCache(
    path.join(ROOT, 'private-data/list-discovery-20261002/sdk-cache'),
  );
  const profile = require(path.join(cache, 'src/profile.js')).einkProfile();

  const db = path.join(ROOT, 'apps/server/data/wewe-rss.db');
  const baseline = snapshot(db);
  // Two owner-confirmed articles were imported after the SDK login. Preserve
  // the account/feed binding while snapshotting the current DB before/after.
  assert.equal(baseline.integrity, 'ok');
  assert.deepEqual(baseline.accounts, loginResult.after.accounts);
  assert.deepEqual(baseline.feeds, loginResult.after.feeds);
  assert(
    baseline.articles.count >= loginResult.after.articles.count,
    'article_count_regressed_since_login',
  );

  const { DatabaseSync } = require('node:sqlite');
  const dbRead = new DatabaseSync(db, { readOnly: true });
  try {
    const rows = dbRead.prepare('SELECT id FROM accounts LIMIT 2').all();
    assert(
      rows.length === 1 &&
        String(rows[0].id) === String(mobileSession.accountId),
    );
  } finally {
    dbRead.close();
  }

  const protectedFiles = [
    configFile,
    resolutionFile,
    resolverResultFile,
    loginResultFile,
    mobileSessionFile,
    evidenceFile,
  ];
  const protectedHashes = () =>
    protectedFiles.map((file) => hash(fs.readFileSync(file)));

  const output = path.join(source, 'review-single');
  fs.mkdirSync(output, { mode: 0o700 });

  const marker = path.join(
    ROOT,
    'private-data/list-discovery-20261002/review-single-attempt.json',
  );
  assert(
    !fs.existsSync(
      path.join(
        ROOT,
        'private-data/list-discovery-20261002/mobile-single-attempt.json',
      ),
    ),
    'alternate_mobile_single_attempt_exists',
  );

  return probe({
    candidate,
    feed,
    reviewId: resolution.reviewId,
    mobile: mobileSession.mobile,
    profile,
    marker,
    output,
    fetchImpl: fetch,
    protectedHashes: protectedHashes(),
    takeSnapshot: () => ({ db: snapshot(db), files: protectedHashes() }),
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--plan') {
    console.log(
      JSON.stringify({
        endpoint: ENDPOINT,
        method: 'GET',
        requests: 0,
        executionBudget: 1,
        productionWrites: 0,
        photoRequests: 0,
        requiresOwner06MobileSession: true,
        requiresResolvedReviewId: true,
        exclusiveMarker: 'review-single-attempt.json',
      }),
    );
  } else if (
    argv.length === 2 &&
    argv[0] === '--execute' &&
    path.isAbsolute(argv[1])
  ) {
    execute(argv[1])
      .then((r) => console.log(JSON.stringify(r)))
      .catch(() => {
        console.log(
          JSON.stringify({
            state: 'execution_stopped',
            requestCountUnknown: true,
          }),
        );
        process.exitCode = 1;
      });
  } else {
    process.exitCode = 1;
  }
}

module.exports = {
  ENDPOINT,
  DEFAULT_BODY_LIMIT,
  publish,
  boundedBody,
  buildRequestUrl,
  parseReviewSingle,
  validatePrerequisites,
  probe,
  execute,
};
