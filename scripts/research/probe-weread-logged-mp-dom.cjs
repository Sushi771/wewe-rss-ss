#!/usr/bin/env node
'use strict';

// Attach only to the dedicated, already visible official login window. The
// owner completes Tencent login. This script never reads cookies or network
// traffic and only returns allowlisted DOM / in-page state counts.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeWereadId } = require('./probe-weread-mp-page-memory.cjs');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');

const BOOK_ID = 'MP_WXS_3895431412';
const TARGET = `https://weread.qq.com/web/mp/reader/${encodeWereadId(BOOK_ID)}`;
const LAUNCHER = path.join(__dirname, 'weread-login-window.ps1');
const PRIVATE_ROOT = path.join(os.homedir(), '.wewe-rss-private');
const MARKER = path.join(PRIVATE_ROOT, 'weread-logged-mp-dom.attempted.json');
const RESULT = path.join(PRIVATE_ROOT, 'weread-logged-mp-dom.result.json');
const PLAYWRIGHT_VERSION = '1.58.2';

function parseArgs(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0])) {
    return { mode: argv[0] };
  }
  if (
    argv.length >= 3 &&
    ['--preflight', '--execute'].includes(argv[0]) &&
    argv[1] === '--playwright-core' &&
    path.isAbsolute(argv[2]) &&
    ((argv[0] === '--preflight' && argv.length === 3) ||
      (argv[0] === '--execute' &&
        argv.length === 5 &&
        argv[3] === '--approved-online' &&
        argv[4] === '--owner-login-confirmed'))
  ) {
    return { mode: argv[0], modulePath: argv[2] };
  }
  throw Error('usage_gate');
}

function runtimeGate(modulePath) {
  const real = fs.realpathSync(modulePath);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(real, 'package.json'), 'utf8'),
  );
  if (
    !fs.statSync(real).isDirectory() ||
    manifest.name !== 'playwright-core' ||
    manifest.version !== PLAYWRIGHT_VERSION
  ) {
    throw Error('runtime_gate');
  }
  const { chromium } = require(real);
  if (typeof chromium?.connectOverCDP !== 'function') {
    throw Error('runtime_gate');
  }
  return chromium;
}

function privateGate() {
  const stat = fs.lstatSync(PRIVATE_ROOT);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(PRIVATE_ROOT).toLowerCase() !==
      path.resolve(PRIVATE_ROOT).toLowerCase()
  ) {
    throw Error('private_root_gate');
  }
  if (fs.existsSync(MARKER) || fs.existsSync(RESULT)) {
    throw Error('logged_dom_already_attempted');
  }
}

function verifiedSessionStatus(raw) {
  const state = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/$/.exec(state?.cdp || '');
  if (
    state?.running !== true ||
    state.browser !== 'Edge' ||
    !match ||
    Number(match[1]) < 1 ||
    Number(match[1]) > 65535
  ) {
    throw Error('dedicated_edge_not_verified');
  }
  return state.cdp;
}

function sessionEndpoint() {
  const output = execFileSync(
    'pwsh',
    ['-NoProfile', '-File', LAUNCHER, '-Action', 'Status'],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 2048, windowsHide: true },
  );
  return verifiedSessionStatus(output);
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

