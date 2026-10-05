'use strict';
// Compile the actual page with offline hooks/JSX/fetch facades. Effects do not
// execute; this is application-handler regression, not real browser acceptance.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = createRequire(path.join(root, 'apps/web/package.json'))(
  'typescript',
);
function compile(file, require, globals = {}) {
  const code = ts.transpileModule(
    fs.readFileSync(path.join(root, file), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports = {};
  vm.runInNewContext(
    code,
    { exports, require, ...globals },
    { filename: file },
  );
  return exports;
}
function page({ phase = 'ready', busy = false, directoryReply } = {}) {
  const task = {
    taskId: '12345678-1234-1234-1234-123456789012',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    state: phase,
    code: 'SAVE_RETRY_REQUIRED',
  };
  const state = [
    'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv',
    { directory: 'synthetic-old-path', askEveryTime: false },
    busy,
    '',
    null,
    '',
    null,
    true,
    { ...task },
  ];
  const refs = [],
    calls = [];
  let cursor = 0,
    refCursor = 0,
    backendPath = 'synthetic-old-path',
    backendTask = { ...task };
  const hooks = {
    useState: () => {
      const i = cursor++;
      return [
        state[i],
        (next) => {
          state[i] = typeof next === 'function' ? next(state[i]) : next;
        },
      ];
    },
    useRef: (value) => {
      const i = refCursor++;
      return refs[i] || (refs[i] = { current: value });
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  const shared = compile('packages/shared/src/browser-article-task.ts', () => {
    throw Error('unexpected shared dependency');
  });
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@nextui-org/react': {
      Button: 'Button',
      Input: 'Input',
      Checkbox: 'Checkbox',
    },
    '@web/utils/auth': { getAuthCode: () => 'synthetic-access' },
    '@web/utils/env': { serverOriginUrl: '' },
    '@wewe-rss/shared': shared,
    '@web/utils/article-download-error': {
      ArticleDownloadRequestError: class extends Error {},
      verificationFromDownloadError: () => null,
    },
    './article-verification-notice': { default: 'Notice' },
  };
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith('/directory')) {
      const selected = directoryReply
        ? await directoryReply()
        : {
            directory: 'synthetic-new-path',
            askEveryTime: false,
            pickToken: 'synthetic-grant',
            cancelled: false,
          };
      if (!selected.cancelled) backendPath = selected.directory;
      return { ok: true, json: async () => selected };
    }
    if (url.endsWith('/save')) {
      if (backendTask.state === 'cancelled')
        return { ok: false, json: async () => ({ message: '任务已取消' }) };
      if (backendPath === 'synthetic-old-path')
        return {
          ok: false,
          json: async () => ({
            code: 'SAVE_PATH_TOO_LONG',
            message: '请选择较短路径',
          }),
        };
      backendTask = { ...backendTask, state: 'saved' };
      return {
        ok: true,
        json: async () => ({
          saved: true,
          directory: backendPath,
          markdownPath: backendPath + '/正文.md',
          imageCount: 1,
          contentSource: 'verified-provider',
        }),
      };
    }
    if (url.endsWith(task.taskId))
      return { ok: true, json: async () => ({ ...backendTask }) };
    throw Error('unexpected local endpoint');
  };
  const component = compile(
    'apps/web/src/pages/tools/article-download.tsx',
    (name) => {
      if (!(name in modules)) throw Error('unexpected page dependency');
      return modules[name];
    },
    { fetch, AbortController, setTimeout, clearTimeout },
  ).default;
  const render = () => {
    cursor = refCursor = 0;
    const nodes = [];
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      visit(node.props?.children);
    };
    visit(component());
    return nodes;
  };
  const button = (text) =>
    render().find(
      (node) => node.type === 'Button' && node.props.children === text,
    );
  return {
    state,
    calls,
    render,
    button,
    cancel: () => {
      backendTask = {
        ...backendTask,
        state: 'cancelled',
        code: 'TASK_CANCELLED',
      };
      state[8] = { ...backendTask };
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
test('ready path recovery chooses a new directory and retries without changing the article or receiving again', async () => {
  const h = page();
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.state[8].state, 'ready');
  assert.equal(h.state[8].code, 'SAVE_RETRY_REQUIRED');
  const choose = h.button('选择下载路径');
  assert.equal(choose.props.isDisabled, false);
  assert.equal(
    h.render().find((node) => node.type === 'Input').props.isDisabled,
    true,
  );
  assert.equal(h.button('下载正文和图片').props.isDisabled, true);
  choose.props.onPress();
  await flush();
  assert.equal(h.state[1].directory, 'synthetic-new-path');
  assert.equal(h.state[1].askEveryTime, false);
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.state[8].state, 'saved');
  assert.equal(h.state[6].markdownPath, 'synthetic-new-path/正文.md');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/directory')).length, 1);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 2);
  assert.ok(h.calls.every((c) => c.url.startsWith('/download/article/')));
  assert.equal(h.state[0], 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv');
});
test('receiving, saving or busy states keep native directory selection disabled', () => {
  for (const options of [
    { phase: 'waiting' },
    { phase: 'claimed' },
    { phase: 'saving' },
    { phase: 'ready', busy: true },
  ])
    assert.equal(page(options).button('选择下载路径').props.isDisabled, true);
});
test('a cancelled picker preserves the retained task and current directory', async () => {
  const h = page({ directoryReply: async () => ({ cancelled: true }) });
  h.button('选择下载路径').props.onPress();
  await flush();
  assert.equal(h.state[1].directory, 'synthetic-old-path');
  assert.equal(h.state[8].state, 'ready');
  assert.equal(h.calls.length, 1);
});
test('directory selection excludes concurrent actions and its late completion cannot revive a cancelled task', async () => {
  let release;
  const h = page({
    directoryReply: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const staleCancel = h.button('取消接收任务');
  h.button('选择下载路径').props.onPress();
  await flush();
  assert.equal(h.button('选择下载路径').props.isDisabled, true);
  assert.equal(h.button('取消接收任务').props.isDisabled, true);
  staleCancel.props.onPress();
  await flush();
  assert.equal(
    h.calls.length,
    1,
    'shared operation guard blocks the stale cancel handler',
  );
  h.cancel();
  release({
    directory: 'synthetic-new-path',
    askEveryTime: false,
    pickToken: 'synthetic-grant',
    cancelled: false,
  });
  await flush();
  assert.equal(h.state[8].state, 'cancelled');
  assert.equal(h.state[6], null);
  assert.equal(h.button('保存已接收的正文和图片'), undefined);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 0);
});
