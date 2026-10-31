const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cacheRoutes = require('./fixtures/xhs-cache-router-seams.json');
const reviewed = {
  prepareXhsHistoryHandoff: '476459a9d1f88857253c0879c14a1c1931de5c2720265b01d641d72bd55f722f',
  confirmXhsHistoryHandoff: '726e8b70d47125b914c14b1b144a8d83318c71c00fe87385a013915bd9906ade',
  reviewWholeCreatorGeneration: 'cfb034a14b0d09b8aa23cb46fb319fff9053e19c365c3ecaa9090cd457f086c9',
  prepareWholeCreatorGeneration: 'a6479de8618ec55f3a68fcc8cfe2b2874328aede67741113eb2ce0b5443dfcda',
  executeWholeCreatorGeneration: 'fe873f68bbeaf0e25feb61973c9e8becd7508337969f04cc81f345768784950b',
  prepareWholeCreatorReviewedAttempt: 'ab9022ddc95a156b83d0ec15600cb1280fc3324ef9f3d871fcffdad633c637f1',
  executeWholeCreatorReviewedAttempt: '3698fd1ccb5184c5b622561a5d5ae8fff2498d6f75188a26446d517b46ab6665',
  reviewWholeCreatorUnknown: '016910f26d7d4345a1f0687cf778bdce77a462ebc7a5f7ad679cbf98b3bc126f',
};
// Remove only the exact reviewed additions before enforcing historical pins.
module.exports = function restorePreReviewedRecoveryRouter(ts, source) {
  for (const route of cacheRoutes) {
    const exact = route.before === null ? '    ' + route.after + ',\n' : route.after;
    assert.equal(source.split(exact).length, 2, 'exact cache collection route: ' + route.name);
    source = source.replace(exact, route.before ?? '');
  }
  const ast = ts.createSourceFile('router.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(ts.isClassDeclaration);
  const member = declaration.members.find(node => node.name?.getText(ast) === 'xiaohongshuRouter');
  const routes = member.initializer.arguments[0].properties.filter(node => Object.hasOwn(reviewed, node.name.getText(ast)));
  assert.equal(routes.length, 8, 'all reviewed recovery routes must be present');
  for (const node of routes) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, node.getText(ast));
    const tokens = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
    assert.equal(crypto.createHash('sha256').update(tokens.join('\0')).digest('hex'), reviewed[node.name.getText(ast)], 'exact reviewed recovery route');
    assert.equal(source[node.end], ',', 'reviewed route delimiter');
  }
  for (const node of [...routes].reverse()) source = source.slice(0, node.getFullStart()) + source.slice(node.end + 1);
  return source;
};
