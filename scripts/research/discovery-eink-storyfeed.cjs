'use strict';

// Antigravity-authored, isolated first-page discovery experiment. Official
// EInk 2.1.2 MpService.update -> syncArticles -> MpRemoteService.getArticles;
// the existing pinned SDK supplies mobile auth. Coverage is still unproven.
// No SQLite access, refresh, retries, body/image requests, or production writes.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const TARGET_BOOK_ID = 'MP_WXS_3895431412';
const ENDPOINT_URL =
  'https://i.weread.qq.com/storyfeed/getCardArticles?channel=901301&type=0&count=50';
const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

const PATHS = {
  session: path.join(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-06/mobile-session.json',
  ),
  loginResult: path.join(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-06/result.json',
  ),
  cache: path.join(ROOT, 'private-data/list-discovery-20261002/sdk-cache'),
  marker: path.join(
    ROOT,
    'private-data/list-discovery-20261002/storyfeed-attempt.json',
  ),
  outputDir: path.join(
    ROOT,
    'private-data/list-discovery-20261002/sdk-login-owner-06/storyfeed',
  ),
};

function assertSafePath(targetPath, rootDir) {
  const resolvedTarget = path.resolve(targetPath);
  const realRoot = fs.existsSync(rootDir)
    ? fs.realpathSync(rootDir)
    : path.resolve(rootDir);

  let cur = resolvedTarget;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const realCur = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  const relCurFromRoot = path.relative(realRoot, realCur);
  if (
    relCurFromRoot === '..' ||
    relCurFromRoot.startsWith('..' + path.sep) ||
    path.isAbsolute(relCurFromRoot)
  ) {
    throw new Error(
      `Path escapes boundary via ancestor symlink: ${targetPath}`,
    );
  }

  const relTargetFromRoot = path.relative(realRoot, resolvedTarget);
  if (
    relTargetFromRoot === '..' ||
    relTargetFromRoot.startsWith('..' + path.sep) ||
    path.isAbsolute(relTargetFromRoot)
  ) {
    throw new Error(`Target path escapes boundary: ${targetPath}`);
  }

  return resolvedTarget;
}

function validateCredentials(sessionJson, resultJson) {
  if (!resultJson || resultJson.success !== true) {
    throw new Error('Login source result indicates failure or is missing');
  }
  if (
    !sessionJson ||
    sessionJson.source !== 'owner-confirmed-eink-sdk-login' ||
    sessionJson.formatVersion !== 1
  ) {
    throw new Error('Invalid session source or formatVersion');
  }
  if (typeof sessionJson.accountId !== 'string' || !sessionJson.accountId) {
    throw new Error('Invalid accountId');
  }
  const mobile = sessionJson.mobile;
  if (!mobile || typeof mobile !== 'object') {
    throw new Error('Missing mobile session object');
  }
  if (String(mobile.vid) !== String(sessionJson.accountId)) {
    throw new Error('mobile.vid does not match accountId');
  }
  if (typeof mobile.accessToken !== 'string' || !mobile.accessToken) {
    throw new Error('Empty accessToken');
  }
  if (/[\s\x00-\x1F\x7F]/.test(mobile.accessToken)) {
    throw new Error('accessToken contains control characters');
  }
  return { accountId: sessionJson.accountId, mobile };
}

function loadProfile(rootDir, cacheDir) {
  const { verifyCache } = require('./prepare-owner-sdk-cache.cjs');
  const targetCache =
    cacheDir ||
    path.join(rootDir, 'private-data/list-discovery-20261002/sdk-cache');
  const verifiedCache = verifyCache(targetCache);
  const profileFactory = require(
    path.join(verifiedCache, 'src/profile.js'),
  ).einkProfile;
  return profileFactory();
}

function buildHeaders(profile, mobile) {
  const auth =
    (typeof profile.authHeaders === 'function'
      ? profile.authHeaders(mobile)
      : profile.authHeaders) || {};
  const version = profile.versionHeaders || {};
  return {
    ...auth,
    ...version,
  };
}

