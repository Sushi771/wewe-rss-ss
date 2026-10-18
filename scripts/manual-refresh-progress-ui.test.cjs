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
          useEffect: () => {},
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

test('a terminal 14-source round exposes skipped gaps and offers no submission action', () => {
  const f = fixture({
    batchId: 'synthetic-round',
    state: 'completed',
    items: Array.from({ length: 14 }, (_, index) => ({
      ...item,
      index,
      state: index < 12 ? 'succeeded' : 'skipped',
      accepted: index < 12,
    })),
    coverage: {
      expected: 14,
      submitted: 12,
      completed: 12,
      pending: 0,
      legitimateSkipped: 0,
      excluded: 0,
      anomalies: 2,
      fullyUpdated: false,
      items: [],
    },
  });
  assert(f.text.includes('本轮应更新 14'));
  assert(f.text.includes('本轮已提交 12'));
  assert(f.text.includes('已完成 12'));
  assert(f.text.includes('异常 2'));
  assert(f.text.includes('本轮尚未全部更新完成。'));
  assert(!f.text.includes('本轮全部更新完成。'));
  assert.equal(f.buttons.length, 0);
  assert.equal(f.requests.length, 0);
});

test('legal exclusions remain visibly different from a fully updated round', () => {
  const base = {
    batchId: 'synthetic-round',
    state: 'completed',
    items: [{ ...item, state: 'succeeded' }],
  };
  const coverage = {
    expected: 2,
    submitted: 1,
    completed: 1,
    pending: 0,
    legitimateSkipped: 1,
    excluded: 1,
    anomalies: 0,
    fullyUpdated: false,
    items: [],
  };
  const excluded = fixture({ ...base, coverage });
  assert(excluded.text.includes('合法跳过 1'));
  assert(excluded.text.includes('本轮尚未全部更新完成。'));
  const done = fixture({
    ...base,
    coverage: {
      ...coverage,
      expected: 1,
      legitimateSkipped: 0,
      excluded: 0,
      fullyUpdated: true,
    },
  });
  assert(done.text.includes('本轮全部更新完成。'));
  assert.equal(done.buttons.length, 0);
  assert.equal(done.requests.length, 0);
});

test('an unexplained terminal gap is not invented as a legal skip or a full success', () => {
  const f = fixture({
    batchId: 'unconfirmed-terminal',
    state: 'completed',
    items: [item],
    coverage: {
      expected: 1,
      submitted: 1,
      completed: 1,
      pending: 0,
      legitimateSkipped: 0,
      excluded: 0,
      anomalies: 0,
      fullyUpdated: false,
      items: [],
    },
  });
  assert(f.progress.props.label.includes('需核对'));
  assert(!f.progress.props.label.includes('含合法跳过'));
  assert(!f.progress.props.label.includes('已全部更新'));
});
