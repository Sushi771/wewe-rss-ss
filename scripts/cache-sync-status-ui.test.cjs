'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
function render(feed, isError = false, extra = {}) {
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
                    return { isError, data: { feeds: [feed], ...extra } };
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
  assert.equal(f.options.refetchInterval, 5000);
  assert.equal(f.options.refetchIntervalInBackground, false);
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
test('automatic media failures, finite retry and operational pause remain visible', () => {
  const media = [
    {
      feedId: 'A',
      pending: 2,
      failed: 1,
      unconfirmed: 1,
      attempts: 3,
      nextRetryAt: '2026-10-11T12:30:00Z',
      code: 'MEDIA_RETRY_EXHAUSTED',
    },
  ];
  const view = render(feed, false, { media, mediaPause: 'disabled' });
  assert.match(
    view.text,
    /图片补齐失败 1 篇.*MEDIA_RETRY_EXHAUSTED.*媒体未确认 1 篇.*图片待补 2 篇.*已尝试 3\/4.*自动图片下载已关闭/,
  );
  assert.match(
    render(feed, false, { media, mediaFailure: 'IMAGE_REQUEST_BLOCKED' }).text,
    /图片补齐暂停.*IMAGE_REQUEST_BLOCKED/,
  );
  assert.match(
    render({ ...feed, feedId: 'B' }, false, {
      mediaFailure: 'MEDIA_WORKER_UNAVAILABLE',
    }).text,
    /图片补齐暂停.*MEDIA_WORKER_UNAVAILABLE/,
  );
});
