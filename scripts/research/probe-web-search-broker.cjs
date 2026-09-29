#!/usr/bin/env node
'use strict';

// One-shot research probe. It uses an already authenticated WeRead tab exposed
// through an explicitly supplied local CDP endpoint; it never opens a tab or
// reads Cookie values. Run --self-test before any live use.

const assert = require('node:assert/strict');
const vm = require('node:vm');

const QUERY = '妈妈部落畅聊阁';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const ORIGIN = 'https://weread.qq.com';
const ENDPOINT = `${ORIGIN}/web/wx_search_broker_proxy`;

async function pageProbe(query, targetBiz) {
  const output = {
    requestCount: 0,
    credentialSource: 'existing_browser_context',
    endpoint: '/web/wx_search_broker_proxy',
  };
  if (globalThis.location?.origin !== 'https://weread.qq.com') {
    return { ...output, decision: 'stop_origin_mismatch' };
  }
  if (globalThis.location.hash === '#login') {
    return { ...output, decision: 'stop_login_page' };
  }

  let response;
  try {
    output.requestCount = 1;
    response = await globalThis.fetch(
      'https://weread.qq.com/web/wx_search_broker_proxy',
      {
        method: 'POST',
        credentials: 'include',
        mode: 'same-origin',
        redirect: 'manual',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch (error) {
    return {
      ...output,
      decision: 'stop_network_or_timeout',
      errorType: error?.name || 'Error',
    };
  }

  output.httpStatus = response.status;
  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    response.status !== 200
  ) {
    return { ...output, decision: 'stop_http_or_redirect' };
  }

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    return { ...output, decision: 'stop_non_json_or_verification' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ...output, decision: 'stop_structure' };
  }

  output.errCode = typeof payload.errCode === 'number' ? payload.errCode : null;
  output.outerRet = typeof payload.ret === 'number' ? payload.ret : null;
  if (output.errCode !== null && output.errCode !== 0) {
    return {
      ...output,
      decision:
        output.errCode === -2010 || output.errCode === -2012
          ? 'stop_auth_expired'
          : 'stop_business_error',
    };
  }

  const content = payload.content;
  if (!content || typeof content !== 'object' || !Array.isArray(content.data)) {
    return { ...output, decision: 'stop_structure' };
  }
  output.contentRet = typeof content.ret === 'number' ? content.ret : null;
  output.bucketCount = content.data.length;
  output.continueFlag =
    typeof content.continueFlag === 'number' ? content.continueFlag : null;
  output.hasOffset = Object.hasOwn(content, 'offset');
  output.hasSearchID =
    typeof content.searchID === 'string' && content.searchID.length > 0;
  output.hasConversationID =
    typeof content.conversationID === 'string' &&
    content.conversationID.length > 0;

  let totalItems = 0;
  let sourceTitleExactMatches = 0;
  let docUrlPresent = 0;
  let timestampPresent = 0;
  let matchingDocUrlPresent = 0;
  let matchingTimestampPresent = 0;
  let explicitTargetBizUrlMatches = 0;
  for (const bucket of content.data) {
    if (!bucket || !Array.isArray(bucket.items)) {
      return { ...output, decision: 'stop_structure' };
    }
    for (const item of bucket.items) {
      if (!item || typeof item !== 'object') {
        return { ...output, decision: 'stop_structure' };
      }
      totalItems += 1;
      const match =
        typeof item.source?.title === 'string' &&
        item.source.title.trim() === query;
      if (match) sourceTitleExactMatches += 1;
      const hasUrl =
        typeof item.doc_url === 'string' && item.doc_url.length > 0;
      const hasTimestamp =
        typeof item.timestamp === 'number' && Number.isFinite(item.timestamp);
      if (hasUrl) docUrlPresent += 1;
      if (hasTimestamp) timestampPresent += 1;
      if (match && hasUrl) matchingDocUrlPresent += 1;
      if (match && hasTimestamp) matchingTimestampPresent += 1;
      if (match && hasUrl) {
        try {
          const articleUrl = new URL(item.doc_url);
          if (
            articleUrl.hostname === 'mp.weixin.qq.com' &&
            articleUrl.searchParams.get('__biz') === targetBiz
          ) {
            explicitTargetBizUrlMatches += 1;
          }
        } catch {
          // A non-canonical URL does not prove the target account identity.
        }
      }
    }
  }
  return {
    ...output,
    totalItems,
    sourceTitleExactMatches,
    docUrlPresent,
    timestampPresent,
    matchingDocUrlPresent,
    matchingTimestampPresent,
    explicitTargetBizUrlMatches,
    decision:
      sourceTitleExactMatches > 0
        ? 'first_page_observed'
        : 'stop_no_exact_target_match',
  };
}

function pageExpression() {
  return `(${pageProbe.toString()})(${JSON.stringify(QUERY)},${JSON.stringify(TARGET_BIZ)})`;
}

function localCdpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid local CDP address');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'CDP address must be an explicit localhost HTTP origin with a port',
    );
  }
  return url;
}

