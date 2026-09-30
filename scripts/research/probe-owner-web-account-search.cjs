#!/usr/bin/env node
'use strict';

// Only the owner's already authenticated dedicated official browser page.
// No login/init/refresh, SDK retry, request interception, or article request.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const {
  safePrivateRoot,
  sqliteApi,
  oneAccount,
} = require('./probe-mobile-refresh-preflight.cjs');
const { verifiedSessionStatus } = require('./probe-weread-logged-mp-dom.cjs');
const {
  environmentGate,
  cookieGate,
  statusStop,
} = require('./probe-refreshed-mobile-web-health.cjs');
const { searchPayload } = require('./probe-refreshed-mobile-target-search.cjs');
const {
  inspect,
  cursor,
  durable,
  snapshot,
} = require('./probe-recent-account-discovery.cjs');
const SEARCH = 'https://weread.qq.com/web/wx_search_broker_proxy';
const SHA = 'e5e090ee6b6180de2ed72ee3eeebdcdab9a10c5c0f5c95f442fd7940730f7089';
const MARKER = 'owner-web-account-search-attempt.json';

// Runs in the known weread.qq.com page. Native fetch carries its own normal
// same-origin login cookies. Body fields/cursor come from fixed Tencent JS.
async function nativeSearch(body) {
  if (
    location.origin !== 'https://weread.qq.com' ||
    !Function.prototype.toString.call(window.fetch).includes('[native code]')
  )
    return { stop: 'stop_origin_or_non_native_fetch' };
  let response;
  try {
    response = await window.fetch('/web/wx_search_broker_proxy', {
      method: 'POST',
      credentials: 'include',
      mode: 'same-origin',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (response.type === 'opaqueredirect' || response.status !== 200)
      return { http: response.status, stop: 'stop_http_or_redirect' };
    const reader = response.body.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 512 * 1024) {
        await reader.cancel();
        return { http: 200, stop: 'stop_body_limit' };
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { http: 200, text: new TextDecoder().decode(bytes) };
  } catch {
    return { stop: 'stop_transport_or_timeout' };
  }
}

async function search(page, context, vid, config, save) {
  const result = {
    credentialSource: 'owner_confirmed_official_web_login',
    requestCount: 0,
    pages: [],
    articleRequests: 0,
    productionWrites: 0,
    sdkRetries: 0,
  };
  let body = { query: config.name, offset: 0, searchcookies: '' };
  for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
    if (!cookieGate(await context.cookies(SEARCH), vid).ready) {
      result.decision = 'stop_cookie_identity';
      return result;
    }
    result.requestCount++;
    const response = await page.evaluate(nativeSearch, body);
    result.lastHttp = response.http ?? null;
    if (response.stop) {
      result.decision = response.stop;
      return result;
    }
    if (response.http !== 200) {
      result.decision = statusStop(response.http);
      return result;
    }
    const payload = await searchPayload({
      headers: () => ({}),
      body: async () => Buffer.from(response.text),
    });
    if (payload.stop) {
      result.decision = payload.stop;
      result.businessCode = payload.errCode ?? payload.ret;
      return result;
    }
    const observed = inspect(payload.data.content, config, Date.now());
    await save(pageNumber, {
      kind: 'owner-web-account-search-page',
      capturedAt: new Date().toISOString(),
      pageNumber,
      requestQuery: config.name,
      targetBiz: config.biz,
      http: response.http,
      ret: payload.ret,
      contentRet: payload.contentRet,
      requestedOffset: body.offset,
      continueFlag: payload.data.content.continueFlag,
      items: observed.items,
      summary: observed.summary,
      timeSemantics: 'search-index-not-original-publication',
    });
    result.pages.push(observed.summary);
    const next = cursor(payload.data.content, config.name);
    if (pageNumber === 2 || !observed.needOnePage || !next) {
      result.continuationStop =
        pageNumber === 2
          ? 'second_page_bound'
          : !observed.needOnePage
            ? 'bounded_sample_sufficient'
            : 'no_valid_response_cursor';
      break;
    }
    if (next.offset <= body.offset) {
      result.decision = 'stop_cursor_not_advancing';
      return result;
    }
    result.continuationReason =
      'mixed_index_dates_or_fewer_than_five_recent_claims';
    body = next;
  }
  result.decision = 'owner_search_pages_preserved';
  return result;
}

async function selfTest() {
  let calls = 0;
  const bodies = [];
  const saved = [];
  const context = {
    cookies: async () => [
      { name: 'wr_vid', value: 'owner' },
      { name: 'wr_skey', value: 'private' },
    ],
  };
  const config = { name: 'test account', biz: 'testbiz' };
  const page = {
    evaluate: async (_, body) => {
      calls++;
      bodies.push(body);
      return {
        http: 200,
        text: JSON.stringify({
          ret: -1,
          content: {
            ret: 0,
            data: [
              {
                items: [
                  {
                    source: { title: config.name },
                    timestamp: 1,
                    doc_url:
                      'http://mp.weixin.qq.com/s?__biz=testbiz&mid=1&idx=1',
                  },
                ],
              },
            ],
            offset: calls * 15,
            searchID: 'actual-id',
            cookies: 'actual-cursor',
            continueFlag: true,
          },
        }),
      };
    },
  };
  const result = await search(page, context, 'owner', config, async (_, d) =>
    saved.push(d),
  );
  assert.equal(result.requestCount, 2);
  assert.equal(saved.length, 2);
  assert.deepEqual(bodies[1], {
    query: config.name,
    offset: 15,
    searchid: 'actual-id',
    searchcookies: 'actual-cursor',
  });
  assert.equal(JSON.stringify(saved).includes('actual-cursor'), false);
  calls = 0;
  page.evaluate = async () => {
    calls++;
    return { http: 200, text: JSON.stringify({ errCode: -2012 }) };
  };
  assert.equal(
    (await search(page, context, 'owner', config, async () => {})).decision,
    'stop_auth_expired_candidate',
  );
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(
    (await search(page, context, 'different-owner', config, async () => {}))
      .requestCount,
    0,
  );
  assert.equal(calls, 0);
  console.log(
    JSON.stringify({ decision: 'self_test_passed', realNetworkRequests: 0 }),
  );
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--self-test')
    return selfTest();
  const a = process.argv.slice(2);
  const keys = ['--db', '--evidence-dir', '--config', '--playwright-core'];
  if (
    !['--preflight', '--execute'].includes(a[0]) ||
    a.length !== 10 ||
    a[9] !== '--owner-login-confirmed' ||
    keys.some((k, i) => a[1 + 2 * i] !== k || !path.isAbsolute(a[2 + 2 * i]))
  )
    throw Error('usage_gate');
  const [dbPath, evidenceDir, configPath, modulePath] = keys.map(
    (_, i) => a[2 + 2 * i],
  );
  environmentGate(process.env);
  safePrivateRoot(evidenceDir);
  const config = JSON.parse(fs.readFileSync(configPath));
  if (
    Object.keys(config).sort().join(',') !== 'biz,name' ||
    typeof config.name !== 'string' ||
    !config.name.trim() ||
    config.name.length > 100 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(config.biz)
  )
    throw Error('config_gate');
  if (
    createHash('sha256')
      .update(
        fs.readFileSync(path.join(evidenceDir, 'read_search.fc739bbf.js')),
      )
      .digest('hex') !== SHA
  )
    throw Error('source_gate');
  if (
    fs.existsSync(path.join(evidenceDir, MARKER)) ||
    fs.existsSync(path.join(evidenceDir, MARKER + '.pending'))
  )
    throw Error('already_attempted');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(modulePath, 'package.json')),
  );
  if (manifest.name !== 'playwright-core' || manifest.version !== '1.58.2')
    throw Error('runtime_gate');
  const status = execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'weread-login-window.ps1'),
      '-Action',
      'Status',
    ],
    { encoding: 'utf8', timeout: 20000, windowsHide: true },
  );
  const endpoint = verifiedSessionStatus(status);
  const db = new (sqliteApi().DatabaseSync)(dbPath, { readOnly: true });
  let vid;
  try {
    db.exec('PRAGMA query_only=ON');
    vid = oneAccount(db).mobile.vid;
  } finally {
    db.close();
  }
  const before = snapshot(dbPath);
  const { chromium } = require(modulePath);
  const browser = await chromium.connectOverCDP(endpoint);
  let result;
  try {
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw Error('context_gate');
    const context = contexts[0];
    const pages = context
      .pages()
      .filter((p) => new URL(p.url()).origin === 'https://weread.qq.com');
    if (pages.length !== 1) throw Error('official_page_gate');
    const page = pages[0];
    const state = await page.evaluate(() => ({
      origin: location.origin,
      nativeFetch: Function.prototype.toString
        .call(window.fetch)
        .includes('[native code]'),
      challengeVisible: Array.from(
        document.querySelectorAll(
          'iframe[src*="captcha" i],iframe[src*="open.weixin.qq.com" i]',
        ),
      ).some((e) => e.getClientRects().length > 0),
    }));
    const gate = cookieGate(await context.cookies(SEARCH), vid);
    if (!gate.ready || !state.nativeFetch || state.challengeVisible)
      throw Error('owner_session_gate');
    if (a[0] === '--preflight') {
      console.log(
        JSON.stringify({
          decision: 'owner_session_ready',
          identityMatchesProduction: true,
          nativeFetch: true,
          cookieNames: gate.names,
          requestCount: 0,
          production: before,
        }),
      );
      return;
    }
    durable(path.join(evidenceDir, MARKER), {
      kind: 'owner-web-account-search',
      attemptedAt: new Date().toISOString(),
      sourceSha256: SHA,
      credentialSource: 'owner_confirmed_official_web_login',
      requestMax: 2,
    });
    durable(path.join(evidenceDir, 'production-before.json'), before);
    try {
      result = await search(page, context, vid, config, async (n, data) =>
        durable(path.join(evidenceDir, `page-${n}.json`), data),
      );
    } catch {
      result = {
        decision: 'stop_structure_or_persistence',
        productionWrites: 0,
      };
    }
    result.capturedAt = new Date().toISOString();
    const after = snapshot(dbPath);
    result.productionUnchanged =
      JSON.stringify(before) === JSON.stringify(after);
    durable(path.join(evidenceDir, 'production-after.json'), after);
    durable(path.join(evidenceDir, 'result.json'), result);
    console.log(JSON.stringify(result));
    if (
      result.decision !== 'owner_search_pages_preserved' ||
      !result.productionUnchanged
    )
      process.exitCode = 1;
  } finally {
    await browser.close();
  } // Disconnect CDP; keep owner's visible browser open.
}
if (require.main === module)
  main().catch(() => {
    console.log(
      JSON.stringify({
        decision: 'local_or_owner_session_gate_failed',
        requestCount: 0,
      }),
    );
    process.exitCode = 1;
  });
module.exports = { search, nativeSearch };
