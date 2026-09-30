#!/usr/bin/env node
'use strict';

// One /api/mp/cover observation. No page navigation or subsequent body GET.
// The old /web/mp/cover marker and result remain independent and untouched.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  environmentGate,
  recoveryGate,
  runtime,
  readPayload,
  numericCode,
  statusStop,
  cookieGate,
  setCookieNames,
} = require('./probe-refreshed-mobile-web-health.cjs');
const {
  privateRootGate,
  targetGate,
  coverShape,
  readCoverJson,
  persistUntilDurable,
} = require('./probe-weread-web-mp-cover.cjs');

const INIT = 'https://weread.qq.com/web/login/session/init';
const COVER = 'https://weread.qq.com/api/mp/cover';
const BOOK_ID = 'MP_WXS_3895431412';
const TARGET_NAME = '妈妈部落畅聊阁';
const MARKER = 'weread-api-mp-cover-target.attempted.json';
const RAW_COVER = 'weread-api-mp-cover-target-response.json';
const CANDIDATE = 'weread-api-mp-cover-target-candidate.json';
const COVER_LIMIT = 64 * 1024;
const CANDIDATE_LIMIT = 8 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
    argv.length === 10 &&
    argv[0] === '--execute' &&
    argv[1] === '--db' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--run-dir' &&
    path.isAbsolute(argv[4]) &&
    argv[5] === '--playwright-core' &&
    path.isAbsolute(argv[6]) &&
    argv[7] === '--browser' &&
    path.isAbsolute(argv[8]) &&
    argv[9] === '--approved-online'
  )
    return {
      mode: argv[0],
      dbPath: argv[2],
      runDir: argv[4],
      modulePath: argv[6],
      browserPath: argv[8],
    };
  throw Error('usage_gate');
}

function historyGate(privateRoot) {
  for (const dir of [
    privateRoot,
    ...fs
      .readdirSync(privateRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith('mobile-refresh-'),
      )
      .map((entry) => path.join(privateRoot, entry.name)),
  ]) {
    if (
      [MARKER, RAW_COVER, CANDIDATE].some((name) =>
        fs.existsSync(path.join(dir, name)),
      )
    )
      throw Error('api_cover_already_attempted');
  }
}

function preflight(dbPath, runDir) {
  const credentials = recoveryGate(dbPath, runDir, 'present');
  const privateRoot = privateRootGate(dbPath, credentials.runDir);
  targetGate(dbPath, credentials.runDir);
  historyGate(privateRoot);
  return { mobile: credentials.mobile, privateRoot };
}