async function existingWereadTab(cdp, tabId) {
  const response = await fetch(new URL('/json/list', cdp), {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('local CDP inventory unavailable');
  const tabs = await response.json();
  if (!Array.isArray(tabs)) throw new Error('local CDP inventory malformed');
  const matches = tabs.filter((tab) => {
    if (tab.type !== 'page' || typeof tab.url !== 'string') return false;
    try {
      return new URL(tab.url).origin === ORIGIN && (!tabId || tab.id === tabId);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1)
    throw new Error('expected exactly one existing WeRead tab');
  let socketUrl;
  try {
    socketUrl = new URL(matches[0].webSocketDebuggerUrl);
  } catch {
    throw new Error('CDP page socket has an unexpected shape');
  }
  if (
    socketUrl.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost'].includes(socketUrl.hostname) ||
    socketUrl.port !== cdp.port ||
    !socketUrl.pathname.startsWith('/devtools/page/')
  ) {
    throw new Error('CDP page socket is not local or has an unexpected shape');
  }
  return socketUrl.href;
}

function evaluateOnce(socketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('CDP evaluation timed out'));
    }, 30000);
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: 25000,
          },
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (
        message.error ||
        message.result?.exceptionDetails ||
        !message.result?.result?.value
      ) {
        reject(new Error('CDP evaluation failed'));
      } else {
        resolve(message.result.result.value);
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP socket failed'));
    });
  });
}

function sanitizedSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CDP result is not a summary');
  }
  const fields = [
    'requestCount',
    'credentialSource',
    'endpoint',
    'decision',
    'errorType',
    'httpStatus',
    'errCode',
    'outerRet',
    'contentRet',
    'bucketCount',
    'continueFlag',
    'hasOffset',
    'hasSearchID',
    'hasConversationID',
    'totalItems',
    'sourceTitleExactMatches',
    'docUrlPresent',
    'timestampPresent',
    'matchingDocUrlPresent',
    'matchingTimestampPresent',
    'explicitTargetBizUrlMatches',
  ];
  const out = {};
  for (const field of fields) {
    const item = value[field];
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      out[field] = item;
    else if (
      field === 'decision' &&
      typeof item === 'string' &&
      /^([a-z_]+)$/.test(item)
    )
      out[field] = item;
    else if (
      field === 'errorType' &&
      typeof item === 'string' &&
      /^[A-Za-z]+Error$/.test(item)
    )
      out[field] = item;
  }
  out.credentialSource = 'existing_browser_context';
  out.endpoint = '/web/wx_search_broker_proxy';
  if (out.requestCount !== 0 && out.requestCount !== 1)
    throw new Error('invalid request count');
  if (!out.decision) throw new Error('missing probe decision');
  return out;
}