function classifyResponse(status, text, json) {
  if (status === 401) {
    return { stop: 'auth_stop', reason: 'HTTP_401' };
  }
  if (status === 403) {
    return { stop: 'auth_stop', reason: 'HTTP_403' };
  }
  if (status === 429) {
    return { stop: 'limit_stop', reason: 'HTTP_429' };
  }

  if (json && typeof json === 'object') {
    const rawCode =
      json.errCode !== undefined
        ? json.errCode
        : json.errcode !== undefined
          ? json.errcode
          : json.code;
    if (rawCode !== undefined) {
      if (typeof rawCode !== 'number' || !Number.isFinite(rawCode)) {
        return { stop: 'shape_stop', reason: 'INVALID_CODE_TYPE' };
      }
      if (rawCode === -2012) {
        return { stop: 'auth_stop', reason: 'ERRCODE_-2012' };
      }
      if (rawCode === -2013) {
        return { stop: 'auth_stop', reason: 'ERRCODE_-2013' };
      }
      if (rawCode === -2041) {
        return { stop: 'limit_stop', reason: 'ERRCODE_-2041' };
      }
      if (rawCode !== 0) {
        return { stop: 'upstream_stop', reason: 'UPSTREAM_NONZERO_CODE' };
      }
    }

    const messageField = json.errMsg || json.errmsg || json.message || json.msg;
    if (
      typeof messageField === 'string' &&
      /captcha|challenge|frequency|rate limit|频率|验证码|限制|操作过于频繁/i.test(
        messageField,
      )
    ) {
      return { stop: 'limit_stop', reason: 'CHALLENGE_DETECTED' };
    }
  }

  if (status < 200 || status >= 300) {
    return { stop: 'upstream_stop', reason: `HTTP_${status}` };
  }

  if (!json || typeof json !== 'object' || !Array.isArray(json.articles)) {
    return { stop: 'shape_stop', reason: 'MISSING_ARTICLES_ARRAY' };
  }

  return { stop: null };
}

function parseAndFilterArticles(articles, targetBookId = TARGET_BOOK_ID) {
  if (!Array.isArray(articles)) {
    return { targetCount: 0, targetArticles: [], skippedTargetCount: 0 };
  }

  const seenReviewIds = new Set();
  const targetArticles = [];
  let skippedTargetCount = 0;

  for (const item of articles) {
    if (!item || typeof item !== 'object') continue;
    if (item.bookId !== targetBookId) continue;

    if (
      typeof item.reviewId !== 'string' ||
      !item.reviewId ||
      item.reviewId.length > 200 ||
      /[\x00-\x1F\x7F]/.test(item.reviewId)
    ) {
      skippedTargetCount++;
      continue;
    }

    const reviewId = item.reviewId;
    const isFirstSeen = !seenReviewIds.has(reviewId);
    seenReviewIds.add(reviewId);

    if (isFirstSeen && targetArticles.length < 5) {
      let title = '';
      if (typeof item.title === 'string') {
        title = item.title
          .slice(0, 500)
          .replace(/[\x00-\x1F\x7F]/g, '')
          .trim();
      }
      const createTimePresence =
        typeof item.createTime === 'number' &&
        Number.isFinite(item.createTime) &&
        item.createTime >= 0;

      targetArticles.push({
        bookId: item.bookId,
        reviewId,
        title,
        createTimePresence,
      });
    }
  }

  return {
    targetCount: seenReviewIds.size,
    targetArticles,
    skippedTargetCount,
  };
}

