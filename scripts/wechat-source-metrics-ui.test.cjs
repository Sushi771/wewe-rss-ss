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
function fixture({
  mpId = 'paid',
  items = [article('paid', 'wechat2rss')],
  channels = { paid: 'wechat2rss', native: 'owner-weread-latest' },
  readAvailable = 1,
  likeAvailable = 1,
} = {}) {
  const state = [],
    params = { id: mpId };
  let cursor = 0,
    query;
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
    useEffect() {},
  };
  const trpc = {
    useUtils: () => ({}),
    article: {
      byId: { useQuery: () => ({}) },
      retryBody: { useMutation: () => ({ isLoading: false }) },
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
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@nextui-org/react': new Proxy({}, { get: (_, key) => key }),
    '@web/utils/trpc': { trpc },
    'react-router-dom': { useParams: () => params },
    dayjs: { default: () => ({ format: () => '合成日期' }) },
    sonner: { toast: {} },
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
        selectedIds: new Set(),
        onSelectionChange() {},
        collectionChannels: channels,
      }),
    );
    return {
      nodes,
      text: text.join(''),
      options: nodes
        .filter((n) => n.type === 'option')
        .map((n) => n.props.value),
      metricRows: nodes.filter((n) => n.props.title?.startsWith('指标来自')),
    };
  }
  return {
    render,
    params,
    get query() {
      return query;
    },
  };
}
test('Wechat2RSS hides historical metric values, coverage notices and heat sorting', () => {
  const h = fixture();
  const view = h.render();
  assert.deepEqual(view.options, []);
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
  assert.deepEqual(view.options, []);
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
  assert.deepEqual(view.options, []);
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
