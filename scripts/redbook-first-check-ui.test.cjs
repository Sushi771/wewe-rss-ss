const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const source = fs.readFileSync(
  'apps/web/src/utils/redbook-first-check.ts',
  'utf8',
);
function fixture(
  host = '127.0.0.1',
  response = { ok: true, json: async () => ({ phase: 'ready' }) },
) {
  const calls = [];
  const context = {
    exports: {},
    window: { location: { hostname: host } },
    AbortSignal,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (...args) => {
      calls.push(args);
      return response;
    },
  };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  return { ...context.exports, calls };
}
test('private submission rejects public origin and missing access password before fetch', async () => {
  const publicPage = fixture('example.com');
  await assert.rejects(
    publicPage.redbookFirstCheckRequest('session', 'private'),
  );
  assert.equal(publicPage.calls.length, 0);
  const local = fixture();
  await assert.rejects(local.redbookFirstCheckRequest('session', ''));
  assert.equal(local.calls.length, 0);
});
test('each manual action sends exactly one same-origin POST without cookie persistence or redirects', async () => {
  const local = fixture();
  assert.equal(local.calls.length, 0);
  for (const action of [
    'status',
    'session',
    'list',
    'detail',
    'images',
    'sample',
    'review',
    'discard',
  ])
    await local.redbookFirstCheckRequest(action, 'manual-password', {
      confirmRequest: true,
    });
  assert.equal(local.calls.length, 8);
  for (const [url, options] of local.calls) {
    assert.match(url, /^\/local\/redbook\/diagnostic\//);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'manual-password');
  }
});
test('rejection never retries or echoes the submitted secret/server body', async () => {
  const local = fixture('localhost', {
    ok: false,
    json: async () => ({ message: 'private-secret' }),
  });
  await assert.rejects(
    local.redbookFirstCheckRequest('list', 'private-secret'),
    (error) => !error.message.includes('private-secret'),
  );
  assert.equal(local.calls.length, 1);
});
test('component initial server render is inert, with no platform request or stored credential loader', () => {
  const componentSource = fs.readFileSync(
    'apps/web/src/components/RedbookFirstCheck.tsx',
    'utf8',
  );
  const react = require(
    require.resolve('react', { paths: [path.resolve('apps/web')] }),
  );
  const renderer = require(
    require.resolve('react-dom/server', { paths: [path.resolve('apps/web')] }),
  );
  const local = fixture();
  const context = {
    exports: {},
    window: { location: { hostname: 'localhost' } },
    require: (name) =>
      name === 'react'
        ? react
        : name === 'react/jsx-runtime'
          ? require(
              require.resolve(name, { paths: [path.resolve('apps/web')] }),
            )
          : local,
  };
  vm.runInNewContext(
    ts.transpileModule(componentSource, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  const html = renderer.renderToStaticMarkup(
    react.createElement(context.exports.default, {
      creator: {
        id: 'synthetic',
        displayName: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic',
      },
      onEnabled: async () => {},
    }),
  );
  assert.match(html, /本机首次小量检查/);
  assert.equal(local.calls.length, 0);
  assert.doesNotMatch(
    componentSource,
    /localStorage|sessionStorage|getAuthCode|serverOriginUrl|dangerouslySetInnerHTML|console\./,
  );
});

function syntheticDetail() {
  return {
    items: [
      {
        id: 'synthetic-note',
        note_card: {
          note_id: 'synthetic-note',
          type: 'normal',
          title: 'Synthetic title',
          desc: 'Synthetic body\nSecond line <script>never execute</script>',
          time: 1720000000000,
          image_list: [
            { url_default: 'https://example.invalid/one' },
            { url_default: 'https://example.invalid/two' },
          ],
        },
      },
    ],
  };
}

test('detail projection uses only the declared schema and leaves references independent', () => {
  const local = fixture();
  const detail = local.redbookDiagnosticDetail(syntheticDetail());
  assert.equal(detail.text, syntheticDetail().items[0].note_card.desc);
  assert.equal(detail.publishedAtMs, 1720000000000);
  assert.equal(detail.declaredImageCount, 2);
  for (const raw of [
    null,
    [],
    { title: 'guessed', text: 'guessed', publishedAt: 1720000000 },
    { items: [] },
  ])
    assert.equal(local.redbookDiagnosticDetail(raw), undefined);
  const mismatched = syntheticDetail();
  mismatched.items[0].id = 'wrong';
  assert.equal(local.redbookDiagnosticDetail(mismatched), undefined);
  const seconds = syntheticDetail();
  seconds.items[0].note_card.time = 1720000000;
  assert.equal(local.redbookDiagnosticDetail(seconds), undefined);
  assert.equal(local.REDBOOK_DIAGNOSTIC_TTL_MS, 24 * 3600000);
  assert.equal(
    local.formatRedbookTime(1720000000000),
    '2024-07-03 17:46:40（北京时间 UTC+08:00）',
  );
  assert.equal(local.formatRedbookTime(NaN), '未提供有效时间');
});

test('inline preview never admits remote or executable image sources', () => {
  const local = fixture();
  assert.equal(
    local.isRedbookDiagnosticImage({
      ordinal: 1,
      bytes: 3,
      inlineData: 'data:image/png;base64,YWJj',
    }),
    true,
  );
  for (const inlineData of [
    'https://example.invalid/image.png',
    'data:image/svg+xml;base64,YWJj',
    'javascript:alert(1)',
  ])
    assert.equal(
      local.isRedbookDiagnosticImage({ ordinal: 1, bytes: 3, inlineData }),
      false,
    );
  assert.equal(
    local.isRedbookDiagnosticImage({
      ordinal: 1,
      bytes: 1000001,
      inlineData: 'data:image/png;base64,YWJj',
    }),
    false,
  );
});

test('request cancellation propagates without retries', async () => {
  const local = fixture();
  const controller = new AbortController();
  controller.abort();
  await local.redbookFirstCheckRequest(
    'status',
    'synthetic-password',
    {},
    controller.signal,
  );
  assert.equal(local.calls.length, 1);
  assert.equal(local.calls[0][1].signal.aborted, true);
});

// A hook harness runs handlers and server-renders React elements; no browser or network.
function componentHarness(
  transport,
  onEnabled = async () => {},
  browser = true,
) {
  const react = require(
    require.resolve('react', { paths: [path.resolve('apps/web')] }),
  );
  const renderer = require(
    require.resolve('react-dom/server', { paths: [path.resolve('apps/web')] }),
  );
  const states = [],
    refs = [],
    cleanups = [],
    calls = [];
  let stateCursor = 0,
    refCursor = 0,
    effectsRun = false,
    unmounted = false,
    lateSetters = 0;
  const hooks = {
    useState(initial) {
      const slot = stateCursor++;
      if (!(slot in states))
        states[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        states[slot],
        (value) => {
          if (unmounted) lateSetters++;
          states[slot] =
            typeof value === 'function' ? value(states[slot]) : value;
        },
      ];
    },
    useRef(initial) {
      const slot = refCursor++;
      return (refs[slot] ||= { current: initial });
    },
    useEffect(effect) {
      if (!effectsRun) cleanups.push(effect());
    },
  };
  const local = fixture();
  const context = {
    exports: {},
    AbortController,
    ...(browser ? { window: { location: { hostname: 'localhost' } } } : {}),
    require: (name) =>
      name === 'react'
        ? hooks
        : name === 'react/jsx-runtime'
          ? require(
              require.resolve(name, { paths: [path.resolve('apps/web')] }),
            )
          : {
              ...local,
              redbookFirstCheckRequest: async (
                action,
                password,
                payload,
                signal,
              ) => {
                calls.push({ action, password, payload, signal });
                return transport(action, payload, signal);
              },
            },
  };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync('apps/web/src/components/RedbookFirstCheck.tsx', 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    context,
  );
  let tree;
  function render() {
    stateCursor = 0;
    refCursor = 0;
    tree = context.exports.default({
      creator: {
        id: 'synthetic',
        displayName: 'Synthetic',
        profileUrl: 'https://example.invalid/profile',
      },
      onEnabled,
    });
    effectsRun = true;
    return tree;
  }
  function nodes(node) {
    if (arguments.length === 0) node = tree;
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child));
    return [
      node,
      ...(node.props?.children === undefined ? [] : nodes(node.props.children)),
    ];
  }
  function text(node) {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    return text(node.props?.children);
  }
  function find(type, label) {
    const result = nodes().find(
      (node) =>
        node.type === type &&
        (text(node).trim() === label || node.props['aria-label'] === label),
    );
    assert.ok(result, 'missing node: ' + type + ' ' + label);
    return result;
  }
  function input(label, value) {
    const parent = nodes().find(
      (node) => node.type === 'label' && text(node).trim() === label,
    );
    assert.ok(parent, 'missing input label: ' + label);
    const field = nodes(parent).find((node) =>
      ['input', 'textarea'].includes(node.type),
    );
    field.props.onChange({ target: { value, checked: value } });
    render();
  }
  render();
  return {
    calls,
    render,
    nodes,
    find,
    input,
    html: () => renderer.renderToStaticMarkup(tree),
    open: () => {
      find('button', '本机首次小量检查').props.onClick();
      render();
    },
    click: (label) => {
      const button = find('button', label);
      assert.equal(!!button.props.disabled, false, label);
      button.props.onClick();
    },
    unmount: () => {
      unmounted = true;
      cleanups.forEach((cleanup) => cleanup?.());
    },
    lateSetters: () => lateSetters,
  };
}
const flushUi = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};
const summaryFixture = () => ({
  configured: true,
  phase: 'sample-ready',
  expiresAt: Date.now() + 24 * 3600000,
  noteId: 'synthetic-note',
  notes: [{ noteId: 'synthetic-note' }],
});

