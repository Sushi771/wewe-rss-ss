'use strict';
// Compile the actual page with offline hooks/JSX/fetch facades. Effects do not
// execute only when explicitly requested below, with controlled local timers;
// this is application regression, not real browser acceptance.
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
    { exports, require, Error, ...globals },
    { filename: file },
  );
  return exports;
}
function page({
  phase = 'ready',
  busy = false,
  directoryReply,
  settings = { directory: 'synthetic-old-path', askEveryTime: false },
  effects = false,
  fetchReply,
  taskPresent = true,
  destinationBound = false,
} = {}) {
  const task = {
    taskId: '12345678-1234-1234-1234-123456789012',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    state: phase,
    code: 'SAVE_RETRY_REQUIRED',
    ...(destinationBound ? { destinationBound: true } : {}),
  };
  const state = [
    'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv',
    settings,
    busy,
    '',
    null,
    '',
    null,
    true,
    taskPresent ? { ...task } : null,
    false,
    0,
    false,
    destinationBound,
  ];
  const refs = [],
    calls = [],
    callbacks = [],
    effectSlots = [],
    pendingEffects = new Map(),
    timers = new Map();
  let cursor = 0,
    refCursor = 0,
    callbackCursor = 0,
    effectCursor = 0,
    timerId = 0,
    backendPath = 'synthetic-old-path',
    backendTask = { ...task };
  const hooks = {
    useState: (initial) => {
      const i = cursor++;
      if (i >= state.length) state[i] = initial;
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
    useCallback: (fn, deps) => {
      const i = callbackCursor++;
      if (!callbacks[i] || !sameDeps(callbacks[i].deps, deps))
        callbacks[i] = { fn, deps };
      return callbacks[i].fn;
    },
    useEffect: (fn, deps) => {
      if (!effects) return;
      const i = effectCursor++;
      if (!effectSlots[i] || !sameDeps(effectSlots[i].deps, deps))
        pendingEffects.set(i, () => {
          effectSlots[i]?.cleanup?.();
          effectSlots[i] = { deps, cleanup: fn() };
        });
    },
  };
  function sameDeps(a, b) {
    return a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));
  }
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
    if (fetchReply) {
      const reply = await fetchReply(url, options);
      if (reply !== undefined) return reply;
    }
    if (url.endsWith('/settings'))
      return {
        ok: true,
        json: async () => ({ ...settings }),
      };
    if (url.endsWith('/browser-task'))
      return { ok: true, json: async () => ({ available: false }) };
    if (url.endsWith('/cancel')) {
      backendTask = {
        ...backendTask,
        state: 'cancelled',
        code: 'TASK_CANCELLED',
      };
      return { ok: true, json: async () => ({ ...backendTask }) };
    }
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
    {
      fetch,
      URL,
      AbortController,
      setTimeout: (fn, delay) => {
        timers.set(++timerId, { fn, delay });
        return timerId;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  ).default;
  const render = () => {
    cursor = refCursor = callbackCursor = effectCursor = 0;
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
      (node) =>
        node.type === 'Button' &&
        (node.props.children === text || node.props['aria-label'] === text),
    );
  return {
    state,
    calls,
    render,
    button,
    runEffects: () => {
      render();
      const pending = [...pendingEffects.values()];
      pendingEffects.clear();
      pending.forEach((run) => run());
    },
    unmount: () => effectSlots.forEach((slot) => slot.cleanup?.()),
    timers,
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

test('a local poll failure retains the same task; explicit read recovery never cancels or reissues it', async () => {
  let failRead = true;
  let release;
  const h = page({
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012')) {
        if (failRead) throw Error('synthetic local connection loss');
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    },
  });
  h.runEffects();
  await flush();
  assert.equal(h.state[8].state, 'ready');
  assert.equal(h.button('保存已接收的正文和图片').props.isDisabled, true);
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/cancel')),
    false,
  );
  failRead = false;
  h.button('重新读取本机任务状态').props.onPress();
  h.runEffects();
  await flush();
  assert.equal(h.button('保存已接收的正文和图片').props.isDisabled, true);
  assert.equal(h.button('重新读取本机任务状态').props.isDisabled, true);
  release({ ok: true, json: async () => ({ ...h.state[8] }) });
  await flush();
  assert.equal(h.button('保存已接收的正文和图片').props.isDisabled, false);
  assert.equal(h.button('重新读取本机任务状态'), undefined);
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/cancel')),
    false,
  );
  assert.ok(h.calls.every((c) => c.method === 'GET'));
  h.unmount();
  await flush();
  assert.equal(h.calls.filter((c) => c.url.endsWith('/cancel')).length, 1);
});

