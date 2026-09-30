#!/usr/bin/env node
'use strict';

// One natural, first-party MP reader navigation using an owner's copied Web
// session or gated mobile recovery. No target request listener, interception,
// replay, scrolling, or clicking.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
} = require('./probe-refreshed-mobile-web-health.cjs');
const {
  privateRootGate,
  targetGate,
} = require('./probe-weread-web-mp-cover.cjs');

const BOOK_ID = 'MP_WXS_3895431412';
const INIT = 'https://weread.qq.com/web/login/session/init';
const INIT_LIMIT = 64 * 1024;
const REQUIRED_WEB_COOKIES = ['wr_vid', 'wr_skey', 'wr_rt', 'wr_pf', 'wr_ql'];
const VALIDATED_INIT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PRIVATE_ROOT = path.join(os.homedir(), '.wewe-rss-private');
const SESSION_COPY = path.join(
  PRIVATE_ROOT,
  'weread-mp-page-memory',
  'session-copy.json',
);
const MARKER = path.join(
  PRIVATE_ROOT,
  'weread-mp-page-memory-target.attempted.json',
);
const RESULT = path.join(
  PRIVATE_ROOT,
  'weread-mp-page-memory-target.result.json',
);

function md5(value) {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

// Port of GZHReader encode_weread_id, fixed at commit 9cde7a4. This encodes
// the route segment; it does not create a request signature or authorization.
function encodeWereadId(value) {
  const source = String(value || '').trim();
  if (!source) throw Error('empty_book_id');
  const digest = md5(source);
  const numeric = /^\d+$/.test(source);
  const chunks = numeric
    ? source.match(/.{1,9}/g).map((part) => BigInt(part).toString(16))
    : [
        Array.from(Buffer.from(source, 'utf8'))
          .map((byte) => byte.toString(16))
          .join(''),
      ];
  let encoded = `${digest.slice(0, 3)}${numeric ? '3' : '4'}2${digest.slice(-2)}`;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.length > 255) throw Error('book_id_too_long');
    encoded += chunk.length.toString(16).padStart(2, '0') + chunk;
    if (index < chunks.length - 1) encoded += 'g';
  }
  if (encoded.length < 20) encoded += digest.slice(0, 20 - encoded.length);
  return encoded + md5(encoded).slice(0, 3);
}

function navigationUrl() {
  return `https://weread.qq.com/web/mp/reader/${encodeWereadId(BOOK_ID)}`;
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0])) {
    return { mode: argv[0] };
  }
  if (
    argv.length >= 5 &&
    ['--preflight', '--execute'].includes(argv[0]) &&
    argv[1] === '--playwright-core' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--browser' &&
    path.isAbsolute(argv[4]) &&
    ((argv[0] === '--preflight' && argv.length === 5) ||
      (argv.length === 6 && argv[5] === '--approved-online'))
  ) {
    return {
      mode: argv[0],
      credentialMode: 'session_copy',
      modulePath: argv[2],
      browserPath: argv[4],
    };
  }
  if (
    argv.length >= 10 &&
    ['--preflight', '--execute'].includes(argv[0]) &&
    argv[1] === '--recovery' &&
    argv[2] === '--db' &&
    path.isAbsolute(argv[3]) &&
    argv[4] === '--run-dir' &&
    path.isAbsolute(argv[5]) &&
    argv[6] === '--playwright-core' &&
    path.isAbsolute(argv[7]) &&
    argv[8] === '--browser' &&
    path.isAbsolute(argv[9]) &&
    ((argv[0] === '--preflight' && argv.length === 10) ||
      (argv.length === 11 && argv[10] === '--approved-online'))
  ) {
    return {
      mode: argv[0],
      credentialMode: 'recovery',
      dbPath: argv[3],
      runDir: argv[5],
      modulePath: argv[7],
      browserPath: argv[9],
    };
  }
  throw Error('usage_gate');
}

function realFile(file) {
  if (!fs.lstatSync(file).isFile()) throw Error('regular_file_required');
  return fs.realpathSync(file);
}

function preflight(args) {
  environmentGate(process.env);
  const privateRoot = fs.realpathSync(PRIVATE_ROOT);
  if (privateRoot.toLowerCase() !== path.resolve(PRIVATE_ROOT).toLowerCase()) {
    throw Error('private_root_symlink');
  }
  if (fs.existsSync(MARKER) || fs.existsSync(RESULT)) {
    throw Error('page_memory_already_attempted');
  }
  const moduleDir = fs.realpathSync(args.modulePath);
  const browser = realFile(args.browserPath);
  const launch = runtime(moduleDir, browser);
  if (args.credentialMode === 'session_copy') {
    const sessionCopy = realFile(SESSION_COPY);
    const relative = path.relative(privateRoot, sessionCopy);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw Error('session_copy_outside_private_root');
    }
    if (fs.statSync(sessionCopy).size === 0) throw Error('empty_session_copy');
    return { credentialMode: 'session_copy', sessionCopy, launch };
  }
  const credentials = recoveryGate(args.dbPath, args.runDir, 'present');
  privateRootGate(args.dbPath, credentials.runDir);
  targetGate(args.dbPath, credentials.runDir);
  return {
    credentialMode: 'recovery',
    mobile: credentials.mobile,
    launch,
  };
}

