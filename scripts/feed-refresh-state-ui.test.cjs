'use strict';
// Executes the actual feeds component with offline hooks and deferred mutations.
// No application server, browser session or upstream update is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const { loadActualTs } = require('./offline-ts-fixture.cjs');
const dateSelection = loadActualTs(
  'apps/web/src/utils/article-date-selection.ts',
);
const articleDates = loadActualTs('packages/shared/src/article-date-filter.ts');
function fixture({
  batchRunning = false,
  feedReadFails = false,
  manualBatch,
  summaryFailed = false,
  privateMode = false,
} = {}) {
  let route = 'A',
    index = 0,
    dirty = false,
    tree,
    sharedLoading = false;
  const hooks = [],
    effects = [],
    requests = [],
    events = [],
    timers = new Map();
  const items = ['A', 'B'].map((id) => ({
    id,
    mpName: `Synthetic ${id}`,
    mpCover: '',
    collectionRoute: { channel: 'wechat2rss' },
  }));
  const element = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in hooks))
        hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [
        hooks[i],
        (next) => {
          const value = typeof next === 'function' ? next(hooks[i]) : next;
          if (!Object.is(value, hooks[i])) dirty = true;
          hooks[i] = value;
        },
      ];
    },
    useRef(initial) {
      const i = index++;
      return (hooks[i] ||= { current: initial });
    },
    useMemo: (fn) => fn(),
    useEffect(fn, deps) {
      const i = index++;
      const old = hooks[i];
      if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) {
        effects.push(() => {
          old?.cleanup?.();
          hooks[i] = { deps, cleanup: fn() };
        });
      }
    },
  };
  const refetch = async () => {
    events.push('feed-read');
    if (feedReadFails) throw new Error('Synthetic reread failure');
  };
  const utils = {
    feed: { cacheSyncStatus: { invalidate: async () => undefined } },
    article: {
      list: {
        reset: async () => events.push('article-reset'),
        invalidate: async () => events.push('article-invalidate'),
      },
      summary: { invalidate: async () => events.push('summary-invalidate') },
    },
  };
  const trpc = new Proxy(
    { useUtils: () => utils },
    {
      get(target, scope) {
        if (scope in target) return target[scope];
        return new Proxy(
          {},
          {
            get(_, name) {
              return {
                useQuery: (input) => ({
                  isError: name === 'summary' && summaryFailed,
                  isFetching: false,
                  data:
                    name === 'summary'
                      ? summaryFailed
                        ? undefined
                        : { articles: input.group ? 37 : 53 }
                      : name === 'list'
                        ? { items: scope === 'feed' ? items : [] }
                        : name === 'groups'
                          ? { items: [] }
                          : name === 'isRefreshAllMpArticlesRunning'
                            ? batchRunning
                            : name === 'manualRefreshBatches'
                              ? { items: manualBatch ? [manualBatch] : [] }
                              : undefined,
                  refetch,
                }),
                useMutation: () => ({
                  isLoading: name === 'refreshArticles' && sharedLoading,
                  mutateAsync: (input) => {
                    if (!['refreshArticles', 'beginRefreshAll'].includes(name))
                      throw new Error(`Unexpected mutation ${String(name)}`);
                    sharedLoading = true;
                    return new Promise((resolve, reject) =>
                      requests.push({
                        name,
                        input,
                        resolve: (value) => {
                          sharedLoading = false;
                          resolve(value);
                        },
                        reject: (error) => {
                          sharedLoading = false;
                          reject(error);
                        },
                      }),
                    );
                  },
                }),
              };
            },
          },
        );
      },
    },
  );
  const ui = new Proxy(
    { useDisclosure: () => ({ isOpen: false, onOpen() {}, onClose() {} }) },
    { get: (target, key) => (key in target ? target[key] : key) },
  );
  const toast = Object.fromEntries(
    ['success', 'error', 'warning', 'info'].map((name) => [
      name,
      (...args) => events.push([name, ...args]),
    ]),
  );
  const module = { exports: {} };
  const source = ts.transpileModule(
    fs.readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8'),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    Error,
    console,
    URLSearchParams,
    setTimeout: (fn) => {
      const key = Symbol();
      timers.set(key, fn);
      return key;
    },
    clearTimeout: (key) => timers.delete(key),
    window: { addEventListener() {}, removeEventListener() {} },
    require: (name) =>
      name === '@web/components/ArticleExportGuidance'
        ? { __esModule: true, default: 'ArticleExportGuidance' }
        : [
              '@web/utils/use-feed-browse-state',
              '@web/utils/use-cache-revision',
            ].includes(name)
          ? {
              useCacheRevision: () => false,
              useFeedBrowseState: () => {
                // Refresh lifecycle tests stay isolated; actual persistence is covered by browser tests.
                const [search, setSearch] = react.useState('');
                const [folderFilter, setFolderFilter] = react.useState('all');
                const [articleDates, setArticleDates] = react.useState({
                  mode: 'day',
                  start: '',
                  end: '',
                });
                const [articleDirection, setArticleDirection] =
                  react.useState('desc');
                const [articleSort, setArticleSort] =
                  react.useState('publishTime');
                return {
                  search,
                  setSearch,
                  folderFilter,
                  setFolderFilter,
                  articleDates,
                  setArticleDates,
                  articleDirection,
                  setArticleDirection,
                  articleSort,
                  setArticleSort,
                  clearBrowseState() {},
                  browseGeneration: 0,
                };
              },
            }
          : name === '@web/utils/article-date-selection'
            ? dateSelection
            : name === '@wewe-rss/shared'
              ? articleDates
              : name === 'react'
                ? react
                : name === 'react/jsx-runtime'
                  ? { jsx: element, jsxs: element, Fragment: 'Fragment' }
                  : [
                        '@nextui-org/react',
                        '@web/components/AppOverlays',
                        '@web/components/SubscriptionPrimitives',
                      ].includes(name)
                    ? ui
                    : name === '@web/utils/trpc'
                      ? { trpc }
                      : name === '@web/utils/refresh-feed-view'
                        ? {
                            refreshFeedViews: async (...operations) => {
                              await Promise.all(operations.map((fn) => fn()));
                            },
                          }
                        : name === 'react-router-dom'
                          ? {
                              useParams: () => ({ id: route }),
                              useNavigate: () => (next) => {
                                route =
                                  next.split('/').at(-1) === 'feeds'
                                    ? ''
                                    : next.split('/').at(-1);
                              },
                            }
                          : name === 'sonner'
                            ? { toast }
                            : name === 'dayjs'
                              ? () => ({ format: () => '' })
                              : name === '@web/utils/env'
                                ? {
                                    acceptanceMode: false,
                                    privateOnlineMode: privateMode,
                                    serverOriginUrl: '',
                                  }
                                : () => null,
  });
  function render() {
    for (let count = 0; count < 10; count++) {
      index = 0;
      dirty = false;
      tree = module.exports.default();
      while (effects.length) effects.shift()();
      if (!dirty) return tree;
    }
    throw new Error('Unstable fixture');
  }
  function walk(node, predicate) {
    if (Array.isArray(node)) {
      for (const n of node) {
        const found = walk(n, predicate);
        if (found) return found;
      }
    } else if (node && typeof node === 'object') {
      if (predicate(node)) return node;
      return walk(node.props?.children, predicate);
    }
  }
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    if (node && typeof node === 'object') return text(node.props?.children);
    return typeof node === 'string' ? node : '';
  }
  function button(batch = false) {
    render();
    const node = walk(
      tree,
      (n) =>
        n.type === 'Button' &&
        (batch
          ? String(n.props.onPress).includes('beginRefreshAll()')
          : String(n.props.onPress).includes('const mpId = currentMpInfo.id')),
    );
    assert(node, 'refresh button exists');
    return { ...node, text: text(node) };
  }
  render();
  return {
    requests,
    events,
    timers,
    render,
    button,
    find: (predicate) => {
      render();
      return walk(tree, predicate);
    },
    navigate: (id) => {
      route = id;
      render();
    },
    unmount: () => {
      for (const hook of hooks) hook?.cleanup?.();
    },
    setBatch: (value) => {
      batchRunning = value;
    },
    text: () => {
      render();
      return text(tree);
    },
  };
}
const complete = [
  {
    source: 'synthetic',
    message: 'Synthetic complete',
    status: 'updated',
    complete: true,
  },
];

