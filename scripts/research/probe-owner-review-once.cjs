'use strict';

// One root-run resolver probe. No token manager, refresh, retry or production writes.
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
const ENDPOINT = 'https://i.weread.qq.com/mp/getreviewid';
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

function sessionGate(session, login, attempt, expectedVid, deviceId, now) {
  const age = now - Date.parse(session.capturedAt);
  assert(
    session.source === 'owner-confirmed-eink-sdk-login' &&
      session.formatVersion === 1,
  );
  assert(login.success === true && login.productionUnchanged === true);
  assert(Number.isFinite(age) && age >= 0 && age < 30 * 60000);
  assert(Date.parse(session.capturedAt) >= Date.parse(attempt.startedAt));
  assert(session.accountId && String(session.mobile?.vid) === expectedVid);
  assert(session.mobile.deviceId === deviceId);
  assert(
    attempt.ownerHash === hash(expectedVid) &&
      attempt.deviceHash === hash(deviceId),
  );
  assert(
    typeof session.mobile.accessToken === 'string' &&
      session.mobile.accessToken.length > 0,
  );
  assert(!/[\s\x00-\x1f\x7f]/.test(session.mobile.accessToken));
  return session.mobile;
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('response_body_missing');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 65536) {
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

async function probe({
  candidate,
  mobile,
  profile,
  marker,
  output,
  fetchImpl,
  takeSnapshot,
  parse,
  protectedHashes,
}) {
  const before = takeSnapshot();
  // Global exclusive marker is published BEFORE the one network call. Never clear it.
  publish(marker, {
    startedAt: new Date().toISOString(),
    candidateId: candidate.id,
    sessionHash: hash(mobile.accessToken),
    before,
    protectedHashes,
  });
  let status = null,
    stage = 'transport',
    resolution;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        ...profile.authHeaders(mobile),
        ...profile.versionHeaders,
        'content-type': 'application/json; charset=UTF-8',
      },
      // Preserve actual search request URL, including its upstream parameters.
      body: JSON.stringify({ urls: [candidate.requestUrl ?? candidate.url] }),
    });
    status = response.status;
    stage = 'response';
    const raw = await boundedBody(response);
    fs.writeFileSync(path.join(output, 'response-body.bin'), raw, {
      flag: 'wx',
      mode: 0o600,
    });
    publish(path.join(output, 'response-metadata.json'), {
      status,
      bytes: raw.length,
    });
    if (status !== 200) throw Error('http_rejected');
    stage = 'identity';
    const data = JSON.parse(raw.toString('utf8'));
    if (
      [data?.errMsg, data?.errmsg, data?.message].some(
        (v) =>
          typeof v === 'string' &&
          /captcha|验证码|安全验证|环境异常|频繁|限流|限频|rate.?limit|too many/i.test(
            v,
          ),
      )
    )
      throw Error('challenge_or_rate_limit');
    resolution = parse(candidate, data);
    stage = 'parsed';
  } catch {
    /* No raw upstream errors or secrets reach logs/public diagnostics. */
  }
  const after = takeSnapshot();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const success = stage === 'parsed' && unchanged;
  if (success) publish(path.join(output, 'resolution.json'), resolution);
  const result = {
    success,
    stage,
    status,
    requests: 1,
    productionUnchanged: unchanged,
    candidateId: candidate.id,
    originalVerified: false,
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
  const read = (file) => JSON.parse(fs.readFileSync(file));
  const configFile = path.join(
    ROOT,
    'private-data/update-fix-20260930/source-config.json',
  );
  const config = read(configFile).feeds.MP_WXS_3895431412;
  const oldFile = path.join(
    ROOT,
    'private-data/mobile-refresh-MUiTjp/mobile-refresh-recovery.json',
  );
  const old = read(oldFile).proposedMobile;
  const sessionFile = path.join(source, 'mobile-session.json');
  const session = read(sessionFile);
  const login = read(path.join(source, 'result.json'));
  const attempt = read(path.join(source, 'attempt.json'));
  const mobile = sessionGate(
    session,
    login,
    attempt,
    String(config.ownerVid),
    old.deviceId,
    Date.now(),
  );
  const evidenceFile = path.join(
    ROOT,
    'private-data/list-discovery-20261002/fresh-search-result.json',
  );
  const evidence = read(evidenceFile);
  assert(
    evidence.productionUnchanged &&
      evidence.requests === 5 &&
      evidence.result.complete === false,
  );
  const candidate = evidence.result.candidates[0]; // Deterministic discovery result, no acceptance seeds.
  assert(candidate.mpId === 'MP_WXS_3895431412' && candidate.requestUrl);
  const built = path.join(ROOT, 'apps/server/dist/apps/server/src/collection');
  const { canonicalArticleUrl } = require(
    path.join(built, 'collection-format.js'),
  );
  const { parseOwnerReviewResolution } = require(
    path.join(built, 'owner-review-resolution.js'),
  );
  const url = new URL(candidate.requestUrl);
  assert(!/[\s\\]|&amp;/.test(candidate.requestUrl));
  assert(
    ['__biz', 'mid', 'idx', 'sn'].every(
      (key) => url.searchParams.getAll(key).length === 1,
    ),
  );
  const canonical = canonicalArticleUrl(candidate.requestUrl);
  assert(
    candidate.id === canonical.id &&
      candidate.url === canonical.url &&
      candidate.mpId === canonical.mpId,
  );
  const cache = verifyCache(
    path.join(ROOT, 'private-data/list-discovery-20261002/sdk-cache'),
  );
  const profile = require(path.join(cache, 'src/profile.js')).einkProfile();
  const db = path.join(ROOT, 'apps/server/data/wewe-rss.db');
  const baseline = snapshot(db);
  assert.deepEqual(baseline, login.after);
  const { DatabaseSync } = require('node:sqlite');
  const dbRead = new DatabaseSync(db, { readOnly: true });
  try {
    const rows = dbRead.prepare('SELECT id FROM accounts LIMIT 2').all();
    assert(rows.length === 1 && rows[0].id === session.accountId);
  } finally {
    dbRead.close();
  }
  const files = [
    configFile,
    config.sessionFile,
    config.wereadLatestStateFile,
    oldFile,
    sessionFile,
    evidenceFile,
  ];
  const protectedHashes = () =>
    files.map((file) => hash(fs.readFileSync(file)));
  const output = path.join(source, 'resolver');
  fs.mkdirSync(output, { mode: 0o700 });
  return probe({
    candidate,
    mobile,
    profile,
    marker: path.join(
      ROOT,
      'private-data/list-discovery-20261002/resolver-attempt.json',
    ),
    output,
    fetchImpl: fetch,
    parse: parseOwnerReviewResolution,
    protectedHashes: protectedHashes(),
    takeSnapshot: () => ({ db: snapshot(db), files: protectedHashes() }),
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--plan')
    console.log(
      JSON.stringify({
        endpoint: '/mp/getreviewid',
        requests: 0,
        executionBudget: 1,
        productionWrites: 0,
        refresh: false,
        requiresNewOwnerSdkSession: true,
      }),
    );
  else if (
    argv.length === 2 &&
    argv[0] === '--execute' &&
    path.isAbsolute(argv[1])
  )
    execute(argv[1])
      .then((r) => console.log(JSON.stringify(r)))
      .catch(() => {
        // May include a post-request local I/O failure: do not falsely report zero.
        console.log(
          JSON.stringify({
            state: 'execution_stopped',
            requestCountUnknown: true,
          }),
        );
        process.exitCode = 1;
      });
  else process.exitCode = 1;
}
module.exports = { sessionGate, boundedBody, probe };