// Serialized by page.evaluate; only known Vue DOM anchors and first-party
// state.mp fields are inspected. The page returns no text, URL, or field value.
function inspectPage(expectedBookId) {
  const pathname = location.pathname;
  const app = document.querySelector('#app');
  const catalog = document.querySelector('.mpCatalog_list');
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    );
  };
  const challengeVisible = Array.from(
    document.querySelectorAll(
      'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]',
    ),
  ).some(visible);
  const loginDialogVisible = Array.from(
    document.querySelectorAll(
      'iframe[src*="open.weixin.qq.com" i], [class*="loginDialog" i]',
    ),
  ).some(visible);

  const anchors = [
    ['app', app],
    ['app_child', app?.firstElementChild],
    ['catalog', catalog],
    ['catalog_parent', catalog?.parentElement],
    ['catalog_grandparent', catalog?.parentElement?.parentElement],
  ];
  for (const element of Array.from(
    document.querySelectorAll('[class*="mpCatalog"]'),
  ).slice(0, 32)) {
    anchors.push(['catalog_component', element]);
  }
  let vueVmPresent = false;
  let store = null;
  let storeAnchor = 'none';
  for (const [kind, element] of anchors) {
    if (!element) continue;
    const vm = element.__vue__;
    const appInstance = element.__vue_app__;
    if (vm || appInstance) vueVmPresent = true;
    const candidate =
      vm?.$store ||
      vm?.$root?.$store ||
      appInstance?.config?.globalProperties?.$store;
    if (candidate?.state && typeof candidate.state === 'object') {
      store = candidate;
      storeAnchor = kind;
      break;
    }
  }

  const mp = store?.state?.mp;
  const mpStatePresent = Boolean(mp && typeof mp === 'object');
  const groups = Array.isArray(mp?.articles) ? mp.articles : [];
  const reviews = groups.flatMap((group) =>
    Array.isArray(group?.subReviews) ? group.subReviews : [],
  );
  const present = (value) =>
    value !== undefined && value !== null && value !== '';
  const count = (getter) =>
    reviews.filter((item) => present(getter(item))).length;
  const ids = reviews.map((item) => item?.review?.reviewId).filter(present);
  return {
    pageKind: pathname.startsWith('/web/mp/reader/')
      ? 'mp_reader'
      : pathname.includes('/login')
        ? 'login'
        : 'other',
    challengeVisible,
    loginDialogVisible,
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
    vueVmPresent,
    storePresent: Boolean(store),
    storeAnchor,
    mpStatePresent,
    mpBookIdMatchesTarget:
      mpStatePresent && present(mp.bookId)
        ? String(mp.bookId) === expectedBookId
        : null,
    groupCount: groups.length,
    groupCreateTimePresentCount: groups.filter((group) =>
      present(group?.createTime),
    ).length,
    subReviewCount: reviews.length,
    reviewIdPresentCount: ids.length,
    distinctReviewIdCount: new Set(ids).size,
    reviewCreateTimePresentCount: count((item) => item?.review?.createTime),
    belongBookIdPresentCount: count((item) => item?.review?.belongBookId),
    originalIdPresentCount: count((item) => item?.review?.mpInfo?.originalId),
    mpInfoTimePresentCount: count((item) => item?.review?.mpInfo?.time),
    mpInfoCtPresentCount: count((item) => item?.review?.mpInfo?.ct),
    mpInfoTitlePresentCount: count((item) => item?.review?.mpInfo?.title),
    mpInfoPicPresentCount: count((item) => item?.review?.mpInfo?.pic_url),
    loadFail: mpStatePresent ? Boolean(mp.mpLoadFail) : null,
    loading: mpStatePresent ? Boolean(mp.isArticlesLoading) : null,
  };
}

function officialPage(browser) {
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw Error('browser_context_ambiguous');
  const pages = contexts[0].pages().filter((page) => {
    try {
      return new URL(page.url()).origin === 'https://weread.qq.com';
    } catch {
      return false;
    }
  });
  if (pages.length !== 1) throw Error('official_page_ambiguous');
  return pages[0];
}