test('single export entry shows actual scope counts, limits ZIP to supported scopes, and closes on route change', () => {
  const f = fixture();
  const entry = () =>
    f.find((n) => n.type === 'Button' && n.props.children === '导出文章');
  entry().props.onPress();
  assert(f.find((n) => n.type === 'Modal' && n.props.isOpen));
  const confirm = () =>
    f.find(
      (n) =>
        n.type === 'Button' &&
        Array.isArray(n.props.children) &&
        n.props.children[0] === '开始导出 ',
    );
  assert.equal(confirm().props.children[1], 37);
  f.find((n) => n.type === 'ContentExportScope').props.onChange('all');
  assert.match(f.text(), /公众号：Synthetic A/);
  assert.equal(
    f.find((n) => n.type === 'ArticleExportGuidance').props.singleFeed,
    true,
  );
  f.find(
    (n) => n.type === 'select' && n.props['aria-label'] === '导出方式',
  ).props.onChange({ target: { value: 'zip' } });
  assert.equal(
    f.find((n) => n.type === 'ArticleExportGuidance').props.format,
    'zip',
  );
  assert.equal(
    f.find((n) => n.type === 'ArticleExportGuidance').props.scope,
    'all',
  );
  assert.equal(confirm().props.children[1], 53);
  assert.equal(
    f.find((n) => n.type === 'option' && n.props.value === 'zip').props
      .disabled,
    false,
  );
  f.navigate('B');
  assert(!f.find((n) => n.type === 'Modal' && n.props.isOpen));
  f.navigate('');
  entry().props.onPress();
  f.find((n) => n.type === 'ContentExportScope').props.onChange('all');
  assert.match(f.text(), /公众号：全部订阅/);
  assert.equal(
    f.find((n) => n.type === 'option' && n.props.value === 'zip').props
      .disabled,
    true,
  );
});