function markAttempt(privateRoot) {
  const marker = {
    kind: 'weread-api-mp-cover-target',
    endpoint: '/api/mp/cover',
    bookId: BOOK_ID,
    attemptedAt: new Date().toISOString(),
  };
  const fd = fs.openSync(path.join(privateRoot, MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(marker) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return marker;
}

function writePrivate(privateRoot, name, body, limit) {
  if (!Buffer.isBuffer(body) || body.length > limit)
    throw Error('api_cover_private_limit');
  const finalPath = path.join(privateRoot, name);
  if (fs.existsSync(finalPath)) {
    if (fs.readFileSync(finalPath).equals(body)) return;
    throw Error('api_cover_private_exists');
  }
  const tempPath = path.join(
    privateRoot,
    `.weread-api-cover-${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.linkSync(tempPath, finalPath);
  if (!fs.readFileSync(finalPath).equals(body))
    throw Error('api_cover_private_verify_gate');
  fs.unlinkSync(tempPath);
}

function writeRaw(privateRoot, raw) {
  writePrivate(privateRoot, RAW_COVER, raw, COVER_LIMIT);
}

function candidateRecord(marker, data, accountVid) {
  if (
    marker.kind !== 'weread-api-mp-cover-target' ||
    marker.endpoint !== '/api/mp/cover' ||
    marker.bookId !== BOOK_ID ||
    !Number.isFinite(Date.parse(marker.attemptedAt))
  )
    throw Error('api_cover_marker_gate');
  const shaped = coverShape(data);
  if (shaped.stop || typeof accountVid !== 'string' || !accountVid)
    throw Error('api_cover_candidate_gate');
  return {
    formatVersion: 1,
    kind: 'weread-api-mp-cover-candidate',
    coverAttemptedAt: marker.attemptedAt,
    endpoint: '/api/mp/cover',
    bookId: BOOK_ID,
    sourceName: TARGET_NAME,
    accountVid,
    reviewId: shaped.reviewId,
    title: shaped.title,
    picPresent: shaped.picPresent,
    articleIdentityVerified: false,
    publishedAtVerified: false,
  };
}

function writeCandidate(privateRoot, record) {
  writePrivate(
    privateRoot,
    CANDIDATE,
    Buffer.from(JSON.stringify(record) + '\n'),
    CANDIDATE_LIMIT,
  );
}

async function probe(mobile, launch, marker, saveRaw, saveCandidate) {
  const out = {
    decision: 'stop_browser_or_context',
    requestCount: 0,
    initRequests: 0,
    coverRequests: 0,
    articleRequests: 0,
    listRequests: 0,
    pageNavigations: 0,
    productionWrites: 0,
    credentialSource: 'private_refresh_recovery_only',
  };
  let browser, context;
  try {
    browser = await launch();
    context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      userAgent: USER_AGENT,
    });
    if ((await context.cookies()).length) {
      out.decision = 'stop_nonempty_context';
      return out;
    }
    let init;
    try {
      out.initRequests = out.requestCount = 1;
      init = await context.request.post(INIT, {
        data: {
          vid: mobile.vid,
          pf: 0,
          skey: mobile.accessToken,
          rt: mobile.refreshToken,
        },
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        timeout: 10_000,
        maxRedirects: 0,
        maxRetries: 0,
      });
    } catch {
      out.decision = 'stop_init_transport_or_timeout';
      return out;
    }
    out.initHttp = init.status();
    out.initSetCookieNames = setCookieNames(init);
    if (out.initHttp !== 200) {
      out.decision = statusStop(out.initHttp);
      await init.dispose();
      return out;
    }
    let initData;
    try {
      initData = await readPayload(init, COVER_LIMIT);
    } catch {
      out.decision = 'stop_init_body_read';
      return out;
    } finally {
      await init.dispose();
    }
    out.initCode = initData.errCode ?? null;
    if (initData.stop) {
      out.decision = initData.stop;
      return out;
    }
    if (
      Object.hasOwn(initData.data, 'success') &&
      numericCode(initData.data.success) !== 1
    ) {
      out.decision = 'stop_init_not_success';
      return out;
    }
    const gate = cookieGate(await context.cookies(COVER), mobile.vid);
    out.wrVidMatchesRecovery = gate.identityMatch;
    out.webCookieNames = gate.names;
    if (
      !gate.ready ||
      !['wr_vid', 'wr_skey', 'wr_rt', 'wr_pf', 'wr_ql'].every((name) =>
        gate.names.includes(name),
      )
    ) {
      out.decision = 'stop_cookie_scope_or_identity';
      return out;
    }
    let cover;
    try {
      out.coverRequests = 1;
      out.requestCount = 2;
      // X-SSR-Request-Id is page SSR state; an isolated request cannot
      // legitimately invent it. This difference is explicit in the report.
      cover = await context.request.get(COVER, {
        params: { bookId: BOOK_ID },
        timeout: 10_000,
        maxRedirects: 0,
        maxRetries: 0,
      });
    } catch {
      out.decision = 'stop_cover_transport_or_timeout';
      return out;
    }
    out.coverHttp = cover.status();
    if (out.coverHttp !== 200) {
      out.decision = statusStop(out.coverHttp);
      await cover.dispose();
      return out;
    }
    let found;
    try {
      found = await readCoverJson(cover);
    } catch {
      out.decision = 'stop_cover_body_read';
      return out;
    } finally {
      await cover.dispose();
    }
    out.coverCode = found.errCode ?? null;
    out.coverRet = found.ret ?? null;
    if (found.stop) {
      out.decision = found.stop;
      return out;
    }
    out.privateRawPersistAttempts = await saveRaw(found.raw);
    out.privateRawSaved = true;
    const shaped = coverShape(found.data);
    if (shaped.stop) {
      out.decision = shaped.stop;
      return out;
    }
    out.sourceNameMatched = true;
    out.reviewIdPrefixMatched = true;
    out.titlePresent = true;
    out.picPresent = shaped.picPresent;
    out.privatePersistAttempts = await saveCandidate(
      candidateRecord(marker, found.data, mobile.vid),
    );
    out.privateCandidateSaved = true;
    out.decision = 'cover_candidate_private_saved';
    return out;
  } catch {
    out.decision = 'stop_browser_or_context';
    return out;
  } finally {
    try {
      await context?.close();
    } catch {
      /* no raw errors */
    }
    try {
      await browser?.close();
    } catch {
      /* no raw errors */
    }
  }
}

async function selfTest() {
  assert.equal(args(['--plan']).mode, '--plan');
  assert.throws(() => args(['--execute']), /usage_gate/);
  assert.throws(
    () => environmentGate({ NODE_DEBUG: 'http' }),
    /environment_gate/,
  );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'api-cover-fixture-'));
  const marker = {
    kind: 'weread-api-mp-cover-target',
    endpoint: '/api/mp/cover',
    bookId: BOOK_ID,
    attemptedAt: new Date().toISOString(),
  };
  const data = {
    name: TARGET_NAME,
    title: 'fixture-private-title',
    reviewId: `${BOOK_ID}_fixture-private-review`,
    pic: 'fixture-pic',
  };
  try {
    assert.equal(
      candidateRecord(marker, data, 'fixture-vid').reviewId,
      data.reviewId,
    );
    writeRaw(scratch, Buffer.from(JSON.stringify(data)));
    assert.throws(
      () => writeRaw(scratch, Buffer.from('{}')),
      /api_cover_private_exists/,
    );
    assert.throws(() => historyGate(scratch), /api_cover_already_attempted/);
    fs.unlinkSync(path.join(scratch, RAW_COVER));
    writeCandidate(scratch, candidateRecord(marker, data, 'fixture-vid'));
    assert.throws(() => historyGate(scratch), /api_cover_already_attempted/);
    fs.unlinkSync(path.join(scratch, CANDIDATE));
    markAttempt(scratch);
    assert.throws(() => markAttempt(scratch), /EEXIST/);
    assert.throws(() => historyGate(scratch), /api_cover_already_attempted/);
    const mobile = {
      vid: 'fixture-vid',
      accessToken: 'fixture-secret-access',
      refreshToken: 'fixture-secret-refresh',
    };
    let calls = 0;
    const fakeResponse = (body, status = 200) => ({
      status: () => status,
      headers: () => ({ 'content-type': 'application/json' }),
      headersArray: () => [],
      body: async () => Buffer.from(JSON.stringify(body)),
      dispose: async () => {},
    });
    const fakeLaunch =
      (scenario = {}) =>
      async () => ({
        newContext: async () => {
          let initialized = false;
          return {
            cookies: async () =>
              initialized
                ? [
                    { name: 'wr_vid', value: mobile.vid },
                    { name: 'wr_skey', value: 'fixture-web-skey' },
                    { name: 'wr_rt', value: 'fixture-web-rt' },
                    { name: 'wr_pf', value: 'fixture-web-pf' },
                    { name: 'wr_ql', value: 'fixture-web-ql' },
                  ]
                : [],
            request: {
              post: async (url, options) => {
                calls++;
                assert.equal(url, INIT);
                assert.equal(options.data.skey, mobile.accessToken);
                assert.equal(options.maxRedirects, 0);
                initialized = true;
                return fakeResponse({ success: 1 }, scenario.initStatus ?? 200);
              },
              get: async (url, options) => {
                calls++;
                assert.equal(url, COVER);
                assert.equal(options.params.bookId, BOOK_ID);
                assert.equal(options.maxRetries, 0);
                assert.equal(options.maxRedirects, 0);
                return fakeResponse(
                  scenario.coverBody ?? data,
                  scenario.coverStatus ?? 200,
                );
              },
            },
            close: async () => {},
          };
        },
        close: async () => {},
      });
    const success = await probe(
      mobile,
      fakeLaunch(),
      marker,
      async (raw) => {
        assert.equal(JSON.parse(raw).reviewId, data.reviewId);
        return 1;
      },
      async (record) => {
        assert.equal(record.reviewId, data.reviewId);
        return 1;
      },
    );
    assert.equal(calls, 2);
    assert.equal(success.decision, 'cover_candidate_private_saved');
    assert.equal(success.articleRequests, 0);
    assert.doesNotMatch(
      JSON.stringify(success),
      /fixture-private|fixture-secret/,
    );
    calls = 0;
    const unknown = await probe(
      mobile,
      fakeLaunch({ coverBody: { unexpected: 'fixture-private-raw' } }),
      marker,
      (raw) =>
        persistUntilDurable(scratch, raw, {
          writer: (root, value) => writeRaw(root, value),
          pause: async () => {},
          notify: () => {},
        }),
      async () => {
        throw Error('candidate_must_not_save');
      },
    );
    assert.equal(calls, 2);
    assert.equal(unknown.decision, 'stop_source_identity');
    assert.equal(unknown.privateRawSaved, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(scratch, RAW_COVER), 'utf8'))
        .unexpected,
      'fixture-private-raw',
    );
    fs.unlinkSync(path.join(scratch, RAW_COVER));
    calls = 0;
    let writes = 0;
    const retried = await probe(
      mobile,
      fakeLaunch({ coverBody: { unexpected: 'fixture-private-raw' } }),
      marker,
      (raw) =>
        persistUntilDurable(scratch, raw, {
          writer: (root, value) => {
            if (++writes === 1) throw Error('fixture_disk_failure');
            writeRaw(root, value);
          },
          pause: async () => {},
          notify: () => {},
        }),
      async () => {
        throw Error('candidate_must_not_save');
      },
    );
    assert.equal(calls, 2);
    assert.equal(writes, 2);
    assert.equal(retried.privateRawPersistAttempts, 2);
    assert.equal(retried.decision, 'stop_source_identity');
    assert.doesNotMatch(JSON.stringify(retried), /fixture-private-raw/);
    calls = 0;
    const restricted = await probe(
      mobile,
      fakeLaunch({ coverBody: { errCode: -2012 } }),
      marker,
      async () => {
        throw Error('raw_must_not_save');
      },
      async () => {
        throw Error('candidate_must_not_save');
      },
    );
    assert.equal(calls, 2);
    assert.equal(restricted.decision, 'stop_auth_expired_candidate');
    calls = 0;
    const initRejected = await probe(
      mobile,
      fakeLaunch({ initStatus: 401 }),
      marker,
      async () => {
        throw Error('raw_must_not_save');
      },
      async () => {
        throw Error('candidate_must_not_save');
      },
    );
    assert.equal(calls, 1);
    assert.equal(initRejected.decision, 'stop_authentication_rejected');
  } finally {
    for (const name of fs.readdirSync(scratch))
      fs.unlinkSync(path.join(scratch, name));
    fs.rmdirSync(scratch);
  }
  return {
    decision: 'self_test_passed',
    realNetworkRequests: 0,
    productionWrites: 0,
  };
}

async function main() {
  let options;
  try {
    options = args(process.argv.slice(2));
  } catch {
    console.log(JSON.stringify({ decision: 'usage_gate', requestCount: 0 }));
    process.exitCode = 2;
    return;
  }
  if (options.mode === '--plan') {
    console.log(
      JSON.stringify({
        decision: 'plan_only',
        endpoint: '/api/mp/cover',
        credentialSource: 'private_refresh_recovery_only',
        initRequestMax: 1,
        coverRequestMax: 1,
        articleRequests: 0,
        listRequests: 0,
        redirects: false,
        retries: false,
        pageNavigations: 0,
        ssrRequestId: 'not_invented',
        privateOutput: 'repo_ignored_private_data',
        boundedJsonSavedBeforeIdentityGate: true,
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
        JSON.stringify({
          decision: 'self_test_failed',
          realNetworkRequests: 0,
        }),
      );
      process.exitCode = 1;
    }
    return;
  }
  try {
    environmentGate(process.env);
  } catch {
    console.log(
      JSON.stringify({ decision: 'environment_gate', requestCount: 0 }),
    );
    process.exitCode = 1;
    return;
  }
  let ready, verified;
  try {
    ready = preflight(options.dbPath, options.runDir);
    if (options.mode === '--execute')
      verified = runtime(options.modulePath, options.browserPath);
  } catch (error) {
    const safe = new Set([
      'api_cover_already_attempted',
      'db_path_gate',
      'private_root_gate',
      'target_feed_gate',
      'target_backup_gate',
      'run_dir_gate',
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
      'runtime_gate',
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
        sourceAndBackupMatched: true,
        targetFeedMatched: true,
        existingApiCoverHistory: false,
        credentialSource: 'private_refresh_recovery_only',
        networkRequests: 0,
        productionWrites: 0,
      }),
    );
    return;
  }
  let marker;
  try {
    marker = markAttempt(ready.privateRoot);
  } catch {
    console.log(
      JSON.stringify({ decision: 'api_cover_marker_gate', requestCount: 0 }),
    );
    process.exitCode = 1;
    return;
  }
  const launch = () =>
    verified.chromium.launch({
      executablePath: verified.browserPath,
      headless: true,
      args: [
        '--disable-background-networking',
        '--no-proxy-server',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  const result = await probe(
    ready.mobile,
    launch,
    marker,
    (raw) => persistUntilDurable(ready.privateRoot, raw, { writer: writeRaw }),
    (record) =>
      persistUntilDurable(ready.privateRoot, record, {
        writer: writeCandidate,
      }),
  );
  console.log(JSON.stringify(result));
  if (result.decision !== 'cover_candidate_private_saved') process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  args,
  historyGate,
  preflight,
  markAttempt,
  writeRaw,
  writeCandidate,
  candidateRecord,
  probe,
  selfTest,
};
