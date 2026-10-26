const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function fixture(view) {
  const slots = [],
    cleanups = [],
    calls = [];
  let index = 0,
    release;
  const gate = new Promise((resolve, reject) => {
    release = { resolve, reject };
  });
  const element = (type, props) =>
    typeof type === 'function' ? type(props) : { type, props };
  const react = {
    useState(v) {
      const i = index++;
      if (!(i in slots)) slots[i] = v;
      return [slots[i], (v) => (slots[i] = v)];
    },
    useRef(v) {
      const i = index++;
      return slots[i] ?? (slots[i] = { current: v });
    },
    useEffect(fn) {
      cleanups.push(fn());
    },
  };
  const module = { exports: {} };
  const utils = {
    xiaohongshu: Object.fromEntries(
      ['engagement', 'notes', 'list'].map((k) => [
        k,
        { invalidate: async () => calls.push(['invalidate', k]) },
      ]),
    ),
  };
  const mutate = async (input) => {
    calls.push(['mutate', input]);
    return gate;
  };
  const trpc = {
    useUtils: () => utils,
    xiaohongshu: {
      engagement: {
        useQuery(input, options) {
          calls.push(['read', input, options]);
          return { data: view, isLoading: false, error: null };
        },
      },
      collectComments: {
        useMutation: () => ({ isLoading: false, mutateAsync: mutate }),
      },
      refreshMetrics: {
        useMutation: () => ({ isLoading: false, mutateAsync: mutate }),
      },
    },
  };
  const code = ts.transpileModule(
    fs.readFileSync('apps/web/src/components/XhsEngagement.tsx', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  new Function('require', 'exports', 'module', code)(
    (name) =>
      ({
        react: react,
        'react/jsx-runtime': { jsx: element, jsxs: element },
        '@web/utils/trpc': { trpc },
      })[name],
    module.exports,
    module,
  );
  const all = (node) =>
    node == null
      ? []
      : Array.isArray(node)
        ? node.flatMap(all)
        : typeof node === 'object'
          ? [node, ...all(node.props?.children)]
          : [node];
  return {
    calls,
    slots,
    release,
    metric: module.exports.XhsMetricLine,
    render: () => {
      index = 0;
      return all(
        module.exports.XhsEngagementPanel({
          creatorId: 'creator-a',
          noteId: 'exact-note',
          canCollectComments: true,
          canRefreshMetrics: true,
        }),
      );
    },
    unmount: () => cleanups.forEach((fn) => fn?.()),
    text: (node) =>
      all(node)
        .filter((x) => typeof x === 'string' || typeof x === 'number')
        .join(''),
  };
}
const empty = {
  metrics: null,
  creatorMetrics: null,
  comments: [],
  windows: [],
  totalSaved: 0,
  returned: 0,
  offset: 0,
};
test('following unknown is omitted, a measured zero and other unknown values stay distinct', () => {
  const f = fixture(empty),
    snapshot = {
      values: { fans: 1615, following: null },
      collectedAt: 1760000000000,
      evidence: 'source-only',
    };
  assert.equal(f.text(f.metric({ creator: true, snapshot })), '粉丝 1,615');
  assert.equal(
    f.text(
      f.metric({
        creator: true,
        snapshot: { ...snapshot, values: { fans: 0, following: 0 } },
      }),
    ),
    '粉丝 0 · 关注 0',
  );
  assert.match(
    f.text(
      f.metric({
        snapshot: {
          ...snapshot,
          values: { likes: 0, collects: null, shares: null, comments: 0 },
        },
      }),
    ),
    /赞 0 · 收藏 未知 · 分享 未知 · 评论 0/,
  );
});
test('engagement reads its own note without a body dependency and mutations lock synchronously', async () => {
  const f = fixture(empty),
    nodes = f.render();
  assert.deepEqual(f.calls[0][1], {
    creatorId: 'creator-a',
    noteId: 'exact-note',
    offset: 0,
    limit: 200,
  });
  assert.equal(f.calls[0][2].keepPreviousData, false);
  const button = nodes.find(
    (n) => n.type === 'button' && n.props.children === '更新互动快照',
  );
  const first = button.props.onClick(),
    second = button.props.onClick();
  assert.equal(f.calls.filter((c) => c[0] === 'mutate').length, 1);
  f.unmount();
  f.release.reject(Error('synthetic late failure'));
  await Promise.all([first, second]);
  assert.equal(
    f.calls.some((c) => c[0] === 'invalidate'),
    false,
  );
  assert.equal(f.slots.includes('synthetic late failure'), false);
});
