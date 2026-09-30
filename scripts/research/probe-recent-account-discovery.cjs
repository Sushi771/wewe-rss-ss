#!/usr/bin/env node
'use strict';

// One current account-name search, optionally one genuine cursor page.
// Acceptance articles are deliberately absent from this module and its inputs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const {
  safePrivateRoot,
  sqliteApi,
} = require('./probe-mobile-refresh-preflight.cjs');
const {
  environmentGate,
  recoveryGate,
  runtime,
  readPayload,
  numericCode,
  statusStop,
  cookieGate,
} = require('./probe-refreshed-mobile-web-health.cjs');
const { searchPayload } = require('./probe-refreshed-mobile-target-search.cjs');

const INIT = 'https://weread.qq.com/web/login/session/init';
const SEARCH = 'https://weread.qq.com/web/wx_search_broker_proxy';
const SOURCE_SHA =
  'e5e090ee6b6180de2ed72ee3eeebdcdab9a10c5c0f5c95f442fd7940730f7089';
const MARKER = 'recent-account-discovery-attempt.json';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function durable(file, value) {
  const tmp = `${file}.pending`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Exclusive publication: never replace earlier evidence or attempt markers.
  fs.linkSync(tmp, file);
  fs.unlinkSync(tmp);
}

function snapshot(dbPath) {
  const { DatabaseSync } = sqliteApi();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const result = {
      integrity: db.prepare('PRAGMA quick_check').get().quick_check,
    };
    for (const table of ['feeds', 'articles', 'accounts']) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
      result[table] = {
        count: rows.length,
        sha256: hash(JSON.stringify(rows)),
      };
    }
    db.exec('ROLLBACK');
    if (result.integrity !== 'ok') throw Error('integrity_gate');
    return result;
  } finally {
    db.close();
  }
}

function claimedIdentity(item, biz) {
  try {
    const u = new URL(item.doc_url);
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.hostname !== 'mp.weixin.qq.com' ||
      u.username ||
      u.password ||
      u.port ||
      u.pathname !== '/s' ||
      /[\s\\]/.test(item.doc_url) ||
      /&amp;/.test(item.doc_url)
    )
      return null;
    if (
      !['__biz', 'mid', 'idx'].every(
        (k) => u.searchParams.getAll(k).length === 1,
      ) ||
      u.searchParams.get('__biz') !== biz ||
      !/^\d+$/.test(u.searchParams.get('mid')) ||
      !/^\d+$/.test(u.searchParams.get('idx'))
    )
      return null;
    return {
      biz,
      mid: u.searchParams.get('mid'),
      idx: u.searchParams.get('idx'),
    };
  } catch {
    return null;
  }
}

function inspect(content, config, now) {
  if (!Array.isArray(content?.data) || content.data.length > 100)
    throw Error('search_shape_gate');
  const items = [];
  for (const bucket of content.data) {
    if (!Array.isArray(bucket?.items)) throw Error('search_shape_gate');
    for (const item of bucket.items) {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        items.length >= 100
      )
        throw Error('search_shape_gate');
      // Preserve returned article fields, never Web cookies or search cursors.
      const saved = Object.fromEntries(
        [
          'docID',
          'doc_url',
          'title',
          'timestamp',
          'bizUin',
          'srcUserName',
          'source',
        ]
          .filter((k) => Object.hasOwn(item, k))
          .map((k) => [k, item[k]]),
      );
      saved.urlIdentityClaim = claimedIdentity(item, config.biz);
      saved.sourceNameMatched = item.source?.title === config.name;
      saved.originalPublishTimeVerified = false;
      items.push(saved);
    }
  }
  const target = items.filter((i) => i.urlIdentityClaim);
  const times = target
    .map((i) => i.timestamp)
    .filter((t) => Number.isSafeInteger(t) && t > 0);
  const cutoff = Math.floor(now / 1000) - 7 * 86400;
  const recent = times.filter(
    (t) => t >= cutoff && t <= Math.floor(now / 1000),
  );
  return {
    items,
    summary: {
      items: items.length,
      nameMatches: items.filter((i) => i.sourceNameMatched).length,
      targetUrlClaims: target.length,
      uniqueTargetClaims: new Set(
        target.map(
          (i) => `${i.urlIdentityClaim.mid}/${i.urlIdentityClaim.idx}`,
        ),
      ).size,
      indexTimeRange: times.length
        ? [Math.min(...times), Math.max(...times)]
        : null,
      recentIndexClaims: recent.length,
      originalPublishTimesVerified: 0,
    },
    needOnePage: recent.length < 5 || times.some((t) => t < cutoff),
  };
}