function createMarker(markerPath) {
  const dir = path.dirname(markerPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let fd;
  try {
    fd = fs.openSync(markerPath, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }

  try {
    const payload = Buffer.from(
      JSON.stringify(
        {
          kind: 'eink-storyfeed-discovery',
          endpoint: ENDPOINT_URL,
          attemptedAt: new Date().toISOString(),
          pid: process.pid,
        },
        null,
        2,
      ),
    );
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

async function runPreflight(options = {}) {
  const paths = { ...PATHS, ...options.paths };
  const rootDir =
    options.rootDir || (options.paths && options.paths.rootDir) || ROOT;

  assertSafePath(paths.session, rootDir);
  assertSafePath(paths.loginResult, rootDir);
  assertSafePath(paths.marker, rootDir);
  assertSafePath(paths.outputDir, rootDir);
  assertSafePath(paths.cache, rootDir);

  if (fs.existsSync(paths.marker)) {
    throw new Error('Exclusive attempt marker already exists');
  }

  if (fs.existsSync(paths.outputDir)) {
    throw new Error('Output directory already exists');
  }

  const sessionRaw = fs.readFileSync(paths.session, 'utf8');
  const resultRaw = fs.readFileSync(paths.loginResult, 'utf8');
  validateCredentials(JSON.parse(sessionRaw), JSON.parse(resultRaw));

  const profile =
    options.profile ||
    (options.profileLoader
      ? options.profileLoader(rootDir, paths.cache)
      : loadProfile(rootDir, paths.cache));
  if (!profile || typeof profile.authHeaders !== 'function') {
    throw new Error('Profile loader returned invalid profile');
  }

  return {
    status: 'preflight_ok',
    requestCount: 0,
    markerWritten: false,
    productionWrites: 0,
    markerAbsent: true,
    credentialValid: true,
    outputDirAvailable: true,
    profileValid: true,
  };
}

async function runStoryfeedDiscovery(options = {}) {
  const paths = { ...PATHS, ...options.paths };
  const rootDir =
    options.rootDir || (options.paths && options.paths.rootDir) || ROOT;
  const fetchFn = options.fetchFn || globalThis.fetch;
  let requestCount = 0;

  assertSafePath(paths.session, rootDir);
  assertSafePath(paths.loginResult, rootDir);
  assertSafePath(paths.marker, rootDir);
  assertSafePath(paths.outputDir, rootDir);
  assertSafePath(paths.cache, rootDir);

  if (fs.existsSync(paths.marker)) {
    return {
      status: 'marker_exists_stop',
      reason: 'MARKER_EXISTS',
      requestCount: 0,
      publicationVerified: false,
      bodyVerified: false,
      subscriptionRecovered: false,
      productionWrites: 0,
    };
  }

  if (fs.existsSync(paths.outputDir)) {
    throw new Error('Output directory must not exist prior to run');
  }

  const session = validateCredentials(
    JSON.parse(fs.readFileSync(paths.session, 'utf8')),
    JSON.parse(fs.readFileSync(paths.loginResult, 'utf8')),
  );

  const profile =
    options.profile ||
    (options.profileLoader
      ? options.profileLoader(rootDir, paths.cache)
      : loadProfile(rootDir, paths.cache));
  const headers = buildHeaders(profile, session.mobile);

  const markerCreated = createMarker(paths.marker);
  if (!markerCreated) {
    return {
      status: 'marker_exists_stop',
      reason: 'MARKER_EXISTS',
      requestCount: 0,
      publicationVerified: false,
      bodyVerified: false,
      subscriptionRecovered: false,
      productionWrites: 0,
    };
  }

  fs.mkdirSync(paths.outputDir, { recursive: true, mode: 0o700 });

  let response;
  let rawBuffer;
  requestCount++;

  try {
    response = await fetchFn(ENDPOINT_URL, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let bytesReceived = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytesReceived += value.length;
            if (bytesReceived > MAX_BYTES) {
              await reader.cancel('MAX_BYTES_EXCEEDED');
              const err = new Error('Response exceeded maximum size limit');
              err.code = 'RESPONSE_LIMIT_EXCEEDED';
              throw err;
            }
            chunks.push(Buffer.from(value));
          }
        }
      } finally {
        reader.releaseLock();
      }
      rawBuffer = Buffer.concat(chunks);
    } else {
      const arrayBuffer = await response.arrayBuffer();
      rawBuffer = Buffer.from(arrayBuffer);
      if (rawBuffer.length > MAX_BYTES) {
        const err = new Error('Response exceeded maximum size limit');
        err.code = 'RESPONSE_LIMIT_EXCEEDED';
        throw err;
      }
    }
  } catch (err) {
    const isLimit = err.code === 'RESPONSE_LIMIT_EXCEEDED';
    const failSummary = {
      status: isLimit ? 'response_limit_stop' : 'network_failure',
      reason: isLimit ? 'RESPONSE_LIMIT_EXCEEDED' : 'NETWORK_ERROR',
      requestCount,
      httpStatus: response ? response.status : 0,
      bytesReceived: rawBuffer ? rawBuffer.length : 0,
      publicationVerified: false,
      bodyVerified: false,
      subscriptionRecovered: false,
      productionWrites: 0,
    };
    fs.writeFileSync(
      path.join(paths.outputDir, 'summary.json'),
      JSON.stringify(failSummary, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    return failSummary;
  }

  fs.writeFileSync(path.join(paths.outputDir, 'raw-response.bin'), rawBuffer, {
    flag: 'wx',
    mode: 0o600,
  });

  const text = rawBuffer.toString('utf8');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  const classification = classifyResponse(response.status, text, json);

  if (classification.stop) {
    const stopSummary = {
      status: classification.stop,
      reason: classification.reason,
      requestCount,
      httpStatus: response.status,
      bytesReceived: rawBuffer.length,
      publicationVerified: false,
      bodyVerified: false,
      subscriptionRecovered: false,
      productionWrites: 0,
    };
    fs.writeFileSync(
      path.join(paths.outputDir, 'summary.json'),
      JSON.stringify(stopSummary, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    return stopSummary;
  }

  const { targetCount, targetArticles, skippedTargetCount } =
    parseAndFilterArticles(json.articles || [], TARGET_BOOK_ID);

  const summary = {
    status: 'success',
    reason: 'OK',
    requestCount,
    httpStatus: response.status,
    bytesReceived: rawBuffer.length,
    totalArticles: Array.isArray(json.articles) ? json.articles.length : 0,
    targetCount,
    targetArticles,
    skippedTargetCount,
    hasMore: Boolean(json.hasMore),
    cursorPresence: Boolean(json.kkOffset || json.kkSearchId),
    publicationVerified: false,
    bodyVerified: false,
    subscriptionRecovered: false,
    productionWrites: 0,
  };

  fs.writeFileSync(
    path.join(paths.outputDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const isPreflight = args.length === 1 && args[0] === '--preflight';
  const isExecute =
    args.length === 2 &&
    args[0] === '--execute' &&
    args[1] === '--approved-online';

  if (!isPreflight && !isExecute) {
    console.error(
      'Usage: node discovery-eink-storyfeed.cjs (--preflight | --execute --approved-online)',
    );
    process.exit(1);
  }

  const {
    environmentGate,
  } = require('./probe-refreshed-mobile-web-health.cjs');
  environmentGate(process.env);

  const privateDataRoot = path.join(ROOT, 'private-data');
  assertSafePath(PATHS.session, privateDataRoot);
  assertSafePath(PATHS.loginResult, privateDataRoot);
  assertSafePath(PATHS.marker, privateDataRoot);
  assertSafePath(PATHS.outputDir, privateDataRoot);
  assertSafePath(PATHS.cache, privateDataRoot);

  if (isPreflight) {
    const res = await runPreflight();
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const result = await runStoryfeedDiscovery();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(() => {
    console.log(
      JSON.stringify({
        status: 'local_gate_stop',
        subscriptionRecovered: false,
      }),
    );
    process.exitCode = 1;
  });
}

module.exports = {
  TARGET_BOOK_ID,
  ENDPOINT_URL,
  PATHS,
  assertSafePath,
  validateCredentials,
  loadProfile,
  buildHeaders,
  classifyResponse,
  parseAndFilterArticles,
  createMarker,
  runPreflight,
  runStoryfeedDiscovery,
};