function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// This function is serialized into the official page. It accesses only the
// mounted Vuex articles and catalog DOM, and returns an allowlisted summary.
function inspectPage() {
  const catalog = document.querySelector('.mpCatalog_list');
  const root = document.querySelector('#app');
  const state = root && root.__vue__ && root.__vue__.$store?.state;
  let moduleState = null;
  if (state && typeof state === 'object') {
    const modules = [state, ...Object.values(state)];
    moduleState =
      modules.find(
        (value) =>
          value &&
          typeof value === 'object' &&
          Array.isArray(value.articles) &&
          Object.hasOwn(value, 'bookId'),
      ) || null;
  }
  const groups = moduleState ? moduleState.articles : [];
  const reviews = groups.flatMap((group) =>
    Array.isArray(group?.subReviews) ? group.subReviews : [],
  );
  const present = (value) =>
    value !== undefined && value !== null && value !== '';
  const reviewIds = reviews
    .map((item) => item?.review?.reviewId)
    .filter(present);
  const count = (getter) =>
    reviews.filter((item) => present(getter(item))).length;
  const pathname = location.pathname;
  const captchaVisible = Array.from(
    document.querySelectorAll(
      'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]',
    ),
  ).some((element) => {
    const style = getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    );
  });
  return {
    pageKind: pathname.startsWith('/web/mp/reader/')
      ? 'mp_reader'
      : pathname.includes('/login')
        ? 'login'
        : 'other',
    captchaVisible,
    catalogPresent: Boolean(catalog),
    domGroupCount:
      catalog?.querySelectorAll('.mpCatalog_list_item').length || 0,
    domTitleCount:
      catalog?.querySelectorAll(
        '.mpCatalog_item_first_item_title, .mpCatalog_item_sub_item_title',
      ).length || 0,
    domGroupTimeCount:
      catalog?.querySelectorAll('.mpCatalog_item_time').length || 0,
    domOfficialArticleHrefPresent: Boolean(
      catalog?.querySelector('a[href^="https://mp.weixin.qq.com/s"]'),
    ),
    domIdentityAttributePresent: Boolean(
      catalog?.querySelector('[data-review-id], [data-original-id]'),
    ),
    vueStoreFound: Boolean(moduleState),
    groupCount: groups.length,
    groupCreateTimePresentCount: groups.filter((group) =>
      present(group?.createTime),
    ).length,
    subReviewCount: reviews.length,
    subReviewIdPresentCount: count((item) => item?.reviewId),
    reviewIdPresentCount: reviewIds.length,
    distinctReviewIdCount: new Set(reviewIds).size,
    reviewCreateTimePresentCount: count((item) => item?.review?.createTime),
    belongBookIdPresentCount: count((item) => item?.review?.belongBookId),
    originalIdPresentCount: count((item) => item?.review?.mpInfo?.originalId),
    mpInfoTimePresentCount: count((item) => item?.review?.mpInfo?.time),
    mpInfoCtPresentCount: count((item) => item?.review?.mpInfo?.ct),
    mpInfoTitlePresentCount: count((item) => item?.review?.mpInfo?.title),
    mpInfoPicPresentCount: count((item) => item?.review?.mpInfo?.pic_url),
    loadFail: Boolean(moduleState?.mpLoadFail),
    loading: Boolean(moduleState?.isArticlesLoading),
  };
}

