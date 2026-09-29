#!/usr/bin/env node
'use strict';

// Offline-first, one-action research probe for an already open official search
// page. It never navigates, sends a search request, clicks a card, or reads cookies.

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { localCdpUrl } = require('./probe-web-search-broker.cjs');

const QUERY = '妈妈部落畅聊阁';
const ORIGIN = 'https://search.weixin.qq.com';
const SCROLL_KEY = '__codexWereadFirstScrollProbe';

function queryInUrl(raw) {
  const url = new URL(raw);
  if (url.origin !== ORIGIN)
    return { allowed: false, reason: 'origin_mismatch' };
  const hashQuery = url.hash.includes('?')
    ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1))
    : null;
  const found =
    url.searchParams.get('query') ?? hashQuery?.get('query') ?? null;
  if (found !== null && found !== QUERY)
    return { allowed: false, reason: 'query_mismatch' };
  return { allowed: true, queryVisibleInUrl: found === QUERY };
}

function pageSnapshot(phase) {
  const key = '__codexWereadFirstScrollProbe';
  const restrictionSelector = [
    'iframe[src*="captcha"]',
    '[class*="captcha"]',
    '[id*="captcha"]',
    '[class*="verify"]',
    '[id*="verify"]',
  ].join(',');
  const restrictionWords =
    /请完成安全验证|访问过于频繁|操作过于频繁|请输入验证码/;
  const bodyText = document.body?.innerText || '';
  const restrictionSuspected =
    Boolean(document.querySelector(restrictionSelector)) ||
    restrictionWords.test(bodyText);
  const cards = [...document.querySelectorAll('.search_list_item')].map(
    (node) => ({
      dataId: node.getAttribute('data-id') || '',
      source: (node.querySelector('.source__title')?.textContent || '').trim(),
      date: (
        node.querySelector('.source__text.date')?.textContent || ''
      ).trim(),
    }),
  );
  const scrollHeight = Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement?.scrollHeight || 0,
  );
  let scrollEventObserved = false;
  if (
    phase === 'initial' &&
    location.origin === 'https://search.weixin.qq.com' &&
    !restrictionSuspected &&
    cards.length > 0 &&
    cards.length <= 30 &&
    Math.abs(window.scrollY) <= 5 &&
    scrollHeight > window.innerHeight &&
    !window[key]
  ) {
    const state = { count: 0, listener: null };
    state.listener = () => {
      state.count += 1;
    };
    window.addEventListener('scroll', state.listener, { passive: true });
    window[key] = state;
  }
  if (phase === 'final' && window[key]) {
    scrollEventObserved = window[key].count > 0;
    window.removeEventListener('scroll', window[key].listener);
    delete window[key];
  }
  return {
    origin: location.origin,
    restrictionSuspected,
    scrollEventObserved,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollHeight,
    cards,
  };
}

function dateShape(text) {
  if (!text) return 'absent';
  if (/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(text))
    return 'absolute_date_like';
  if (/昨天|今天|刚刚|前|小时前|分钟前|天前|周前|月前/.test(text))
    return 'relative_date_like';
  return 'other_text';
}

function summarize(initial, final) {
  const base = {
    targetNavigationsByProbe: 0,
    scrollActions: final ? 1 : 0,
    backendRequestCount: 'not_observed',
    credentialSource: 'existing_authenticated_browser_page',
    firstPage: null,
    firstScrollIncrement: null,
  };
  if (initial.origin !== ORIGIN)
    return { ...base, decision: 'stop_origin_mismatch' };
  if (initial.restrictionSuspected)
    return { ...base, decision: 'stop_possible_verification' };
  if (initial.cards.length === 0)
    return { ...base, decision: 'stop_no_first_page_cards' };
  if (initial.cards.length > 30 || Math.abs(initial.scrollY) > 5) {
    return { ...base, decision: 'stop_not_first_page' };
  }
  if (initial.scrollHeight <= initial.viewportHeight) {
    return { ...base, decision: 'stop_no_scrollable_page' };
  }
  const initialIds = new Set(
    initial.cards.map((card) => card.dataId).filter(Boolean),
  );
  const page = cardShape(initial.cards);
  if (!final)
    return { ...base, firstPage: page, decision: 'ready_for_single_scroll' };
  if (final.origin !== ORIGIN) {
    return { ...base, firstPage: page, decision: 'stop_origin_changed' };
  }
  if (final.restrictionSuspected) {
    return {
      ...base,
      firstPage: page,
      decision: 'stop_possible_verification_after_scroll',
    };
  }
  const newCards = final.cards.filter(
    (card) => card.dataId && !initialIds.has(card.dataId),
  );
  const increment = cardShape(newCards);
  return {
    ...base,
    firstPage: page,
    firstScrollIncrement: increment,
    finalVisibleCardCount: final.cards.length,
    visibleCardCountDelta: final.cards.length - initial.cards.length,
    actualScrollEventObserved: final.scrollEventObserved,
    decision: !final.scrollEventObserved
      ? 'scroll_event_not_observed'
      : increment.uniqueDataIdCount === 0
        ? 'no_increment_observed'
        : 'first_increment_observed',
  };
}