test('a late recovered local poll cannot revive a cancelled task', async () => {
  let release;
  const h = page({
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012'))
        return new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  h.runEffects();
  await flush();
  const ready = { ...h.state[8] };
  h.button('取消接收任务').props.onPress();
  await flush();
  assert.equal(h.state[8].state, 'cancelled');
  release({ ok: true, json: async () => ready });
  await flush();
  assert.equal(h.state[8].state, 'cancelled');
  assert.equal(h.button('保存已接收的正文和图片'), undefined);
  h.unmount();
});

test('a save with unreadable final status requires same-task read before another save', async () => {
  let unreadable = true;
  const h = page({
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012') && unreadable)
        throw Error('synthetic status loss after save');
    },
  });
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.state[8].state, 'saving');
  assert.ok(h.button('重新读取本机任务状态'));
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 1);
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/cancel')),
    false,
  );
  unreadable = false;
  h.button('重新读取本机任务状态').props.onPress();
  h.runEffects();
  await flush();
  assert.equal(h.state[8].state, 'ready');
  h.button('选择下载路径').props.onPress();
  await flush();
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.state[8].state, 'saved');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 2);
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/cancel')),
    false,
  );
  h.unmount();
});

test('successful save followed by status loss is recovered as saved without another save or capture', async () => {
  let unreadable = true;
  const h = page({
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012') && unreadable)
        throw Error('synthetic status loss after committed save');
    },
  });
  h.button('选择下载路径').props.onPress();
  await flush();
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.ok(h.state[6].markdownPath.endsWith('/正文.md'));
  assert.equal(h.state[8].state, 'saving');
  assert.equal(h.button('保存已接收的正文和图片'), undefined);
  unreadable = false;
  h.button('重新读取本机任务状态').props.onPress();
  h.runEffects();
  await flush();
  assert.equal(h.state[8].state, 'saved');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 1);
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/cancel')),
    false,
  );
  h.unmount();
});

test('failed initial preferences read can recover locally without changing its remembered path or asking policy', async () => {
  let failRead = true;
  const remembered = {
    directory: 'synthetic-remembered-path',
    askEveryTime: true,
  };
  const h = page({
    settings: null,
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/settings')) {
        if (failRead) throw Error('synthetic settings connection loss');
        return { ok: true, json: async () => ({ ...remembered }) };
      }
    },
  });
  h.runEffects();
  await flush();
  assert.equal(h.button('选择下载路径').props.isDisabled, true);
  failRead = false;
  h.button('重新读取保存设置').props.onPress();
  await flush();
  assert.deepEqual(h.state[1], remembered);
  assert.equal(h.button('重新读取保存设置'), undefined);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/settings')).length, 2);
  assert.equal(
    h.calls.some(
      (c) => c.url.endsWith('/directory') || c.url.endsWith('/save'),
    ),
    false,
  );
  h.unmount();
});

test('failed asking-policy update rolls back the selection without losing the remembered directory', async () => {
  const remembered = {
    directory: 'synthetic-remembered-path',
    askEveryTime: true,
  };
  const h = page({
    phase: 'cancelled',
    settings: remembered,
    fetchReply: async (url) => {
      if (url.endsWith('/settings'))
        throw Error('synthetic persistence failure');
    },
  });
  h.render()
    .find((n) => n.type === 'Checkbox')
    .props.onValueChange(false);
  await flush();
  assert.deepEqual(h.state[1], remembered);
  assert.equal(h.state[2], false);
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].url.endsWith('/settings'));
});

