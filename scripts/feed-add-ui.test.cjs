const assert = require('node:assert/strict'),
  test = require('node:test'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function render(capability) {
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
    useMemo: (fn) => fn(),
    useEffect() {},
  };
  const emptyQuery = {
    data: undefined,
    refetch: async () => {},
    isFetching: false,
  };
  const utils = new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          { get: () => new Proxy({}, { get: () => async () => {} }) },
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
    success: () => events.push({ success: true }),
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
  mount();
  state[0] = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
  const tree = mount();
  return {
    events,
    state,
    button: walk(
      tree,
      (node) => node.type === 'Button' && node.props.children === '确定',
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
    assert.equal(h.state[0], h.input.props.value);
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
  assert.equal(h.state[0], h.input.props.value);
  assert.equal(
    h.events.filter((event) => event.mutation === 'addFromArticle').length,
    1,
  );
  assert(!h.events.some((event) => event.closed || event.success));
});