function cardShape(cards) {
  const dateShapes = {
    absent: 0,
    absolute_date_like: 0,
    relative_date_like: 0,
    other_text: 0,
  };
  for (const card of cards) dateShapes[dateShape(card.date)] += 1;
  return {
    cardCount: cards.length,
    dataIdPresentCount: cards.filter((card) => Boolean(card.dataId)).length,
    uniqueDataIdCount: new Set(cards.map((card) => card.dataId).filter(Boolean))
      .size,
    exactSourceNameCount: cards.filter((card) => card.source === QUERY).length,
    dateShapes,
  };
}

function checkedSummary(value) {
  // Reconstruct all output fields from a whitelist; raw DOM values never print.
  const safeShape = (shape) =>
    shape && {
      cardCount: Number(shape.cardCount),
      dataIdPresentCount: Number(shape.dataIdPresentCount),
      uniqueDataIdCount: Number(shape.uniqueDataIdCount),
      exactSourceNameCount: Number(shape.exactSourceNameCount),
      dateShapes: Object.fromEntries(
        [
          'absent',
          'absolute_date_like',
          'relative_date_like',
          'other_text',
        ].map((key) => [key, Number(shape.dateShapes[key])]),
      ),
    };
  if (!/^[a-z_]+$/.test(value.decision)) throw new Error('invalid decision');
  return {
    targetNavigationsByProbe: value.targetNavigationsByProbe,
    scrollActions: value.scrollActions,
    backendRequestCount: 'not_observed',
    credentialSource: 'existing_authenticated_browser_page',
    firstPage: safeShape(value.firstPage),
    firstScrollIncrement: safeShape(value.firstScrollIncrement),
    finalVisibleCardCount: Number.isFinite(value.finalVisibleCardCount)
      ? value.finalVisibleCardCount
      : null,
    visibleCardCountDelta: Number.isFinite(value.visibleCardCountDelta)
      ? value.visibleCardCountDelta
      : null,
    actualScrollEventObserved: value.actualScrollEventObserved === true,
    decision: value.decision,
  };
}

async function existingTargetTab(cdp, tabId) {
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
      return queryInUrl(tab.url).allowed && (!tabId || tab.id === tabId);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1)
    throw new Error('expected exactly one existing official search tab');
  const pageUrl = new URL(matches[0].url);
  const socketUrl = new URL(matches[0].webSocketDebuggerUrl);
  if (
    pageUrl.origin !== ORIGIN ||
    socketUrl.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost'].includes(socketUrl.hostname) ||
    socketUrl.port !== cdp.port ||
    !socketUrl.pathname.startsWith('/devtools/page/')
  ) {
    throw new Error('CDP search page socket has an unexpected shape');
  }
  return {
    socketUrl: socketUrl.href,
    queryVisibleInUrl: queryInUrl(matches[0].url).queryVisibleInUrl,
  };
}

function cdpSession(socketUrl) {
  const socket = new WebSocket(socketUrl);
  let nextId = 0;
  const pending = new Map();
  const failPending = () => {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('CDP socket failed'));
    }
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error || message.result?.exceptionDetails)
      job.reject(new Error('CDP command failed'));
    else job.resolve(message.result);
  });
  socket.addEventListener('error', failPending);
  socket.addEventListener('close', failPending);
  async function command(method, params) {
    if (socket.readyState > WebSocket.OPEN)
      throw new Error('CDP socket closed');
    if (socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('CDP socket timed out')),
          5000,
        );
        socket.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          'error',
          () => {
            clearTimeout(timer);
            reject(new Error('CDP socket failed'));
          },
          { once: true },
        );
        socket.addEventListener(
          'close',
          () => {
            clearTimeout(timer);
            reject(new Error('CDP socket closed'));
          },
          { once: true },
        );
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP command timed out'));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  return { command, close: () => socket.close() };
}

async function readSnapshot(session, phase) {
  const expression = `(${pageSnapshot.toString()})(${JSON.stringify(phase)})`;
  const result = await session.command('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  const value = result?.result?.value;
  if (!value || !Array.isArray(value.cards))
    throw new Error('CDP snapshot unavailable');
  return value;
}

async function execute(cdp, tabId) {
  const tab = await existingTargetTab(cdp, tabId);
  const session = cdpSession(tab.socketUrl);
  let scrollActions = 0;
  try {
    const initial = await readSnapshot(session, 'initial');
    const ready = summarize(initial, null);
    if (ready.decision !== 'ready_for_single_scroll')
      return checkedSummary(ready);
    // One browser wheel action; no synthetic scroll event or retry.
    scrollActions = 1;
    await session.command('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.min(500, Math.max(20, initial.viewportWidth / 2)),
      y: Math.min(500, Math.max(20, initial.viewportHeight / 2)),
      deltaX: 0,
      deltaY: 20000,
      pointerType: 'mouse',
    });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const final = await readSnapshot(session, 'final');
    return checkedSummary(summarize(initial, final));
  } catch {
    try {
      await session.command('Runtime.evaluate', {
        expression: `(() => { const state = window[${JSON.stringify(SCROLL_KEY)}]; if (state) { window.removeEventListener('scroll', state.listener); delete window[${JSON.stringify(SCROLL_KEY)}]; } })()`,
      });
    } catch {
      /* A closed CDP socket needs no further action. */
    }
    return {
      targetNavigationsByProbe: 0,
      scrollActions,
      backendRequestCount: 'not_observed',
      decision: 'stop_cdp_or_snapshot_error',
    };
  } finally {
    session.close();
  }
}