test('local task expiry wins over a late successful status response', async () => {
  let release;
  const h = page({
    phase: 'waiting',
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012'))
        return new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  h.runEffects();
  await flush();
  const expiry = [...h.timers.values()].find((timer) => timer.delay > 10000);
  assert.ok(expiry);
  expiry.fn();
  assert.equal(h.state[8].state, 'expired');
  release({
    ok: true,
    json: async () => ({ ...h.state[8], state: 'ready', code: undefined }),
  });
  await flush();
  assert.equal(h.state[8].state, 'expired');
  assert.equal(h.button('保存已接收的正文和图片'), undefined);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 0);
  h.unmount();
});

test('a definitive pruned task response unlocks the page without claiming that a save failed or succeeded', async () => {
  const h = page({
    phase: 'saving',
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012'))
        return {
          ok: false,
          status: 410,
          json: async () => ({ code: 'TASK_GONE', message: 'synthetic gone' }),
        };
    },
  });
  h.runEffects();
  await flush();
  assert.equal(h.state[8], null);
  assert.equal(
    h.render().find((n) => n.type === 'Input').props.isDisabled,
    false,
  );
  assert.ok(h.state[3].includes('若未收到保存结果'));
  assert.equal(h.state[6], null);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 0);
  h.unmount();
});

