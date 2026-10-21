'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { loadActualTs } = require('./offline-ts-fixture.cjs');
const { failureMessage, operationDiagnostic } = loadActualTs(
  'apps/web/src/utils/operation-message.ts',
);
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
test('known permission, storage, verification and uncertain outcomes remain actionable before details', () => {
  for (const [raw, expected] of [
    ['UNAUTHORIZED 401', /登录/],
    ['FORBIDDEN 403', /无权/],
    ['SQLITE_FULL', /存储空间不足/],
    ['captcha', /官方验证/],
    ['429', /频繁/],
    ['未收到有效的导出回执', /尚未确认.*避免重复/],
    ['数据检查未通过', /数据检查/],
  ])
    assert.match(failureMessage({ message: raw }), expected);
  assert.equal(
    operationDiagnostic({ message: 'original detail' }),
    'original detail',
  );
  assert.equal(
    failureMessage('unknown internal error', '读取失败，请刷新。'),
    '读取失败，请刷新。',
  );
});
test('notice diagnostics receive source errors rather than another JSX notice', () => {
  const files = fs
    .readdirSync('apps/web/src', { recursive: true })
    .filter((n) => n.endsWith('.tsx') && !n.startsWith('prototypes'));
  for (const file of files) {
    const full = path.join('apps/web/src', file),
      ast = ts.createSourceFile(
        full,
        fs.readFileSync(full, 'utf8'),
        99,
        true,
        ts.ScriptKind.TSX,
      );
    function visit(n) {
      if (
        ts.isJsxSelfClosingElement(n) &&
        n.tagName.getText(ast) === 'FailureNotice'
      ) {
        const attr = n.attributes.properties.find(
            (p) => p.name?.getText(ast) === 'error',
          ),
          expr = attr?.initializer?.expression;
        assert(expr, full);
        assert(
          !ts.isJsxSelfClosingElement(expr) && !ts.isJsxElement(expr),
          full + ': diagnostic must retain the original error',
        );
      }
      ts.forEachChild(n, visit);
    }
    visit(ast);
  }
});