function cursor(content, name) {
  if (![true, 1].includes(content?.continueFlag)) return null;
  if (
    !Number.isSafeInteger(content.offset) ||
    content.offset <= 0 ||
    content.offset > 1000000 ||
    !(
      (typeof content.searchID === 'string' &&
        content.searchID.length > 0 &&
        content.searchID.length <= 8192) ||
      (Number.isSafeInteger(content.searchID) && content.searchID >= 0)
    ) ||
    !content.cookies ||
    !['string', 'object'].includes(typeof content.cookies) ||
    JSON.stringify(content.cookies).length > 8192
  )
    return null;
  return {
    query: name,
    offset: content.offset,
    searchid: content.searchID,
    searchcookies: content.cookies,
  };
}

async function discover(mobile, config, launch, save) {
  const result = {
    decision: 'stop_before_init',
    requestCount: 0,
    pages: [],
    articleRequests: 0,
    productionWrites: 0,
    pageLimit: 2,
  };
  let browser, context;
  try {
    browser = await launch();
    context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    if ((await context.cookies()).length) throw Error('nonempty_context_gate');
    result.requestCount++;
    const init = await context.request.post(INIT, {
      data: {
        vid: mobile.vid,
        pf: 0,
        skey: mobile.accessToken,
        rt: mobile.refreshToken,
      },
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      timeout: 10000,
      maxRetries: 0,
      maxRedirects: 0,
    });
    result.initHttp = init.status();
    if (init.status() !== 200) {
      result.decision = statusStop(init.status());
      await init.dispose();
      return result;
    }
    let parsed;
    try {
      parsed = await readPayload(init, 64 * 1024);
    } finally {
      await init.dispose();
    }
    if (parsed.stop) {
      result.decision = parsed.stop;
      return result;
    }
    if (
      Object.hasOwn(parsed.data, 'success') &&
      numericCode(parsed.data.success) !== 1
    )
      throw Error('init_success_gate');
    if (!cookieGate(await context.cookies(SEARCH), mobile.vid).ready)
      throw Error('cookie_identity_gate');
    let body = { query: config.name, offset: 0, searchcookies: '' };
    const attemptedOffsets = new Set([0]);
    for (let page = 0; page < 2; page++) {
      if (!cookieGate(await context.cookies(SEARCH), mobile.vid).ready)
        throw Error('cookie_identity_gate');
      result.requestCount++;
      const response = await context.request.post(SEARCH, {
        data: JSON.stringify(body),
        headers: {
          'content-type': 'application/json; charset=utf-8',
          origin: 'https://search.weixin.qq.com',
        },
        timeout: 20000,
        maxRedirects: 0,
        maxRetries: 0,
      });
      const http = response.status();
      result.searchHttp = http;
      if (http !== 200) {
        result.decision = statusStop(http);
        await response.dispose();
        return result;
      }
      let payload;
      try {
        payload = await searchPayload(response);
      } finally {
        await response.dispose();
      }
      if (payload.stop) {
        result.decision = payload.stop;
        result.businessCode = payload.errCode ?? payload.ret;
        return result;
      }
      const now = Date.now();
      const observed = inspect(payload.data.content, config, now);
      const metadata = {
        kind: 'current-account-name-search-page',
        page: page + 1,
        capturedAt: new Date(now).toISOString(),
        requestQuery: config.name,
        targetBiz: config.biz,
        requestedOffset: body.offset,
        http,
        ret: payload.ret,
        contentRet: payload.contentRet,
        continueFlag: payload.data.content.continueFlag,
        items: observed.items,
        summary: observed.summary,
        timeSemantics: 'search-index-fields-not-original-publish-time',
      };
      await save(page, metadata); // Persist before any possible next request.
      result.pages.push(observed.summary);
      const next = cursor(payload.data.content, config.name);
      if (page === 1 || !observed.needOnePage || !next) {
        result.continuationStop =
          page === 1
            ? 'bounded_second_page'
            : !observed.needOnePage
              ? 'first_page_sufficient_for_bounded_sample'
              : 'no_valid_explicit_cursor';
        break;
      }
      if (next.offset <= body.offset || attemptedOffsets.has(next.offset))
        throw Error('cursor_progress_gate');
      result.continuationReason =
        'mixed_index_time_range_or_fewer_than_five_recent_claims';
      attemptedOffsets.add(next.offset);
      body = next;
    }
    result.decision = 'current_search_pages_preserved';
    return result;
  } catch {
    result.decision = 'stop_transport_structure_or_persistence';
    return result;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function selfTest() {
  const config = { name: 'test account', biz: 'test-biz' };
  const item = {
    source: { title: config.name },
    timestamp: 1,
    doc_url: 'http://mp.weixin.qq.com/s?__biz=test-biz&mid=123&idx=1',
  };
  assert.equal(
    inspect({ data: [{ items: [item] }] }, config, Date.now()).summary
      .targetUrlClaims,
    1,
  );
  assert.equal(
    claimedIdentity(
      { ...item, doc_url: item.doc_url + '&mid=456' },
      config.biz,
    ),
    null,
  );
  assert.equal(
    claimedIdentity(
      {
        ...item,
        doc_url: item.doc_url.replace(
          'mp.weixin.qq.com',
          'mp.weixin.qq.com.evil',
        ),
      },
      config.biz,
    ),
    null,
  );
  const bodies = [];
  const saved = [];
  let closed = false;
  function response(data) {
    return {
      status: () => 200,
      headers: () => ({}),
      body: async () => Buffer.from(JSON.stringify(data)),
      dispose: async () => {},
    };
  }
  const context = {
    cookies: async (url) =>
      url
        ? [
            { name: 'wr_vid', value: 'test-vid' },
            { name: 'wr_skey', value: 'private' },
          ]
        : [],
    close: async () => {
      closed = true;
    },
    request: {
      post: async (url, options) => {
        assert.equal(options.maxRetries, 0);
        assert.equal(options.maxRedirects, 0);
        if (url === INIT) return response({ success: 1 });
        bodies.push(JSON.parse(options.data));
        return response({
          ret: -1,
          content: {
            ret: 0,
            data: [{ items: [item] }],
            offset: 15 * bodies.length,
            searchID: 'server-id',
            cookies: 'server-cursor',
            continueFlag: true,
          },
        });
      },
    },
  };
  const launch = async () => ({
    newContext: async () => context,
    close: async () => {},
  });
  const mobile = {
    vid: 'test-vid',
    accessToken: 'secret',
    refreshToken: 'secret',
  };
  const result = await discover(mobile, config, launch, async (page, data) =>
    saved.push(data),
  );
  assert.equal(result.requestCount, 3);
  assert.equal(saved.length, 2);
  assert.equal(closed, true);
  assert.deepEqual(bodies[1], {
    query: config.name,
    offset: 15,
    searchid: 'server-id',
    searchcookies: 'server-cursor',
  });
  assert.equal(JSON.stringify(saved).includes('server-cursor'), false);
  bodies.length = 0;
  const persistenceStop = await discover(mobile, config, launch, async () => {
    throw Error('disk-full');
  });
  assert.equal(persistenceStop.requestCount, 2);
  assert.equal(bodies.length, 1);
  bodies.length = 0;
  context.request.post = async (url) =>
    url === INIT
      ? response({ errCode: -2012 })
      : (bodies.push(url), response({}));
  const rejected = await discover(mobile, config, launch, async () => {});
  assert.equal(rejected.requestCount, 1);
  assert.equal(bodies.length, 0);
  console.log(
    JSON.stringify({ decision: 'self_test_passed', realNetworkRequests: 0 }),
  );
}

async function main() {
  if (process.argv[2] === '--self-test' && process.argv.length === 3)
    return selfTest();
  const argv = process.argv.slice(2);
  const fields = [
    '--db',
    '--run-dir',
    '--evidence-dir',
    '--config',
    '--playwright-core',
    '--browser',
  ];
  if (
    !['--preflight', '--execute'].includes(argv[0]) ||
    argv.length !== 13 ||
    fields.some(
      (field, i) =>
        argv[1 + 2 * i] !== field || !path.isAbsolute(argv[2 + 2 * i]),
    )
  )
    throw Error('usage_gate');
  const [dbPath, runDir, evidenceDir, configPath, modulePath, browserPath] =
    fields.map((_, i) => argv[2 + 2 * i]);
  environmentGate(process.env);
  if (fs.realpathSync(evidenceDir) !== safePrivateRoot(evidenceDir))
    throw Error('private_root_gate');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (
    Object.keys(cfg).sort().join(',') !== 'biz,name' ||
    typeof cfg.name !== 'string' ||
    !cfg.name.trim() ||
    cfg.name.length > 100 ||
    typeof cfg.biz !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(cfg.biz)
  )
    throw Error('config_gate');
  if (
    hash(fs.readFileSync(path.join(evidenceDir, 'read_search.fc739bbf.js'))) !==
    SOURCE_SHA
  )
    throw Error('fixed_source_gate');
  const recovered = recoveryGate(dbPath, runDir, 'present');
  const verified = runtime(modulePath, browserPath);
  const before = snapshot(dbPath);
  if (
    fs.existsSync(path.join(evidenceDir, MARKER)) ||
    fs.existsSync(path.join(evidenceDir, MARKER + '.pending'))
  )
    throw Error('already_attempted');
  // The earlier successful search observation precedes this publication window.
  // Existing rejected endpoint and anonymous article markers remain untouched.
  if (argv[0] === '--preflight') {
    console.log(
      JSON.stringify({
        decision: 'preflight_ready',
        requestCount: 0,
        before,
        sourceSha256: SOURCE_SHA,
      }),
    );
    return;
  }
  durable(path.join(evidenceDir, MARKER), {
    kind: 'current-recent-account-discovery',
    attemptedAt: new Date().toISOString(),
    requestMax: 3,
    pageMax: 2,
    sourceSha256: SOURCE_SHA,
  });
  durable(path.join(evidenceDir, 'production-before.json'), before);
  const result = await discover(
    recovered.mobile,
    cfg,
    () =>
      verified.chromium.launch({
        executablePath: browserPath,
        headless: true,
        args: [
          '--disable-background-networking',
          '--no-proxy-server',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      }),
    async (page, data) =>
      durable(path.join(evidenceDir, `page-${page + 1}.json`), data),
  );
  const after = snapshot(dbPath);
  result.productionUnchanged = JSON.stringify(before) === JSON.stringify(after);
  durable(path.join(evidenceDir, 'production-after.json'), after);
  durable(path.join(evidenceDir, 'result.json'), result);
  console.log(JSON.stringify(result));
  if (
    result.decision !== 'current_search_pages_preserved' ||
    !result.productionUnchanged
  )
    process.exitCode = 1;
}

if (require.main === module)
  main().catch(() => {
    console.log(JSON.stringify({ decision: 'preflight_or_local_gate_failed' }));
    process.exitCode = 1;
  });
module.exports = {
  claimedIdentity,
  inspect,
  cursor,
  discover,
  durable,
  snapshot,
};