async function observe(browser, mark) {
  const page = officialPage(browser);
  const alreadyTarget =
    new URL(page.url()).pathname === new URL(TARGET).pathname;
  mark(alreadyTarget);
  if (!alreadyTarget) {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  let summary;
  let observations = 0;
  for (; observations < 10; observations++) {
    summary = await page.evaluate(inspectPage, BOOK_ID);
    if (
      summary.challengeVisible ||
      summary.loginDialogVisible ||
      summary.pageKind !== 'mp_reader' ||
      summary.domGroupCount > 0 ||
      summary.groupCount > 0 ||
      summary.loadFail
    ) {
      break;
    }
    if (observations < 9) await page.waitForTimeout(500);
  }
  return {
    outcome:
      summary.challengeVisible || summary.loginDialogVisible
        ? 'verification_or_login_visible'
        : summary.pageKind !== 'mp_reader'
          ? 'left_mp_reader'
          : summary.domGroupCount > 0 || summary.groupCount > 0
            ? 'initial_catalog_observed'
            : summary.loadFail
              ? 'in_page_load_fail_flag'
              : 'initial_catalog_not_observed',
    topLevelNavigations: alreadyTarget ? 0 : 1,
    observations: Math.min(observations + 1, 10),
    summary,
  };
}

async function selfTest() {
  assert.equal(parseArgs(['--plan']).mode, '--plan');
  assert.throws(() => parseArgs(['--execute']), /usage_gate/);
  assert.throws(
    () =>
      verifiedSessionStatus({
        running: true,
        browser: 'Chrome',
        cdp: 'http://127.0.0.1:1/',
      }),
    /dedicated_edge_not_verified/,
  );
  assert.equal(
    verifiedSessionStatus({
      running: true,
      browser: 'Edge',
      cdp: 'http://127.0.0.1:49123/',
    }),
    'http://127.0.0.1:49123/',
  );
  const prior = {
    document: global.document,
    location: global.location,
    getComputedStyle: global.getComputedStyle,
  };
  try {
    const groups = [
      {
        createTime: 123,
        subReviews: [
          {
            review: {
              reviewId: 'a',
              createTime: 124,
              mpInfo: { originalId: 'o', time: 125 },
            },
          },
          { review: { reviewId: 'b', mpInfo: { title: 'private-title' } } },
        ],
      },
    ];
    const catalog = {
      querySelectorAll: () => [1],
      querySelector: () => null,
      parentElement: null,
    };
    global.document = {
      querySelector: (selector) =>
        selector === '#app'
          ? {
              __vue__: {
                $store: {
                  state: { mp: { bookId: BOOK_ID, articles: groups } },
                },
              },
            }
          : selector === '.mpCatalog_list'
            ? catalog
            : null,
      querySelectorAll: () => [],
    };
    global.location = { pathname: '/web/mp/reader/test' };
    global.getComputedStyle = () => ({
      display: 'block',
      visibility: 'visible',
    });
    const summary = inspectPage(BOOK_ID);
    assert.equal(summary.groupCount, 1);
    assert.equal(summary.subReviewCount, 2);
    assert.equal(summary.distinctReviewIdCount, 2);
    assert.equal(summary.mpBookIdMatchesTarget, true);
    assert.equal(summary.storeAnchor, 'app');
    assert.equal(JSON.stringify(summary).includes('private-title'), false);
    global.document.querySelector = (selector) =>
      selector === '#app'
        ? {}
        : selector === '.mpCatalog_list'
          ? catalog
          : null;
    const missingStore = inspectPage(BOOK_ID);
    assert.equal(missingStore.storePresent, false);
    assert.equal(missingStore.loadFail, null);
    assert.equal(missingStore.groupCount, 0);
    catalog.__vue__ = {
      $store: { state: { mp: { bookId: BOOK_ID, articles: groups } } },
    };
    const catalogStore = inspectPage(BOOK_ID);
    assert.equal(catalogStore.storeAnchor, 'catalog');
    assert.equal(catalogStore.groupCount, 1);
    delete catalog.__vue__;
    global.document.querySelectorAll = (selector) =>
      selector.includes('captcha') ? [{ getClientRects: () => [1] }] : [];
    assert.equal(inspectPage(BOOK_ID).challengeVisible, true);
  } finally {
    global.document = prior.document;
    global.location = prior.location;
    global.getComputedStyle = prior.getComputedStyle;
  }
  let calls = 0;
  let marked = false;
  const page = {
    url: () => 'https://weread.qq.com/',
    goto: async (url) => {
      assert.equal(marked, true);
      assert.equal(url, TARGET);
      calls++;
    },
    evaluate: async () => ({
      pageKind: 'mp_reader',
      challengeVisible: false,
      loginDialogVisible: false,
      domGroupCount: 1,
      groupCount: 1,
    }),
  };
  const result = await observe(
    { contexts: () => [{ pages: () => [page] }] },
    () => {
      marked = true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'initial_catalog_observed');
  assert.equal(result.topLevelNavigations, 1);
  const sameTarget = {
    ...page,
    url: () => TARGET,
    goto: async () => {
      throw Error('unexpected_navigation');
    },
  };
  const already = await observe(
    { contexts: () => [{ pages: () => [sameTarget] }] },
    () => {},
  );
  assert.equal(already.topLevelNavigations, 0);
  assert.throws(
    () => officialPage({ contexts: () => [{ pages: () => [page, page] }] }),
    /official_page_ambiguous/,
  );
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'weread-logged-dom-test-'),
  );
  try {
    const marker = path.join(temp, 'marker.json');
    writeOnce(marker, { attempted: true });
    assert.throws(() => writeOnce(marker, { attempted: false }), /EEXIST/);
  } finally {
    fs.unlinkSync(path.join(temp, 'marker.json'));
    fs.rmdirSync(temp);
  }
  return { ok: true, fakePages: 2, onlineBrowserStarts: 0, targetRequests: 0 };
}

