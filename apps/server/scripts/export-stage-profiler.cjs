/* Opt-in synthetic benchmark instrumentation. No paths, IDs or content retained. */
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { promises: fs } = require('node:fs');

exports.exportStageProfiler = (Store) => {
  if (process.env.EXPORT_STAGE_PROFILE !== '1')
    return { start() {}, finish: () => undefined };
  const context = new AsyncLocalStorage();
  let events = [],
    totals = {},
    started,
    enabled = false,
    overflow = false;
  const begin = (label) => {
    if (!enabled) return;
    const parent = context.getStore();
    return { label, start: performance.now(), depth: (parent?.depth || 0) + 1 };
  };
  const end = (span) => {
    if (!span) return;
    span.end = performance.now();
    const total = (totals[span.label] ||= { calls: 0, inclusiveMs: 0 });
    total.calls++;
    total.inclusiveMs += span.end - span.start;
    if (events.length < 200000) events.push(span);
    else overflow = true;
  };
  const asyncWrap = (owner, name, label) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = async function (...args) {
      const span = begin(label);
      if (!span) return original.apply(this, args);
      return context.run(span, async () => {
        try {
          return await original.apply(this, args);
        } finally {
          end(span);
        }
      });
    };
  };
  for (const name of [
    'withRetainedBatch',
    'acquireSaveLock',
    'saveInternal',
    'findRetainedArticle',
    'buildRetainedIndex',
    'readSourceReceipt',
    'readLegacyRetained',
    'savePrepared',
    'publishSourcedArticle',
    'sourceDirectory',
    'createSourceDirectory',
  ])
    asyncWrap(Store.prototype, name, 'store.' + name);
  for (const name of [
    'lstat',
    'stat',
    'readFile',
    'writeFile',
    'readdir',
    'opendir',
    'mkdir',
    'rename',
    'link',
    'unlink',
    'copyFile',
    'rm',
  ])
    asyncWrap(fs, name, 'fs.' + name);
  const articleExport = require('../src/article-export');
  asyncWrap(articleExport, 'buildArticleMarkdown', 'body.markdownAndImages');
  const media = require('../src/cached-article-media-analysis');
  const original = media.cachedArticleMediaAnalysis;
  media.cachedArticleMediaAnalysis = function (...args) {
    const span = begin('body.mediaFacts');
    try {
      return original.apply(this, args);
    } finally {
      end(span);
    }
  };
  return {
    start() {
      events = [];
      totals = {};
      overflow = false;
      started = performance.now();
      enabled = true;
    },
    finish() {
      const elapsedMs = performance.now() - started;
      enabled = false;
      // Exclusive wall-time partition: overlapping asynchronous spans count once,
      // deepest span wins. Inclusive method/FS totals must not be added together.
      const edges = events
        .flatMap((event, id) => [
          { time: event.start, id, add: true },
          { time: event.end, id, add: false },
        ])
        .sort((a, b) => a.time - b.time || Number(a.add) - Number(b.add));
      const active = new Map(),
        exclusiveMs = {};
      let previous = started;
      for (const edge of edges) {
        let current;
        for (const event of active.values())
          if (!current || event.depth > current.depth) current = event;
        const label = current?.label || 'other';
        exclusiveMs[label] = (exclusiveMs[label] || 0) + edge.time - previous;
        if (edge.add) active.set(edge.id, events[edge.id]);
        else active.delete(edge.id);
        previous = edge.time;
      }
      exclusiveMs.other =
        (exclusiveMs.other || 0) + started + elapsedMs - previous;
      return { elapsedMs, overflow, exclusiveMs, totals };
    },
  };
};
