const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(
  require.resolve('typescript', { paths: [path.join(root, 'apps/server')] }),
);
const manifest = require('../apps/server/scripts/fixtures/main-wechat-runtime-scope.json');
const localSearch = require('./fixtures/local-body-search-runtime-scope.json');
// Git's Windows checkout conversion must not change source-policy fingerprints.
const read = (file) =>
  fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function tokens(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    text,
  );
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
    result.push(scanner.getTokenText());
  return hash(result.join('\0'));
}
function members(file) {
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = ast.statements.find(ts.isClassDeclaration);
  return Object.fromEntries(
    declaration.members.map((node) => [
      node.name?.getText(ast) || 'constructor',
      tokens(node.getText(ast)),
    ]),
  );
}
test('the collection extraction preserves every unrelated main member and the selected deployed members', () => {
  assert.deepEqual(
    members('apps/server/src/collection/collection.service.ts'),
    manifest.collectionMembers,
  );
});
test('only the explicitly reviewed local search reading scope extends the frozen safety manifest', () => {
  assert.deepEqual(
    Object.keys(localSearch.criticalBlobs).sort(),
    [
      'apps/server/src/article-list-page.ts',
      'apps/server/src/article-body-search.ts',
      'packages/shared/src/article-date-filter.ts',
    ].sort(),
  );
  assert.deepEqual(Object.keys(localSearch.routerMembers), [
    'buildOfflineFeedDirectory',
  ]);
  assert.deepEqual(
    Object.keys(localSearch.articleRoutes).sort(),
    ['searchStatus', 'prepareSearch', 'summary', 'list'].sort(),
  );
});

test('native login and safety policies remain pinned outside the explicit local search reading scope', () => {
  const service = members('apps/server/src/trpc/trpc.service.ts');
  for (const [name, expected] of Object.entries(manifest.nativeLoginMembers))
    assert.equal(service[name], expected, name);
  for (const [file, expected] of Object.entries({
    ...manifest.criticalBlobs,
    ...localSearch.criticalBlobs,
  }))
    assert.equal(hash(read(file)), expected, file);
});

test('only the selected media and explicit local search routes change', () => {
  assert.deepEqual(
    members('apps/server/src/trpc/trpc.service.ts'),
    manifest.trpcServiceMembers,
  );
  const file = 'apps/server/src/trpc/trpc.router.ts';
  const actual = members(file);
  delete actual.articleRouter;
  assert.deepEqual(actual, {
    ...manifest.routerMembers,
    ...localSearch.routerMembers,
  });
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = ast.statements.find(ts.isClassDeclaration);
  const article = declaration.members.find(
    (node) => node.name?.getText(ast) === 'articleRouter',
  );
  assert.deepEqual(
    Object.fromEntries(
      article.initializer.arguments[0].properties.map((node) => [
        node.name.getText(ast),
        tokens(node.getText(ast)),
      ]),
    ),
    { ...manifest.articleRoutes, ...localSearch.articleRoutes },
  );
});
test('the main extraction excludes XHS and general download tools while keeping the authorized deployed lifecycle', () => {
  const file = 'apps/server/src/trpc/trpc.router.ts';
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = ast.statements.find(ts.isClassDeclaration);
  const router = declaration.members.find(
    (node) => node.name?.getText(ast) === 'appRouter',
  );
  assert.deepEqual(
    router.initializer.arguments[0].properties.map((node) =>
      node.name.getText(ast),
    ),
    manifest.appRouters,
  );
  for (const file of manifest.excludedFiles)
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  assert(!read('apps/server/src/app.module.ts').includes('Xiaohongshu'));
  assert(!read('apps/server/src/trpc/trpc.module.ts').includes('Xiaohongshu'));
  assert(
    read('apps/server/scripts/backup-sqlite.py').includes(
      'SQLITE_PERIODIC_LIFECYCLE_ENABLED',
    ),
  );
  assert(
    read('apps/server/src/trpc/trpc.router.ts').includes(
      'supplementSavedMedia',
    ),
  );
  assert(!read('apps/server/src/trpc/trpc.router.ts').includes('exportIds'));
});
