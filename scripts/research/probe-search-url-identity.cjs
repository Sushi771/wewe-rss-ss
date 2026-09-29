#!/usr/bin/env node
'use strict';

// Bounded URL-structure diagnosis for one search first page. No article GET.
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
  digest,
} = require('./probe-refreshed-mobile-target-search.cjs');

const ORIGIN = 'https://weread.qq.com';
const SEARCH_PAGE_ORIGIN = 'https://search.weixin.qq.com';
const INIT = `${ORIGIN}/web/login/session/init`;
const SEARCH = `${ORIGIN}/web/wx_search_broker_proxy`;
const TARGET_NAME = '妈妈部落畅聊阁';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const TARGET_BIZ_UIN = '3895431412';
const PRIOR_MARKER = 'refreshed-mobile-target-search-attempt.json';
const MARKER = 'search-url-identity-attempt.json';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_ITEMS = 100;
const MAX_URL_LENGTH = 8192;

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
  const prior = JSON.parse(
    fs.readFileSync(path.join(runDir, PRIOR_MARKER), 'utf8'),
  );
  if (
    prior.kind !== 'refreshed-mobile-target-search' ||
    !Number.isFinite(Date.parse(prior.attemptedAt)) ||
    JSON.stringify(prior.endpoints) !==
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
        kind: 'search-url-identity',
        endpoints: ['/web/login/session/init', '/web/wx_search_broker_proxy'],
        attemptedAt: new Date().toISOString(),
      }) + '\n',
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function indexBizUinMatches(value) {
  return typeof value === 'string' && /^\d+$/.test(value)
    ? value === TARGET_BIZ_UIN
    : Number.isSafeInteger(value)
      ? String(value) === TARGET_BIZ_UIN
      : null;
}