async function selfTest() {
  const run = async (
    payload,
    { origin = ORIGIN, status = 200, type = 'basic', isJson = true } = {},
  ) => {
    let calls = 0;
    const context = {
      location: { origin, hash: '' },
      URL,
      AbortSignal,
      fetch: async (_url, options) => {
        calls += 1;
        assert.equal(options.method, 'POST');
        assert.equal(options.credentials, 'include');
        assert.equal(options.redirect, 'manual');
        assert.deepEqual(JSON.parse(options.body), { query: QUERY });
        return {
          status,
          type,
          redirected: false,
          text: async () =>
            isJson ? JSON.stringify(payload) : '<html>verification</html>',
        };
      },
    };
    const result = await vm.runInNewContext(pageExpression(), context);
    return { result, calls };
  };
  const item = {
    source: { title: QUERY },
    doc_url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(TARGET_BIZ)}&mid=1&idx=1`,
    timestamp: 1790000000,
  };
  const success = {
    ret: -1,
    content: {
      ret: 0,
      data: [{ items: [item, { source: { title: '其他号' } }] }],
      continueFlag: 1,
      offset: 18,
      searchID: 'test',
      conversationID: 'test',
    },
  };
  let test = await run(success);
  assert.equal(test.calls, 1);
  assert.equal(test.result.decision, 'first_page_observed');
  assert.equal(test.result.outerRet, -1);
  assert.equal(test.result.sourceTitleExactMatches, 1);
  assert.equal(test.result.explicitTargetBizUrlMatches, 1);
  const cleaned = sanitizedSummary({
    ...test.result,
    rawHtml: '<private>',
    cookie: '<private>',
  });
  assert.equal(cleaned.sourceTitleExactMatches, 1);
  assert.equal(Object.hasOwn(cleaned, 'rawHtml'), false);
  assert.equal(Object.hasOwn(cleaned, 'cookie'), false);
  test = await run({ errCode: -2010 });
  assert.equal(test.result.decision, 'stop_auth_expired');
  test = await run({ ret: -1 });
  assert.equal(test.result.decision, 'stop_structure');
  test = await run(null, { isJson: false });
  assert.equal(test.result.decision, 'stop_non_json_or_verification');
  test = await run(success, { status: 429 });
  assert.equal(test.result.decision, 'stop_http_or_redirect');
  test = await run(success, { origin: 'https://example.com' });
  assert.equal(test.calls, 0);
  assert.equal(test.result.decision, 'stop_origin_mismatch');
  assert.throws(() => localCdpUrl('https://remote.example:9222/'));
  console.log(
    JSON.stringify({ selfTest: 'passed', cases: 8, targetRequests: 0 }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length === 1 && args[0] === '--plan') {
    console.log(
      JSON.stringify({
        targetRequestLimit: 1,
        method: 'POST',
        endpoint: ENDPOINT,
        bodyKeys: ['query'],
        credentialSource: 'existing_authenticated_browser_context',
        retries: 0,
        pages: 1,
        rawResponseSaved: false,
      }),
    );
    return;
  }
  if (
    !args.includes('--execute') ||
    !args.includes('--confirmed-authenticated')
  ) {
    throw new Error(
      'live use requires --execute and --confirmed-authenticated',
    );
  }
  const cdpArg = args.find((arg) => arg.startsWith('--cdp='));
  if (!cdpArg)
    throw new Error('live use requires --cdp=http://127.0.0.1:<port>/');
  const tabArg = args.find((arg) => arg.startsWith('--tab-id='));
  if (typeof WebSocket !== 'function')
    throw new Error('Node runtime has no WebSocket client');
  const cdp = localCdpUrl(cdpArg.slice('--cdp='.length));
  const socketUrl = await existingWereadTab(
    cdp,
    tabArg?.slice('--tab-id='.length),
  );
  const summary = await evaluateOnce(socketUrl, pageExpression());
  console.log(JSON.stringify(sanitizedSummary(summary)));
}

if (require.main === module) {
  main().catch((error) => {
    // Do not print raw browser, HTTP, or CDP error bodies.
    console.error(
      JSON.stringify({
        stopped: true,
        reason: 'local_preflight_or_cdp_failure',
        errorType: error?.name || 'Error',
        targetRequests: 'unknown_or_zero',
      }),
    );
    process.exitCode = 1;
  });
}

module.exports = { pageProbe, pageExpression, localCdpUrl, sanitizedSummary };