test('a form submission rejected during directory selection does not clear or cancel the retained task', async () => {
  let release;
  const h = page({
    effects: true,
    directoryReply: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  h.runEffects();
  await flush();
  const form = h.render().find((n) => n.type === 'form');
  h.button('选择下载路径').props.onPress();
  form.props.onSubmit({ preventDefault() {} });
  h.runEffects();
  await flush();
  assert.equal(h.state[8].state, 'ready');
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/cancel')),
    false,
  );
  release({ cancelled: true });
  await flush();
  h.unmount();
});

test('a second asking-policy event rejected by the operation lock cannot mutate the visible preference', async () => {
  let release;
  const h = page({
    phase: 'cancelled',
    fetchReply: async (url, options) => {
      if (url.endsWith('/settings') && options.method === 'POST')
        return new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  const change = h.render().find((n) => n.type === 'Checkbox')
    .props.onValueChange;
  change(true);
  change(false);
  assert.equal(h.state[1].askEveryTime, true);
  assert.equal(h.calls.length, 1);
  release({
    ok: true,
    json: async () => ({ directory: 'synthetic-old-path', askEveryTime: true }),
  });
  await flush();
  assert.equal(h.state[1].askEveryTime, true);
});

test('authorization or incomplete errors cannot masquerade as a definitive missing task', async () => {
  for (const reply of [
    { status: 401, code: 'TASK_GONE' },
    { status: 410, code: 'OTHER_ERROR' },
  ]) {
    const h = page({
      phase: 'saving',
      effects: true,
      fetchReply: async (url) => {
        if (url.endsWith('/12345678-1234-1234-1234-123456789012'))
          return {
            ok: false,
            status: reply.status,
            json: async () => ({
              code: reply.code,
              message: 'synthetic error',
            }),
          };
      },
    });
    h.runEffects();
    await flush();
    assert.equal(h.state[8].state, 'saving');
    assert.ok(h.button('重新读取本机任务状态'));
    assert.equal(
      h.calls.some((c) => c.url.endsWith('/save')),
      false,
    );
    h.unmount();
  }
});

test('a pruned final save status unlocks the page and preserves the acknowledged saved file result', async () => {
  const h = page({
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012'))
        return {
          ok: false,
          status: 410,
          json: async () => ({ code: 'TASK_GONE' }),
        };
    },
  });
  h.button('选择下载路径').props.onPress();
  await flush();
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.state[8], null);
  assert.equal(h.state[2], false);
  assert.equal(h.state[6].markdownPath, 'synthetic-new-path/正文.md');
  assert.ok(h.state[3].includes('若未收到保存结果'));
  assert.equal(h.calls.filter((c) => c.url.endsWith('/save')).length, 1);
});

test('late target-input events cannot replace an active retained article', () => {
  const h = page();
  const before = { ...h.state[8] };
  h.render()
    .find((n) => n.type === 'Input')
    .props.onValueChange('https://mp.weixin.qq.com/s/another');
  assert.equal(h.state[0], 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv');
  assert.deepEqual(h.state[8], before);
  assert.equal(h.calls.length, 0);
});

test('a fixed ready task locks its directory and explains that a new destination needs renewed confirmation', () => {
  const h = page({ destinationBound: true });
  assert.equal(h.button('选择下载路径').props.isDisabled, true);
  const text = JSON.stringify(h.render());
  assert.ok(text.includes('取得新的接收许可'));
  assert.equal(text.includes('可重新选择路径后保存'), false);
  h.button('选择下载路径').props.onPress();
  assert.equal(h.calls.length, 0);
});

test('asking-policy selection precedes fixed task issue; save never opens a second picker', async () => {
  let issued;
  const h = page({
    taskPresent: false,
    destinationBound: true,
    settings: { directory: 'synthetic-old-path', askEveryTime: true },
    fetchReply: async (url, options) => {
      if (url.endsWith('/browser-task') && options.method === 'POST') {
        issued = {
          taskId: '12345678-1234-1234-1234-123456789012',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          state: 'waiting',
          destinationBound: true,
        };
        return { ok: true, json: async () => issued };
      }
      if (issued && url.endsWith(issued.taskId))
        return { ok: true, json: async () => ({ ...issued, state: 'saved' }) };
    },
  });
  h.button('通过已打开的官方文章接收').props.onPress();
  await flush();
  assert.deepEqual(
    h.calls.map((c) => c.url.split('/').at(-1)),
    ['directory', 'browser-task'],
  );
  assert.equal(JSON.parse(h.calls[1].body).pickToken, 'synthetic-grant');
  assert.equal(h.state[8].destinationBound, true);
  h.state[8] = { ...h.state[8], state: 'ready' };
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.calls.filter((c) => c.url.endsWith('/directory')).length, 1);
  assert.equal(
    JSON.parse(h.calls.find((c) => c.url.endsWith('/save')).body).pickToken,
    undefined,
  );
  assert.equal(h.state[6].saved, true);
});

test('cancelling pre-task native selection issues no fixed task', async () => {
  const h = page({
    taskPresent: false,
    destinationBound: true,
    settings: { directory: 'synthetic-old-path', askEveryTime: true },
    directoryReply: async () => ({ cancelled: true }),
  });
  h.button('通过已打开的官方文章接收').props.onPress();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].url.endsWith('/directory'));
  assert.equal(h.state[8], null);
});

test('a fixed directory conflict disables further save and retains explicit cancel', async () => {
  const h = page({
    destinationBound: true,
    fetchReply: async (url) => {
      if (url.endsWith('/save'))
        return {
          ok: false,
          status: 409,
          json: async () => ({
            code: 'SAVE_DIRECTORY_CHANGED',
            message: '取消任务并重新确认目录',
          }),
        };
      if (url.endsWith('12345678-1234-1234-1234-123456789012'))
        return {
          ok: true,
          json: async () => ({
            ...h.state[8],
            state: 'ready',
            code: 'SAVE_DIRECTORY_CHANGED',
          }),
        };
    },
  });
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.state[8].code, 'SAVE_DIRECTORY_CHANGED');
  assert.equal(h.button('保存已接收的正文和图片').props.isDisabled, true);
  assert.equal(h.button('选择下载路径').props.isDisabled, true);
  assert.ok(
    h
      .render()
      .some(
        (n) => n.type === 'Button' && String(n.props.children).includes('取消'),
      ),
  );
  assert.equal(h.state[6], null);
  const calls = h.calls.length;
  h.button('保存已接收的正文和图片').props.onPress();
  await flush();
  assert.equal(h.calls.length, calls);
});

