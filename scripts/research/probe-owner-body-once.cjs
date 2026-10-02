'use strict';

// One root-run body-only probe for the resolved reviewId from owner-06.
// Uses existing owner-weread-latest body transport, articleIdentity /
// articleContentHtml, and Web session Cookie helper.
// No cover, closed relay, original WeChat requests, images,
// production writes or old-stop deletion.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const serverRequire = createRequire(
  path.join(ROOT, 'apps/server/package.json'),
);
const cheerio = serverRequire('cheerio');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const {
  safePrivateRoot,
  within,
} = require('./probe-mobile-refresh-preflight.cjs');
const { snapshot } = require('./probe-recent-account-discovery.cjs');
const ENDPOINT = 'https://weread.qq.com/web/mp/content';
const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024;
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
  if (!reader) throw Error('response_body_missing');
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

function parseBodyHtml(html, { candidate, feed }) {
  const $ = cheerio.load(html);
  if (
    $(
      'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
    ).length ||
    /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
      html,
    )
  ) {
    throw Error('challenge_or_rate_limit');
  }

  const { articleIdentity, articleContentHtml } = require(
    path.join(
      ROOT,
      'apps/server/dist/apps/server/src/collection/article-page.js',
    ),
  );

  const identity = articleIdentity(html);
  const title = $('#activity-name').text().trim();
  const accountName = $('#js_name').text().trim();
  const norm = (v) => (v || '').normalize('NFKC').replace(/\s+/gu, '');
  const contentHtml = articleContentHtml(html);

  if (
    identity.mpId !== candidate.mpId ||
    identity.id !== candidate.id ||
    (feed?.name && norm(accountName) !== norm(feed.name)) ||
    (candidate.title && norm(title) !== norm(candidate.title)) ||
    !identity.publishTime ||
    typeof identity.publishTime !== 'number' ||
    identity.publishTime <= 0 ||
    !contentHtml ||
    typeof contentHtml !== 'string' ||
    !contentHtml.trim()
  ) {
    throw Error('identity_time_or_body_invalid');
  }

  return {
    candidateId: identity.id,
    mpId: identity.mpId,
    title,
    accountName,
    publishTime: identity.publishTime,
    url: identity.url,
    contentHtml,
    contentBytes: Buffer.byteLength(contentHtml, 'utf8'),
    verified: true,
  };
}

function validatePrerequisites({
  resolution,
  resolverResult,
  loginResult,
  mobileSession,
  feed,
  candidate,
  webSession,
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
      mobileSession.accountId &&
      mobileSession.mobile &&
      typeof mobileSession.mobile.accessToken === 'string',
    'mobile_session_mismatch',
  );

  assert(feed && feed.mpId === resolution.mpId, 'feed_mpId_mismatch');
  assert(
    String(feed.ownerVid) === String(mobileSession.accountId),
    'feed_ownerVid_mismatch',
  );
  assert(
    Array.isArray(feed.originalStopFiles) &&
      feed.originalStopFiles.length > 0 &&
      feed.originalStopFiles.every((f) => fs.existsSync(f)),
    'feed_original_stop_files_missing',
  );

  assert(
    candidate &&
      candidate.id === resolution.candidateId &&
      candidate.mpId === resolution.mpId &&
      typeof candidate.title === 'string' &&
      candidate.title.trim().length > 0,
    'candidate_mismatch',
  );

  const { ownerSessionCookie } = require(
    path.join(
      ROOT,
      'apps/server/dist/apps/server/src/collection/owner-web-search.js',
    ),
  );
  const cookieHeader = ownerSessionCookie(webSession, String(feed.ownerVid));
  assert(
    typeof cookieHeader === 'string' &&
      cookieHeader.includes('wr_skey=') &&
      cookieHeader.includes('wr_vid='),
    'web_session_cookie_invalid',
  );

  return { cookieHeader };
}

