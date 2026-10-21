const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/server')] }),
);
const pins = require('./fixtures/deployed-export-adaptation.json');
const copyPins = require('./fixtures/product-copy-layout.json');
const searchPins = require('./fixtures/deployed-body-search-scope.json');
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
function tokens(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.JSX,
    text,
  );
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
    result.push(scanner.getTokenText());
  return hash(result.join('\0'));
}
test('deployment baseline keeps existing routes and safety/startup/reader/title policies', () => {
  assert.deepEqual(Object.keys(searchPins.criticalFiles).sort(), [
    'apps/server/src/article-body-search.ts',
    'apps/server/src/article-list-page.ts',
  ]);
  assert.deepEqual(Object.keys(searchPins.articleRoutes).sort(), [
    'exportIds',
    'list',
    'prepareSearch',
    'searchStatus',
    'summary',
  ]);
  const file = 'apps/server/src/trpc/trpc.router.ts';
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = ast.statements.find(ts.isClassDeclaration);
  const members = {},
    routes = {};
  for (const member of declaration.members) {
    const key = member.name?.getText(ast) || 'constructor';
    if (key === 'articleRouter') {
      for (const route of member.initializer.arguments[0].properties) {
        const name = route.name.getText(ast);
        if (name !== 'saveToObsidianBatch')
          routes[name] = tokens(route.getText(ast));
      }
    } else if (
      !['buildOfflineFeedDirectory', 'applyMiddleware'].includes(key)
    ) {
      members[key] = tokens(member.getText(ast));
    }
  }
  assert.deepEqual(members, pins.routerMembers);
  assert.deepEqual(routes, {
    ...pins.articleRoutes,
    ...searchPins.articleRoutes,
  });
  for (const [file, expected] of Object.entries({
    ...pins.criticalFiles,
    ...searchPins.criticalFiles,
  }))
    assert.equal(hash(read(file)), expected, file);
  // Export conversion now reuses its current DOM. Pin all other conversion
  // statements and the uncertainty predicate to the deployed source semantics.
  const conversion = ts.createSourceFile(
    'article-export.ts',
    read('apps/server/src/article-export.ts'),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = conversion.statements.filter(ts.isFunctionDeclaration);
  const build = functions.find(
    (node) => node.name.text === 'buildArticleMarkdown',
  );
  const rest = build.body.statements.filter(
    (node) =>
      !ts.isVariableStatement(node) ||
      !node.declarationList.declarations.some(
        (decl) => decl.name.getText(conversion) === 'mediaUnconfirmed',
      ),
  );
  assert.equal(
    tokens(rest.map((node) => node.getText(conversion)).join('\n')),
    pins.articleExportConversion,
  );
  const predicate = functions.find(
    (node) => node.name.text === 'mediaUnconfirmedInDocument',
  );
  assert.equal(
    tokens(
      predicate.body.statements
        .map((node) => node.getText(conversion))
        .join('\n'),
    ),
    pins.articleExportPredicate,
  );
});
test('the reviewed export dialog and production reading layout retain their approved snapshot', () => {
  const file = 'apps/web/src/pages/feeds/index.tsx';
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const feeds = ast.statements
    .flatMap((node) =>
      ts.isVariableStatement(node)
        ? [...node.declarationList.declarations]
        : [],
    )
    .find((node) => node.name.getText(ast) === 'Feeds');
  const returned = feeds.initializer.body.statements.find(ts.isReturnStatement);
  // This snapshot includes the authorized unified export dialog. Product wording and expandable diagnostics are reviewed separately. The server,
  // startup and data contracts above remain pinned to the deployment baseline.
  function shape(node) {
    if (
      ts.isExpressionStatement(node) &&
      node.expression.getText(ast) === 'exportController.current?.abort()'
    )
      return undefined;
    const children = node.getChildren(ast);
    return children.length
      ? [node.kind, children.map(shape).filter((child) => child !== undefined)]
      : [node.kind, node.getText(ast)];
  }
  assert.equal(hash(JSON.stringify(shape(returned))), copyPins.indexLayout);
});
