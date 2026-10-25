const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/server')] }),
);
const pins = require('./fixtures/deployed-export-adaptation.json');
const xhsCompatibility = require('./fixtures/xhs-integration-router-compatibility.json');
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
  // Keep every unrelated historical pin. This explicit layer records the four
  // independently reproduced f8fbb3c XHS differences and the two reviewed
  // engagement injection/router changes; it is not a full router repin.
  assert.deepEqual(Object.keys(xhsCompatibility.baseline).sort(), [
    'constructor',
    'requireLocalXhsAccess',
    'requireLocalXhsConnection',
    'xiaohongshuRouter',
  ]);
  assert.deepEqual(Object.keys(xhsCompatibility.engagement).sort(), [
    'constructor',
    'xiaohongshuRouter',
  ]);
  // The whole-creator extension may change only this injection and five XHS routes.
  // Remove those exact AST nodes and still enforce the previous engagement pins.
  assert.deepEqual(Object.keys(xhsCompatibility.wholeCreator).sort(), [
    'constructor',
    'xiaohongshuRouter',
  ]);
  const wholeRoutes = [
    'wholeCreatorJobs',
    'startWholeCreator',
    'resumeWholeCreator',
    'cancelWholeCreator',
    'extendWholeCreatorBudget',
  ];
  for (const key of ['constructor', 'xiaohongshuRouter']) {
    const member = declaration.members.find(
      (node) => (node.name?.getText(ast) || 'constructor') === key,
    );
    const removed =
      key === 'constructor'
        ? member.parameters.filter(
            (parameter) => parameter.name.getText(ast) === 'xhsWhole',
          )
        : member.initializer.arguments[0].properties.filter((property) =>
            wholeRoutes.includes(property.name.getText(ast)),
          );
    assert.equal(removed.length, key === 'constructor' ? 1 : 5);
    let prior = member.getText(ast);
    const offset = member.getStart(ast);
    for (const node of [...removed].reverse()) {
      assert.equal(
        read(file)[node.end],
        ',',
        'exact additive seam must retain its delimiter',
      );
      prior =
        prior.slice(0, node.getFullStart() - offset) +
        prior.slice(node.end + 1 - offset);
    }
    assert.equal(
      tokens(prior),
      xhsCompatibility.engagement[key],
      `unchanged pre-whole ${key}`,
    );
  }
  assert.deepEqual(members, {
    ...pins.routerMembers,
    ...xhsCompatibility.baseline,
    ...xhsCompatibility.engagement,
    ...xhsCompatibility.wholeCreator,
  });
  assert.deepEqual(routes, {
    ...pins.articleRoutes,
    ...searchPins.articleRoutes,
  });
  for (const [file, expected] of Object.entries({
    ...pins.criticalFiles,
    ...searchPins.criticalFiles,
    ...xhsCompatibility.criticalFiles,
  })) {
    let source = read(file);
    if (file === 'apps/server/src/article-download.controller.ts') {
      const additions = [
        [
          'import { basename, dirname, isAbsolute, join }',
          'import { dirname, isAbsolute, join }',
        ],
        ['          withSource.afterSave = prepare.afterSave;\n', ''],
        [
          '    let snapshotSavedCount = 0;\n    const snapshotFiles: string[] = [];\n',
          '',
        ],
        [
          "        if (result.supplement) {\n          snapshotFiles.push(basename(result.supplement.path));\n          if (result.supplement.status !== 'retained') snapshotSavedCount++;\n        }\n",
          '',
        ],
        ['        snapshotSavedCount,\n        snapshotFiles,\n', ''],
      ];
      for (const [addition, original] of additions) {
        assert.equal(
          source.split(addition).length,
          2,
          'reviewed XHS supplement seam',
        );
        source = source.replace(addition, original);
      }
    }
    if (file === 'scripts/local-release/runtime.cjs') {
      // The separately tested release scope adds exactly one entry guard. Keep
      // every pre-existing runtime statement pinned to its deployed baseline.
      const guarded =
        "async function runtime() {\n  require('./lib.cjs').hostEffects.assertRuntime();\n";
      assert.equal(source.split(guarded).length, 2);
      source = source.replace(guarded, 'async function runtime() {\n');
    }
    assert.equal(hash(source), expected, file);
  }
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
  // This snapshot includes the authorized unified export dialog. The server,
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
