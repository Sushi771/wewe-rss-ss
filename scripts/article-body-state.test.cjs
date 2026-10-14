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
const { articleBodyState } = compiled;
const failed = {
  status: 'failed',
  filled: false,
  cached: false,
  requestFailure: { reason: 'http_status', httpStatus: 302 },
};
test('cache presence and retry history remain independent after later cache fill and restart', () => {
  assert.equal(articleBodyState(false, failed).needsBody, true);
  assert.match(articleBodyState(false, failed).history, /当前无正文缓存/);
  const current = articleBodyState(true, failed);
  assert.equal(current.current, '正文已缓存，可阅读');
  assert.equal(current.needsBody, false);
  assert.match(
    current.history,
    /失败.*HTTP 302 跳转，未跟随.*当前缓存仍可阅读/,
  );
  assert.equal(
    articleBodyState(true, JSON.parse(JSON.stringify(failed))).history,
    current.history,
  );
  assert.equal(failed.cached, false);
});
test('success and real missing-body failures are reported honestly', () => {
  assert.match(
    articleBodyState(true, { status: 'available', filled: true }).history,
    /成功，已补入正文/,
  );
  assert.equal(articleBodyState(false, failed).current, '正文未缓存');
  assert.equal(articleBodyState(true, null).history, '');
  assert.doesNotMatch(
    articleBodyState(true, {
      ...failed,
      requestFailure: { reason: 'SECRET Cookie=https://evil.invalid' },
    }).history,
    /SECRET|Cookie|evil/,
  );
});
test('the real list shows current cache and historical time; stale failure cannot request an already cached body', () => {
  const source = fs.readFileSync('apps/web/src/pages/feeds/list.tsx', 'utf8');
  assert.match(
    source,
    /articleBodyState\(item.bodyCached, item.bodyRetryResult\)\s*\.current/,
  );
  assert.match(
    source,
    /articleBodyState\(item.bodyCached, item.bodyRetryResult\)\s*\.history/,
  );
  assert.doesNotMatch(source, /item.bodyRetryResult\?\.status === 'failed'/);
});