function urlStructure(value) {
  const result = {
    rawForm: 'non_string',
    scheme: 'none',
    host: 'none',
    path: 'none',
    htmlAmpEscaped: false,
    percentEncodedUrl: false,
    slashEscaped: false,
    authoritySafe: false,
    hasBiz: false,
    bizMatchesTarget: null,
    hasMid: false,
    hasIdx: false,
    midIdxNumeric: false,
    locallyClaimedArticleKey: false,
  };
  if (value == null || value === '') {
    result.rawForm = 'missing';
    return result;
  }
  if (typeof value !== 'string') return result;
  if (value.length > MAX_URL_LENGTH) {
    result.rawForm = 'oversize';
    return result;
  }
  let candidate = value.trim();
  if (!candidate) {
    result.rawForm = 'missing';
    return result;
  }
  result.htmlAmpEscaped = /&amp;|&#0*38;|&#x0*26;/i.test(candidate);
  if (result.htmlAmpEscaped)
    candidate = candidate.replace(/&amp;|&#0*38;|&#x0*26;/gi, '&');
  result.slashEscaped = candidate.includes('\\/');
  if (result.slashEscaped) candidate = candidate.replace(/\\\//g, '/');
  result.percentEncodedUrl = /^https?%3a%2f%2f/i.test(candidate);
  if (result.percentEncodedUrl) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      result.rawForm = 'bad_percent_encoding';
      return result;
    }
  }
  if (/^https:\/\//i.test(candidate)) result.rawForm = 'https_absolute';
  else if (/^http:\/\//i.test(candidate)) result.rawForm = 'http_absolute';
  else if (candidate.startsWith('//')) result.rawForm = 'protocol_relative';
  else if (candidate.startsWith('/')) result.rawForm = 'relative_path';
  else if (/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
    result.rawForm = 'other_scheme';
    return result;
  } else {
    result.rawForm = 'unrecognized_text';
    return result;
  }
  let url;
  try {
    url =
      result.rawForm === 'protocol_relative'
        ? new URL(`https:${candidate}`)
        : result.rawForm === 'relative_path'
          ? new URL(candidate, SEARCH_PAGE_ORIGIN)
          : new URL(candidate);
  } catch {
    result.rawForm = 'parse_failed';
    return result;
  }
  result.scheme =
    url.protocol === 'https:'
      ? 'https'
      : url.protocol === 'http:'
        ? 'http'
        : 'other';
  result.host =
    url.hostname === 'mp.weixin.qq.com'
      ? 'mp_weixin'
      : url.hostname === 'search.weixin.qq.com'
        ? 'search_weixin'
        : 'other';
  result.authoritySafe = !url.username && !url.password && !url.port;
  result.path = /^\/s\/[^/]+$/.test(url.pathname)
    ? 'short_s'
    : url.pathname === '/s'
      ? 'query_s'
      : 'other';
  if (result.host !== 'mp_weixin') return result;
  const params = url.searchParams;
  result.hasBiz = params.has('__biz');
  result.hasMid = params.has('mid');
  result.hasIdx = params.has('idx');
  result.midIdxNumeric =
    /^\d+$/.test(params.get('mid') ?? '') &&
    /^\d+$/.test(params.get('idx') ?? '');
  result.bizMatchesTarget =
    result.hasBiz && result.authoritySafe
      ? params.get('__biz') === TARGET_BIZ
      : null;
  result.locallyClaimedArticleKey =
    result.authoritySafe &&
    result.bizMatchesTarget === true &&
    result.midIdxNumeric;
  return result;
}

function tally(items) {
  const counts = {
    itemCount: 0,
    sourceNameMatches: 0,
    urlBizPresent: 0,
    urlBizMatchesTarget: 0,
    indexBizUinPresent: 0,
    indexBizUinParseable: 0,
    indexBizUinMatchesTarget: 0,
    rawForms: {},
    schemes: {},
    hosts: {},
    paths: {},
    htmlAmpEscaped: 0,
    percentEncodedUrl: 0,
    slashEscaped: 0,
    unsafeUrlAuthority: 0,
  };
  let selected = null,
    selectedRank = -1;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw Error('search_item_shape');
    counts.itemCount++;
    const u = urlStructure(item.doc_url);
    for (const [name, key] of [
      ['rawForms', u.rawForm],
      ['schemes', u.scheme],
      ['hosts', u.host],
      ['paths', u.path],
    ])
      counts[name][key] = (counts[name][key] ?? 0) + 1;
    for (const flag of ['htmlAmpEscaped', 'percentEncodedUrl', 'slashEscaped'])
      if (u[flag]) counts[flag]++;
    if (u.host === 'mp_weixin' && !u.authoritySafe) counts.unsafeUrlAuthority++;
    if (u.hasBiz) counts.urlBizPresent++;
    if (u.bizMatchesTarget) counts.urlBizMatchesTarget++;
    const indexMatch = indexBizUinMatches(item.bizUin);
    if (Object.hasOwn(item, 'bizUin')) counts.indexBizUinPresent++;
    if (indexMatch !== null) counts.indexBizUinParseable++;
    if (indexMatch) counts.indexBizUinMatchesTarget++;
    const nameMatch =
      typeof item.source?.title === 'string' &&
      item.source.title.trim() === TARGET_NAME;
    if (nameMatch) counts.sourceNameMatches++;
    if (!nameMatch) continue;
    const rank =
      u.locallyClaimedArticleKey && indexMatch === true
        ? 3
        : u.locallyClaimedArticleKey || indexMatch === true
          ? 2
          : u.host === 'mp_weixin'
            ? 1
            : 0;
    if (rank <= selectedRank) continue;
    selectedRank = rank;
    selected = {
      selection: 'first_highest_rank_exact_source_name',
      keyDigest: digest(item),
      rawForm: u.rawForm,
      scheme: u.scheme,
      host: u.host,
      path: u.path,
      authoritySafe: u.authoritySafe,
      hadEscapedInput:
        u.htmlAmpEscaped || u.percentEncodedUrl || u.slashEscaped,
      urlBizPresent: u.hasBiz,
      urlBizMatchesTarget: u.bizMatchesTarget,
      indexBizUinPresent: Object.hasOwn(item, 'bizUin'),
      indexBizUinParseable: indexMatch !== null,
      indexBizUinMatchesTarget: indexMatch,
      hasMid: u.hasMid,
      hasIdx: u.hasIdx,
      midIdxNumeric: u.midIdxNumeric,
      locallyClaimedArticleKey: u.locallyClaimedArticleKey,
      hasTimestamp: Number.isFinite(item.timestamp),
      hasSourceDateTime:
        item.source != null && Object.hasOwn(item.source, 'dateTime'),
      hasSrcUserName:
        typeof item.srcUserName === 'string' && !!item.srcUserName,
      originalBizAndCtVerified: false,
    };
  }
  return { counts, candidate: selected };
}

async function probe(mobile, launch) {
  const out = {
    decision: 'stop_browser_or_context',
    requestCount: 0,
    initRequests: 0,
    searchRequests: 0,
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
    const gate = cookieGate(await context.cookies(SEARCH), mobile.vid);
    out.searchCookieNames = gate.names;
    out.searchCookieCount = gate.count;
    out.wrVidMatchesRecovery = gate.identityMatch;
    if (!gate.ready) {
      out.decision = 'stop_cookie_scope_or_identity';
      return out;
    }
    let search;
    try {
      out.searchRequests = 1;
      out.requestCount = 2;
      search = await context.request.post(SEARCH, {
        data: initialSearchBody(),
        headers: {
          'content-type': 'application/json; charset=utf-8',
          origin: SEARCH_PAGE_ORIGIN,
        },
        timeout: 20_000,
        maxRedirects: 0,
        maxRetries: 0,
      });
    } catch {
      out.decision = 'stop_search_transport_or_timeout';
      return out;
    }
    out.searchHttp = search.status();
    if (out.searchHttp !== 200) {
      out.decision = statusStop(out.searchHttp);
      await search.dispose();
      return out;
    }
    let found;
    try {
      found = await searchPayload(search);
    } catch {
      out.decision = 'stop_search_body_read';
      return out;
    } finally {
      await search.dispose();
    }
    out.searchCode = found.errCode ?? null;
    out.searchRet = found.ret ?? null;
    out.contentRet = found.contentRet ?? null;
    if (found.stop) {
      out.decision = found.stop;
      return out;
    }
    const content = found.data.content;
    if (!content || !Array.isArray(content.data)) {
      out.decision = 'stop_search_shape';
      return out;
    }
    const items = [];
    for (const bucket of content.data) {
      if (!bucket || !Array.isArray(bucket.items)) {
        out.decision = 'stop_search_shape';
        return out;
      }
      items.push(...bucket.items);
      if (items.length > MAX_ITEMS) {
        out.decision = 'stop_item_limit';
        return out;
      }
    }
    const summary = tally(items);
    Object.assign(out, summary);
    out.decision = 'url_shapes_observed';
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
  const long = `http://mp.weixin.qq.com/s?__biz=${TARGET_BIZ}&mid=2&idx=1`;
  assert.equal(urlStructure(long).rawForm, 'http_absolute');
  assert.equal(urlStructure(long).locallyClaimedArticleKey, true);
  assert.equal(urlStructure(long.replace(/&/g, '&amp;')).htmlAmpEscaped, true);
  assert.equal(urlStructure(encodeURIComponent(long)).percentEncodedUrl, true);
  assert.equal(urlStructure(long.replaceAll('/', '\\/')).slashEscaped, true);
  assert.equal(
    urlStructure(`//mp.weixin.qq.com/s/x`).rawForm,
    'protocol_relative',
  );
  assert.equal(urlStructure('/s?__biz=x').host, 'search_weixin');
  assert.equal(urlStructure('javascript:alert(1)').rawForm, 'other_scheme');
  assert.equal(urlStructure('not a url').rawForm, 'unrecognized_text');
  assert.equal(
    urlStructure(
      'http://user@mp.weixin.qq.com/s?__biz=' + TARGET_BIZ + '&mid=2&idx=1',
    ).locallyClaimedArticleKey,
    false,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'url-identity-test-'));
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
    let calls = 0;
    const cookies = [
      { name: 'wr_vid', value: 'fixture-vid' },
      { name: 'wr_skey', value: 'fixture-web' },
    ];
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
    function fakeLaunch(body) {
      let initialized = false;
      return async () => ({
        newContext: async () => ({
          cookies: async () => (initialized ? cookies : []),
          request: {
            post: async (url, request) => {
              calls++;
              assert.equal(request.maxRedirects, 0);
              assert.equal(request.maxRetries, 0);
              assert.equal(request.headers.cookie, undefined);
              if (url === INIT) {
                assert.equal(request.data.skey, 'new-access');
                initialized = true;
                return response({ success: 1 });
              }
              assert.equal(url, SEARCH);
              assert.equal(request.headers.origin, SEARCH_PAGE_ORIGIN);
              assert.deepEqual(JSON.parse(request.data), {
                query: TARGET_NAME,
                offset: 0,
                searchcookies: '',
              });
              return response(body);
            },
          },
          close: async () => {},
        }),
        close: async () => {},
      });
    }
    const good = await probe(
      mobile,
      fakeLaunch({
        ret: -1,
        content: {
          ret: 0,
          data: [
            {
              items: [
                {
                  docID: 'one',
                  doc_url: long,
                  bizUin: Number(TARGET_BIZ_UIN),
                  source: { title: TARGET_NAME, dateTime: 'index-time' },
                  timestamp: 1,
                },
              ],
            },
          ],
        },
      }),
    );
    assert.equal(good.decision, 'url_shapes_observed');
    assert.equal(good.requestCount, 2);
    assert.equal(good.counts.rawForms.http_absolute, 1);
    assert.equal(good.candidate.urlBizMatchesTarget, true);
    assert.equal(good.candidate.indexBizUinMatchesTarget, true);
    assert.equal(good.candidate.originalBizAndCtVerified, false);
    assert.equal(
      /http:\/\/|__biz|index-time|new-access|fixture-web|one/.test(
        JSON.stringify(good),
      ),
      false,
    );
    calls = 0;
    const stopped = await probe(mobile, fakeLaunch({ errMsg: '请完成验证码' }));
    assert.equal(stopped.decision, 'stop_verification');
    assert.equal(calls, 2);
    markAttempt(runDir);
    assert.throws(() => markerGate(runDir), /already_attempted/);
  } finally {
    const base = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(root);
    if (
      !within(base, resolved) ||
      !path.basename(resolved).startsWith('url-identity-test-')
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
        requestMax: 2,
        initRequestMax: 1,
        searchRequestMax: 1,
        articleRequests: 0,
        pageNavigations: 0,
        candidateMax: 1,
        itemParseMax: MAX_ITEMS,
        credentialSource: 'private_refresh_recovery_only',
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
  if (result.decision !== 'url_shapes_observed') process.exitCode = 1;
}

if (require.main === module) main();
