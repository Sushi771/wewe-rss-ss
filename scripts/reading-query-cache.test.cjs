'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve('apps/web');
const ts = require(require.resolve('typescript', { paths: [web] }));
const { QueryClient, QueryObserver } = require(
  require.resolve('@tanstack/react-query', { paths: [web] }),
);
const loaded = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync('apps/web/src/utils/reading-query-cache.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
  { module: loaded, exports: loaded.exports },
);
const { installReadingCacheBudget } = loaded.exports;
const key = (name, input) => [['article', name], { input, type: 'infinite' }];
function client() {
  const query = new QueryClient({
    defaultOptions: { queries: { cacheTime: 60000, retry: false } },
  });
  installReadingCacheBudget(query);
  return query;
}
test('retains complete cursor chains, separates filters and preserves invalidation', async () => {
  const query = client();
  try {
    const all = key('list', {}),
      filtered = key('list', { search: 'x' });
    const pages = {
      pages: [{ items: ['a'], nextCursor: 'b' }, { items: ['b'] }],
      pageParams: [undefined, 'b'],
    };
    query.setQueryData(all, pages);
    query.setQueryData(filtered, {
      pages: [{ items: ['x'] }],
      pageParams: [undefined],
    });
    assert.equal(query.getQueryData(all), pages);
    await query.invalidateQueries({ queryKey: [['article', 'list']] });
    assert.equal(query.getQueryState(all).isInvalidated, true);
    assert.equal(query.getQueryState(filtered).isInvalidated, true);
    assert.equal(query.getQueryData(all), pages);
  } finally {
    query.clear();
  }
});
test('caps inactive pages, query count and saved-body bytes without evicting observed data', () => {
  const query = client();
  try {
    const activeKey = key('byId', 'large-active');
    const observer = new QueryObserver(query, {
      queryKey: activeKey,
      enabled: false,
    });
    const stop = observer.subscribe(() => {});
    const large = { contentHtml: 'x'.repeat(2 * 1024 * 1024) };
    query.setQueryData(activeKey, large);
    assert.equal(query.getQueryData(activeKey), large);
    for (let i = 0; i < 8; i++)
      query.setQueryData(key('list', i), {
        pages: [{}, {}, {}],
        pageParams: [0, 1, 2],
      });
    const retained = query
      .getQueryCache()
      .getAll()
      .filter((q) => !q.getObserversCount());
    assert.equal(retained.length, 4);
    assert.equal(
      retained.reduce((n, q) => n + q.state.data.pages.length, 0),
      12,
    );
    stop();
    assert.equal(
      query.getQueryData(activeKey),
      undefined,
      'oversized body is released when its reader detaches',
    );
    for (let i = 0; i < 20; i++)
      query.setQueryData(key('summary', i), { articles: i });
    assert(query.getQueryCache().getAll().length <= 12);
    query.setQueryData(key('byId', 'oversized'), large);
    assert.equal(query.getQueryData(key('byId', 'oversized')), undefined);
    query.setQueryData(['unrelated'], large);
    assert.equal(query.getQueryData(['unrelated']), large);
  } finally {
    query.clear();
  }
});

test('unobserved in-flight results cannot retain oversized cached bodies', async () => {
  const query = client();
  let done;
  try {
    const id = key('byId', 'background');
    const observer = new QueryObserver(query, { queryKey: id, enabled: false });
    const stop = observer.subscribe(() => {});
    query.setQueryData(id, { contentHtml: 'x'.repeat(2 * 1024 * 1024) });
    const request = query
      .fetchQuery({
        queryKey: id,
        queryFn: () =>
          new Promise((resolve) => {
            done = resolve;
          }),
      })
      .catch(() => undefined);
    const detached = query.getQueryCache().find(id);
    stop();
    assert.equal(query.getQueryData(id), undefined);
    assert.equal(
      detached.state.data,
      undefined,
      'eviction releases orphaned in-flight body immediately',
    );
    done({ contentHtml: 'unused' });
    await request;
    assert.equal(
      query.getQueryData(id),
      undefined,
      'late response cannot recreate an evicted view',
    );
  } finally {
    done?.({});
    query.clear();
  }
});
