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
                    ? { ...emptyQuery, data: capability }
                    : name === 'list'
                      ? { ...emptyQuery, data: { items: [] } }
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
      (node) =>
        node.type === 'Button' && node.props.children === '提交所选来源',
    ),
    input: walk(tree, (node) => node.type === 'Textarea'),
  };
}
test('disabled or unknown source preserves input without invoking legacy add or success', async () => {
  for (const capability of [
    undefined,
    { available: false, message: '当前新增来源未接通，输入已保留' },
  ]) {
    const h = render(capability);
    assert.equal(h.button.props.isDisabled, true);
    await h.button.props.onPress();
    assert.equal(h.articleValue(), h.input.props.value);
    assert(
      !h.events.some(
        (event) => event.mutation || event.closed || event.success,
      ),
    );
    assert(h.events.some((event) => event.toast));
  }
});
test('a later backend failure preserves the entered link and does not claim success', async () => {
  const h = render({ available: true, message: '已显式配置来源' });
  assert.equal(h.button.props.isDisabled, false);
  await h.button.props.onPress();
  assert.equal(h.articleValue(), h.input.props.value);
  assert.equal(
    h.events.filter((event) => event.mutation === 'addFromArticle').length,
    1,
  );
  assert(!h.events.some((event) => event.closed || event.success));
});

// All identities and links below are synthetic; only actual component handlers
// run in the VM. No browser rendering, database, platform request or login.
const firstLink = 'https://mp.weixin.qq.com/s/synthetic-first';
const secondLink = 'https://mp.weixin.qq.com/s/synthetic-second';
const receipt = (overrides = {}) => ({
  requestedSource: 'wechat2rss',
  sourceBindingChanged: true,
  accepted: true,
  pending: false,
  status: 'updated',
  created: true,
  feed: { id: 'MP_WXS_1234567890', mpName: '合成公众号' },
  message: '已读取2篇缓存，新增2篇，正文缺失0篇，图片缺失0张。',
  sync: { status: 'partial', bodyMissing: 0, imageBlocked: 0 },
  ...overrides,
});
const feedback = (h) =>
  h.find((node) => node.props['aria-label'] === '新增订阅处理结果')?.props
    .children;
const feedbackText = (h) =>
  feedback(h)
    .map((li) => li.props.children)
    .join('\n');

test('new and existing subscriptions distinguish identity and cache import, with visible receipts', async () => {
  for (const created of [true, false]) {
    const h = render(
      { available: true },
      { mutate: async () => receipt({ created }) },
    );
    await h.button.props.onPress();
    assert.equal(h.articleValue(), '');
    assert(!h.events.some((event) => event.closed));
    assert(h.events.some((event) => event.success));
    assert.match(feedbackText(h), created ? /新增成功/ : /已有订阅/);
    assert.match(feedbackText(h), /新增2篇/);
    assert.deepEqual(h.refreshed, ['list.reset', 'summary.invalidate']);
    assert.equal(
      h.find(
        (node) =>
          node.type === 'Button' && node.props.children === '提交所选来源',
      ).props.isDisabled,
      true,
    );
    // A stale handler invoked after completion cannot submit the cleared input.
    await h
      .find(
        (node) =>
          node.type === 'Button' && node.props.children === '提交所选来源',
      )
      .props.onPress();
    assert.equal(h.events.filter((event) => event.mutation).length, 1);
  }
});

test('accepted pending or blocked cache refreshes local views, removes processed link and stops the batch', async () => {
  for (const status of ['pending', 'blocked']) {
    const h = render(
      { available: true },
      {
        links: `${firstLink}\n${secondLink}`,
        mutate: async () =>
          receipt({
            status,
            pending: true,
            message: '缓存未完成，请从原更新按钮读取。',
          }),
      },
    );
    await h.button.props.onPress();
    assert.equal(h.articleValue(), secondLink);
    assert.equal(h.events.filter((event) => event.mutation).length, 1);
    assert(!h.events.some((event) => event.success || event.closed));
    assert.deepEqual(h.refreshed, ['list.reset', 'summary.invalidate']);
    assert.match(feedbackText(h), /新增成功/);
    assert.match(feedbackText(h), /缓存未完成/);
  }
});

test('no-feed pending, account block and failure retain all links without success or follow-on requests', async () => {
  for (const [status, accepted] of [
    ['pending', true],
    ['blocked', false],
    ['failed', false],
  ]) {
    const links = `${firstLink}\n${secondLink}`;
    const h = render(
      { available: true },
      {
        links,
        mutate: async () =>
          receipt({
            status,
            accepted,
            feed: null,
            pending: true,
            message: '等待缓存或核对实例状态。',
          }),
      },
    );
    await h.button.props.onPress();
    assert.equal(h.articleValue(), links);
    assert.equal(h.events.filter((event) => event.mutation).length, 1);
    assert(!h.events.some((event) => event.success || event.closed));
    assert.deepEqual(h.refreshed, []);
    assert.match(feedbackText(h), accepted ? /请求已受理/ : /未新增订阅/);
  }
});

