#!/usr/bin/env node
'use strict';

// One first-party-shaped cursor continuation after a fresh isolated Web init.
// The response cursor lives in memory only. No article GET or further pages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  preflight,
  within,
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
  setCookieNames,
} = require('./probe-refreshed-mobile-web-health.cjs');
const {
  initialSearchBody,
  searchPayload,
  targetBiz,
  digest,
} = require('./probe-refreshed-mobile-target-search.cjs');

const ORIGIN = 'https://weread.qq.com';
const SEARCH_PAGE_ORIGIN = 'https://search.weixin.qq.com';
const INIT = `${ORIGIN}/web/login/session/init`;
const SEARCH = `${ORIGIN}/web/wx_search_broker_proxy`;
const TARGET_NAME = '妈妈部落畅聊阁';
const PRIOR_MARKER = 'refreshed-mobile-target-search-attempt.json';
const MARKER = 'refreshed-mobile-search-cursor-attempt.json';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SHAPES = [
  'official_short',
  'official_long',
  'official_query_partial',
  'official_query_other',
  'other_mp',
  'other_host',
  'malformed',
  'missing',
];

function args(argv) {
  if (argv.length === 1 && ['--plan', '--self-test'].includes(argv[0]))
    return { mode: argv[0] };
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
      mode: '--execute',
      dbPath: argv[2],
      runDir: argv[4],
      modulePath: argv[6],
      browserPath: argv[8],
    };
  throw Error('usage_gate');
}

function markerGate(runDir) {
  if (fs.existsSync(path.join(runDir, MARKER)))
    throw Error('already_attempted');
  const previous = JSON.parse(
    fs.readFileSync(path.join(runDir, PRIOR_MARKER), 'utf8'),
  );
  if (
    previous.kind !== 'refreshed-mobile-target-search' ||
    !Number.isFinite(Date.parse(previous.attemptedAt)) ||
    JSON.stringify(previous.endpoints) !==
      JSON.stringify(['/web/login/session/init', '/web/wx_search_broker_proxy'])
  )
    throw Error('prior_search_marker_gate');
}

function markAttempt(runDir) {
  const fd = fs.openSync(path.join(runDir, MARKER), 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        kind: 'refreshed-mobile-search-cursor',
        endpoints: ['/web/login/session/init', '/web/wx_search_broker_proxy'],
        searchRequestMax: 2,
        attemptedAt: new Date().toISOString(),
      }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function cursorGate(content) {
  if (!Array.isArray(content?.data) || content.data.length === 0)
    return { stop: 'stop_first_page_empty' };
  if (content?.continueFlag !== true && content?.continueFlag !== 1)
    return { stop: 'stop_no_explicit_continuation' };
  if (
    !Object.hasOwn(content, 'offset') ||
    !Object.hasOwn(content, 'searchID') ||
    !Object.hasOwn(content, 'cookies')
  )
    return { stop: 'stop_cursor_fields_missing' };
  const offset = content.offset;
  const searchid = content.searchID;
  const searchcookies = content.cookies;
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > 1_000_000)
    return { stop: 'stop_cursor_shape' };
  if (
    !(
      (typeof searchid === 'string' &&
        searchid.length > 0 &&
        searchid.length <= 8192) ||
      (Number.isSafeInteger(searchid) && searchid >= 0)
    )
  )
    return { stop: 'stop_cursor_shape' };
  if (
    searchcookies === null ||
    searchcookies === undefined ||
    !['string', 'object'].includes(typeof searchcookies) ||
    JSON.stringify(searchcookies)?.length > 8192
  )
    return { stop: 'stop_cursor_shape' };
  // Preserve Tencent's types and exact values in memory; lowercase request
  // field names come from the fixed first-party JS. Never print this body.
  return {
    stop: null,
    body: JSON.stringify({
      query: TARGET_NAME,
      offset,
      searchid,
      searchcookies,
    }),
  };
}

function linkShape(value) {
  if (typeof value !== 'string' || !value) return 'missing';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'malformed';
  }
  if (url.protocol !== 'https:') return 'malformed';
  if (url.hostname !== 'mp.weixin.qq.com') return 'other_host';
  if (/^\/s\/[^/]+$/.test(url.pathname)) return 'official_short';
  if (url.pathname !== '/s') return 'other_mp';
  const params = url.searchParams;
  if (params.has('__biz') && params.has('mid') && params.has('idx'))
    return 'official_long';
  if (params.has('__biz')) return 'official_query_partial';
  return 'official_query_other';
}