async function execute(chromium, endpoint) {
  let browser;
  let attempted = false;
  let result = {
    kind: 'weread-logged-mp-dom',
    outcome: 'browser_connection_or_page_gate_failed',
    topLevelNavigations: 0,
  };
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    result = await observe(browser, (alreadyTarget) => {
      writeOnce(MARKER, {
        kind: 'weread-logged-mp-dom',
        attemptedAt: new Date().toISOString(),
      });
      attempted = true;
      result.topLevelNavigations = alreadyTarget ? 0 : 1;
    });
    result.kind = 'weread-logged-mp-dom';
  } catch (error) {
    if (attempted) {
      result.outcome = 'navigation_or_observation_failed';
    } else if (
      ['browser_context_ambiguous', 'official_page_ambiguous'].includes(
        error.message,
      )
    ) {
      result.outcome = error.message;
    }
  } finally {
    // For a connected browser this disposes the Playwright connection, not
    // the owner's visible browser process or its original context.
    if (browser) await browser.close().catch(() => {});
  }
  if (attempted) writeOnce(RESULT, result);
  return result;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.mode === '--plan') {
    return {
      mode: 'offline_plan',
      browser: 'dedicated_visible_edge_only',
      targetRouteKind: 'official_mp_reader',
      directListRequests: 0,
      maxTopLevelNavigations: 1,
      output: 'allowlisted_counts_and_booleans_only',
    };
  }
  if (args.mode === '--self-test') return selfTest();
  environmentGate(process.env);
  privateGate();
  const chromium = runtimeGate(args.modulePath);
  const endpoint = sessionEndpoint();
  if (args.mode === '--preflight') {
    return {
      mode: 'local_preflight',
      ready: true,
      dedicatedEdgeRunning: true,
      ownerLoginStatus: 'must_be_confirmed_visually',
      targetRequests: 0,
    };
  }
  return execute(chromium, endpoint);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (value) => console.log(JSON.stringify(value)),
    (error) => {
      const safeReasons = [
        'usage_gate',
        'runtime_gate',
        'private_root_gate',
        'logged_dom_already_attempted',
        'dedicated_edge_not_verified',
        'environment_gate',
      ];
      console.error(
        JSON.stringify({
          stopped: true,
          reason: safeReasons.includes(error.message)
            ? error.message
            : 'local_gate_or_runtime_failure',
        }),
      );
      process.exitCode = 1;
    },
  );
}

module.exports = {
  inspectPage,
  observe,
  parseArgs,
  selfTest,
  verifiedSessionStatus,
};