function selfTest() {
  const cards = [
    { dataId: 'a', source: QUERY, date: '2025-09-01' },
    { dataId: 'b', source: '其他号', date: '昨天' },
  ];
  const initial = {
    origin: ORIGIN,
    restrictionSuspected: false,
    scrollY: 0,
    viewportWidth: 1200,
    viewportHeight: 900,
    scrollHeight: 1800,
    cards,
  };
  const final = {
    ...initial,
    scrollEventObserved: true,
    cards: [...cards, { dataId: 'c', source: QUERY, date: '3 天前' }],
  };
  let result = summarize(initial, final);
  assert.equal(result.decision, 'first_increment_observed');
  assert.equal(result.firstPage.cardCount, 2);
  assert.equal(result.firstScrollIncrement.uniqueDataIdCount, 1);
  assert.equal(result.firstScrollIncrement.exactSourceNameCount, 1);
  assert.equal(result.visibleCardCountDelta, 1);
  assert.equal(result.firstPage.dateShapes.absolute_date_like, 1);
  assert.equal(
    summarize(initial, { ...final, scrollEventObserved: false }).decision,
    'scroll_event_not_observed',
  );
  assert.equal(
    summarize(initial, { ...final, cards }).decision,
    'no_increment_observed',
  );
  assert.equal(
    summarize({ ...initial, restrictionSuspected: true }, null).decision,
    'stop_possible_verification',
  );
  assert.equal(
    summarize({ ...initial, scrollY: 200 }, null).decision,
    'stop_not_first_page',
  );
  assert.equal(
    queryInUrl('https://search.weixin.qq.com/?query=%E5%85%B6%E4%BB%96')
      .allowed,
    false,
  );
  assert.equal(queryInUrl('https://example.com/').allowed, false);
  assert.equal(queryInUrl('https://search.weixin.qq.com/').allowed, true);
  assert.throws(() => localCdpUrl('http://remote.example:9222/'));
  const cleaned = checkedSummary({
    ...result,
    cookie: 'private',
    rawHtml: 'private',
  });
  assert.equal(Object.hasOwn(cleaned, 'cookie'), false);
  assert.equal(Object.hasOwn(cleaned, 'rawHtml'), false);
  const mockPage = {
    location: { origin: ORIGIN },
    window: {
      scrollY: 0,
      innerWidth: 1200,
      innerHeight: 900,
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      body: { innerText: '', scrollHeight: 1800 },
      documentElement: { scrollHeight: 1800 },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };
  assert.equal(
    vm.runInNewContext(`(${pageSnapshot.toString()})('initial')`, mockPage)
      .cards.length,
    0,
  );
  console.log(
    JSON.stringify({
      selfTest: 'passed',
      assertions: 17,
      targetRequests: 0,
      scrollActions: 0,
    }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length === 1 && args[0] === '--plan') {
    console.log(
      JSON.stringify({
        targetNavigationsByProbe: 0,
        scrollActionsMax: 1,
        backendRequestCount: 'page_controlled_not_observed',
        snapshots: 2,
        articleClicks: 0,
        credentialSource: 'existing_authenticated_browser_page',
        rawResponseSaved: false,
        retries: 0,
      }),
    );
    return;
  }
  if (
    !args.includes('--execute') ||
    !args.includes('--confirmed-authenticated') ||
    !args.includes('--confirmed-target-page')
  ) {
    throw new Error('live use requires authenticated target page confirmation');
  }
  const cdpArg = args.find((arg) => arg.startsWith('--cdp='));
  if (!cdpArg)
    throw new Error('live use requires an explicit localhost CDP address');
  if (typeof WebSocket !== 'function')
    throw new Error('Node runtime has no WebSocket client');
  const cdp = localCdpUrl(cdpArg.slice('--cdp='.length));
  const tabArg = args.find((arg) => arg.startsWith('--tab-id='));
  console.log(
    JSON.stringify(await execute(cdp, tabArg?.slice('--tab-id='.length))),
  );
}

if (require.main === module) {
  main().catch(() => {
    console.error(
      JSON.stringify({
        stopped: true,
        reason: 'local_preflight_failure',
        targetNavigationsByProbe: 0,
        scrollActions: 0,
      }),
    );
    process.exitCode = 1;
  });
}

module.exports = { queryInUrl, pageSnapshot, summarize, checkedSummary };
