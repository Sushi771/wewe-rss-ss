'use strict';
// Real task TSX, simulated local-only RPC and hooks. No platform or database.
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(
  require.resolve('typescript', { paths: [path.join(root, 'apps/web')] }),
);
const batch = {
  batchId: '11111111-1111-4111-8111-111111111111',
  state: 'running',
  items: [
    { index: 0, state: 'waiting', message: '' },
    { index: 1, state: 'queued', message: '' },
  ],
};
function fixture(
  initial = [batch],
  adding = false,
  legacy = false,
  excluded = [],
) {
  let data = { items: initial },
    queryError = false,
    options,
    stateIndex = 0,
    refIndex = 0,
    savingFails = false,
    resumeWait;
  const states = [],
    refs = [],
    calls = [];
  const hooks = {
    useState(value) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = value;
      return [
        states[i],
        (v) => {
          states[i] = typeof v === 'function' ? v(states[i]) : v;
        },
      ];
    },
    useRef(value) {
      const i = refIndex++;
      return refs[i] || (refs[i] = { current: value });
    },
  };
  const jsx = (type, props) => ({ type, props });
  const query = {
    useQuery(input, config) {
      assert.equal(input, undefined);
      options = config;
      return {
        data,
        isError: queryError,
        async refetch() {
          calls.push('local-task-read');
          await options.onSuccess(data);
        },
      };
    },
  };
  const resume = {
    useMutation(config) {
      assert.equal(config.retry, false);
      return {
        async mutateAsync(input) {
          calls.push(['resume', input]);
          await resumeWait;
        },
      };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        path.join(root, 'apps/web/src/pages/feeds/subscription-tasks.tsx'),
        'utf8',
      ) + '\nexport { LegacySubscriptionTasks };',
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
    {
      module,
      exports: module.exports,
      require(id) {
        if (id === 'react') return hooks;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === '@nextui-org/react') return { Button: 'Button' };
        if (id === '@web/utils/trpc')
          return {
            trpc: {
              feed: {
                subscriptionBatches: query,
                subscriptionTasks: query,
                resumeSubscriptionTask: resume,
                stopSubscriptionBatch: {
                  useMutation(config) {
                    const m = resume.useMutation(config);
                    return {
                      mutateAsync: async (input) => {
                        calls.push(['stop', input]);
                        await resumeWait;
                      },
                    };
                  },
                },
                resumeSubscriptionBatch: resume,
              },
            },
          };
        throw Error(id);
      },
    },
  );
  const walk = (node) =>
    !node || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(walk)
        : [node, ...walk(node.props?.children)];
  const text = (node) =>
    node == null || typeof node === 'boolean'
      ? ''
      : typeof node !== 'object'
        ? String(node)
        : Array.isArray(node)
          ? node.map(text).join('')
          : text(node.props?.children);
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    const tree = (
      legacy ? module.exports.LegacySubscriptionTasks : module.exports.default
    )({
      adding,
      excluded,
      feeds: [{ id: 'MP_WXS_1234567890', mpName: '合成公众号' }],
      onSaved: async (reveal) => {
        calls.push(['local-view-refresh', reveal]);
        if (savingFails) throw Error('SYNTHETIC_LOCAL_READ');
      },
    });
    return { tree, nodes: walk(tree), text: text(tree) };
  };
  return {
    calls,
    render,
    get options() {
      render();
      return options;
    },
    setData(items) {
      data = { items };
    },
    setError(value) {
      queryError = value;
    },
    setSavingFails(value) {
      savingFails = value;
    },
    setResumeWait(value) {
      resumeWait = value;
    },
    async deliver(items) {
      data = { items };
      render();
      await options.onSuccess(data);
    },
    button(label) {
      const node = render().nodes.find(
        (n) => n.type === 'Button' && text(n) === label,
      );
      assert(node, label);
      return node;
    },
  };
}

