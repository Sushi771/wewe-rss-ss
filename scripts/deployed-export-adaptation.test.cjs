const restorePreOriginalLinkRouter = require('./xhs-original-link-router-seams.cjs');
const restorePreReviewedRecoveryRouter = require('./xhs-reviewed-recovery-router-seams.cjs');
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
const { restoreXhsReaderRoute } = require('./xhs-reader-removal.cjs');
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

test('reviewed recovery seam retains the exact existing router source', () => {
  const restored = restorePreReviewedRecoveryRouter(ts, read('apps/server/src/trpc/trpc.router.ts'));
  const blob = crypto.createHash('sha1').update('blob '+Buffer.byteLength(restored)+'\0').update(restored).digest('hex');
  assert.equal(blob, '782fbcd89c949bd06063488594e05b316d61008d', 'exact pre-recovery router from the reviewed baseline');
});

test('reviewed recovery seam rejects missing routes and changed writable authentication', () => {
  const source = read('apps/server/src/trpc/trpc.router.ts');
  for (const name of ['prepareWholeCreatorReviewedAttempt', 'executeWholeCreatorReviewedAttempt', 'reviewWholeCreatorUnknown']) {
    const declaration = name+': this.trpcService.protectedProcedure';
    assert.equal(source.split(declaration).length, 2);
    assert.throws(() => restorePreReviewedRecoveryRouter(ts, source.replace(declaration, name+': this.trpcService.publicProcedure')), /exact reviewed recovery route/);
    assert.throws(() => restorePreReviewedRecoveryRouter(ts, source.replace(name+':', 'unreviewedReplacement:')), /all reviewed recovery routes/);
  }
});
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
  // Assert deletion, then reconstruct only the exact removed reader seam.
  // All old router/wholeCreator/engagement pins remain authoritative.
  const pinnedRouterSource = restoreXhsReaderRoute(ts, restorePreOriginalLinkRouter(restorePreReviewedRecoveryRouter(ts, read(file))));
  const ast = ts.createSourceFile(
    file,
    pinnedRouterSource,
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
        pinnedRouterSource[node.end],
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
    // Reader-only files were intentionally removed; keep every download/cache
    // baseline pin below and require these exact retired components to stay absent.
    const removedReaders = {
      'apps/web/src/components/ArticleReader.tsx': '5427dcc31fac30a42f7daaa09dcbf3e842013d8a65a29ec94c30750ceca1c071',
      'apps/web/src/utils/article-reader-find.ts': 'f46a6144c8dac9cce7cbb1f3835e1606b5be8b8bd8d192ac336fd73c8eac1b79',
    };
    if (file in removedReaders) {
      assert.equal(expected, removedReaders[file], 'exact retired reader pin');
      assert.equal(fs.existsSync(file), false, file + ' must remain removed');
      continue;
    }
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
    let requiredHash = expected;
    if (file === 'scripts/local-release/restart.cjs') {
      assert.equal(expected, 'd958e4f2be1bb1f3f031f809669dde57057ffa6c6c7b2cce993862b4c466a4cc', 'exact pre-preserving restart baseline');
      // Reviewed schema proof retention and closed-copy restart inspection.
      requiredHash = '4ff5d4deb9dc621f6b91ee55309fd1e7674e650f4dcc6c53fc40caea0d7061ea';
      const restartAst = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const calls = [];
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) calls.push(node.expression.name.text);
        ts.forEachChild(node, visit);
      };
      visit(restartAst);
      for (const [name, count] of [['validateSameSchema', 1], ['validateActiveBinding', 1], ['bindPreservingChild', 1], ['confirmPreservingProcessExit', 2]])
        assert.equal(calls.filter((value) => value === name).length, count, 'reviewed preserving restart ' + name);
    }
    if (file === 'apps/server/src/prisma/prisma.service.ts') {
      // Keep the deployed baseline pin authoritative. Only this independently
      // reviewed recovery version is accepted; all unknown changes still fail.
      assert.equal(
        expected,
        '5e5887853c41a58205e6b6a22e217dff5501bfa964969044f510c9ef36731aaf',
        'exact pre-recovery Prisma baseline',
      );
      requiredHash =
        '6b71dbdced274a391826ccd6844eff781fd5e01a1dfa9fc765ab46eb2a1a7ab4';
      const recoveryAst = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const service = recoveryAst.statements.find(ts.isClassDeclaration);
      const recovery = service.members.filter(
        (member) => member.name?.getText(recoveryAst) === 'recoverFailedMediaTransaction',
      );
      assert.equal(recovery.length, 1, 'one reviewed recovery owner');
      assert.equal(recovery[0].parameters.length, 0, 'recovery cannot receive a replay callback');
      assert.ok(recovery[0].body.getText(recoveryAst).includes('await this.$disconnect();'));
      assert.ok(recovery[0].body.getText(recoveryAst).includes('await this.$connect();'));
      assert.ok(recovery[0].body.getText(recoveryAst).includes("setDatabaseRecovery('failed')"));
    }
    assert.equal(hash(source), requiredHash, file);
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