test('scope read errors prevent export with retry and private mode retains ZIP without exposing local directory export', () => {
  const f = fixture({ summaryFailed: true });
  f.find(
    (n) => n.type === 'Button' && n.props.children === '导出文章',
  ).props.onPress();
  assert(
    f.find((n) => n.type === 'Button' && n.props.children === '重试读取篇数'),
  );
  assert.equal(
    f.find(
      (n) =>
        n.type === 'Button' &&
        Array.isArray(n.props.children) &&
        n.props.children[0] === '开始导出 ',
    ).props.isDisabled,
    true,
  );
  assert.equal(f.requests.length, 0);
  const p = fixture({ privateMode: true });
  p.find(
    (n) => n.type === 'Button' && n.props.children === '导出文章',
  ).props.onPress();
  assert.equal(
    p.find((n) => n.type === 'select' && n.props['aria-label'] === '导出方式')
      .props.value,
    'zip',
  );
  assert.equal(
    p.find((n) => n.type === 'option' && n.props.value === 'obsidian').props
      .disabled,
    true,
  );
});

test('single-feed request remains scoped; switching and concurrent feeds never inherit mutation loading', async () => {
  const f = fixture();
  const a = f.button();
  const pa = a.props.onPress();
  await a.props.onPress();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].input)), {
    mpId: 'A',
  });
  assert.equal(f.button().text, '更新中');
  f.navigate('B');
  assert.equal(f.button().text, '更新本号');
  assert.equal(f.button().props.isDisabled, false);
  const pb = f.button().props.onPress();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].input)), {
    mpId: 'B',
  });
  f.requests[0].resolve(complete);
  await pa;
  assert.equal(f.button().text, '更新中');
  f.navigate('A');
  assert.equal(f.button().text, '内容已同步');
  f.requests[1].reject(new Error('Synthetic B failure'));
  await pb;
  f.navigate('B');
  assert.equal(f.button().text, '更新本号');
  assert.equal(f.button().props.isDisabled, false);
  assert(
    f.events.some(
      (e) =>
        Array.isArray(e) &&
        e[0] === 'error' &&
        e[1].includes('可再次点击更新本号重试'),
    ),
  );
});

