'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
const compiled = {};
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync('apps/web/src/utils/article-body-state.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
  { exports: compiled },
);
test('availability is derived only from current cache, without history labels', () => {
  assert.equal(compiled.articleBodyState(true).current, '正文已保存，可阅读');
  assert.equal(compiled.articleBodyState(false).current, '正文尚未保存');
  assert.equal(compiled.articleBodyState(false).needsBody, true);
  assert(!Object.hasOwn(compiled.articleBodyState(true), 'history'));
});
test('actual list does not bind historical retries or HTTP diagnostics to row UI', () => {
  const source = fs.readFileSync('apps/web/src/pages/feeds/list.tsx', 'utf8');
  assert.match(source, /articleBodyState\(item.bodyCached\)\s*\.current/);
  assert.doesNotMatch(source, /item\.bodyRetryResult|上次原文重试|HTTP \d{3}/);
});