test('pending batch polling reads local progress and shows every queued link', () => {
  const f = fixture();
  assert.match(f.render().text, /第 1 条/);
  assert.match(f.render().text, /第 2 条/);
  assert.match(f.render().text, /等待首批缓存/);
  assert.equal(f.options.retry, false);
  assert.equal(f.options.refetchOnWindowFocus, false);
  assert.equal(
    f.options.refetchInterval(
      { items: [batch] },
      { state: { status: 'success' } },
    ),
    3000,
  );
  assert.deepEqual(f.calls, []);
});
test('automatic sequential progress advances locally without any new submit mutation', async () => {
  const f = fixture();
  const saved = {
    ...batch.items[0],
    state: 'succeeded',
    feedId: 'MP_WXS_1234567890',
    bodyReady: true,
  };
  const next = {
    ...batch,
    items: [saved, { ...batch.items[1], state: 'submitting' }],
  };
  await f.deliver([next]);
  await f.deliver([next]);
  assert.deepEqual(f.calls, [['local-view-refresh', true]]);
  const complete = {
    ...next,
    state: 'completed',
    items: [
      saved,
      {
        ...next.items[1],
        state: 'succeeded',
        feedId: 'MP_WXS_9876543210',
        bodyReady: true,
      },
    ],
  };
  await f.deliver([complete]);
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.options.refetchInterval(
      { items: [complete] },
      { state: { status: 'success' } },
    ),
    false,
  );
  assert.match(f.render().text, /处理结束/);
});
test('reopened persisted progress reads all links without re-enqueueing', async () => {
  const f = fixture([batch]);
  await f.deliver([batch]);
  assert.match(f.render().text, /本批 2 条/);
  assert.deepEqual(f.calls, []);
});
test('blocked batch pauses automatic actions; explicit resume guards duplicate clicks', async () => {
  const paused = {
    ...batch,
    state: 'paused',
    items: [{ ...batch.items[0], state: 'blocked' }, batch.items[1]],
  };
  const f = fixture([paused]);
  assert.equal(
    f.options.refetchInterval(
      { items: [paused] },
      { state: { status: 'success' } },
    ),
    false,
  );
  assert.deepEqual(f.calls, []);
  let done;
  f.setResumeWait(new Promise((r) => (done = r)));
  const press = f.button('检查账号后继续').props.onPress;
  const first = press();
  await press();
  assert.equal(
    f.calls.filter((c) => Array.isArray(c) && c[0] === 'resume').length,
    1,
  );
  assert.equal(f.calls[0][1].batchId, batch.batchId);
  done();
  await first;
});
test('stop is explicit and uses saved batch identity, never a pasted URL', async () => {
  const f = fixture();
  await f.button('停止未执行项').props.onPress();
  assert.equal(f.calls[0][0], 'stop');
  assert.equal(f.calls[0][1].batchId, batch.batchId);
  assert.equal(f.calls.at(-1), 'local-task-read');
  f.setData([
    {
      ...batch,
      state: 'stopped',
      items: [batch.items[0], { ...batch.items[1], state: 'cancelled' }],
    },
  ]);
  assert.match(f.render().text, /已停止，未提交/);
  assert.equal(
    f.options.refetchInterval(
      { items: [{ ...batch, state: 'stopped' }] },
      { state: { status: 'success' } },
    ),
    3000,
  );
});
test('connection errors stop polling and only offer a local read', async () => {
  const f = fixture();
  f.setError(true);
  assert.equal(
    f.options.refetchInterval(
      { items: [batch] },
      { state: { status: 'error' } },
    ),
    false,
  );
  await f.button('重新读取进度').props.onPress();
  assert.deepEqual(f.calls, ['local-task-read']);
});
test('local view failure retries only local views, without submitting again', async () => {
  const persisted = {
    ...batch,
    items: [{ ...batch.items[0], feedId: 'MP_WXS_1234567890' }, batch.items[1]],
  };
  const f = fixture([persisted]);
  f.setSavingFails(true);
  await f.deliver([persisted]);
  assert.match(f.render().text, /列表尚未显示/);
  f.setSavingFails(false);
  await f.deliver([persisted]);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every((c) => c[0] === 'local-view-refresh'));
});

test('older accepted single tasks remain visible and finish using local reads only', async () => {
  const task = { taskId: 'a'.repeat(64), state: 'pending', phase: 'identity' };
  const f = fixture([task], false, true);
  assert.match(f.render().text, /仍在处理/);
  assert.equal(
    f.options.refetchInterval(
      { items: [task] },
      { state: { status: 'success' } },
    ),
    3000,
  );
  const saved = { ...task, state: 'succeeded', feedId: 'MP_WXS_1234567890' };
  await f.deliver([saved]);
  assert.deepEqual(f.calls, [['local-view-refresh', true]]);
  assert.equal(
    f.options.refetchInterval(
      { items: [saved] },
      { state: { status: 'success' } },
    ),
    false,
  );
});
test('source-preserved completion does not claim newly imported or fully ready content', () => {
  const f = fixture([
    {
      ...batch,
      state: 'completed',
      items: [
        {
          index: 0,
          state: 'succeeded',
          feedId: 'MP_WXS_1234567890',
          message: '已有订阅，保留原来源。',
        },
      ],
    },
  ]);
  assert.match(f.render().text, /已有订阅/);
  assert(!f.render().text.includes('正文已确认完成'));
  assert(!f.render().text.includes('文章已同步'));
});
test('completed batch metadata continues local polling and refreshes the real publisher name', async () => {
  const task = {
    taskId: 'b'.repeat(64),
    feedId: 'MP_WXS_1234567890',
    state: 'pending',
    phase: 'metadata',
  };
  const f = fixture([task], false, true, [task.taskId]);
  assert.equal(
    f.options.refetchInterval(
      { items: [task] },
      { state: { status: 'success' } },
    ),
    3000,
  );
  await f.deliver([task]);
  await f.deliver([{ ...task, state: 'succeeded' }]);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every((c) => c[0] === 'local-view-refresh'));
  assert.equal(
    f.options.refetchInterval(
      { items: [{ ...task, state: 'succeeded' }] },
      { state: { status: 'success' } },
    ),
    false,
  );
  assert.equal(f.render().text, '');
});