test('multiple successful receipts emit one operation notice; mixed failure stays retryable without exposing raw errors', async () => {
  const f = fixture();
  const pending = f.button().props.onPress();
  f.requests[0].resolve([complete[0], { ...complete[0], source: 'second' }]);
  await pending;
  assert.equal(
    f.events.filter((e) => Array.isArray(e) && e[0] === 'success').length,
    1,
  );
  const next = f.button().props.onPress();
  f.requests[1].resolve([
    complete[0],
    {
      source: 'error',
      status: 'failed',
      complete: false,
      message: 'SQLITE_INTERNAL_SYNTHETIC',
    },
  ]);
  await next;
  const errors = f.events.filter((e) => Array.isArray(e) && e[0] === 'error');
  assert.equal(errors.length, 1);
  assert(!errors[0][1].includes('SQLITE_INTERNAL'));
  assert.equal(f.button().props.isDisabled, false);
});
test('single-feed work does not label overview or other feeds as updating; batch has its own lock', async () => {
  const f = fixture();
  const pa = f.button().props.onPress();
  f.navigate('');
  assert.equal(f.button(true).text, '更新全部');
  assert.equal(f.button(true).props.isDisabled, true);
  await f.button(true).props.onPress();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(complete);
  await pa;
  const batch = f.button(true);
  const pb = batch.props.onPress();
  await batch.props.onPress();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].name, 'beginRefreshAll');
  assert.equal(f.requests[1].input, undefined);
  assert.equal(f.button(true).text, '正在开始');
  f.navigate('B');
  assert.equal(f.button().text, '更新本号');
  assert.equal(f.button().props.isDisabled, true);
  await f.button().props.onPress();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({
    total: 2,
    queuedCount: 2,
    skippedCount: 0,
    reused: false,
  });
  await pb;
  assert(
    f.events.some(
      (event) =>
        Array.isArray(event) &&
        event[0] === 'info' &&
        event[1].includes('共 2 个，待发送 2 个'),
    ),
  );
  assert(
    !f.events.some(
      (event) =>
        Array.isArray(event) &&
        event[0] === 'success' &&
        event[1].includes('完整更新'),
    ),
  );
  assert.equal(f.button().props.isDisabled, false);
});
test('recovered background and paused batches prevent new submissions and remain separate from single-feed feedback', async () => {
  for (const state of ['running', 'paused']) {
    const f = fixture({
      manualBatch: {
        batchId: 'synthetic-batch',
        state,
        items: [{ state: 'waiting', accepted: true }],
      },
    });
    f.navigate('');
    assert.equal(
      f.button(true).text,
      state === 'paused' ? '更新已暂停' : '后台更新中',
    );
    assert.equal(f.button(true).props.isDisabled, true);
    await f.button(true).props.onPress();
    assert.equal(f.requests.length, 0);
    f.navigate('A');
    assert.equal(f.button().text, '更新本号');
    assert.equal(f.button().props.isDisabled, true);
  }
});
test('failure, abort and local reread failure release single-feed and batch locks', async () => {
  const f = fixture({ feedReadFails: true });
  const p = f.button().props.onPress();
  const abort = new Error('Synthetic cancelled');
  abort.name = 'AbortError';
  f.requests[0].reject(abort);
  await p;
  assert.equal(f.button().props.isDisabled, false);
  assert.equal(f.button().text, '更新本号');
  f.navigate('');
  const batch = f.button(true).props.onPress();
  f.requests[1].reject(new Error('Synthetic batch failure'));
  await batch;
  assert.equal(f.button(true).props.isDisabled, false);
  assert.equal(f.button(true).text, '更新全部');
  f.navigate('A');
  const reread = f.button().props.onPress();
  f.requests[2].resolve(complete);
  await reread;
  assert.equal(f.button().props.isDisabled, false);
  assert.equal(f.button().text, '更新本号');
});
test('unmount suppresses late completion, clears timers and never starts follow-up reads', async () => {
  const f = fixture();
  const p = f.button().props.onPress();
  f.unmount();
  f.requests[0].resolve(complete);
  await p;
  assert.equal(f.events.length, 0);
  assert.equal(f.timers.size, 0);
  const g = fixture();
  const pg = g.button().props.onPress();
  g.requests[0].resolve(complete);
  await pg;
  assert.equal(g.timers.size, 1);
  g.unmount();
  assert.equal(g.timers.size, 0);
});
test('a new refresh cancels the previous completion timer; background batch stays separate', async () => {
  const f = fixture();
  const p = f.button().props.onPress();
  f.requests[0].resolve(complete);
  await p;
  const p2 = f.button().props.onPress();
  assert.equal(f.timers.size, 0);
  assert.equal(f.button().text, '更新中');
  f.requests[1].resolve([
    { ...complete[0], complete: false, status: 'blocked' },
  ]);
  await p2;
  assert.equal(f.button().text, '更新本号');
  f.setBatch(true);
  assert.equal(f.button().text, '更新本号');
  assert.equal(f.button().props.isDisabled, true);
  await f.button().props.onPress();
  assert.equal(f.requests.length, 2);
  f.navigate('');
  assert.equal(f.button(true).text, '后台更新中');
});
