'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
function render(feed, isError = false) {
  const module = { exports: {} };
  let options;
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync('apps/web/src/pages/feeds/cache-sync-status.tsx', 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
      },
    ).outputText,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name === 'react/jsx-runtime')
          return {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
          };
        if (name === '@web/utils/trpc')
          return {
            trpc: {
              feed: {
                cacheSyncStatus: {
                  useQuery: (_, opts) => {
                    options = opts;
                    return { isError, data: { feeds: [feed] } };
                  },
                },
              },
            },
          };
        if (name === 'dayjs') return () => ({ format: () => '10-11 12:30' });
        throw Error(name);
      },
    },
  );
  const tree = module.exports.default({ feedId: 'A' });
  return {
    tree,
    options,
    text: tree ? [tree.props.children].flat().join('') : '',
  };
}
const feed = {
  feedId: 'A',
  upstreamCheckTime: null,
  nextUpdateTime: null,
  paused: null,
  state: 'waiting',
};
test('unknown check time and waiting cache never claim update completion', () => {
  const f = render(feed);
  assert.match(f.text, /上游检查未确认.*等待缓存变化/);
  assert.doesNotMatch(f.text, /完成|成功/);
  assert.equal(f.options.refetchInterval, undefined);
  assert.equal(f.options.retry, false);
});
test('check timestamp and synced old cache remain distinct from current collection completion', () => {
  const f = render({
    ...feed,
    upstreamCheckTime: '2026-10-11T12:30:00Z',
    state: 'synced-cache',
  });
  assert.match(f.text, /上游最近检查.*现存缓存已同步/);
  assert.doesNotMatch(f.text, /完成|成功/);
});
test('paused, media pending and failed diagnostic reads report their actual state', () => {
  assert.match(
    render({ ...feed, paused: true, state: 'synced-cache' }).text,
    /上游已暂停/,
  );
  assert.match(
    render({ ...feed, state: 'media-pending' }).text,
    /正文图片待核/,
  );
  assert.match(
    render({ ...feed, state: 'unavailable' }).text,
    /缓存检查未完成/,
  );
  assert.match(render(feed, true).text, /暂无法读取/);
});
test('one feed diagnostic cannot label another feed as updating', () => {
  assert.equal(render({ ...feed, feedId: 'B', paused: true }).tree, null);
});
