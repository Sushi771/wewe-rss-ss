'use strict';
// Offline actual component rendering; no platform, database or browser calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const { loadActualTs } = require('./offline-ts-fixture.cjs');
const metrics = JSON.stringify({
  read: { display: '123' },
  like: { display: '8' },
  favorite: { display: '3' },
});
const article = (mpId, channel, raw = metrics) => ({
  id: `article-${mpId}`,
  mpId,
  title: `合成文章-${mpId}`,
  metrics: raw,
  feed: { mpName: `合成号-${mpId}`, collectionChannel: channel },
  bodyCached: true,
  bodyRetry: { allowed: false, reason: '合成状态' },
  publishTime: 1,
});
const failedRetry = {
  status: 'failed',
  filled: false,
  cached: false,
  attemptedAt: 1700000000,
  message: '原文请求失败；缓存保留。',
  requestFailure: { reason: 'http_status', httpStatus: 302 },
};
test('actual list rendering shows current availability and keeps retry history out of row UI after reload', () => {
  const item = {
    ...article('paid', 'wechat2rss'),
    bodyRetryResult: failedRetry,
  };
  for (const row of [item, JSON.parse(JSON.stringify(item))]) {
    const view = fixture({ items: [row] }).render();
    assert.match(view.text, /正文已缓存，可阅读/);
    assert.doesNotMatch(
      JSON.stringify(view.nodes),
      /上次原文重试|HTTP 302|原文请求失败|1700000000/,
    );
    assert(
      !view.nodes.some((node) =>
        node.props['aria-label']?.startsWith('重试正文：'),
      ),
    );
  }
});
test('actual list rendering keeps missing-cache actions available and hides historical success and failure', () => {
  const item = {
    ...article('paid', 'wechat2rss'),
    bodyCached: false,
    bodyRetryResult: failedRetry,
    bodyRetry: { allowed: true, reason: '' },
  };
  const missing = fixture({ items: [item] }).render();
  assert.match(missing.text, /正文未缓存/);
  assert.doesNotMatch(missing.text, /上次原文重试|HTTP 302/);
  assert(
    missing.nodes.some(
      (node) =>
        node.props['aria-label']?.startsWith('重试正文：') &&
        !node.props.isDisabled,
    ),
  );
  const ready = fixture({
    items: [
      {
        ...item,
        bodyCached: true,
        bodyRetryResult: { ...failedRetry, status: 'available', filled: true },
      },
    ],
  }).render();
  assert.match(ready.text, /正文已缓存，可阅读/);
  assert.doesNotMatch(ready.text, /上次原文重试|已补入正文|HTTP 302/);
});
test('current failed user retry gives a concise toast without publishing audit details into the row', async () => {
  const item = {
    ...article('paid', 'wechat2rss'),
    bodyCached: false,
    bodyRetryResult: failedRetry,
    bodyRetry: { allowed: true, reason: '' },
  };
  const before = JSON.stringify(item);
  const current = fixture({
    items: [item],
    retryResult: { ...failedRetry, message: 'HTTP 302 Cookie=SECRET' },
  });
  const button = current
    .render()
    .nodes.find((node) => node.props['aria-label']?.startsWith('重试正文：'));
  await button.props.onPress();
  assert.equal(current.toasts.length, 1);
  assert.equal(current.toasts[0].kind, 'error');
  assert.match(current.toasts[0].message, /正文重试失败/);
  assert.doesNotMatch(current.toasts[0].message, /HTTP|Cookie|SECRET/);
  assert.doesNotMatch(current.render().text, /上次原文重试|HTTP/);
  assert.equal(JSON.stringify(item), before);
});
function fixture({
  mpId = 'paid',
  items = [article('paid', 'wechat2rss')],
  channels = { paid: 'wechat2rss', native: 'owner-weread-latest' },
  readAvailable = 1,
  likeAvailable = 1,
  retryResult = { status: 'available' },
} = {}) {
  const toasts = [];
  const state = [],
    params = { id: mpId };
  let cursor = 0,
    query,
    sort = 'publishTime',
    direction = 'desc';
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      return [
        state[i],
        (v) => {
          state[i] = typeof v === 'function' ? v(state[i]) : v;
        },
      ];
    },
    useMemo: (fn) => fn(),
    useRef(initial) {
      const i = cursor++;
      return (state[i] ||= { current: initial });
    },
    useCallback: (fn) => fn,
    useEffect() {},
    useLayoutEffect() {},
  };
  const trpc = {
    useUtils: () => ({
      article: {
        list: { invalidate: async () => {} },
        summary: { invalidate: async () => {} },
        byId: { invalidate: async () => {} },
      },
    }),
    article: {
      byId: { useQuery: () => ({}) },
      retryBody: {
        useMutation: () => ({
          isLoading: false,
          mutateAsync: async () => retryResult,
        }),
      },
      summary: {
        useQuery: () => ({
          data: {
            articles: items.length,
            cachedBodies: items.length,
            readAvailable,
            likeAvailable,
          },
        }),
      },
      list: {
        useInfiniteQuery(input) {
          query = input;
          return {
            data: { pages: [{ items }] },
            isLoading: false,
            isError: false,
            hasNextPage: false,
          };
        },
      },
    },
  };
  const modules = {
    '@web/utils/article-body-state': loadActualTs(
      'apps/web/src/utils/article-body-state.ts',
    ),
    '@web/utils/feed-selection': loadActualTs(
      'apps/web/src/utils/feed-selection.ts',
    ),
    '@wewe-rss/shared': loadActualTs(
      'packages/shared/src/article-date-filter.ts',
    ),
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@nextui-org/react': new Proxy({}, { get: (_, key) => key }),
    '@web/utils/trpc': { trpc },
    '@web/components/ArticleReader': { default: 'ArticleReader' },
    // Metric visibility is independent of scroll restoration.
    '@web/utils/use-article-list-position': {
      useArticleListPosition: () => ({
        scrollRef: { current: null },
        capturePosition() {},
        cancelRestore() {},
        rememberForReader() {},
        restoreAfterReader() {},
      }),
    },
    'react-router-dom': { useParams: () => params },
    dayjs: { default: () => ({ format: () => '合成日期' }) },
    sonner: {
      toast: Object.fromEntries(
        ['success', 'error', 'warning'].map((kind) => [
          kind,
          (message) => toasts.push({ kind, message }),
        ]),
      ),
    },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(
    fs.readFileSync('apps/web/src/pages/feeds/list.tsx', 'utf8'),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === '@web/utils/reading-query-cache')
        return { READING_CACHE_TIME: 60000 };
      assert(name in modules, name);
      return modules[name];
    },
  });
  function render() {
    cursor = 0;
    const nodes = [],
      text = [];
    function visit(n) {
      if (Array.isArray(n)) return n.forEach(visit);
      if (typeof n === 'string' || typeof n === 'number') {
        text.push(String(n));
        return;
      }
      if (!n || typeof n !== 'object') return;
      nodes.push(n);
      visit(n.props.children);
    }
    visit(
      module.exports.default({
        search: '',
        sort,
        onSortChange(value) {
          sort = value;
        },
        direction,
        onDirectionChange(value) {
          direction = value;
        },
        selectedIds: new Set(),
        onSelectionChange() {},
        collectionChannels: channels,
      }),
    );
    return {
      nodes,
      text: text.join(''),
      options: nodes
        .filter(
          (n) =>
            n.type === 'option' && !['asc', 'desc'].includes(n.props.value),
        )
        .map((n) => n.props.value),
      metricRows: nodes.filter((n) => n.props.title?.startsWith('指标来自')),
    };
  }
  return {
    render,
    toasts,
    params,
    get query() {
      return query;
    },
  };
}
test('Wechat2RSS hides historical metric values, coverage notices and heat sorting', () => {
  const h = fixture();
  const view = h.render();
  assert.deepEqual(view.options, ['publishTime']);
  assert.equal(view.metricRows.length, 0);
  assert(!/阅读已获取|点赞已获取|未获取|热度|收藏/.test(view.text));
  assert.match(view.text, /文章标题 · 1 篇/);
  assert(!view.text.includes('存量详情'));
  assert.equal(h.query.sort, 'publishTime');
});
test('effective route mapping hides metrics even when old stored channel is empty', () => {
  const h = fixture({ items: [article('paid', null)] });
  assert.equal(h.render().metricRows.length, 0);
});
test('supported source retains its real values and available metric sorting', () => {
  const view = fixture({
    mpId: 'native',
    items: [article('native', 'owner-weread-latest')],
  }).render();
  assert.deepEqual(view.options, ['publishTime', 'readCount', 'likeCount']);
  assert.equal(view.metricRows.length, 1);
  assert.match(view.text, /阅读 123/);
  assert.match(view.text, /收藏 3/);
});
test('empty metric sorts are absent rather than disabled placeholders', () => {
  const view = fixture({
    mpId: 'native',
    items: [article('native', 'owner-weread-latest')],
    readAvailable: 0,
    likeAvailable: 0,
  }).render();
  assert.deepEqual(view.options, ['publishTime']);
  assert(!/热度排序已禁用|从高到低（未获取）/.test(view.text));
});
test('mixed overview keeps supported rows but omits unsupported aggregate coverage and ranking', () => {
  const items = [
    article('paid', 'wechat2rss'),
    article('native', 'owner-weread-latest'),
  ];
  const before = JSON.stringify(items);
  const view = fixture({ mpId: '', items }).render();
  assert.equal(view.metricRows.length, 1);
  assert.deepEqual(view.options, ['publishTime']);
  assert(!/阅读已获取|点赞已获取/.test(view.text));
  assert.equal(JSON.stringify(items), before);
});
test('switching from real heat sorting to Wechat2RSS forces the query to publication time immediately', () => {
  const h = fixture({
    mpId: 'native',
    items: [article('native', 'owner-weread-latest')],
  });
  h.render()
    .nodes.find((n) => n.props['aria-label'] === '文章排序')
    .props.onChange({ target: { value: 'readCount' } });
  h.render();
  assert.equal(h.query.sort, 'readCount');
  h.params.id = 'paid';
  h.render();
  assert.equal(h.query.sort, 'publishTime');
});