async function probe({
  candidate,
  feed,
  reviewId,
  cookieHeader,
  marker,
  output,
  fetchImpl,
  takeSnapshot,
  protectedHashes,
  bodyLimit = DEFAULT_BODY_LIMIT,
}) {
  const before = takeSnapshot();
  // Exclusive pre-fetch marker is published BEFORE the single network call. Never clear it.
  publish(marker, {
    startedAt: new Date().toISOString(),
    candidateId: candidate.id,
    reviewId,
    cookieHash: hash(cookieHeader),
    before,
    protectedHashes,
  });

  let status = null,
    stage = 'transport',
    article = null;
  try {
    const url = new URL(ENDPOINT);
    url.searchParams.set('reviewId', reviewId);

    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Cookie: cookieHeader,
        Referer: 'https://weread.qq.com/',
        Origin: 'https://weread.qq.com',
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
    });

    status = response.status;
    stage = 'response';
    const raw = await boundedBody(response, bodyLimit);

    // Save raw response body privately before parsing.
    fs.writeFileSync(path.join(output, 'response-body.html'), raw, {
      flag: 'wx',
      mode: 0o600,
    });
    publish(path.join(output, 'response-metadata.json'), {
      status,
      bytes: raw.length,
    });

    if (status !== 200) throw Error('http_rejected');

    stage = 'parsing';
    const html = raw.toString('utf8');
    article = parseBodyHtml(html, { candidate, feed });
    stage = 'parsed';
  } catch {
    /* No raw upstream errors or secrets reach logs/public diagnostics. */
  }

  const after = takeSnapshot();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const success = stage === 'parsed' && unchanged;

  if (success && article) {
    publish(path.join(output, 'article.json'), {
      candidateId: article.candidateId,
      mpId: article.mpId,
      reviewId,
      title: article.title,
      accountName: article.accountName,
      publishTime: article.publishTime,
      url: article.url,
      contentBytes: article.contentBytes,
      verified: true,
    });
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
    publishTime: article?.publishTime ?? null,
  };

  publish(path.join(output, 'result.json'), result);
  return result;
}

async function execute(sessionDirectory) {
  environmentGate(process.env);
  const source = safePrivateRoot(sessionDirectory);
  assert(
    within(path.join(ROOT, 'private-data/list-discovery-20261002'), source),
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
  const webSession = read(feed.sessionFile);

  const evidenceFile = path.join(
    ROOT,
    'private-data/list-discovery-20261002/fresh-search-result.json',
  );
  const evidence = read(evidenceFile);
  const candidate = evidence.result.candidates.find(
    (c) => c.id === resolution.candidateId,
  );

  const { cookieHeader } = validatePrerequisites({
    resolution,
    resolverResult,
    loginResult,
    mobileSession,
    feed,
    candidate,
    webSession,
  });

  const db = path.join(ROOT, 'apps/server/data/wewe-rss.db');
  const baseline = snapshot(db);
  assert.deepEqual(baseline, loginResult.after);

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
    feed.sessionFile,
    ...feed.originalStopFiles,
    resolutionFile,
    resolverResultFile,
    loginResultFile,
    mobileSessionFile,
    evidenceFile,
  ];
  const protectedHashes = () =>
    protectedFiles.map((file) => hash(fs.readFileSync(file)));

  const output = path.join(source, 'body');
  fs.mkdirSync(output, { mode: 0o700 });

  const marker = path.join(
    ROOT,
    'private-data/list-discovery-20261002/body-attempt.json',
  );

  return probe({
    candidate,
    feed,
    reviewId: resolution.reviewId,
    cookieHeader,
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
        requests: 0,
        executionBudget: 1,
        productionWrites: 0,
        coverRequests: 0,
        imagesArchived: 0,
        requiresResolvedReviewId: true,
        requiresWebSession: true,
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
  parseBodyHtml,
  validatePrerequisites,
  probe,
  execute,
};
