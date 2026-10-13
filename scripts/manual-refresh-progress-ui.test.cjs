'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);

function fixture(batch) {
  const requests = [],
    changes = [];
  const jsx = (type, props) => ({ type, props });
  const trpc = {
    feed: Object.fromEntries(
      ['stopSubscriptionBatch', 'resumeSubscriptionBatch'].map((name) => [
        name,
        {
          useMutation: (options) => {
            assert.equal(options.retry, false);
            return {
              mutateAsync: (input) =>
                new Promise((resolve, reject) =>
                  requests.push({ name, input, resolve, reject }),
                ),
            };
          },
        },
      ]),
    ),
  };
  const module = { exports: {} };
  const source = ts.transpileModule(
    fs.readFileSync(
      'apps/web/src/pages/feeds/manual-refresh-progress.tsx',
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react')
        return {
          useRef: (value) => ({ current: value }),
          useState: (value) => [value, () => {}],
        };
      if (name === '@nextui-org/react')
        return { Button: 'Button', Progress: 'Progress' };
      if (name === '@web/utils/trpc') return { trpc };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const tree = module.exports.default({
    batch,
    feeds: [{ id: 'synthetic-feed', mpName: '合成公众号' }],
    onChange: async () => changes.push('read'),
  });
  const all = (node, type) =>
    Array.isArray(node)
      ? node.flatMap((value) => all(value, type))
      : node && typeof node === 'object'
        ? [
            ...(node.type === type ? [node] : []),
            ...all(node.props?.children, type),
          ]
        : [];
  const text = (node) =>
    Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object'
        ? text(node.props?.children)
        : typeof node === 'string'
          ? node
          : '';
  return {
    tree,
    requests,
    changes,
    buttons: all(tree, 'Button'),
    progress: all(tree, 'Progress')[0],
    text: text(tree),
  };
}
const item = {
  index: 0,
  feedId: 'synthetic-feed',
  state: 'waiting',
  accepted: true,
  message: '上游已受理，缓存仍在生成。',
};
test('actual progress component distinguishes queued, upstream accepted and synchronized cache counts', () => {
  const f = fixture({
    batchId: 'synthetic-batch',
    state: 'running',
    items: [
      item,
      { ...item, index: 1, state: 'queued', accepted: false },
      { ...item, index: 2, state: 'succeeded' },
    ],
  });
  assert.equal(f.progress.props.value, 2);
  assert.equal(f.progress.props.maxValue, 3);
  assert(
    f.progress.props.label.includes('排队 1 · 上游已受理 2 · 缓存已同步 1'),
  );
  assert(f.text.includes('等待缓存'));
  assert(f.text.includes('缓存已同步'));
  assert(!f.text.includes('全部正文已完成'));
  assert.equal(f.requests.length, 0);
});
test('stop handler has a synchronous repeated-click guard and only invokes the existing stop RPC', async () => {
  const f = fixture({
    batchId: 'synthetic-batch',
    state: 'running',
    items: [item],
  });
  f.buttons[0].props.onPress();
  f.buttons[0].props.onPress();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].name, 'stopSubscriptionBatch');
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].input)), {
    batchId: 'synthetic-batch',
  });
  f.requests[0].resolve({ state: 'stopped' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.changes, ['read']);
});
test('unknown /add receipts offer no resume, whereas confirmed accepted cache failure may resume reads', () => {
  const unknown = fixture({
    batchId: 'synthetic-batch',
    state: 'paused',
    items: [
      {
        ...item,
        accepted: false,
        state: 'blocked',
        message: '回执未知，不能重发。',
      },
    ],
  });
  assert.equal(unknown.buttons.length, 1);
  assert(unknown.text.includes('检查未完成'));
  const cache = fixture({
    batchId: 'synthetic-batch',
    state: 'paused',
    items: [{ ...item, state: 'blocked' }],
  });
  assert.equal(cache.buttons.length, 2);
  cache.buttons[1].props.onPress();
  assert.equal(cache.requests[0].name, 'resumeSubscriptionBatch');
});
test('cancelled and completed batches never advertise full-history or newest-article completion', () => {
  const stopped = fixture({
    batchId: 'synthetic-batch',
    state: 'stopped',
    items: [{ ...item, state: 'cancelled', accepted: false }],
  });
  assert.equal(stopped.buttons.length, 0);
  assert.equal(stopped.progress, undefined);
  assert.equal(stopped.text, '');
  const complete = fixture({
    batchId: 'synthetic-batch',
    state: 'completed',
    items: [{ ...item, state: 'succeeded' }],
  });
  assert.equal(complete.progress, undefined);
  assert.equal(complete.text, '');
  assert.equal(complete.buttons.length, 0);
});
