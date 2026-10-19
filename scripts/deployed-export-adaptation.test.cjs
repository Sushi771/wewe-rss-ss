const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/server')] }),
);
const pins = require('./fixtures/deployed-export-adaptation.json');
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
  assert.deepEqual(routes, pins.articleRoutes);
  for (const [file, expected] of Object.entries(pins.criticalFiles))
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
test('the deployed toolbar, grouping and reading layout are unchanged', () => {
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
  // Only the existing Stop action gains transport cancellation. Its behavior
  // and the abort receipt are exercised by the handler/HTTP regressions.
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
  assert.equal(hash(JSON.stringify(shape(returned))), pins.indexLayout);
});