function emptyShapes() {
  return Object.fromEntries(SHAPES.map((name) => [name, 0]));
}

function pageSummary(content) {
  const summary = {
    bucketCount: 0,
    itemCount: 0,
    sourceNameMatches: 0,
    explicitBizMatches: 0,
    targetCandidateCount: 0,
    targetTimestampPresent: 0,
    targetSourceDateTimePresent: 0,
    allTimestampPresent: 0,
    allSourceDateTimePresent: 0,
    targetMissingArticleKey: 0,
    allLinkShapes: emptyShapes(),
    targetLinkShapes: emptyShapes(),
    canContinue: content?.continueFlag === true || content?.continueFlag === 1,
  };
  const keys = new Set();
  if (!content || !Array.isArray(content.data))
    return { stop: 'stop_search_shape', summary, keys };
  summary.bucketCount = content.data.length;
  for (const bucket of content.data) {
    if (!bucket || !Array.isArray(bucket.items))
      return { stop: 'stop_search_shape', summary, keys };
    for (const item of bucket.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        return { stop: 'stop_search_shape', summary, keys };
      summary.itemCount++;
      const shape = linkShape(item.doc_url);
      summary.allLinkShapes[shape]++;
      const hasTimestamp = Number.isFinite(item.timestamp);
      const hasDateTime =
        item.source != null && Object.hasOwn(item.source, 'dateTime');
      if (hasTimestamp) summary.allTimestampPresent++;
      if (hasDateTime) summary.allSourceDateTimePresent++;
      const nameMatch =
        typeof item.source?.title === 'string' &&
        item.source.title.trim() === TARGET_NAME;
      const bizMatch = targetBiz(item);
      if (nameMatch) summary.sourceNameMatches++;
      if (bizMatch) summary.explicitBizMatches++;
      if (!nameMatch && !bizMatch) continue;
      summary.targetCandidateCount++;
      summary.targetLinkShapes[shape]++;
      if (hasTimestamp) summary.targetTimestampPresent++;
      if (hasDateTime) summary.targetSourceDateTimePresent++;
      const key = digest(item);
      if (key) keys.add(key);
      else summary.targetMissingArticleKey++;
    }
  }
  return { stop: null, summary, keys };
}

function comparison(first, second) {
  const overlap = [...second.keys].filter((key) => first.keys.has(key));
  const added = [...second.keys].filter((key) => !first.keys.has(key));
  return {
    firstUniqueTargetKeys: first.keys.size,
    secondUniqueTargetKeys: second.keys.size,
    overlapKeyCount: overlap.length,
    newKeyCount: added.length,
    overlapKeyDigests: overlap.slice(0, 30),
    newKeyDigests: added.slice(0, 30),
    digestListsTruncated: overlap.length > 30 || added.length > 30,
    keylessTargetCandidates:
      first.summary.targetMissingArticleKey +
      second.summary.targetMissingArticleKey,
  };
}