async function initRecoveryContext(context, mobile) {
  const summary = {
    initRequests: 0,
    initHttp: null,
    initCode: null,
    cookieIdentityMatched: false,
    webCookiesReady: false,
  };
  if ((await context.cookies()).length) {
    return { ready: false, outcome: 'stop_nonempty_context', summary };
  }
  let response;
  try {
    summary.initRequests = 1;
    response = await context.request.post(INIT, {
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
    return { ready: false, outcome: 'stop_init_transport_or_timeout', summary };
  }
  try {
    summary.initHttp = response.status();
    if (summary.initHttp !== 200) {
      return {
        ready: false,
        outcome: statusStop(summary.initHttp),
        summary,
      };
    }
    let payload;
    try {
      payload = await readPayload(response, INIT_LIMIT);
    } catch {
      return { ready: false, outcome: 'stop_init_body_read', summary };
    }
    summary.initCode = payload.errCode ?? payload.ret ?? null;
    if (payload.stop) {
      return { ready: false, outcome: payload.stop, summary };
    }
    if (
      (Object.hasOwn(payload.data, 'success') &&
        numericCode(payload.data.success) !== 1) ||
      (Object.hasOwn(payload.data, 'succ') &&
        numericCode(payload.data.succ) !== 1)
    ) {
      return { ready: false, outcome: 'stop_init_not_success', summary };
    }
  } finally {
    await response.dispose();
  }
  const cookies = cookieGate(
    await context.cookies(navigationUrl()),
    mobile.vid,
  );
  summary.cookieIdentityMatched = cookies.identityMatch;
  summary.webCookiesReady =
    cookies.ready &&
    REQUIRED_WEB_COOKIES.every((name) => cookies.names.includes(name));
  return summary.webCookiesReady
    ? { ready: true, summary }
    : { ready: false, outcome: 'stop_cookie_scope_or_identity', summary };
}

async function selfTest() {
  assert.equal(encodeWereadId('43208843'), 'c9c321c07293508bc9c79df');
  assert.match(
    navigationUrl(),
    /^https:\/\/weread\.qq\.com\/web\/mp\/reader\/[0-9a-f]+$/,
  );
  assert.equal(parseArgs(['--plan']).mode, '--plan');
  assert.throws(() => parseArgs(['--execute']), /usage_gate/);
  assert.throws(
    () => parseArgs(['--execute', '--playwright-core', 'x', '--browser', 'y']),
    /usage_gate/,
  );
  const recoveryArgs = [
    '--preflight',
    '--recovery',
    '--db',
    path.resolve('fixture.sqlite'),
    '--run-dir',
    path.resolve('mobile-refresh-fixture'),
    '--playwright-core',
    path.resolve('playwright-core'),
    '--browser',
    path.resolve('msedge.exe'),
  ];
  assert.equal(parseArgs(recoveryArgs).credentialMode, 'recovery');
  assert.throws(
    () => parseArgs(['--execute', ...recoveryArgs.slice(1)]),
    /usage_gate/,
  );
  assert.equal(
    parseArgs(['--execute', ...recoveryArgs.slice(1), '--approved-online'])
      .credentialMode,
    'recovery',
  );
  const savedDocument = global.document;
  const savedLocation = global.location;
  try {
    const groups = [
      {
        createTime: 123,
        subReviews: [
          {
            review: {
              reviewId: 'a',
              createTime: 124,
              mpInfo: { originalId: 'o', title: 't' },
            },
          },
          { review: { reviewId: 'b', mpInfo: { time: 456, title: 'u' } } },
        ],
      },
    ];
    const catalog = { querySelectorAll: () => [1], querySelector: () => null };
    global.document = {
      querySelectorAll: () => [],
      querySelector: (selector) =>
        selector === '#app'
          ? {
              __vue__: {
                $store: {
                  state: { mpReader: { bookId: 'x', articles: groups } },
                },
              },
            }
          : selector === '.mpCatalog_list'
            ? catalog
            : null,
    };
    global.location = { pathname: '/web/mp/reader/test' };
    const result = inspectPage();
    assert.equal(result.groupCount, 1);
    assert.equal(result.subReviewCount, 2);
    assert.equal(result.distinctReviewIdCount, 2);
    assert.equal(result.originalIdPresentCount, 1);
    assert.equal(result.reviewCreateTimePresentCount, 1);
    assert.equal(result.mpInfoTimePresentCount, 1);
  } finally {
    global.document = savedDocument;
    global.location = savedLocation;
  }
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'weread-page-marker-test-'),
  );
  const marker = path.join(tempDir, 'attempted.json');
  try {
    writeOnce(marker, { test: true });
    assert.throws(() => writeOnce(marker, { test: false }), /EEXIST/);
  } finally {
    fs.unlinkSync(marker);
    fs.rmdirSync(tempDir);
  }
  let initCalls = 0;
  const mobile = {
    vid: 'fixture-vid',
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
  };
  const fakeContext = {
    cookies: async (url) =>
      url
        ? REQUIRED_WEB_COOKIES.map((name) => ({
            name,
            value: name === 'wr_vid' ? mobile.vid : 'fixture-value',
          }))
        : [],
    request: {
      post: async (endpoint, options) => {
        initCalls++;
        assert.equal(endpoint, INIT);
        assert.equal(options.data.skey, mobile.accessToken);
        assert.equal(options.maxRetries, 0);
        return {
          status: () => 200,
          headers: () => ({ 'content-length': '10' }),
          body: async () => Buffer.from('{"succ":1}'),
          dispose: async () => {},
        };
      },
    },
  };
  const initialized = await initRecoveryContext(fakeContext, mobile);
  assert.equal(initCalls, 1);
  assert.equal(initialized.ready, true);
  assert.equal(initialized.summary.cookieIdentityMatched, true);
  assert.equal(initialized.summary.webCookiesReady, true);
  assert.equal(JSON.stringify(initialized).includes(mobile.accessToken), false);
  const stopped = await initRecoveryContext(
    {
      cookies: async () => [{ name: 'unexpected', value: 'fixture' }],
      request: {
        post: async () => {
          throw Error('init_must_not_run');
        },
      },
    },
    mobile,
  );
  assert.equal(stopped.ready, false);
  assert.equal(stopped.summary.initRequests, 0);
  return {
    ok: true,
    checks: [
      'route_vector',
      'argument_gate',
      'field_summary',
      'one_shot_marker',
      'recovery_gate_args',
      'single_init_and_cookie_scope',
    ],
  };
}

