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

test('resume mutations are labeled as continued processing rather than read-only progress', () => {
  let checked = 0;
  for (const file of [
    'manual-refresh-progress.tsx',
    'subscription-tasks.tsx',
  ]) {
    const full = path.join('apps/web/src/pages/feeds', file);
    const ast = ts.createSourceFile(
      full,
      fs.readFileSync(full, 'utf8'),
      99,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node) {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(ast) === 'Button'
      ) {
        const press =
          node.openingElement.attributes.properties
            .find((p) => p.name?.getText(ast) === 'onPress')
            ?.initializer?.getText(ast) || '';
        if (/act\([^]*'resume'|legacy\.resume\.mutateAsync/.test(press)) {
          const label = node.children
            .filter(ts.isJsxText)
            .map((n) => n.text)
            .join(' ')
            .trim();
          assert.match(label, /继续处理/, full);
          assert(!/查看进度|读取进度/.test(label), full);
          checked++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.equal(
    checked,
    5,
    'cover the manual batch, subscription batches and legacy task resume controls',
  );
});

test('both actual download handlers retain a lost receipt after saving without suggesting or starting another save', async () => {
  const vm = require('node:vm');
  for (const file of ['article-download.tsx', 'xiaohongshu-download.tsx']) {
    const full = path.join('apps/web/src/pages/tools', file);
    const ast = ts.createSourceFile(
      full,
      fs.readFileSync(full, 'utf8'),
      99,
      true,
      ts.ScriptKind.TSX,
    );
    let operate;
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(ast) === 'operate'
      )
        operate = node.initializer.getText(ast);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert(operate, full);
    const notices = [],
      errors = [],
      savedContents = [],
      savedViews = [];
    const scope = {
      module: { exports: undefined },
      AbortController,
      Error,
      request: { current: null },
      setBusy() {},
      setNotice() {},
      setVerification() {},
      setSaved: (value) => savedViews.push(value),
      setError: (message) => errors.push(message),
      toast: { error: (message) => notices.push(message) },
      ArticleDownloadRequestError: class extends Error {},
    };
    vm.runInNewContext(
      ts.transpileModule('module.exports = ' + operate, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      }).outputText,
      scope,
    );
    let calls = 0;
    await scope.module.exports(async () => {
      calls++;
      savedContents.push('synthetic saved article and image');
      throw new Error('未收到有效的本机保存结果。');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, full + ': no replay after a lost receipt');
    assert.equal(savedContents.length, 1, full + ': prior save remains');
    assert.equal(savedViews.at(-1), null, full + ': no false success');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /先核对.*已保存内容/);
    assert(!/重试|重新下载|重新保存/.test(notices[0]), full);
    assert.match(failureMessage(errors.at(-1)), /尚未确认.*避免重复操作/);
    assert.equal(scope.request.current, null);
  }
});
