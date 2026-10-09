const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const output = ts.transpileModule(
  fs.readFileSync('apps/web/src/utils/xiaohongshu-refresh.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
const moduleObject = { exports: {} };
new Function('exports', 'module', output)(moduleObject.exports, moduleObject);
const { refreshCreatorBatch } = moduleObject.exports;
test('complete batch and empty batch account for all requested creators', async () => {
  assert.deepEqual(
    await refreshCreatorBatch(['a', 'b'], async () => 'complete'),
    { completed: 2, remaining: 0 },
  );
  assert.deepEqual(
    await refreshCreatorBatch([], async () => {
      throw Error('unused');
    }),
    { completed: 0, remaining: 0 },
  );
});
test('partial result stops subsequent requests and retains complete count', async () => {
  const calls = [];
  const result = await refreshCreatorBatch(['a', 'b', 'c'], async (id) => {
    calls.push(id);
    return id === 'a' ? 'complete' : 'partial';
  });
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(result, { completed: 1, remaining: 1, failedId: 'b' });
});
test('request error reports failed creator and remaining count', async () => {
  const calls = [];
  const result = await refreshCreatorBatch(['a', 'b'], async (id) => {
    calls.push(id);
    throw Error('source unavailable');
  });
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(result, {
    completed: 0,
    remaining: 1,
    failedId: 'a',
    error: 'source unavailable',
  });
});

function downloadFixture() {
  const state = [],
    effects = [];
  let index = 0,
    retry = false;
  const element = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(value) {
      const i = index++;
      if (!(i in state)) state[i] = value;
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
    useCallback: (fn) => fn,
    useEffect: (fn) => {
      effects.push(fn);
    },
  };
  const compiled = ts.transpileModule(
    fs.readFileSync(
      'apps/web/src/pages/tools/xiaohongshu-download.tsx',
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const mod = { exports: {} };
  const requireMock = (name) =>
    name === 'react'
      ? react
      : name === 'react/jsx-runtime'
        ? { jsx: element, jsxs: element }
        : name === '@nextui-org/react'
          ? { Button: 'Button', Input: 'Input', Checkbox: 'Checkbox' }
          : name === '@web/utils/auth'
            ? { getAuthCode: () => '' }
            : name === '@web/utils/env'
              ? { serverOriginUrl: '' }
              : {};
  const fetchMock = async (endpoint) => {
    if (!retry) throw Error('local service unavailable');
    return {
      ok: true,
      json: async () =>
        endpoint.endsWith('/settings')
          ? { directory: 'fixture-only', askEveryTime: false }
          : { available: false, message: '来源尚未配置' },
    };
  };
  new Function('require', 'exports', 'module', 'fetch', compiled)(
    requireMock,
    mod.exports,
    mod,
    fetchMock,
  );
  const render = () => {
    index = 0;
    return mod.exports.default();
  };
  const all = (node) =>
    node == null
      ? []
      : Array.isArray(node)
        ? node.flatMap(all)
        : typeof node === 'object'
          ? [node, ...all(node.props?.children)]
          : [node];
  return {
    render,
    all,
    start: () => effects[0](),
    enableRetry: () => {
      retry = true;
    },
  };
}
test('download initial failure ends loading text and offers a working local retry', async () => {
  const fixture = downloadFixture();
  fixture.render();
  fixture.start();
  await new Promise((resolve) => setImmediate(resolve));
  let nodes = fixture.all(fixture.render());
  assert.ok(nodes.includes('单篇取文能力未能读取，请重新读取。'));
  assert.ok(nodes.includes('本地保存设置未能读取，请重新读取。'));
  assert.ok(!nodes.includes('正在读取单篇取文能力。'));
  const retry = nodes.find(
    (node) =>
      node.type === 'Button' &&
      node.props.children === '重新读取本地设置与能力',
  );
  assert.ok(retry && !retry.props.isDisabled);
  fixture.enableRetry();
  retry.props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  nodes = fixture.all(fixture.render());
  assert.ok(nodes.includes('来源尚未配置'));
  assert.ok(nodes.includes('fixture-only'));
  assert.ok(!nodes.includes('本地保存设置未能读取，请重新读取。'));
});