async function execute(gate) {
  writeOnce(MARKER, {
    kind: 'weread-mp-page-memory-target',
    bookId: BOOK_ID,
    credentialMode: gate.credentialMode,
    attemptedAt: new Date().toISOString(),
  });
  let result = {
    kind: 'weread-mp-page-memory-target',
    credentialMode: gate.credentialMode,
    outcome: 'browser_error',
    initRequests: 0,
    pageNavigations: 0,
  };
  let browser, context;
  try {
    browser = await gate.launch.chromium.launch({
      executablePath: gate.launch.browserPath,
      headless: true,
      args: [
        '--disable-background-networking',
        '--no-proxy-server',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    context = await browser.newContext({
      ...(gate.credentialMode === 'session_copy'
        ? { storageState: gate.sessionCopy }
        : { userAgent: VALIDATED_INIT_USER_AGENT }),
      acceptDownloads: false,
    });
    let ready = true;
    if (gate.credentialMode === 'recovery') {
      const initialized = await initRecoveryContext(context, gate.mobile);
      result = { ...result, ...initialized.summary };
      ready = initialized.ready;
      if (!ready) result.outcome = initialized.outcome;
    }
    if (ready) {
      const page = await context.newPage();
      result.pageNavigations = 1;
      const response = await page.goto(navigationUrl(), {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      let summary;
      for (let observation = 0; observation < 10; observation++) {
        summary = await page.evaluate(inspectPage);
        if (
          summary.captchaVisible ||
          summary.pageKind !== 'mp_reader' ||
          summary.domGroupCount > 0 ||
          summary.groupCount > 0 ||
          summary.loadFail
        ) {
          break;
        }
        if (observation < 9) await page.waitForTimeout(500);
      }
      result = {
        ...result,
        outcome:
          summary.captchaVisible || summary.pageKind !== 'mp_reader'
            ? 'redirect_or_verification_observed'
            : summary.domGroupCount > 0 || summary.groupCount > 0
              ? 'initial_catalog_observed'
              : summary.loadFail
                ? 'initial_catalog_load_failed'
                : 'initial_catalog_not_observed',
        navigationStatus: response?.status() || null,
        summary,
      };
    }
  } catch {
    // Raw browser errors can contain URLs or session details. Keep only this
    // bounded classification; a failed attempt still consumes the one-shot gate.
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  writeOnce(RESULT, result);
  return result;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.mode === '--plan') {
    return {
      mode: 'offline_plan',
      bookId: BOOK_ID,
      navigationUrl: navigationUrl(),
      credentialModes: ['session_copy', 'recovery'],
      recoveryInit: INIT,
      sessionCopyPath: SESSION_COPY,
      markerPath: MARKER,
      resultPath: RESULT,
      topLevelNavigations: 1,
      observation: 'catalog DOM and allowlisted Vuex field counts only',
    };
  }
  if (args.mode === '--self-test') return selfTest();
  const gate = preflight(args);
  if (args.mode === '--preflight') {
    return {
      mode: 'offline_preflight',
      credentialMode: gate.credentialMode,
      ready: true,
      markerAbsent: true,
      sessionCopyPresent: fs.existsSync(SESSION_COPY),
      recoveryAndBackupValidated: gate.credentialMode === 'recovery',
    };
  }
  return execute(gate);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (value) => console.log(JSON.stringify(value)),
    (error) => {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    },
  );
}

module.exports = {
  encodeWereadId,
  inspectPage,
  initRecoveryContext,
  parseArgs,
  selfTest,
};