async function probe(mobile, launch) {
  const out = {
    decision: 'stop_browser_or_context',
    requestCount: 0,
    initRequests: 0,
    firstSearchRequests: 0,
    cursorSearchRequests: 0,
    shelfRequests: 0,
    articleRequests: 0,
    pageNavigations: 0,
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
      initData = await readPayload(init, 64 * 1024);
    } catch {
      out.decision = 'stop_init_body_read';
      return out;
    } finally {
      await init.dispose();
    }
    out.initCode = initData.errCode ?? null;
    out.initRet = initData.ret ?? null;
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
    const initialGate = cookieGate(await context.cookies(SEARCH), mobile.vid);
    out.searchCookieNames = initialGate.names;
    out.searchCookieCount = initialGate.count;
    out.wrVidMatchesRecovery = initialGate.identityMatch;
    if (!initialGate.ready) {
      out.decision = 'stop_cookie_scope_or_identity';
      return out;
    }
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      origin: SEARCH_PAGE_ORIGIN,
    };
    let firstResponse;
    try {
      out.firstSearchRequests = 1;
      out.requestCount = 2;
      firstResponse = await context.request.post(SEARCH, {
        data: initialSearchBody(),
        headers,
        timeout: 20_000,
        maxRedirects: 0,
        maxRetries: 0,
      });
    } catch {
      out.decision = 'stop_first_transport_or_timeout';
      return out;
    }
    out.firstHttp = firstResponse.status();
    if (out.firstHttp !== 200) {
      out.decision = statusStop(out.firstHttp);
      await firstResponse.dispose();
      return out;
    }
    let firstPayload;
    try {
      firstPayload = await searchPayload(firstResponse);
    } catch {
      out.decision = 'stop_first_body_read';
      return out;
    } finally {
      await firstResponse.dispose();
    }
    out.firstCode = firstPayload.errCode ?? null;
    out.firstRet = firstPayload.ret ?? null;
    out.firstContentRet = firstPayload.contentRet ?? null;
    if (firstPayload.stop) {
      out.decision = firstPayload.stop;
      return out;
    }
    const first = pageSummary(firstPayload.data.content);
    out.firstPage = first.summary;
    if (first.stop) {
      out.decision = first.stop;
      return out;
    }
    const cursor = cursorGate(firstPayload.data.content);
    if (cursor.stop) {
      out.decision = cursor.stop;
      return out;
    }
    const afterFirstGate = cookieGate(
      await context.cookies(SEARCH),
      mobile.vid,
    );
    out.wrVidMatchesRecoveryAfterFirst = afterFirstGate.identityMatch;
    if (!afterFirstGate.ready) {
      out.decision = 'stop_cookie_changed_or_missing';
      return out;
    }
    let nextResponse;
    try {
      out.cursorSearchRequests = 1;
      out.requestCount = 3;
      nextResponse = await context.request.post(SEARCH, {
        data: cursor.body,
        headers,
        timeout: 20_000,
        maxRedirects: 0,
        maxRetries: 0,
      });
    } catch {
      out.decision = 'stop_cursor_transport_or_timeout';
      return out;
    }
    out.cursorHttp = nextResponse.status();
    if (out.cursorHttp !== 200) {
      out.decision = statusStop(out.cursorHttp);
      await nextResponse.dispose();
      return out;
    }
    let nextPayload;
    try {
      nextPayload = await searchPayload(nextResponse);
    } catch {
      out.decision = 'stop_cursor_body_read';
      return out;
    } finally {
      await nextResponse.dispose();
    }
    out.cursorCode = nextPayload.errCode ?? null;
    out.cursorRet = nextPayload.ret ?? null;
    out.cursorContentRet = nextPayload.contentRet ?? null;
    if (nextPayload.stop) {
      out.decision = nextPayload.stop;
      return out;
    }
    const next = pageSummary(nextPayload.data.content);
    out.cursorPage = next.summary;
    if (next.stop) {
      out.decision = next.stop;
      return out;
    }
    out.comparison = comparison(first, next);
    out.nextCursorAdvanced =
      Number.isSafeInteger(nextPayload.data.content.offset) &&
      nextPayload.data.content.offset > firstPayload.data.content.offset;
    out.decision = 'cursor_page_observed';
    return out;
  } catch {
    out.decision = 'stop_browser_or_context';
    return out;
  } finally {
    try {
      await context?.close();
    } catch {
      /* No raw browser errors. */
    }
    try {
      await browser?.close();
    } catch {
      /* No raw browser errors. */
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
  assert.equal(
    cursorGate({ data: [{}], continueFlag: true }).stop,
    'stop_cursor_fields_missing',
  );
  assert.equal(
    cursorGate({ data: [{}], continueFlag: false }).stop,
    'stop_no_explicit_continuation',
  );
  assert.equal(
    cursorGate({
      data: [{}],
      continueFlag: true,
      offset: 0,
      searchID: 'id',
      cookies: 'cookie',
    }).stop,
    'stop_cursor_shape',
  );
  assert.equal(
    cursorGate({
      data: [{}],
      continueFlag: true,
      offset: 15,
      searchID: '',
      cookies: 'cookie',
    }).stop,
    'stop_cursor_shape',
  );
  assert.equal(
    cursorGate({
      data: [],
      continueFlag: true,
      offset: 15,
      searchID: 'id',
      cookies: 'cookie',
    }).stop,
    'stop_first_page_empty',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-page-test-'));
  try {
    const dbPath = path.join(root, 'fixture.sqlite');
    const privateRoot = path.join(root, 'private');
    fs.mkdirSync(privateRoot);
    const { DatabaseSync } = sqliteApi();
    const db = new DatabaseSync(dbPath);
    const oldMobile = {
      vid: 'fixture-vid',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      deviceId: 'fixture-device',
    };
    try {
      db.exec(
        'CREATE TABLE accounts (id TEXT PRIMARY KEY, token TEXT NOT NULL)',
      );
      db.exec('CREATE TABLE feeds (id TEXT PRIMARY KEY)');
      db.exec('CREATE TABLE articles (id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO accounts (id, token) VALUES (?, ?)').run(
        'fixture-account',
        JSON.stringify({ mobile: oldMobile }),
      );
    } finally {
      db.close();
    }
    const ready = await preflight(dbPath, privateRoot);
    const runDir = ready.privateRunDir;
    fs.writeFileSync(
      path.join(runDir, 'mobile-refresh-attempt.json'),
      JSON.stringify({
        kind: 'mobile-refresh-once',
        endpoint: '/login',
        attemptedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(
      path.join(runDir, 'mobile-refresh-recovery.json'),
      JSON.stringify({
        formatVersion: 2,
        kind: 'mobile-refresh-response-tokens',
        decision: 'candidate_identity_matched',
        httpStatus: 200,
        businessCode: null,
        accountId: 'fixture-account',
        originalMobile: oldMobile,
        responseTokenFields: { vid: 'fixture-vid', accessToken: 'new-access' },
        proposedMobile: { ...oldMobile, accessToken: 'new-access' },
      }),
    );
    fs.writeFileSync(
      path.join(runDir, 'refreshed-mobile-web-health-attempt.json'),
      JSON.stringify({
        kind: 'refreshed-mobile-web-health',
        endpoints: ['/web/login/session/init', '/web/shelf/sync'],
        attemptedAt: new Date().toISOString(),
      }),
    );
    const mobile = recoveryGate(dbPath, runDir, 'present').mobile;
    assert.throws(() => markerGate(runDir));
    fs.writeFileSync(
      path.join(runDir, PRIOR_MARKER),
      JSON.stringify({
        kind: 'refreshed-mobile-target-search',
        endpoints: ['/web/login/session/init', '/web/wx_search_broker_proxy'],
        attemptedAt: new Date().toISOString(),
      }),
    );
    markerGate(runDir);
    const firstItem = {
      docID: 'first-key',
      source: {
        title: TARGET_NAME,
        dateTime: 'index-time',
      },
      timestamp: 1,
      doc_url: 'https://mp.weixin.qq.com/s/short-token',
    };
    const secondItem = {
      docID: 'second-key',
      source: {
        title: TARGET_NAME,
        dateTime: 'index-time',
      },
      timestamp: 2,
      doc_url: 'https://mp.weixin.qq.com/s?__biz=fixture&mid=2&idx=1',
    };
    const firstContent = {
      ret: 0,
      data: [{ items: [firstItem] }],
      continueFlag: true,
      offset: 15,
      searchID: 'private-id',
      cookies: 'private-cursor-cookie',
    };
    const nextContent = {
      ret: 0,
      data: [{ items: [firstItem, secondItem] }],
      continueFlag: true,
      offset: 30,
      searchID: 'next-private-id',
      cookies: 'next-private-cookie',
    };
    let calls = 0;
    function fakeLaunch(options = {}) {
      const cookies = [
        { name: 'wr_vid', value: options.wrongVid ? 'wrong' : 'fixture-vid' },
        { name: 'wr_skey', value: 'fixture-web' },
        { name: 'wr_rt', value: 'fixture-rt' },
      ];
      let initialized = false;
      let cookieReads = 0;
      const response = (body) => ({
        status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
        headersArray: () =>
          cookies.map((cookie) => ({
            name: 'Set-Cookie',
            value: `${cookie.name}=${cookie.value}; Path=/; Secure`,
          })),
        body: async () => Buffer.from(JSON.stringify(body)),
        dispose: async () => {},
      });
      return async () => ({
        newContext: async () => ({
          cookies: async () => {
            cookieReads++;
            if (!initialized) return [];
            if (options.rotateAfterFirst && cookieReads >= 3)
              return [{ ...cookies[0], value: 'wrong' }, ...cookies.slice(1)];
            return cookies;
          },
          request: {
            post: async (url, request) => {
              calls++;
              assert.equal(request.maxRedirects, 0);
              assert.equal(request.maxRetries, 0);
              assert.equal(request.headers.cookie, undefined);
              if (url === INIT) {
                assert.equal(request.data.skey, 'new-access');
                initialized = true;
                return response(options.initBody ?? { success: 1 });
              }
              assert.equal(url, SEARCH);
              assert.equal(request.headers.origin, SEARCH_PAGE_ORIGIN);
              const body = JSON.parse(request.data);
              if (calls === 2) {
                assert.deepEqual(body, {
                  query: TARGET_NAME,
                  offset: 0,
                  searchcookies: '',
                });
                return response(
                  options.firstBody ?? { ret: -1, content: firstContent },
                );
              }
              assert.deepEqual(body, {
                query: TARGET_NAME,
                offset: 15,
                searchid: 'private-id',
                searchcookies: 'private-cursor-cookie',
              });
              return response(
                options.nextBody ?? { ret: -1, content: nextContent },
              );
            },
          },
          close: async () => {},
        }),
        close: async () => {},
      });
    }
    const good = await probe(mobile, fakeLaunch());
    assert.equal(good.decision, 'cursor_page_observed');
    assert.equal(calls, 3);
    assert.equal(good.firstPage.sourceNameMatches, 1);
    assert.equal(good.cursorPage.sourceNameMatches, 2);
    assert.equal(good.firstPage.targetLinkShapes.official_short, 1);
    assert.equal(good.cursorPage.targetLinkShapes.official_long, 1);
    assert.equal(good.comparison.overlapKeyCount, 1);
    assert.equal(good.comparison.newKeyCount, 1);
    assert.equal(good.nextCursorAdvanced, true);
    assert.equal(
      /first-key|second-key|private-id|private-cursor-cookie|index-time/.test(
        JSON.stringify(good),
      ),
      false,
    );
    calls = 0;
    assert.equal(
      (
        await probe(
          mobile,
          fakeLaunch({
            firstBody: {
              ret: -1,
              content: { ...firstContent, continueFlag: false },
            },
          }),
        )
      ).decision,
      'stop_no_explicit_continuation',
    );
    assert.equal(calls, 2);
    calls = 0;
    assert.equal(
      (await probe(mobile, fakeLaunch({ rotateAfterFirst: true }))).decision,
      'stop_cookie_changed_or_missing',
    );
    assert.equal(calls, 2);
    calls = 0;
    const repeated = await probe(
      mobile,
      fakeLaunch({
        nextBody: {
          ret: -1,
          content: firstContent,
        },
      }),
    );
    assert.equal(repeated.comparison.overlapKeyCount, 1);
    assert.equal(repeated.comparison.newKeyCount, 0);
    assert.equal(repeated.nextCursorAdvanced, false);
    assert.equal(calls, 3);
    calls = 0;
    assert.equal(
      (
        await probe(
          mobile,
          fakeLaunch({
            firstBody: {
              errMsg: '请完成验证码',
            },
          }),
        )
      ).decision,
      'stop_verification',
    );
    assert.equal(calls, 2);
    calls = 0;
    assert.equal(
      (
        await probe(
          mobile,
          fakeLaunch({
            nextBody: {
              errMsg: '请求频繁',
            },
          }),
        )
      ).decision,
      'stop_rate_limit',
    );
    assert.equal(calls, 3);
    markAttempt(runDir);
    assert.throws(() => markerGate(runDir), /already_attempted/);
  } finally {
    const base = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(root);
    if (
      !within(base, resolved) ||
      !path.basename(resolved).startsWith('cursor-page-test-')
    )
      throw Error('self_test_cleanup_gate');
    fs.rmSync(resolved, { recursive: true });
  }
  return {
    decision: 'self_test_passed',
    productionReads: 0,
    productionWrites: 0,
    realNetworkRequests: 0,
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
        credentialSource: 'private_refresh_recovery_only',
        requestMax: 3,
        initRequestMax: 1,
        searchRequestMax: 2,
        cursorSource: 'first_response_content_only',
        cursorRequestKeys: ['query', 'offset', 'searchid', 'searchcookies'],
        articleRequests: 0,
        shelfRequests: 0,
        pageNavigations: 0,
        redirects: false,
        retries: false,
        productionReads: 0,
        productionWrites: 0,
        realNetworkRequests: 0,
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
  let credentials, verified;
  try {
    credentials = recoveryGate(options.dbPath, options.runDir, 'present');
    markerGate(credentials.runDir);
    verified = runtime(options.modulePath, options.browserPath);
    markAttempt(credentials.runDir);
  } catch (error) {
    const safe = new Set([
      'already_attempted',
      'prior_search_marker_gate',
      'run_dir_gate',
      'refresh_marker_gate',
      'health_marker_gate',
      'recovery_gate',
      'source_backup_gate',
      'recovery_identity_gate',
      'db_gate',
      'private_root_gate',
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
  const result = await probe(credentials.mobile, launch);
  console.log(JSON.stringify(result));
  if (result.decision !== 'cursor_page_observed') process.exitCode = 1;
}

if (require.main === module) main();
