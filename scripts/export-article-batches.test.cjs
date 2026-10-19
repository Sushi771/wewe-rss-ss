const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const loaded = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync('apps/web/src/utils/export-article-batches.ts', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
      },
    },
  ).outputText,
  { module: loaded, exports: loaded.exports, Set, Error },
);
const { exportArticleBatches } = loaded.exports;
const success = (ids) => ({
  cancelled: false,
  results: ids.map((id) => ({
    id,
    saved: { markdownPath: id + '.md', alreadySaved: false, status: 'new' },
  })),
});
test('freezes selection, sends at most64 targets and acknowledges only ordered individual receipts', async () => {
  const ids = Array.from({ length: 130 }, (_, i) => String(i)),
    calls = [],
    saved = [];
  const result = await exportArticleBatches(
    ids,
    async (batch) => {
      calls.push([...batch]);
      ids.push('later');
      return success(batch);
    },
    (_, id) => saved.push(id),
  );
  assert.equal(result.cancelled, false);
  assert.deepEqual(
    calls.map((x) => x.length),
    [64, 64, 2],
  );
  assert.equal(saved.length, 130);
  assert(!saved.includes('later'));
});
test('cancel stops later batches and an aborted request is not retried', async () => {
  const controller = new AbortController(),
    calls = [];
  const result = await exportArticleBatches(
    Array.from({ length: 70 }, (_, i) => String(i)),
    async (ids) => {
      calls.push(ids);
      controller.abort();
      return success(ids);
    },
    () => {},
    { signal: controller.signal },
  );
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 1);
  let attempts = 0;
  const active = new AbortController();
  const cancelled = await exportArticleBatches(
    ['a'],
    async () => {
      attempts++;
      active.abort();
      throw Error('aborted');
    },
    () => {},
    { signal: active.signal },
  );
  assert.equal(cancelled.cancelled, true);
  assert.equal(attempts, 1);
});
test('foreign, truncated, failed and incomplete receipts never claim all targets saved', async () => {
  for (const receipt of [
    {
      cancelled: false,
      results: [
        { id: 'other', saved: { markdownPath: 'x', alreadySaved: true } },
      ],
    },
    { cancelled: false, results: [] },
    { cancelled: false, results: [{ id: 'a', error: 'failed' }] },
    {
      cancelled: false,
      results: [
        {
          id: 'a',
          saved: {
            markdownPath: 'x',
            alreadySaved: false,
            mediaComplete: false,
          },
        },
      ],
    },
  ]) {
    let saved = 0;
    await assert.rejects(
      exportArticleBatches(
        ['a'],
        async () => receipt,
        () => {
          saved++;
        },
      ),
    );
    assert.equal(saved, 0);
  }
});
