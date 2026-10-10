'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const source = ts.createSourceFile(
  'feeds.tsx',
  fs.readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let initializer;
function find(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'handleBatchExport'
  )
    initializer = node.initializer.getText(source);
  ts.forEachChild(node, find);
}
find(source);
assert(initializer);
async function run(results, rejectAt) {
  const calls = [],
    notifications = [],
    loading = [],
    selections = [];
  const context = {
    articleSelectedIds: new Set(results.map((_, i) => 'fixture-' + i)),
    setIsBatchExporting: (x) => loading.push(x),
    setArticleSelectedIds: (x) => selections.push(x.size),
    queryUtils: {
      client: {
        article: {
          saveToObsidian: {
            mutate: async (id) => {
              calls.push(id);
              if (calls.length === rejectAt)
                throw new Error('synthetic save failure');
              return results[calls.length - 1];
            },
          },
        },
      },
    },
    toast: {
      success: (...x) => notifications.push(['success', ...x]),
      error: (...x) => notifications.push(['error', ...x]),
    },
    Set,
    Array,
    Error,
  };
  vm.createContext(context);
  const js = ts.transpileModule('(' + initializer + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await vm.runInContext(js, context)();
  return { calls, notifications, loading, selections };
}
test('normal publication exports keep one compact success notice', async () => {
  const r = await run([{ publicationDate: '2026-10-05' }]);
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0][0], 'success');
  assert.equal(r.notifications[0][2].description, undefined);
  assert.deepEqual(r.loading, [true, false]);
  assert.deepEqual(r.selections, [0]);
});
test('pending date and retained edits are aggregated once after the batch', async () => {
  const r = await run([
    { datePendingReason: '缺少可信原文发布日期' },
    { datePendingReason: '缺少可信原文发布日期', legacyLayoutRetained: true },
  ]);
  assert.equal(r.calls.length, 2);
  assert.equal(r.notifications.length, 1);
  assert.equal(
    r.notifications[0][2].description,
    '日期待核（缺少可信原文发布日期）；保留原有位置及编辑',
  );
});
test('save failure stops remaining exports and releases the original loading state', async () => {
  const r = await run([{}, {}], 1);
  assert.equal(r.calls.length, 1);
  assert.equal(r.notifications[0][0], 'error');
  assert.deepEqual(r.loading, [true, false]);
  assert.deepEqual(r.selections, []);
});
