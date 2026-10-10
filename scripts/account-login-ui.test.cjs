'use strict';
// Execute the actual TSX handlers with offline hooks and synthetic tRPC replies.
// This verifies application behavior, not a browser, QR scan or platform login.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(
  require.resolve('typescript', { paths: [path.join(root, 'apps/web')] }),
);
const syntheticWechatStatus = {
  configured: true,
  code: 'AVAILABLE',
  available: true,
  challenged: false,
  checkedAt: '2026-10-10T04:00:00.000Z',
  message: '合成实例账号状态，仅只读检查。',
};
test('Wechat2RSS status is manual-only and does not use local login operations', async () => {
  const f = fixture();
  const view = f.render();
  assert.match(view.text, /本地微信读书账号不控制此来源/);
  assert.match(view.text, /尚未检查实例账号状态/);
  assert.equal(f.wechatOptions.enabled, false);
  assert.equal(f.wechatOptions.retry, false);
  assert.equal(f.wechatOptions.refetchOnWindowFocus, false);
  assert.equal(f.wechatOptions.refetchOnReconnect, false);
  assert.equal(f.wechatOptions.refetchInterval, false);
  assert.equal(f.calls.length, 0);
  await f.button('检查实例账号状态').props.onPress();
  assert.deepEqual(f.calls, ['wechat-status-read']);
});
test('Wechat2RSS available and challenged states, wait time and check time remain separate', () => {
  for (const [available, challenged, label] of [
    [true, false, '账号可用'],
    [false, true, '待官方验证'],
    [false, false, '账号暂不可用'],
    [true, true, '部分账号待官方验证'],
  ]) {
    const f = fixture({
      wechatStatus: {
        ...syntheticWechatStatus,
        available,
        challenged,
        retryAfter: '合成等待30秒',
      },
    });
    const view = f.render();
    assert.match(view.text, new RegExp(label));
    assert.match(view.text, /合成等待30秒/);
    assert.match(view.text, /检查时间（北京时间）/);
    assert.equal(f.calls.length, 0);
  }
});
test('Wechat2RSS status failure hides stale status and does not auto retry or login', () => {
  const f = fixture({ wechatError: true, wechatStatus: syntheticWechatStatus });
  const view = f.render();
  assert.match(view.text, /实例账号状态读取失败/);
  assert(!view.text.includes('账号可用'));
  assert.equal(f.calls.length, 0);
});
test('unconfigured and failed upstream status do not imply usable accounts or a fake check date', () => {
  for (const [code, checkedAt, label] of [
    ['SOURCE_UNAVAILABLE', null, '实例未配置'],
    ['STATUS_CHECK_FAILED', syntheticWechatStatus.checkedAt, '状态读取失败'],
  ]) {
    const f = fixture({
      wechatStatus: {
        ...syntheticWechatStatus,
        available: false,
        code,
        checkedAt,
      },
    });
    const view = f.render();
    assert.match(view.text, new RegExp(label));
    assert(!/1970|Invalid Date|账号可用/.test(view.text));
    if (!checkedAt) assert.match(view.text, /尚未检查/);
  }
});
test('Wechat2RSS status button guards rapid double clicks and disables during a read', async () => {
  const f = fixture();
  let release;
  f.wechatWait = new Promise((done) => {
    release = done;
  });
  const button = f.button('检查实例账号状态');
  const read = button.props.onPress();
  await button.props.onPress();
  assert.deepEqual(f.calls, ['wechat-status-read']);
  release();
  await read;
  const busy = fixture({ wechatFetching: true });
  assert.equal(busy.button('检查实例账号状态').props.isDisabled, true);
  await busy.button('检查实例账号状态').props.onPress();
  assert.equal(busy.calls.length, 0);
});
function fixture({
  count = 0,
  loginData = null,
  relogin = '123',
  accounts = [],
  notices = [],
  expanded = false,
  wechatStatus,
  wechatError = false,
  wechatFetching = false,
} = {}) {
  const state = [count, relogin, '', null],
    refs = [],
    calls = [];
  let cursor = 0,
    refCursor = 0,
    createOptions,
    resultOptions,
    resultInput,
    createFails = false,
    cancelWait,
    wechatOptions,
    wechatWait;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (i >= state.length) state[i] = initial;
      return [
        state[i],
        (next) => {
          state[i] = typeof next === 'function' ? next(state[i]) : next;
        },
      ];
    },
    useRef(initial) {
      const i = refCursor++;
      return refs[i] || (refs[i] = { current: initial });
    },
    useId: () => 'synthetic-notice',
    useEffect() {},
  };
  const jsx = (type, props) => ({ type, props });
  const query = (name) => async () => {
    calls.push(name);
  };
  const utils = {
    platform: {
      getLoginResult: {
        cancel: async () => {
          calls.push('cancel');
          await cancelWait;
        },
      },
    },
    collection: {
      verificationStatus: { invalidate: query('verification-read') },
    },
    account: { manualRefreshOptions: { invalidate: query('connection-read') } },
  };
  const forbiddenMutation = {
    useMutation: () => ({
      mutateAsync() {
        throw Error('UNEXPECTED_ACCOUNT_WRITE');
      },
    }),
  };
  const trpc = {
    useUtils: () => utils,
    account: {
      wechat2rssStatus: {
        useQuery(_input, options) {
          wechatOptions = options;
          return {
            data: wechatStatus,
            isError: wechatError,
            isFetching: wechatFetching,
            async refetch() {
              calls.push('wechat-status-read');
              await wechatWait;
            },
          };
        },
      },
      list: {
        useQuery: () => ({
          data: { items: accounts, blocks: [] },
          refetch: query('account-read'),
          isFetching: false,
        }),
      },
      edit: forbiddenMutation,
      delete: forbiddenMutation,
      manualRefreshOptions: {
        useQuery: () => ({ isFetching: false, data: { options: [] } }),
      },
      connectManualRefresh: {
        useMutation: () => ({
          isLoading: false,
          mutate() {
            throw Error('UNEXPECTED_BINDING');
          },
        }),
      },
    },
    platform: {
      createLoginUrl: {
        useMutation(options) {
          createOptions = options;
          return {
            data: loginData,
            isLoading: false,
            reset() {
              loginData = null;
            },
            async mutateAsync() {
              calls.push('create-qr');
              if (createFails) {
                const err = Error('Synthetic QR failure');
                options.onError(err);
                throw err;
              }
              loginData = {
                uuid: 'new-qr',
                scanUrl: 'https://example.invalid/offline-qr',
              };
              options.onSuccess(loginData);
              return loginData;
            },
          };
        },
      },
      getLoginResult: {
        useQuery(input, options) {
          resultInput = input;
          resultOptions = options;
          return { data: undefined };
        },
      },
    },
    collection: {
      verificationStatus: {
        useQuery: () => ({
          data: { notices, unavailable: false },
          refetch: query('local-state-read'),
          isFetching: false,
        }),
      },
    },
  };
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@nextui-org/react': Object.fromEntries(
      [
        'Modal',
        'ModalContent',
        'ModalHeader',
        'ModalBody',
        'ModalFooter',
        'Button',
        'Spinner',
      ].map((n) => [n, n]),
    ),
    'qrcode.react': { QRCodeSVG: 'QRCodeSVG' },
    sonner: {
      toast: Object.fromEntries(
        ['success', 'error', 'warning'].map((n) => [
          n,
          (message) => calls.push(n + ':' + message),
        ]),
      ),
    },
    '@web/components/PlusIcon': { PlusIcon: 'PlusIcon' },
    '@web/components/StatusDropdown': { StatusDropdown: 'StatusDropdown' },
    '@web/utils/trpc': { trpc },
    '../utils/trpc': { trpc },
    '@web/constants': { statusMap: { 0: { label: '失效' } } },
    'react-router-dom': {
      Link: 'Link',
      useLocation: () => ({ pathname: '/feeds' }),
    },
  };
  modules['@nextui-org/react'].useDisclosure = () => ({
    isOpen: true,
    onOpen: query('open'),
    onClose: query('close'),
    onOpenChange: query('close'),
  });
  function compile(file) {
    const exports = {};
    const code = ts.transpileModule(
      fs.readFileSync(path.join(root, file), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText;
    vm.runInNewContext(
      code,
      {
        exports,
        require(name) {
          assert.ok(name in modules, 'Unexpected dependency ' + name);
          return modules[name];
        },
        window: { location: { hostname: 'localhost' } },
        setTimeout() {
          throw Error('UNCONTROLLED_TIMER');
        },
        clearTimeout() {},
      },
      { filename: file },
    );
    return exports.default;
  }
  const accountPage = compile(
    'apps/web/src/pages/accounts/legacy-accounts.tsx',
  );
  const noticePage = compile(
    'apps/web/src/components/OwnerVerificationNotice.tsx',
  );
  function render(component = accountPage) {
    cursor = refCursor = 0;
    const nodes = [],
      text = [];
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (typeof value === 'function') return visit(value());
      if (typeof value === 'string' || typeof value === 'number') {
        text.push(String(value));
        return;
      }
      if (!value || typeof value !== 'object') return;
      nodes.push(value);
      visit(value.props?.children);
    };
    visit(component());
    return { nodes, text: text.join('') };
  }
  const button = (name, tree = render()) =>
    tree.nodes.find(
      (n) => ['Button', 'button'].includes(n.type) && n.props.children === name,
    );
  return {
    render,
    button,
    calls,
    state,
    get wechatOptions() {
      return wechatOptions;
    },
    set wechatWait(value) {
      wechatWait = value;
    },
    get resultOptions() {
      return resultOptions;
    },
    get resultInput() {
      return resultInput;
    },
    set createFails(value) {
      createFails = value;
    },
    set cancelWait(value) {
      cancelWait = value;
    },
    renderNotice() {
      state[0] = expanded;
      state[1] = false;
      return render(noticePage);
    },
  };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
test('saved expiry overrides enabled account display while challenge remains separate', () => {
  const f = fixture({
    accounts: [
      {
        id: '123',
        status: 1,
        loginState: 'expired',
        verificationRequired: true,
        nativeLoginAt: null,
      },
    ],
  });
  const tree = f.render();
  assert.ok(tree.text.includes('登录已过期'));
  assert.ok(tree.text.includes('需官方验证'));
  assert.ok(f.button('重新扫码登录', tree));
  assert.ok(!f.button('连接手动更新', tree));
  assert.deepEqual(f.calls, []);
});
test('expired QR stops polling and only an explicit retry creates a new QR for the same account', async () => {
  const f = fixture({
    loginData: { uuid: 'old-qr', scanUrl: 'https://example.invalid/old' },
  });
  assert.ok(f.render().text.includes('二维码已过期'));
  assert.equal(f.resultOptions.enabled, false);
  f.button('重新生成二维码').props.onPress();
  await flush();
  f.render();
  assert.equal(f.state[1], '123');
  assert.equal(f.resultInput.id, 'new-qr');
  assert.equal(f.resultOptions.enabled, true);
  assert.equal(f.calls.filter((c) => c === 'create-qr').length, 1);
  assert.ok(f.calls.indexOf('cancel') < f.calls.indexOf('create-qr'));
});
test('QR creation and polling failures retain explicit same-account retry without automatic requests', async () => {
  const f = fixture({ accounts: [{ id: '123', status: 0 }] });
  f.createFails = true;
  f.button('重新扫码登录').props.onClick();
  await flush();
  assert.ok(f.render().text.includes('Synthetic QR failure'));
  assert.equal(f.calls.filter((c) => c === 'create-qr').length, 1);
  f.createFails = false;
  f.button('重新生成二维码').props.onPress();
  await flush();
  f.render();
  f.resultOptions.onError(Error('Synthetic polling failure'));
  assert.ok(f.render().text.includes('Synthetic polling failure'));
  assert.equal(f.resultOptions.enabled, false);
  assert.ok(f.button('重新生成二维码'));
  assert.equal(f.state[1], '123');
  assert.equal(f.calls.filter((c) => c === 'create-qr').length, 2);
});
test('queued duplicate retry waits for old polling cancellation and creates one QR', async () => {
  const f = fixture({
    loginData: { uuid: 'old-qr', scanUrl: 'https://example.invalid/old' },
  });
  let release;
  f.cancelWait = new Promise((resolve) => {
    release = resolve;
  });
  const retry = f.button('重新生成二维码').props.onPress;
  retry();
  retry();
  await flush();
  assert.equal(f.calls.filter((c) => c === 'create-qr').length, 0);
  release();
  await flush();
  assert.equal(f.calls.filter((c) => c === 'cancel').length, 1);
  assert.equal(f.calls.filter((c) => c === 'create-qr').length, 1);
});
test('saved login refreshes account and verification metadata without another save or collection', async () => {
  const f = fixture({
    count: 60,
    loginData: { uuid: 'qr', scanUrl: 'https://example.invalid/offline' },
    accounts: [{ id: '123', status: 1, verificationRequired: true }],
  });
  f.render();
  await f.resultOptions.onSuccess({ saved: true, vid: 123 });
  assert.equal(f.calls.filter((c) => c === 'account-read').length, 1);
  assert.equal(f.calls.filter((c) => c === 'verification-read').length, 1);
  assert.equal(f.calls.filter((c) => c === 'connection-read').length, 1);
  assert.ok(f.calls.some((c) => c.includes('未自动解除')));
  assert.ok(f.render().text.includes('需官方验证'));
  assert.equal(f.calls.filter((c) => c === 'create-qr').length, 0);
});
test('global notice separates saved expiry from challenge and labels homepage as ordinary', async () => {
  for (const kind of ['expired', 'verification_required']) {
    const f = fixture({
      expanded: true,
      notices: [
        {
          feedId: 'synthetic',
          feedName: 'fixture',
          state: kind,
          stage: '目录',
          accountName: 'fixture',
          accountTail: '1234',
          officialUrl: 'https://weread.qq.com/',
        },
      ],
    });
    const tree = f.renderNotice();
    assert.ok(
      tree.text.includes(
        kind === 'expired' ? '登录已过期' : '未提供可核验的官方验证地址',
      ),
    );
    const anchor = tree.nodes.find((n) => n.type === 'a');
    assert.equal(anchor.props.href, 'https://weread.qq.com/');
    assert.ok(anchor.props.children.includes('非验证地址'));
    const read = f.button('刷新本机状态（只读）', tree);
    await read.props.onClick();
    assert.deepEqual(f.calls, ['local-state-read']);
  }
});
