'use strict';
// Execute actual account TSX with fake hooks, clock and RPC; no browser/network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(
  require.resolve('typescript', { paths: [path.join(root, 'apps/web')] }),
);
const waiting = {
  state: 'waiting',
  message: '请扫码',
  sessionId: 'synthetic-handle',
  qrcode: 'data:image/png;base64,synthetic',
  expiresAt: 180000,
};
function fixture() {
  const state = [],
    refs = [],
    calls = [],
    timers = new Map(),
    options = {};
  let stateCursor = 0,
    refCursor = 0,
    now = 0,
    timerId = 0,
    cleanup,
    mounted = false;
  let startResult = waiting,
    pollResult = waiting,
    statusError = false;
  const hooks = {
    useState(initial) {
      const i = stateCursor++;
      if (!(i in state)) state[i] = initial;
      return [
        state[i],
        (value) => {
          state[i] = typeof value === 'function' ? value(state[i]) : value;
        },
      ];
    },
    useRef(initial) {
      const i = refCursor++;
      return refs[i] || (refs[i] = { current: initial });
    },
    useEffect(effect) {
      if (!mounted) {
        cleanup = effect();
        mounted = true;
      }
    },
  };
  const account = {
    wechat2rssAccounts: {
      useQuery(_input, config) {
        options.status = config;
        return {
          data: {
            message: '已检查',
            accounts: [{ name: '合成账号', available: true, needCheck: false }],
          },
          isError: statusError,
          async refetch() {
            calls.push('list');
          },
        };
      },
    },
    list: {
      useQuery(_input, config) {
        options.legacy = config;
        return { data: { items: [{ id: 'old', name: '旧账号' }] } };
      },
    },
    wechat2rssLoginStart: {
      useMutation(config) {
        options.start = config;
        return {
          async mutateAsync() {
            calls.push('start');
            const result = await startResult;
            if (result instanceof Error) throw result;
            return result;
          },
        };
      },
    },
    wechat2rssLoginPoll: {
      useMutation(config) {
        options.poll = config;
        return {
          async mutateAsync(input) {
            calls.push(['poll', input]);
            const result = await pollResult;
            if (result instanceof Error) throw result;
            return result;
          },
        };
      },
    },
    wechat2rssLoginClose: {
      useMutation(config) {
        options.close = config;
        return {
          async mutateAsync(input) {
            calls.push(['close', input]);
          },
        };
      },
    },
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        path.join(root, 'apps/web/src/pages/accounts/index.tsx'),
        'utf8',
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
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
        if (id === '@web/utils/trpc') return { trpc: { account } };
        if (id === '@nextui-org/react')
          return Object.fromEntries(
            [
              'Button',
              'Modal',
              'ModalBody',
              'ModalContent',
              'ModalFooter',
              'ModalHeader',
              'Spinner',
            ].map((name) => [name, name]),
          );
        throw Error(id);
      },
      Date: { now: () => now },
      setTimeout(fn, delay) {
        const id = ++timerId;
        timers.set(id, { fn, at: now + delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  const nodes = (node) =>
    !node || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(nodes)
        : [node, ...nodes(node.props?.children)];
  const text = (node) =>
    node == null || typeof node === 'boolean'
      ? ''
      : typeof node !== 'object'
        ? String(node)
        : Array.isArray(node)
          ? node.map(text).join('')
          : text(node.props?.children);
  const render = () => {
    stateCursor = 0;
    refCursor = 0;
    const tree = module.exports.default();
    return { tree, nodes: nodes(tree), text: text(tree) };
  };
  return {
    calls,
    options,
    timers,
    render,
    button(label) {
      const button = render().nodes.find(
        (n) => n.type === 'Button' && text(n) === label,
      );
      assert(button, label);
      return button;
    },
    close() {
      render()
        .nodes.find((n) => n.type === 'Modal')
        .props.onClose();
    },
    unmount() {
      cleanup();
    },
    setStart(value) {
      startResult = value;
    },
    setPoll(value) {
      pollResult = value;
    },
    setError(value) {
      statusError = value;
    },
    async tick(ms = 3000) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          await timer.fn();
        }
    },
  };
}
test('main entry does not initiate login or upstream account reads automatically', async () => {
  const f = fixture();
  const view = f.render();
  assert.match(view.text, /Wechat2RSS 账号/);
  assert.match(view.text, /旧本地账号记录（只读）/);
  assert.equal(f.options.status.enabled, false);
  assert.equal(f.options.legacy.enabled, false);
  for (const key of ['status', 'start', 'poll', 'close'])
    assert.equal(f.options[key].retry, false);
  assert.deepEqual(f.calls, []);
  await f.button('刷新账号状态').props.onPress();
  assert.deepEqual(f.calls, ['list']);
});
test('double submit is blocked before rerender and polling carries only opaque handle', async () => {
  const f = fixture();
  let resolve;
  f.setStart(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const handler = f.button('添加微信账号').props.onPress;
  const first = handler();
  await handler();
  assert.deepEqual(f.calls, ['start']);
  resolve(waiting);
  await first;
  assert.equal(
    f.render().nodes.find((n) => n.type === 'img').props.src,
    waiting.qrcode,
  );
  await f.tick();
  assert.equal(
    JSON.stringify(f.calls[1]),
    JSON.stringify(['poll', { sessionId: waiting.sessionId }]),
  );
  assert.equal(f.timers.size, 1);
});
test('success clears QR, closes session and stops polling; status list refresh follows success', async () => {
  const f = fixture();
  await f.button('添加微信账号').props.onPress();
  f.setPoll({ state: 'succeeded', message: '登录成功' });
  await f.tick();
  assert.match(f.render().text, /登录成功/);
  assert(!f.render().nodes.some((n) => n.type === 'img'));
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.at(-1), 'list');
  await f.tick(180000);
  assert.equal(
    f.calls.filter((x) => Array.isArray(x) && x[0] === 'poll').length,
    1,
  );
});
test('an initially empty QR keeps polling the same session without a new start', async () => {
  const f = fixture();
  f.setStart({
    ...waiting,
    qrcode: undefined,
    message: '正在等待实例生成二维码。',
  });
  await f.button('添加微信账号').props.onPress();
  assert.equal(f.timers.size, 1);
  assert(!f.render().nodes.some((n) => n.type === 'img'));
  await f.tick();
  assert(f.render().nodes.some((n) => n.type === 'img'));
  assert.equal(f.calls.filter((x) => x === 'start').length, 1);
});
test('close before QR creation resolves releases late session without reopening', async () => {
  const f = fixture();
  let resolve;
  f.setStart(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = f.button('添加微信账号').props.onPress();
  f.close();
  resolve(waiting);
  await pending;
  assert.equal(
    f.render().nodes.find((n) => n.type === 'Modal').props.isOpen,
    false,
  );
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.at(-1)[0], 'close');
});
test('close/unmount during polling ignores late success and never schedules another request', async () => {
  for (const action of ['close', 'unmount']) {
    const f = fixture();
    await f.button('添加微信账号').props.onPress();
    let resolve;
    f.setPoll(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = f.tick();
    f[action]();
    resolve({ state: 'succeeded', message: '迟到成功' });
    await pending;
    await f.tick();
    assert.equal(f.timers.size, 0);
    assert(!f.calls.includes('list'));
    assert.equal(
      f.calls.filter((x) => Array.isArray(x) && x[0] === 'poll').length,
      1,
    );
  }
});
test('local deadline expires without a new upstream request or automatic restart', async () => {
  const f = fixture();
  await f.button('添加微信账号').props.onPress();
  await f.tick(180000);
  assert.match(f.render().text, /本次登录已过期/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.filter((x) => x === 'start').length, 1);
  assert(!f.calls.some((x) => Array.isArray(x) && x[0] === 'poll'));
});
test('poll/start failures stop and never display raw exception or stale status', async () => {
  const f = fixture();
  await f.button('添加微信账号').props.onPress();
  f.setPoll(Error('private-token'));
  await f.tick();
  assert.match(f.render().text, /登录状态读取失败/);
  assert(!f.render().text.includes('private-token'));
  assert.equal(f.timers.size, 0);
  f.setError(true);
  assert(!f.render().text.includes('合成账号'));
  f.setStart(Error('private-cookie'));
  await f.button('重新获取二维码').props.onPress();
  assert.match(f.render().text, /二维码获取失败/);
  assert(!f.render().text.includes('private-cookie'));
});
