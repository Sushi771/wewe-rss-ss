'use strict';
// Keep the existing CI entrypoint, exercising current product behavior instead
// of loading the retired platform reader or historical component fixtures.
require('./wechat-original-link.test.cjs');
require('./xhs-original-link-ui.test.cjs');
require('./feed-export-date-ui.test.cjs');

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const read = (file) => fs.readFileSync(file, 'utf8');
function tree(file) {
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.equal(ast.parseDiagnostics.length, 0);
  return ast;
}
function nodes(ast, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return matches;
}

test('both current platform lists retain native original titles and no embedded article reader', () => {
  for (const file of [
    'apps/web/src/components/ArticleReader.tsx',
    'apps/web/src/utils/article-reader-find.ts',
  ])
    assert.equal(fs.existsSync(file), false, `${file} must remain retired`);
  const wechat = tree('apps/web/src/pages/feeds/list.tsx');
  const xhs = tree('apps/web/src/pages/feeds/xiaohongshu.tsx');
  for (const ast of [wechat, xhs]) {
    assert.equal(
      nodes(
        ast,
        (node) =>
          ts.isIdentifier(node) &&
          ['ArticleReader', 'readingId', 'readerFindOpen'].includes(node.text),
      ).length,
      0,
    );
    assert.equal(
      nodes(
        ast,
        (node) =>
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(ast) === 'iframe',
      ).length,
      0,
    );
  }
  assert(
    nodes(
      wechat,
      (node) =>
        ts.isJsxAttribute(node) &&
        node.name.getText(wechat) === 'href' &&
        node.initializer?.getText(wechat) ===
          '{wechatOriginalUrl(item.sourceUrl)}',
    ).length > 0,
  );
  assert(
    nodes(
      xhs,
      (node) =>
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(xhs) === 'XhsOriginalLink',
    ).length > 0,
  );
});

test('current export controls retain Obsidian and ZIP paths independently of native reading', () => {
  const wechat = read('apps/web/src/pages/feeds/index.tsx');
  const xhs = read('apps/web/src/pages/feeds/xiaohongshu.tsx');
  assert.match(wechat, /article\.saveToObsidianBatch\.mutate/);
  assert.match(wechat, /exportFormat === 'zip'/);
  assert.match(xhs, /exportNotes\.mutateAsync/);
  assert.match(xhs, /xhsExportFormat === 'obsidian'/);
  assert.match(xhs, /<option value="obsidian">/);
  assert.match(xhs, /<option value="zip">/);
});
