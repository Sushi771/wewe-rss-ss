'use strict';
// Inspect actual JSX containment and evaluate the short status. This is local
// behavior/layout-contract verification, not browser pixel acceptance.
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const elements = [],
    declarations = {};
  function visit(n) {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) elements.push(n);
    if (ts.isVariableDeclaration(n) && n.initializer)
      declarations[n.name.getText(ast)] = n.initializer.getText(ast);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  const opening = (n) => (ts.isJsxElement(n) ? n.openingElement : n);
  const attr = (n, key) =>
    opening(n).attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText(ast) === key,
    )?.initializer;
  const value = (n, key) => attr(n, key)?.getText(ast) || '';
  const classNode = (marker) =>
    elements.find((n) => value(n, 'className').includes(marker));
  return { ast, elements, declarations, opening, attr, value, classNode, text };
}
const feeds = parse('apps/web/src/pages/feeds/index.tsx'),
  list = parse('apps/web/src/pages/feeds/list.tsx');
const more = feeds.classNode('feed-reading-more'),
  details = feeds.classNode('feed-reading-details');
function within(node, parent) {
  while (node) {
    if (node === parent) return true;
    node = node.parent;
  }
  return false;
}
test('management controls and low-frequency imports are inside a collapsed More menu', () => {
  assert(more);
  assert(!feeds.attr(more, 'open'));
  assert(!feeds.attr(more, 'isOpen'));
  assert(!feeds.attr(more, 'defaultOpen'));
  for (const tag of ['Switch', 'PublicAlbums', 'LocalCollection']) {
    const node = feeds.elements.find(
      (n) => feeds.opening(n).tagName.getText(feeds.ast) === tag,
    );
    assert(node, tag);
    assert(within(node, more), tag);
  }
  const deleted = feeds.elements.find((n) =>
    feeds.value(n, 'onPress').includes('deleteFeed(currentMpInfo.id)'),
  );
  assert(deleted);
  assert(within(deleted, more));
});
test('update, download and search remain direct reading-toolbar actions', () => {
  const toolbar = feeds.classNode('feed-reading-toolbar');
  for (const marker of [
    'refreshMpArticles({ mpId })',
    '/download/feed/',
    'setIsSearchOpen',
  ]) {
    const node = feeds.elements.find((n) =>
      ['onPress', 'href'].some((k) => feeds.value(n, k).includes(marker)),
    );
    assert(node, marker);
    assert(within(node, toolbar));
    assert(!within(node, more));
  }
  for (const node of feeds.elements.filter((n) =>
    feeds.value(n, 'href').includes('.atom'),
  ))
    assert(within(node, more));
});
test('source explanations, operation logs and candidate diagnostics have one collapsed outer container', () => {
  assert(details);
  assert(!feeds.attr(details, 'open'));
  const diagnosticText = details.getText(feeds.ast);
  assert.match(diagnosticText, /普通更新通道/);
  assert.match(diagnosticText, /currentUpdate.message/);
  assert.match(diagnosticText, /待核验搜索候选/);
  const log = feeds.elements.find(
    (n) =>
      n.getText(feeds.ast).startsWith('<p') &&
      n.getText(feeds.ast).includes('currentUpdate.message'),
  );
  assert(log);
  assert(within(log, details));
  const candidate = feeds.elements.find(
    (n) =>
      feeds.opening(n).tagName.getText(feeds.ast) === 'details' &&
      n !== details &&
      n.getText(feeds.ast).includes('待核验搜索候选'),
  );
  assert(candidate);
  assert(within(candidate, details));
  assert(!feeds.attr(candidate, 'open'));
});
test('responsive toolbar wraps and More uses a viewport portal outside the clipped content area', () => {
  // mac-content's later overflow:hidden must not override the short-screen scroll area.
  assert.match(
    feeds.value(feeds.classNode('feed-content'), 'className'),
    /!overflow-y-auto/,
  );
  assert.match(
    feeds.value(feeds.classNode('feed-reading-toolbar'), 'className'),
    /!h-auto.*!flex-wrap/,
  );
  assert(
    feeds.elements.some(
      (n) =>
        feeds.value(n, 'className').includes('basis-full') &&
        feeds.value(n, 'className').includes('sm:basis-0'),
    ),
  );
  const panel = feeds.elements.find(
    (n) =>
      within(n, more) &&
      feeds.value(n, 'className').includes('max-w-[calc(100vw-2rem)]'),
  );
  assert(panel);
  assert.equal(feeds.opening(more).tagName.getText(feeds.ast), 'Popover');
  assert.equal(
    feeds.opening(panel).tagName.getText(feeds.ast),
    'PopoverContent',
  );
  // NextUI's default portal escapes the mac-content overflow:hidden ancestor.
  assert(!feeds.attr(more, 'portalContainer'));
  assert.doesNotMatch(feeds.value(panel, 'className'), /absolute|top-full/);
  assert.match(feeds.value(panel, 'className'), /max-h-\[60dvh\]/);
  assert.match(feeds.value(panel, 'className'), /overflow-auto/);
});
test('short reading status preserves failure, paused and partial meanings', () => {
  function status(scope) {
    const ctx = {
      module: { exports: null },
      currentMpInfo: { status: 1 },
      updateFailed: false,
      collectionChannel: 'wechat2rss',
      currentUpdate: undefined,
      ...scope,
    };
    vm.runInNewContext(
      ts.transpileModule(
        'module.exports = ' + feeds.declarations.readingStatus,
        {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
          },
        },
      ).outputText,
      ctx,
    );
    return ctx.module.exports;
  }
  assert.equal(status({ updateFailed: true }), '更新未完成，已有内容保留');
  assert.equal(status({ currentMpInfo: { status: 0 } }), '已停用');
  assert.equal(
    status({ currentUpdate: { status: 'partial' } }),
    '部分内容已保存',
  );
  assert.equal(status({ collectionChannel: 'unavailable' }), '更新来源未就绪');
  assert.equal(status({}), '阅读本地存量');
  const notice = feeds.elements.find(
    (n) =>
      feeds.value(n, 'role').includes('updateFailed') &&
      within(n, feeds.classNode('feed-reading-toolbar')),
  );
  assert(notice);
});
test('stock counts and date qualifications are folded while body incompleteness remains in the summary', () => {
  const stock = list.classNode('feed-stock-details');
  assert(stock);
  assert(!list.attr(stock, 'open'));
  assert.match(stock.getText(list.ast), /oldestPublishTime/);
  assert.match(stock.getText(list.ast), /cachedBodies/);
  const summary = list.elements.find(
    (n) =>
      list.opening(n).tagName.getText(list.ast) === 'summary' &&
      within(n, stock),
  );
  assert(summary);
  assert.match(summary.getText(list.ast), /部分正文未缓存/);
  assert.match(
    summary.getText(list.ast),
    /cachedBodies < summary.data.articles/,
  );
});
test('Wechat2RSS or mixed view hides metric CSV without removing existing-file import', () => {
  const local = feeds.elements.find(
    (n) => feeds.opening(n).tagName.getText(feeds.ast) === 'LocalCollection',
  );
  assert.match(
    feeds.value(local, 'showMetricsExport'),
    /collectionChannel !== 'wechat2rss'/,
  );
  assert.match(
    feeds.value(local, 'showMetricsExport'),
    /feed.collectionRoute.channel === 'wechat2rss'/,
  );
  const collection = parse('apps/web/src/pages/feeds/collection.tsx');
  const exporter = collection.elements.find((n) =>
    collection.value(n, 'onPress').includes('exporter.mutateAsync'),
  );
  assert(exporter);
  let guard = exporter.parent;
  while (guard && !ts.isBinaryExpression(guard)) guard = guard.parent;
  assert(guard);
  assert.equal(guard.left.getText(collection.ast), 'showMetricsExport');
  assert.match(collection.text, /导入已有文件/);
});
