const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cacheRoutes = require('./fixtures/xhs-cache-router-seams.json');
const reviewed = {
  reviewWholeCreatorGeneration: '6a00210d437bbad3dad74131eac7382b3a3f4a152d4834b4a0f81a7904c93479',
  prepareWholeCreatorGeneration: 'a6479de8618ec55f3a68fcc8cfe2b2874328aede67741113eb2ce0b5443dfcda',
  executeWholeCreatorGeneration: 'fe873f68bbeaf0e25feb61973c9e8becd7508337969f04cc81f345768784950b',
  prepareWholeCreatorReviewedAttempt: '32944638bc18f0be29aae435cec3821e17c65f77559c7c0ec17c7309dd04ebae',
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
  assert.equal(routes.length, 6, 'all reviewed recovery routes must be present');
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
