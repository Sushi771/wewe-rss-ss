#!/usr/bin/env node
'use strict';

// One natural, first-party MP reader navigation using an owner's copied Web
// session. No request listener, interception, replay, scrolling, or clicking.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOOK_ID = 'MP_WXS_3895431412';
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
    ['--preflight', '--execute'].includes(argv[0]) &&
    argv[1] === '--playwright-core' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--browser' &&
    path.isAbsolute(argv[4]) &&
    ((argv[0] === '--preflight' && argv.length === 5) ||
      (argv.length === 6 && argv[5] === '--approved-online'))
  ) {
    return { mode: argv[0], modulePath: argv[2], browserPath: argv[4] };
  }
  throw Error('usage_gate');
}

function realFile(file) {
  if (!fs.lstatSync(file).isFile()) throw Error('regular_file_required');
  return fs.realpathSync(file);
}

function preflight(modulePath, browserPath) {
  const privateRoot = fs.realpathSync(PRIVATE_ROOT);
  if (privateRoot.toLowerCase() !== path.resolve(PRIVATE_ROOT).toLowerCase()) {
    throw Error('private_root_symlink');
  }
  const sessionCopy = realFile(SESSION_COPY);
  const relative = path.relative(privateRoot, sessionCopy);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Error('session_copy_outside_private_root');
  }
  if (fs.statSync(sessionCopy).size === 0) throw Error('empty_session_copy');
  const moduleDir = fs.realpathSync(modulePath);
  if (!fs.statSync(moduleDir).isDirectory()) throw Error('module_dir_required');
  const moduleInfo = JSON.parse(
    fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8'),
  );
  if (moduleInfo.name !== 'playwright-core')
    throw Error('playwright_core_required');
  const browser = realFile(browserPath);
  if (
    !['msedge.exe', 'chrome.exe'].includes(path.basename(browser).toLowerCase())
  ) {
    throw Error('edge_or_chrome_required');
  }
  if (fs.existsSync(MARKER) || fs.existsSync(RESULT)) {
    throw Error('page_memory_already_attempted');
  }
  return { sessionCopy, moduleDir, browser };
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
  const captchaVisible = Boolean(
    document.querySelector(
      'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]',
    ),
  );
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

function selfTest() {
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
  return {
    ok: true,
    checks: [
      'route_vector',
      'argument_gate',
      'field_summary',
      'one_shot_marker',
    ],
  };
}

async function execute(gate) {
  const { chromium } = require(gate.moduleDir);
  writeOnce(MARKER, {
    kind: 'weread-mp-page-memory-target',
    bookId: BOOK_ID,
    attemptedAt: new Date().toISOString(),
  });
  let result = {
    kind: 'weread-mp-page-memory-target',
    outcome: 'browser_error',
  };
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: gate.browser,
      headless: true,
    });
    const context = await browser.newContext({
      storageState: gate.sessionCopy,
      acceptDownloads: false,
    });
    const page = await context.newPage();
    const response = await page.goto(navigationUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await page.waitForTimeout(5000);
    const summary = await page.evaluate(inspectPage);
    result = {
      kind: 'weread-mp-page-memory-target',
      outcome:
        summary.captchaVisible || summary.pageKind !== 'mp_reader'
          ? 'redirect_or_verification_observed'
          : summary.domGroupCount > 0 || summary.groupCount > 0
            ? 'initial_catalog_observed'
            : 'initial_catalog_not_observed',
      navigationStatus: response?.status() || null,
      summary,
    };
    await context.close();
  } catch {
    // Raw browser errors can contain URLs or session details. Keep only this
    // bounded classification; a failed attempt still consumes the one-shot gate.
  } finally {
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
      sessionCopyPath: SESSION_COPY,
      markerPath: MARKER,
      resultPath: RESULT,
      topLevelNavigations: 1,
      observation: 'catalog DOM and allowlisted Vuex field counts only',
    };
  }
  if (args.mode === '--self-test') return selfTest();
  const gate = preflight(args.modulePath, args.browserPath);
  if (args.mode === '--preflight') {
    return {
      mode: 'offline_preflight',
      ready: true,
      markerAbsent: true,
      sessionCopyPresent: true,
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

module.exports = { encodeWereadId, inspectPage, parseArgs, selfTest };