test('initial render and opening are inert, including a server without window', () => {
  const ui = componentHarness(async () => {
    throw new Error('unexpected request');
  });
  ui.open();
  assert.equal(ui.calls.length, 0);
  assert.match(ui.html(), /24 小时/);
  assert.doesNotMatch(ui.html(), /15\s*分钟/);
  const server = componentHarness(async () => {}, undefined, false);
  assert.equal(server.find('button', '本机首次小量检查').props.disabled, true);
  assert.equal(server.calls.length, 0);
});

test('sample shows readable escaped content, server deadline and limited inline bytes without filling review', async () => {
  const summary = summaryFixture();
  const ui = componentHarness(async (action) =>
    action === 'sample'
      ? {
          ...summary,
          detail: syntheticDetail(),
          images: [
            { ordinal: 1, bytes: 3, inlineData: 'data:image/png;base64,YWJj' },
            {
              ordinal: 2,
              bytes: 3,
              inlineData: 'https://example.invalid/never-fetch',
            },
          ],
        }
      : summary,
  );
  ui.open();
  ui.input(
    '订阅平台的访问密码（平时打开 WeWe 使用的密码）',
    'synthetic-password',
  );
  ui.click('读取本机状态');
  await flushUi();
  ui.render();
  ui.click('查看待核验样本');
  await flushUi();
  ui.render();
  const html = ui.html();
  assert.match(html, /Synthetic title/);
  assert.match(html, /Synthetic body/);
  assert.match(html, /&lt;script&gt;never execute&lt;\/script&gt;/);
  assert.match(html, /响应发布时间：2024-07-03 17:46:40/);
  assert.match(html, /正文响应声明图片数：2/);
  assert.match(html, /可预览已下载图片：1/);
  assert.match(html, /已下载预览合计：3 字节/);
  assert.doesNotMatch(html, /src="https:/);
  assert.match(html, /诊断会话截止：/);
  assert.equal(
    ui.nodes().find((node) => node.type === 'textarea').props.value,
    '',
  );
  assert.equal(
    ui
      .nodes()
      .filter((node) => node.type === 'input' && node.props.type === 'checkbox')
      .every((node) => node.props.checked === false),
    true,
  );
  assert.deepEqual(
    ui.calls.map((call) => call.action),
    ['status', 'sample'],
  );
});

test('rapid duplicate actions send one request; close and reopen ignore its late response', async () => {
  let resolve;
  const ui = componentHarness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  ui.open();
  ui.input(
    '订阅平台的访问密码（平时打开 WeWe 使用的密码）',
    'synthetic-password',
  );
  ui.click('读取本机状态');
  ui.click('读取本机状态');
  assert.equal(ui.calls.length, 1);
  ui.click('关闭');
  ui.render();
  ui.open();
  assert.equal(ui.calls[0].signal.aborted, true);
  resolve(summaryFixture());
  await flushUi();
  ui.render();
  assert.doesNotMatch(ui.html(), /sample-ready|诊断会话截止：/);
  assert.equal(ui.find('button', '读取本机状态').props.disabled, true);
});

test('unmounting a pending detail prevents sample follow-up and state updates', async () => {
  let resolve;
  const ui = componentHarness((action) =>
    action === 'detail'
      ? new Promise((done) => {
          resolve = done;
        })
      : { ...summaryFixture(), phase: 'listed' },
  );
  ui.open();
  ui.input(
    '订阅平台的访问密码（平时打开 WeWe 使用的密码）',
    'synthetic-password',
  );
  ui.click('读取本机状态');
  await flushUi();
  ui.render();
  ui.find('select', '选择一篇待检查笔记').props.onChange({
    target: { value: 'synthetic-note' },
  });
  ui.render();
  ui.click('确认读取这篇正文');
  ui.unmount();
  resolve(summaryFixture());
  await flushUi();
  assert.equal(ui.calls.at(-1).signal.aborted, true);
  assert.deepEqual(
    ui.calls.map((call) => call.action),
    ['status', 'detail'],
  );
  assert.equal(ui.lateSetters(), 0);
});

test('session submission sets a 24-hour absolute deadline and never requests platform data', async () => {
  const ui = componentHarness(async (_, payload) => ({
    configured: true,
    phase: 'ready',
    expiresAt: payload.expiresAt,
  }));
  ui.open();
  ui.input(
    '订阅平台的访问密码（平时打开 WeWe 使用的密码）',
    'synthetic-password',
  );
  ui.input('小红书 a1', 'synthetic-a1');
  ui.input('小红书 web_session', 'synthetic-session');
  const before = Date.now();
  ui.nodes()
    .find((node) => node.type === 'form')
    .props.onSubmit({ preventDefault() {} });
  await flushUi();
  ui.render();
  assert.deepEqual(
    ui.calls.map((call) => call.action),
    ['session'],
  );
  assert.ok(ui.calls[0].payload.expiresAt >= before + 24 * 3600000);
  assert.ok(ui.calls[0].payload.expiresAt <= Date.now() + 24 * 3600000);
  assert.equal(
    ui
      .nodes()
      .filter((node) => node.type === 'input' && node.props.type === 'password')
      .slice(1)
      .every((node) => node.props.value === ''),
    true,
  );
});

test('independent manual review preserves the 2-hour handoff and gives the existing refresh instruction', async () => {
  let enabled = 0;
  const expiresAt = Date.now() + 2 * 3600000;
  const ui = componentHarness(
    async (action) =>
      action === 'review' ? { configured: true, expiresAt } : summaryFixture(),
    async () => {
      enabled++;
    },
  );
  ui.open();
  ui.input(
    '订阅平台的访问密码（平时打开 WeWe 使用的密码）',
    'synthetic-password',
  );
  ui.click('读取本机状态');
  await flushUi();
  ui.render();
  ui.input('原笔记全文', 'independently observed');
  ui.input('原笔记全部图片数量', '2');
  ui.input('原笔记发布时间（北京时间）', '2024-07-03T17:46:40');
  for (const label of [
    '已对照博主主页核实作者归属',
    '已对照原笔记核实全文',
    '已对照原笔记核实全部图片及顺序',
    '已核实原笔记发布时间',
    '我允许后续手动刷新进行正式归档',
  ])
    ui.input(label, true);
  ui.click('提交核验并允许后续手动刷新');
  await flushUi();
  ui.render();
  assert.equal(enabled, 1);
  assert.deepEqual(
    ui.calls.map((call) => call.action),
    ['status', 'review'],
  );
  assert.equal(ui.calls[1].payload.observedText, 'independently observed');
  assert.equal(ui.calls[1].payload.publishedAt, 1720000000);
  assert.match(ui.html(), /正式手工归档会话截止：/);
  assert.match(ui.html(), /正式会话最多 2 小时/);
  assert.match(ui.html(), /刷新此博主/);
  assert.match(ui.html(), /未执行刷新/);
});
