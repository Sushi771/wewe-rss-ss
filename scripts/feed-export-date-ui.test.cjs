'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const batchModule = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync('apps/web/src/utils/export-article-batches.ts', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  { module: batchModule, exports: batchModule.exports, Set, Error },
);
const { exportArticleBatches } = batchModule.exports;
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
async function run(results, rejectAt, options = {}) {
  const calls = [],
    notifications = [],
    loading = [],
    selections = [],
    queries = [];
  const context = {
    articleSelectedIds: new Set(results.map((_, i) => 'fixture-' + i)),
    batchExporting: { current: false },
    exportCancelled: { current: false },
    dateError: undefined,
    exportController: { current: null },
    AbortController,
    exportArticleBatches,
    articleDateFilter: { dateStart: '2026-10-11', dateEnd: '2026-10-11' },
    folderFilter: 'g',
    id: 'MP_WXS_1234567890',
    search: 'match',
    setExportResult: () => {},
    setIsBatchExporting: (x) => loading.push(x),
    setArticleSelectedIds: (x) =>
      selections.push(
        (typeof x === 'function' ? x(context.articleSelectedIds) : x).size,
      ),
    queryUtils: {
      client: {
        article: {
          exportIds: {
            query: async (filter) => {
              queries.push(filter);
              if (options.cancelOnQuery) context.exportCancelled.current = true;
              return options.scopeIds || results.map((_, i) => 'fixture-' + i);
            },
          },
          saveToObsidianBatch: {
            mutate: async ({ ids }) => {
              const receipts = [];
              for (const id of ids) {
                if (context.exportCancelled.current) break;
                calls.push(id);
                if (options.cancelAfter === calls.length)
                  context.exportCancelled.current = true;
                if (calls.length === rejectAt)
                  receipts.push({ id, error: 'synthetic save failure' });
                else
                  receipts.push({
                    id,
                    saved: {
                      markdownPath: id + '.md',
                      alreadySaved: false,
                      ...results[calls.length - 1],
                    },
                  });
              }
              return {
                results: receipts,
                cancelled: context.exportCancelled.current,
              };
            },
          },
        },
      },
    },
    toast: {
      success: (...x) => notifications.push(['success', ...x]),
      error: (...x) => notifications.push(['error', ...x]),
      warning: (...x) => notifications.push(['warning', ...x]),
    },
    Set,
    Array,
    Error,
  };
  vm.createContext(context);
  const js = ts.transpileModule('(' + initializer + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await vm.runInContext(js, context)(options.wholeScope || false);
  return { calls, notifications, loading, selections, queries };
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
test('save failure counts a failure, continues remaining exports and releases loading', async () => {
  const r = await run([{}, {}], 1);
  assert.equal(r.calls.length, 2);
  assert.equal(r.notifications[0][0], 'warning');
  assert.match(r.notifications[0][1], /新增 1.*失败 1/);
  assert.deepEqual(r.loading, [true, false]);
  assert.deepEqual(r.selections, []);
});

test('mixed results keep skipped, repaired and incomplete distinct', async () => {
  const r = await run([
    { status: 'new' },
    { status: 'skipped', alreadySaved: true },
    { status: 'repaired' },
    { status: 'new', mediaComplete: false },
  ]);
  assert.equal(r.notifications[0][0], 'warning');
  assert.match(r.notifications[0][1], /新增 1.*跳过 1.*补齐 1.*失败 1/);
  assert.deepEqual(r.selections, []);
});

test('whole filtered scope freezes all 25 identities with filters and de-duplicates repeated IDs', async () => {
  const results = Array.from({ length: 25 }, () => ({ status: 'new' }));
  const scopeIds = results.map((_, i) => 'fixture-' + i).concat('fixture-0');
  const r = await run(results, undefined, { wholeScope: true, scopeIds });
  assert.equal(r.calls.length, 25);
  assert.equal(new Set(r.calls).size, 25);
  assert.deepEqual(
    { ...r.queries[0] },
    {
      dateStart: '2026-10-11',
      dateEnd: '2026-10-11',
      group: 'g',
      mpId: 'MP_WXS_1234567890',
      search: 'match',
    },
  );
  assert.match(r.notifications[0][1], /新增 25/);
  assert.deepEqual(r.selections, []);
});
test('cancel stops subsequent submissions and retains selection for a resumable retry', async () => {
  const r = await run([{}, {}, {}], undefined, { cancelAfter: 1 });
  assert.equal(r.calls.length, 1);
  assert.equal(r.notifications[0][0], 'warning');
  assert.match(r.notifications[0][1], /已停止后续导出/);
  assert.deepEqual(r.selections, []);
  assert.deepEqual(r.loading, [true, false]);
});
test('changing filters during identity snapshot fetch starts no saves', async () => {
  const r = await run([{}, {}], undefined, {
    wholeScope: true,
    cancelOnQuery: true,
  });
  assert.equal(r.calls.length, 0);
  assert.equal(r.queries.length, 1);
  assert.equal(r.notifications[0][0], 'warning');
});