test('leaving cancels capture and ignores late reads; returning loads preferences without silently issuing a task', async () => {
  let release;
  const left = page({
    phase: 'waiting',
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/12345678-1234-1234-1234-123456789012'))
        return new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  left.runEffects();
  await flush();
  left.unmount();
  release({
    ok: true,
    json: async () => ({ ...left.state[8], state: 'ready' }),
  });
  await flush();
  assert.equal(left.calls.filter((c) => c.url.endsWith('/cancel')).length, 1);
  assert.equal(
    left.state[8].state,
    'waiting',
    'unmounted effect ignored the late read',
  );
  const remembered = {
    directory: 'synthetic-returned-path',
    askEveryTime: true,
  };
  const returned = page({
    taskPresent: false,
    settings: remembered,
    effects: true,
  });
  returned.runEffects();
  await flush();
  assert.equal(returned.state[8], null);
  assert.deepEqual(returned.state[1], remembered);
  assert.ok(returned.calls.every((c) => c.method === 'GET'));
  returned.unmount();
});

test('ordinary single download shows Wechat2RSS-only cache errors without selecting another transport', async () => {
  const h = page({
    taskPresent: false,
    effects: true,
    fetchReply: async (url, options) => {
      if (url.endsWith('/download/article') && options.method === 'POST')
        return {
          ok: false,
          json: async () => ({
            code: 'WECHAT2RSS_SINGLE_CACHE_MISS',
            message: '文章不在Wechat2RSS缓存中，不使用其他来源。',
          }),
        };
    },
  });
  h.state[0] =
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
  h.runEffects();
  await flush();
  assert.equal(h.state[7], false);
  assert.ok(JSON.stringify(h.render()).includes('需要时会订阅该公众号'));
  h.render()
    .find((n) => n.type === 'form')
    .props.onSubmit({ preventDefault() {} });
  await flush();
  assert.ok(h.state[3].includes('Wechat2RSS缓存'));
  assert.equal(h.state[6], null);
  const posted = h.calls.filter((c) => c.method === 'POST');
  assert.equal(posted.length, 1);
  assert.ok(posted[0].url.endsWith('/download/article'));
  assert.equal(JSON.parse(posted[0].body).source, undefined);
  h.unmount();
});

test('ordinary single download refuses a successful receipt from an unconfirmed article source', async () => {
  const h = page({
    taskPresent: false,
    fetchReply: async (url, options) => {
      if (url.endsWith('/download/article') && options.method === 'POST')
        return {
          ok: true,
          json: async () => ({
            saved: true,
            markdownPath: 'synthetic-path/正文.md',
            contentSource: 'remote',
          }),
        };
    },
  });
  h.state[0] =
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
  h.render()
    .find((n) => n.type === 'form')
    .props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(h.state[6], null);
  assert.ok(h.state[3].includes('Wechat2RSS 来源确认'));
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
});

test('ordinary short links reach the single backend without manual long-link extraction', async () => {
  const settings = { directory: 'synthetic-old-path', askEveryTime: false };
  const h = page({
    taskPresent: false,
    settings,
    fetchReply: async (url, options) => {
      if (url.endsWith('/download/article') && options.method === 'POST')
        return {
          ok: true,
          json: async () => ({
            saved: true,
            markdownPath: 'synthetic-old-path/正文.md',
            contentSource: 'wechat2rss-cache',
          }),
        };
    },
  });
  h.render()
    .find((n) => n.type === 'form')
    .props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(h.state[3], '');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(
    JSON.parse(h.calls[0].body).url,
    'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv',
  );
  assert.deepEqual(h.state[1], settings);
  assert.equal(h.state[6].contentSource, 'wechat2rss-cache');
});

test('path preferences and detailed help remain collapsed without changing remembered settings', () => {
  const settings = { directory: 'synthetic-old-path', askEveryTime: true };
  const h = page({ taskPresent: false, settings });
  const nodes = h.render();
  const details = nodes.filter((n) => n.type === 'details');
  assert.equal(details.length, 2);
  assert.ok(details.every((n) => !n.props.open));
  const preferences = details.find((n) =>
    JSON.stringify(n).includes('每次下载询问路径'),
  );
  assert.ok(preferences);
  assert.equal(nodes.find((n) => n.type === 'Checkbox').props.isSelected, true);
  assert.equal(nodes.filter((n) => n.type === 'h1').length, 1);
  assert.equal(
    nodes.find((n) => n.type === 'Input').props.description,
    undefined,
  );
  assert.equal(h.button('选择下载路径').props.children, '更改');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.state[1], settings);
});

test('a pending single download retains the server receipt and leaving never cancels it', async () => {
  const task = {
    taskId: 'a'.repeat(64),
    revision: 1,
    state: 'waiting',
    message: '正在等待精确正文，之后自动保存。',
  };
  const h = page({
    taskPresent: false,
    effects: true,
    fetchReply: async (url, options) => {
      if (url.endsWith('/single-tasks'))
        return { ok: true, json: async () => ({ tasks: [] }) };
      if (url.endsWith('/download/article') && options.method === 'POST')
        return { ok: true, json: async () => ({ pending: true, task }) };
    },
  });
  h.runEffects();
  await flush();
  h.render()
    .find((n) => n.type === 'form')
    .props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(h.state[13].taskId, task.taskId);
  assert.equal(h.state[3], '');
  assert.equal(h.state[6], null);
  assert.equal(h.button('下载正文和图片').props.isDisabled, true);
  assert.equal(h.button('选择下载路径').props.isDisabled, true);
  const calls = h.calls.length;
  h.unmount();
  await flush();
  assert.equal(h.calls.length, calls);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/cancel')).length, 0);
});

test('a stale local status cannot revive a cancelled durable download', async () => {
  const cancelled = {
    taskId: 'b'.repeat(64),
    revision: 3,
    state: 'cancelled',
    message: '下载已取消。',
  };
  const h = page({
    taskPresent: false,
    effects: true,
    fetchReply: async (url) => {
      if (url.endsWith('/single-tasks'))
        return {
          ok: true,
          json: async () => ({
            tasks: [{ ...cancelled, revision: 2, state: 'waiting' }],
          }),
        };
    },
  });
  h.state[13] = cancelled;
  h.runEffects();
  await flush();
  assert.equal(h.state[13].state, 'cancelled');
  assert.equal(h.state[13].revision, 3);
  h.unmount();
});

test('terminal missing short mapping replaces waiting with an explicit cached-article chooser', async () => {
  const waiting = {
    taskId: 'c'.repeat(64),
    revision: 2,
    state: 'waiting',
    message: '仍在等待该篇可核验正文',
  };
  const failed = {
    ...waiting,
    revision: 3,
    state: 'failed',
    code: 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
    feedId: 'MP_WXS_1234567890',
    message: '缓存没有短链接映射，无法确定目标，未保存。',
  };
  const h = page({
    taskPresent: false,
    effects: true,
    fetchReply: async (url) =>
      url.endsWith('/single-tasks')
        ? { ok: true, json: async () => ({ tasks: [failed] }) }
        : undefined,
  });
  h.state[13] = waiting;
  h.runEffects();
  await flush();
  assert.equal(h.state[13].state, 'failed');
  const nodes = h.render();
  assert.ok(h.button('选择已缓存文章'));
  assert.ok(
    !nodes.some(
      (n) => n.type === 'Button' && n.props.children === '继续原下载',
    ),
  );
  assert.equal(h.button('下载正文和图片').props.isDisabled, false);
  assert.ok(h.calls.every((c) => c.method === 'GET'));
  h.unmount();
});

test('in-tool choice sends only a server-provided stable article identity and leaves the original destination fixed', async () => {
  const task = {
    taskId: 'f'.repeat(64),
    revision: 3,
    state: 'failed',
    feedId: 'MP_WXS_1234567890',
    code: 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
    message: '无法自动确定短链目标',
  };
  const articleId = 'WX_1234567890_2247000001_1';
  const h = page({
    taskPresent: false,
    fetchReply: async (url) => {
      if (url.endsWith('/candidates'))
        return {
          ok: true,
          json: async () => ({
            taskId: task.taskId,
            destination: 'original-confirmed-path',
            articles: [
              { articleId, title: '用户确认的目标', publishTime: 1800000000 },
            ],
          }),
        };
      if (url.endsWith('/select'))
        return {
          ok: true,
          json: async () => ({
            ...task,
            revision: 4,
            state: 'waiting',
            destination: 'original-confirmed-path',
            selectedArticle: {
              articleId,
              title: '用户确认的目标',
              publishTime: 1800000000,
            },
            message: '正在保存所选文章',
          }),
        };
    },
  });
  h.state[13] = task;
  h.state[1].directory = 'changed-preference-path';
  h.button('选择已缓存文章').props.onPress();
  await flush();
  assert.equal(h.calls[0].method, 'GET');
  assert.ok(JSON.stringify(h.render()).includes('original-confirmed-path'));
  assert.ok(JSON.stringify(h.render()).includes('用户确认的目标'));
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  const choose = h
    .render()
    .find(
      (n) =>
        n.type === 'Button' &&
        JSON.stringify(n.props.children).includes('用户确认的目标'),
    );
  choose.props.onPress();
  await flush();
  const posted = h.calls.filter((c) => c.method === 'POST');
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(posted[0].body), { articleId });
  assert.equal(h.state[13].state, 'waiting');
  assert.equal(h.state[1].directory, 'changed-preference-path');
  assert.equal(h.state[16], null);
});

