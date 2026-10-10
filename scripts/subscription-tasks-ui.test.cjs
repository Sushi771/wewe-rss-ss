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
  storage = new Map(),
) {
  let data = { items: initial },
    queryError = false,
    options,
    stateIndex = 0,
    refIndex = 0,
    savingFails = false,
    resumeWait;
  const effects = [],
    notifications = [];
  const states = [],
    refs = [],
    calls = [];
  const hooks = {
    useEffect(effect) {
      effects.push(effect);
    },
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
      ),
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
      document: { body: { syntheticPortalRoot: true } },
      localStorage: {
        getItem: (key) => storage.get(key),
        setItem: (key, value) => storage.set(key, value),
      },
      require(id) {
        if (id === 'react') return hooks;
        if (id === 'sonner')
          return { toast: { success: (...args) => notifications.push(args) } };
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === '@nextui-org/react')
          return new Proxy({}, { get: (_, key) => key });
        if (id === '@web/utils/trpc')
          return {
            trpc: {
              feed: {
                subscriptionBatches: legacy
                  ? {
                      useQuery: () => ({
                        data: { items: [] },
                        isError: false,
                        refetch: async () => {},
                      }),
                    }
                  : query,
                subscriptionTasks: legacy
                  ? query
                  : {
                      useQuery: () => ({
                        data: { items: [] },
                        isError: false,
                        refetch: async () => {},
                      }),
                    },
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
    const tree = module.exports.default({
      adding,
      excluded,
      feeds: [{ id: 'MP_WXS_1234567890', mpName: '合成公众号' }],
      onSaved: async (reveal) => {
        calls.push(['local-view-refresh', reveal]);
        if (savingFails) throw Error('SYNTHETIC_LOCAL_READ');
      },
    });
    effects.splice(0).forEach((effect) => effect());
    return { tree, nodes: walk(tree), text: text(tree) };
  };
  return {
    calls,
    notifications,
    storage,
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

test('main shows only real progress and waits without inventing cache percentage', () => {
  const f = fixture();
  const view = f.render();
  const progress = view.nodes.find((n) => n.type === 'Progress');
  assert.equal(progress.props.value, 0);
  assert.equal(progress.props.maxValue, 2);
  assert.match(
    progress.props.label,
    /上游已受理 0 \/ 共 2.*内容同步 0.*等待缓存/,
  );
  assert(!view.text.includes('添加进度与记录'));
  assert(!view.text.includes('历史记录'));
  assert(!view.text.includes('第 1 条'));
  assert.equal(f.options.retry, false);
  assert.equal(
    f.options.refetchInterval(
      { items: [batch] },
      { state: { status: 'success' } },
    ),
    3000,
  );
  assert.deepEqual(f.calls, []);
});
test('new failures aggregate in body portal; closing never cancels and unchanged polling does not reopen', async () => {
  const f = fixture();
  f.render();
  const failed = {
    ...batch,
    state: 'paused',
    items: [
      { index: 0, state: 'blocked', message: 'SECRET_TECHNICAL_LOG' },
      { index: 1, state: 'failed', message: 'SECRET_TECHNICAL_LOG' },
    ],
  };
  await f.deliver([failed]);
  let view = f.render();
  let modal = view.nodes.find((n) => n.type === 'Modal');
  assert.equal(modal.props.isOpen, true);
  assert.equal(modal.props.portalContainer.syntheticPortalRoot, true);
  assert.equal(modal.props.isKeyboardDismissDisabled, false);
  assert.equal(modal.props.scrollBehavior, 'inside');
  assert.match(view.text, /添加需要处理（2 条）/);
  assert(!view.text.includes('SECRET_TECHNICAL_LOG'));
  assert.equal(
    view.nodes.find((n) => n.type === 'details').props.open,
    undefined,
  );
  modal.props.onOpenChange(false);
  await f.deliver([failed]);
  assert.equal(
    f.render().nodes.find((n) => n.type === 'Modal').props.isOpen,
    false,
  );
  assert.deepEqual(f.calls, []);
  await f.deliver([batch]);
  await f.deliver([failed]);
  assert.equal(
    f.render().nodes.find((n) => n.type === 'Modal').props.isOpen,
    true,
  );
});
test('refresh and changed technical messages do not repeat an acknowledged failure', async () => {
  const f = fixture();
  f.render();
  const failed = {
    ...batch,
    state: 'paused',
    items: [{ index: 0, state: 'failed', message: 'first log' }],
  };
  await f.deliver([failed]);
  f.button('知道了').props.onPress();
  await f.deliver([
    {
      ...failed,
      updatedAt: 999,
      items: [{ ...failed.items[0], message: 'another log' }],
    },
  ]);
  assert.equal(
    f.render().nodes.find((n) => n.type === 'Modal').props.isOpen,
    false,
  );
  const reopened = fixture([failed], false, false, [], f.storage);
  reopened.render();
  assert.equal(
    reopened.render().nodes.find((n) => n.type === 'Modal').props.isOpen,
    false,
  );
  assert(reopened.button('继续检查原请求'));
});
test('historical failure at mount is quiet and failed or cancelled work never counts as success', () => {
  const f = fixture([
    {
      ...batch,
      state: 'paused',
      items: [
        { index: 0, state: 'failed' },
        { index: 1, state: 'cancelled' },
      ],
    },
  ]);
  f.render();
  const view = f.render();
  assert.equal(view.nodes.find((n) => n.type === 'Modal').props.isOpen, false);
  assert.equal(view.nodes.find((n) => n.type === 'Progress').props.value, 0);
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
  assert.equal(f.notifications.length, 1);
  assert(!f.render().nodes.some((n) => n.type === 'Progress'));
});
test('reopened persisted progress reads all links without re-enqueueing', async () => {
  const f = fixture([batch]);
  await f.deliver([batch]);
  assert.match(
    f.render().nodes.find((n) => n.type === 'Progress').props.label,
    /共 2/,
  );
  assert.deepEqual(f.calls, []);
});
test('blocked batch pauses automatic actions; explicit resume guards duplicate clicks', async () => {
  const paused = {
    ...batch,
    state: 'paused',
    items: [{ ...batch.items[0], state: 'blocked' }, batch.items[1]],
  };
  const f = fixture();
  f.render();
  await f.deliver([paused]);
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
  const press = f.button('继续检查原请求').props.onPress;
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
  assert.match(
    f.render().nodes.find((n) => n.type === 'Progress').props.label,
    /共 2/,
  );
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
  assert.match(
    f.render().nodes.find((n) => n.type === 'Progress').props.label,
    /处理中/,
  );
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
  assert(!f.render().nodes.some((n) => n.type === 'Progress'));
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
  assert(!f.render().nodes.some((n) => n.type === 'Progress'));
  assert.equal(
    f.render().nodes.find((n) => n.type === 'Modal').props.isOpen,
    false,
  );
});

test('identity isolation and a locally disabled feed never accuse the collection account', async () => {
  for (const [code, explanation] of [
    ['LEGACY_IDENTITY_UNVERIFIED', '部分旧文章身份待核实'],
    ['SUBSCRIPTION_PAUSED', '本地订阅已停用'],
  ]) {
    const f = fixture();
    f.render();
    await f.deliver([
      {
        ...batch,
        state: 'paused',
        items: [{ index: 0, state: 'blocked', code }],
      },
    ]);
    const view = f.render();
    assert(view.text.includes(explanation));
    assert(!view.text.includes('检查账号后继续'));
    assert(!view.text.includes('账号不可用'));
    assert.deepEqual(f.calls, []);
  }
});

test('a stopped batch stays stopped while its saved feed metadata is projected and refreshed', async () => {
  const saved = {
    ...batch,
    state: 'stopped',
    items: [
      {
        index: 0,
        state: 'succeeded',
        feedId: 'MP_WXS_1234567890',
        listReady: true,
        bodyReady: false,
        metadataPending: true,
        code: 'LEGACY_IDENTITY_UNVERIFIED',
      },
      { index: 1, state: 'cancelled' },
    ],
  };
  const f = fixture([saved]);
  await f.deliver([saved]);
  assert.equal(
    f.options.refetchInterval(
      { items: [saved] },
      { state: { status: 'success' } },
    ),
    3000,
  );
  const ready = {
    ...saved,
    items: [{ ...saved.items[0], metadataPending: false }, saved.items[1]],
  };
  await f.deliver([ready]);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every((call) => call[0] === 'local-view-refresh'));
  assert.equal(
    f.options.refetchInterval(
      { items: [ready] },
      { state: { status: 'success' } },
    ),
    false,
  );
  assert.deepEqual(f.notifications, []);
});

test('six-link paused progress reports the accepted first feed separately from unsynchronized content', () => {
  const f = fixture([
    {
      ...batch,
      state: 'paused',
      items: Array.from({ length: 6 }, (_, index) =>
        index === 0
          ? {
              index,
              state: 'failed',
              accepted: true,
              taskId: 'c'.repeat(64),
              feedId: 'MP_WXS_1234567890',
              bodyReady: false,
            }
          : { index, state: 'queued', accepted: false },
      ),
    },
  ]);
  const progress = f.render().nodes.find((node) => node.type === 'Progress');
  assert.equal(progress.props.value, 1);
  assert.match(
    progress.props.label,
    /上游已受理 1 \/ 共 6.*内容同步 0.*提交已暂停/,
  );
  assert.deepEqual(f.calls, []);
});

test('image-pending completion preserves the subscription and warns without claiming complete offline content', async () => {
  const f = fixture();
  f.render();
  const partial = {
    ...batch,
    state: 'completed',
    items: [
      {
        index: 0,
        state: 'succeeded',
        feedId: 'MP_WXS_1234567890',
        bodyReady: false,
        code: 'CACHE_IMAGES_PENDING',
        imagePendingCount: 1,
      },
    ],
  };
  await f.deliver([partial]);
  let view = f.render();
  assert(view.text.includes('正文已同步；媒体完整性未确认'));
  assert(view.text.includes('正文和有效图片可保存'));
  assert(!view.text.includes('完整离线保存尚未就绪'));
  assert(!view.text.includes('部分订阅暂未完成'));
  assert(!view.nodes.some((node) => node.type === 'Progress'));
  assert.match(f.notifications[0][0], /订阅已保留.*媒体完整性未确认/);
  await f.button('知道了').props.onPress();
  await f.deliver([{ ...partial, updatedAt: Date.now() }]);
  view = f.render();
  assert.equal(
    view.nodes.find((node) => node.type === 'Modal').props.isOpen,
    false,
  );
  assert(f.calls.every((call) => call[0] === 'local-view-refresh'));
});
