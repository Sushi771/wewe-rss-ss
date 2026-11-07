const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cacheRoutes = require('./fixtures/xhs-cache-router-seams.json');
const originals = require('./fixtures/xhs-reviewed-recovery-originals.json');
const { shape } = require('./xhs-platform-directory-seams.cjs');
const reviewed = {
  prepareXhsHistoryHandoff:
    '476459a9d1f88857253c0879c14a1c1931de5c2720265b01d641d72bd55f722f',
  confirmXhsHistoryHandoff:
    'd665b26a1ee6d1de60fa625b94a8cbf4d56d114407f7756fafb5bc585e72cb42',
  reviewWholeCreatorGeneration:
    'cfb034a14b0d09b8aa23cb46fb319fff9053e19c365c3ecaa9090cd457f086c9',
  prepareWholeCreatorGeneration:
    'a6479de8618ec55f3a68fcc8cfe2b2874328aede67741113eb2ce0b5443dfcda',
  executeWholeCreatorGeneration:
    'fe873f68bbeaf0e25feb61973c9e8becd7508337969f04cc81f345768784950b',
  prepareWholeCreatorReviewedAttempt:
    'ab9022ddc95a156b83d0ec15600cb1280fc3324ef9f3d871fcffdad633c637f1',
  executeWholeCreatorReviewedAttempt:
    '3698fd1ccb5184c5b622561a5d5ae8fff2498d6f75188a26446d517b46ab6665',
  reviewWholeCreatorUnknown:
    '016910f26d7d4345a1f0687cf778bdce77a462ebc7a5f7ad679cbf98b3bc126f',
};
// Remove only the exact reviewed additions before enforcing historical pins.
module.exports = function restorePreReviewedRecoveryRouter(ts, source) {
  source = require('./xhs-approved-router-seams.cjs')(ts, source);
  for (const route of cacheRoutes) {
    const exact =
      route.before === null ? '    ' + route.after + ',\n' : route.after;
    assert.equal(
      source.split(exact).length,
      2,
      'exact cache collection route: ' + route.name,
    );
    source = source.replace(exact, route.before ?? '');
  }
  const ast = ts.createSourceFile(
    'router.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = ast.statements.find(ts.isClassDeclaration);
  const member = declaration.members.find(
    (node) => node.name?.getText(ast) === 'xiaohongshuRouter',
  );
  const routes = member.initializer.arguments[0].properties.filter((node) =>
    Object.hasOwn(reviewed, node.name.getText(ast)),
  );
  assert.equal(
    routes.length,
    8,
    'all reviewed recovery routes must be present',
  );
  for (const node of routes) {
    const original = originals.reviewed[node.name.getText(ast)];
    assert(original, 'fixed reviewed route source');
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.JSX,
      original.source,
    );
    const tokens = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
      tokens.push(scanner.getTokenText());
    assert.equal(
      crypto.createHash('sha256').update(tokens.join('\0')).digest('hex'),
      reviewed[node.name.getText(ast)],
      'unchanged original reviewed route pin',
    );
    assert.equal(
      shape('({' + node.getText(ast) + '})'),
      shape('({' + original.source + '})'),
      'exact reviewed recovery route',
    );
    assert.equal(source[node.end], ',', 'reviewed route delimiter');
  }
  for (const node of [...routes].reverse())
    source = source.slice(0, node.getFullStart()) + source.slice(node.end + 1);
  // Exact collection integration additions, separately reviewed from the old routes.
  const integrationPins = {
    batchImport:
      'c488b9a90093ba1215439318fe0a94961414c3c4a2d3b527dcc2a9969d1e0ba8',
    batchGetter:
      'ac744ac98deefed82071bae0047efbd5bcaa4337a5527422f4f35e0688e3cefc',
    prepareLegacyPendingOwnerReview:
      '9cd6e8fdb52305922d5b34550d67c5617656c797047a7957989eebe2be36464a',
    confirmLegacyPendingOwnerReview:
      '5da29d0caad9cdca9abcbbf274e725aebaa8b1708b246eda06a44c2a1e348fed',
    legacyRefresh:
      '33f6d240790741aa05b0832ac92ce2103a190abcc8c586c825cc48ac595c5e05',
    refreshStatus:
      'ab03c81ee16ef4199da52647501363dc2cf761df39173fbddf54c70b90791b6a',
    stopRefresh:
      '08eb39ab910e2619a2c14cb6cbdeac8a308c248784df83c99cb526f2cfa18f84',
    createRefreshBatch:
      'be3725cb434e958003e811794a7b3da980a85f6531b476f20fdab645b56489f2',
    activeRefreshBatch:
      'b9caae0f8bfc1645ab2b8a80bc9c0597530dd5b1d32fbe50098c918ed41ae67b',
    refreshBatchStatus:
      'f1165624d6eb68f3612b4fa5bbbcf079ef5e545627b4d065d3182b1f52088c2e',
    advanceRefreshBatch:
      '5a340fd023d638c08218ca0a623ccdc4be718a226268042d3b342acf160d2a83',
    stopRefreshBatch:
      '83d12a505eebcdd54359d5e31eb3d3beddca4e90a2d095186dd768bb61bec8f0',
  };
  const integratedAst = ts.createSourceFile(
    'router.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const integratedClass = integratedAst.statements.find(ts.isClassDeclaration);
  const integratedRouter = integratedClass.members.find(
    (n) => n.name?.getText(integratedAst) === 'xiaohongshuRouter',
  );
  const integrationNodes = [
    [
      'batchImport',
      integratedAst.statements.find(
        (n) =>
          ts.isImportDeclaration(n) &&
          n.moduleSpecifier.text === '../collection/xiaohongshu-batches',
      ),
      false,
    ],
    [
      'batchGetter',
      integratedClass.members.find(
        (n) =>
          ts.isGetAccessor(n) && n.name.getText(integratedAst) === 'xhsBatches',
      ),
      false,
    ],
    ...[
      'prepareLegacyPendingOwnerReview',
      'confirmLegacyPendingOwnerReview',
      'legacyRefresh',
      'refreshStatus',
      'stopRefresh',
      'createRefreshBatch',
      'activeRefreshBatch',
      'refreshBatchStatus',
      'advanceRefreshBatch',
      'stopRefreshBatch',
    ].map((name) => [
      name,
      integratedRouter.initializer.arguments[0].properties.find(
        (n) => n.name?.getText(integratedAst) === name,
      ),
      true,
    ]),
  ];
  for (const [name, node] of integrationNodes) {
    assert(
      node,
      'all reviewed collection integration additions must remain present',
    );
    const original = originals.integration[name];
    assert.equal(
      crypto.createHash('sha256').update(original).digest('hex'),
      integrationPins[name],
      'fixed collection integration source',
    );
    const wrap = (text) =>
      name === 'batchImport'
        ? text
        : name === 'batchGetter'
          ? 'class C {' + text + '}'
          : '({' + text + '})';
    assert.equal(
      shape(wrap(node.getText(integratedAst))),
      shape(wrap(original)),
      'exact collection integration addition: ' + name,
    );
  }
  for (const [, node, comma] of integrationNodes.sort(
    (a, b) => b[1].pos - a[1].pos,
  )) {
    if (comma)
      assert.equal(source[node.end], ',', 'integration route delimiter');
    source =
      source.slice(0, node.getFullStart()) +
      source.slice(node.end + (comma ? 1 : 0));
  }
  const baseline = Buffer.from(originals.baseline);
  assert.equal(
    originals.baselineSha1,
    '782fbcd89c949bd06063488594e05b316d61008d',
    'unchanged pre-recovery pin',
  );
  assert.equal(
    crypto
      .createHash('sha1')
      .update('blob ' + baseline.length + '\0')
      .update(baseline)
      .digest('hex'),
    originals.baselineSha1,
    'fixed original router blob',
  );
  assert.equal(
    shape(source),
    shape(originals.baseline),
    'complete pre-recovery router AST preserved',
  );
  return originals.baseline;
};