test('failed local polling marks waiting as stale and offers a read-only status retry', async () => {
  const task = {
    taskId: 'd'.repeat(64),
    revision: 2,
    state: 'waiting',
    message: '正在等待',
  };
  const h = page({
    taskPresent: false,
    effects: true,
    fetchReply: async (url) =>
      url.endsWith('/single-tasks')
        ? { ok: false, json: async () => ({ message: '请先登录' }) }
        : undefined,
  });
  h.state[13] = task;
  h.runEffects();
  await flush();
  assert.equal(h.state[13].state, 'waiting');
  assert.ok(JSON.stringify(h.render()).includes('当前显示可能已过期'));
  h.button('重新读取下载状态').props.onPress();
  h.render();
  h.runEffects();
  await flush();
  assert.equal(
    h.calls.filter((c) => c.url.endsWith('/single-tasks')).length,
    2,
  );
  assert.ok(h.calls.every((c) => c.method === 'GET'));
  h.unmount();
});

test('an explicitly chosen long-link save replaces the old failed short task and preserves path settings', async () => {
  const failed = {
    taskId: 'e'.repeat(64),
    revision: 3,
    state: 'failed',
    code: 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
    feedId: 'MP_WXS_1234567890',
    message: '无短链映射',
  };
  const h = page({
    taskPresent: false,
    effects: true,
    fetchReply: async (url, options) => {
      if (url.endsWith('/single-tasks'))
        return { ok: true, json: async () => ({ tasks: [failed] }) };
      if (url.endsWith('/download/article') && options.method === 'POST')
        return {
          ok: true,
          json: async () => ({
            saved: true,
            contentSource: 'wechat2rss-cache',
            markdownPath: 'synthetic-old-path/正文.md',
          }),
        };
    },
  });
  h.state[13] = failed;
  h.state[0] =
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
  h.render()
    .find((n) => n.type === 'form')
    .props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(h.state[13], null);
  assert.equal(h.state[6].contentSource, 'wechat2rss-cache');
  assert.equal(h.state[1].directory, 'synthetic-old-path');
  h.render();
  h.runEffects();
  await flush();
  assert.equal(h.state[13], null);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
  h.unmount();
});
