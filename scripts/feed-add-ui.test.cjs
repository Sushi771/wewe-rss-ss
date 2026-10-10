const assert = require('node:assert/strict'),
  test = require('node:test'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function render(capability, options = {}) {
  // Use the current paid capability shape; this fixture never contacts a source.
  if (capability)
    capability = {
      source: 'wechat2rss',
      requiresAccount: false,
      sources: [
        { source: 'wechat2rss', requiresAccount: false, ...capability },
      ],
      ...capability,
    };
  const state = [],
    events = [];
  let localFeeds = options.initialFeeds || [];
  let index = 0;
  const element = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(value) {
      const i = index++;
      if (!(i in state))
        state[i] = typeof value === 'function' ? value() : value;
      return [
        state[i],
        (next) => {
          state[i] = typeof next === 'function' ? next(state[i]) : next;
        },
      ];
    },
    useRef(value) {
      const i = index++;
      if (!(i in state)) state[i] = { current: value };
      return state[i];
    },
    useMemo: (fn) => fn(),
    useEffect() {},
  };
  const emptyQuery = {
    data: undefined,
    refetch: async () => {},
    isFetching: false,
  };
  const refreshed = [];
  const utils = new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          {
            get: (_target, query) =>
              new Proxy(
                {},
                {
                  get: (_query, action) => async () => {
                    refreshed.push(`${String(query)}.${String(action)}`);
                    if (options.viewRead) await options.viewRead(query, action);
                    if (options.viewReadFails)
                      throw new Error('SYNTHETIC_VIEW_READ_FAILURE');
                  },
                },
              ),
          },
        ),
    },
  );
  const trpc = new Proxy(
    { useUtils: () => utils },
    {
      get(target, key) {
        if (key in target) return target[key];
        return new Proxy(
          {},
          {
            get(_target, name) {
              return {
                useQuery: () =>
                  name === 'addCapability'
                    ? {
                        ...emptyQuery,
                        data: capability,
                        error: options.capabilityError,
                      }
                    : name === 'list'
                      ? {
                          ...emptyQuery,
                          data: { items: key === 'feed' ? localFeeds : [] },
                          refetch: async () => {
                            events.push({ localRead: 'feed.list' });
                            if (options.feedRead) await options.feedRead();
                            if (options.savedFeeds)
                              localFeeds = options.savedFeeds;
                            return { data: { items: localFeeds } };
                          },
                        }
                      : emptyQuery,
                useMutation: () => ({
                  isLoading: false,
                  mutateAsync: async (input) => {
                    events.push({ mutation: name, input });
                    if (options.mutate) return options.mutate(input);
                    throw new Error('SUBSCRIPTION_SOURCE_UNAVAILABLE');
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
    {
      useDisclosure: () => ({
        isOpen: true,
        onOpen() {},
        onClose() {
          events.push({ closed: true });
        },
        onOpenChange() {},
      }),
    },
    { get: (target, key) => (key in target ? target[key] : key) },
  );
  const toast = {
    error: (...args) => events.push({ toast: args }),
    warning: (...args) => events.push({ warning: args }),
    success: (...args) => events.push({ success: true, args }),
  };
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
  const module = { exports: {} };
  const requireMock = (name) =>
    name === 'react'
      ? react
      : name === 'react/jsx-runtime'
        ? { jsx: element, jsxs: element, Fragment: 'Fragment' }
        : name === '@nextui-org/react'
          ? ui
          : name === '@web/utils/trpc'
            ? { trpc }
            : name === '@web/utils/refresh-feed-view'
              ? { refreshFeedViews: async () => {} }
              : name === 'react-router-dom'
                ? { useNavigate: () => () => {}, useParams: () => ({}) }
                : name === 'sonner'
                  ? { toast }
                  : name === 'dayjs'
                    ? () => ({ format: () => '' })
                    : name === '@web/utils/env'
                      ? {
                          acceptanceMode: false,
                          privateOnlineMode: false,
                          serverOriginUrl: (value) => value,
                        }
                      : () => null;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: requireMock,
    console,
  });
  const mount = () => {
    index = 0;
    return module.exports.default();
  };
  function walk(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const value = walk(child, predicate);
        if (value) return value;
      }
      return null;
    }
    if (predicate(node)) return node;
    const children = node.props?.children;
    return walk(
      typeof children === 'function'
        ? children(() => events.push({ closed: true }))
        : children,
      predicate,
    );
  }
  // Drive the actual input instead of assuming a useState position; account
  // selection, feedback and the persistent submit guard also use hooks.
  const initial = mount();
  walk(initial, (node) => node.type === 'Textarea').props.onValueChange(
    options.links || 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv',
  );
  const tree = mount();
  return {
    events,
    state,
    refreshed,
    tree: mount,
    find: (predicate) => walk(mount(), predicate),
    articleValue: () =>
      walk(mount(), (node) => node.type === 'Textarea').props.value,
    button: walk(
      tree,
      (node) => node.type === 'Button' && node.props.children === '添加订阅',
    ),
    input: walk(tree, (node) => node.type === 'Textarea'),
  };
}

const url = (suffix) => `https://mp.weixin.qq.com/s/${suffix}`;
const queued = {
  batchId: 'synthetic-batch',
  state: 'queued',
  items: [
    { index: 0, state: 'queued' },
    { index: 1, state: 'queued' },
  ],
};
test('unavailable paid source blocks even if native is available', async () => {
  for (const capability of [
    undefined,
    {
      available: false,
      sources: [{ source: 'native', available: true, requiresAccount: true }],
    },
  ]) {
    const h = render(capability);
    await h.button.props.onPress();
    assert.equal(h.articleValue(), h.input.props.value);
    assert(!h.events.some((e) => e.mutation || e.success));
  }
});
test('one multiline submit persists the whole batch without a native account or frontend add loop', async () => {
  const h = render(
    { available: true },
    { links: [url('one'), url('two')].join('\n'), mutate: async () => queued },
  );
  await h.button.props.onPress();
  const mutations = h.events.filter((e) => e.mutation);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].mutation, 'addSubscriptionBatch');
  assert.deepEqual(Array.from(mutations[0].input.articleUrls), [
    url('one'),
    url('two'),
  ]);
  assert.equal(h.articleValue(), '');
  assert.deepEqual(h.refreshed, ['subscriptionBatches.invalidate']);
  assert(!h.events.some((e) => e.success));
});
test('close during atomic submit retains server execution, disables double clicks and clears only acknowledged input', async () => {
  let done;
  const h = render(
    { available: true },
    {
      links: [url('one'), url('two')].join('\n'),
      mutate: () => new Promise((r) => (done = r)),
    },
  );
  const first = h.button.props.onPress();
  await h.button.props.onPress();
  assert.equal(h.find((n) => n.type === 'Textarea').props.isDisabled, true);
  h.find(
    (n) => n.type === 'Button' && n.props.children === '取消',
  ).props.onPress();
  done(queued);
  await first;
  assert.equal(h.events.filter((e) => e.mutation).length, 1);
  assert.equal(h.articleValue(), '');
  assert(!h.events.some((e) => e.success));
});
test('ambiguous mutation failure preserves original input and only reads durable progress', async () => {
  const h = render(
    { available: true },
    {
      mutate: async () => {
        throw Error('synthetic-private-error');
      },
    },
  );
  await h.button.props.onPress();
  assert.equal(h.articleValue(), h.input.props.value);
  assert.equal(h.events.filter((e) => e.mutation).length, 1);
  assert.deepEqual(h.refreshed, ['subscriptionBatches.invalidate']);
  assert(!h.events.some((e) => e.success));
  assert(!JSON.stringify(h.events).includes('synthetic-private-error'));
});
test('failed progress read after acknowledgement cannot make the accepted input repeatable', async () => {
  const h = render(
    { available: true },
    { mutate: async () => queued, viewReadFails: true },
  );
  await h.button.props.onPress();
  assert.equal(h.articleValue(), '');
  assert.equal(h.events.filter((e) => e.mutation).length, 1);
  assert(!h.events.some((e) => e.success));
});
test('LF and CRLF, blank lines and exact duplicates normalize once; twenty-one links are rejected', async () => {
  const h = render(
    { available: true },
    {
      links: ' ' + url('one') + '\r\n\n' + url('one') + '\n' + url('two'),
      mutate: async () => queued,
    },
  );
  await h.button.props.onPress();
  assert.deepEqual(
    Array.from(h.events.find((e) => e.mutation).input.articleUrls),
    [url('one'), url('two')],
  );
  const invalid = render(
    { available: true },
    { links: Array.from({ length: 21 }, (_, i) => url(i)).join('\n') },
  );
  await invalid.button.props.onPress();
  assert(!invalid.events.some((e) => e.mutation));
  assert.equal(invalid.articleValue(), invalid.input.props.value);
});
test('empty and impostor-host input cannot invoke the handler when controls are bypassed', async () => {
  for (const links of [
    ' ',
    'https://mp.weixin.qq.com.evil/s/one',
    url('one') + ' ' + url('two'),
  ]) {
    const h = render({ available: true }, { links });
    await h.button.props.onPress();
    assert(!h.events.some((e) => e.mutation));
  }
});
test('new add modal has no native source/account chooser and uses the real capability read', async () => {
  const h = render({ available: true, requiresAccount: false });
  assert(
    !h.find((n) => n.type === 'Select' && n.props.label === '新增订阅来源'),
  );
  const stale = render(
    { available: true },
    { capabilityError: Error('stale') },
  );
  await stale.button.props.onPress();
  assert(!stale.events.some((e) => e.mutation));
});
test('concurrent progress observers share the saved list read and reveal the new row outside the selected group', async () => {
  let release;
  const wait = new Promise((r) => (release = r));
  const saved = {
    id: 'MP_WXS_1234567890',
    mpName: 'Synthetic feed',
    channel: 'wechat2rss',
    collectionRoute: { channel: 'wechat2rss' },
  };
  const h = render(
    { available: true },
    { savedFeeds: [saved], feedRead: () => wait },
  );
  h.find((node) => typeof node.props.onFilter === 'function').props.onFilter(
    'old-group',
  );
  const panel = h.find((n) => typeof n.props.onSaved === 'function');
  assert(panel);
  const run = panel.props.onSaved(true);
  const concurrent = panel.props.onSaved(false);
  await Promise.resolve();
  assert.deepEqual(h.refreshed, []);
  assert.equal(h.events.filter((e) => e.localRead === 'feed.list').length, 1);
  release();
  await Promise.all([run, concurrent]);
  assert.deepEqual(h.refreshed, ['list.reset', 'summary.invalidate']);
  assert(h.events.some((e) => e.localRead === 'feed.list'));
  assert.equal(
    h.find((node) => typeof node.props.onFilter === 'function').props.filter,
    'all',
  );
});