test('existing source receipt preserves original binding without implying cache success', async () => {
  const h = render(
    { available: true },
    {
      mutate: async () =>
        receipt({
          status: 'source-preserved',
          created: false,
          sourceBindingChanged: false,
          message: '原来源及内容保持。',
          sync: null,
        }),
    },
  );
  await h.button.props.onPress();
  assert.match(feedbackText(h), /已有订阅/);
  assert.match(feedbackText(h), /原来源及内容保持/);
  assert(h.events.some((event) => event.warning?.[0] === '现有订阅来源保持'));
  assert(!h.events.some((event) => event.success || event.closed));
});

test('rapid duplicate submit is guarded before a render and input is locked until completion', async () => {
  let resolve;
  const request = new Promise((done) => {
    resolve = done;
  });
  const h = render({ available: true }, { mutate: () => request });
  const run = h.button.props.onPress();
  await h.button.props.onPress();
  assert.equal(h.events.filter((event) => event.mutation).length, 1);
  assert.equal(
    h.find((node) => node.type === 'Textarea').props.isDisabled,
    true,
  );
  h.input.props.onValueChange(secondLink);
  assert.equal(h.articleValue(), h.input.props.value);
  resolve(receipt());
  await run;
  assert.equal(
    h.find((node) => node.type === 'Textarea').props.isDisabled,
    false,
  );
});

test('closing while the first request runs prevents further requests and keeps remaining input', async () => {
  let resolve;
  const request = new Promise((done) => {
    resolve = done;
  });
  const h = render(
    { available: true },
    { links: `${firstLink}\n${secondLink}`, mutate: () => request },
  );
  const run = h.button.props.onPress();
  h.find(
    (node) =>
      node.type === 'Button' && node.props.children === '停止后续并关闭',
  ).props.onPress();
  resolve(receipt());
  await run;
  assert.equal(h.events.filter((event) => event.mutation).length, 1);
  assert.equal(h.articleValue(), secondLink);
  assert(!h.events.some((event) => event.success));
});

test('a local view read failure does not turn accepted cache import into failed add or repeatable input', async () => {
  const h = render(
    { available: true },
    { viewReadFails: true, mutate: async () => receipt() },
  );
  await h.button.props.onPress();
  assert.equal(h.articleValue(), '');
  assert.match(feedbackText(h), /列表重新读取未完成/);
  assert.match(feedbackText(h), /新增成功/);
  assert(h.events.some((event) => event.success));
  assert.equal(h.events.filter((event) => event.mutation).length, 1);
});

test('closing while local views are reloading suppresses stale receipts and subsequent submissions', async () => {
  let resume, reached;
  const paused = new Promise((done) => {
    resume = done;
  });
  const started = new Promise((done) => {
    reached = done;
  });
  const h = render(
    { available: true },
    {
      links: `${firstLink}\n${secondLink}`,
      mutate: async () => receipt(),
      viewRead: async () => {
        reached();
        await paused;
      },
    },
  );
  const run = h.button.props.onPress();
  await started;
  h.find(
    (node) =>
      node.type === 'Button' && node.props.children === '停止后续并关闭',
  ).props.onPress();
  resume();
  await run;
  assert.equal(h.events.filter((event) => event.mutation).length, 1);
  assert.equal(h.articleValue(), secondLink);
  assert(!h.events.some((event) => event.success));
  assert.equal(h.events.filter((event) => event.warning).length, 1);
  assert.match(
    h.events.find((event) => event.warning).warning[0],
    /已停止后续/,
  );
});

test('empty or impostor-host links cannot invoke the handler despite bypassing disabled controls', async () => {
  for (const links of [
    ' ',
    'https://mp.weixin.qq.com/synthetic',
    'https://mp.weixin.qq.com.evil.invalid/s/fake',
    `${firstLink}\nhttps://example.invalid/s/other`,
  ]) {
    const h = render(
      { available: true },
      { links, mutate: async () => receipt() },
    );
    await h.button.props.onPress();
    assert.equal(h.events.filter((event) => event.mutation).length, 0);
    assert.equal(h.articleValue(), links);
  }
});

test('native pending results refresh partial caches without sending remaining links', async () => {
  const h = render(
    { available: true },
    {
      links: `${firstLink}\n${secondLink}`,
      mutate: async () => ({
        source: 'owner-weread-latest',
        accepted: true,
        pending: true,
        created: true,
        feed: receipt().feed,
        message: '正文图片待完成',
      }),
    },
  );
  await h.button.props.onPress();
  assert.equal(h.events.filter((event) => event.mutation).length, 1);
  assert.equal(h.articleValue(), secondLink);
  assert.deepEqual(h.refreshed, ['list.reset', 'summary.invalidate']);
  assert(!h.events.some((event) => event.success));
});
