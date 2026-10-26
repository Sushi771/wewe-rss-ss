const assert = require('node:assert/strict');
const seam = require('./fixtures/xhs-reader-removal.json');

function parse(ts, source) {
  return ts.createSourceFile(
    'candidate.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
}
function restoreXhsReaderRoute(ts, source) {
  const ast = parse(ts, source);
  const declaration = ast.statements.find(ts.isClassDeclaration);
  const router = declaration.members.find(
    (m) => m.name?.getText(ast) === 'xiaohongshuRouter',
  );
  const routes = router.initializer.arguments[0].properties;
  assert.equal(
    routes.filter((r) => r.name.getText(ast) === 'body').length,
    0,
    'XHS platform reader route must remain deleted',
  );
  const anchor = routes.filter((r) => r.name.getText(ast) === 'refresh');
  assert.equal(anchor.length, 1, 'exact deleted route seam');
  const at = anchor[0].getFullStart();
  return source.slice(0, at) + seam.removedRoute + source.slice(at);
}
function restoreXhsReaderService(ts, source) {
  const ast = parse(ts, source);
  const declaration = ast.statements.find(ts.isClassDeclaration);
  assert.equal(
    declaration.members.filter((m) => m.name?.getText(ast) === 'body').length,
    0,
    'XHS platform reader service must remain deleted',
  );
  const anchor = declaration.members.filter(
    (m) => m.name?.getText(ast) === 'export',
  );
  assert.equal(anchor.length, 1, 'exact deleted service seam');
  assert.equal(source.includes(seam.removedImport.trim()), false);
  const at = anchor[0].getFullStart();
  const prior = source.slice(0, at) + seam.removedMethod + source.slice(at);
  const importAnchor =
    "import { visibleBodyText } from '../article-body-search';\n";
  assert.equal(prior.split(importAnchor).length, 2);
  return prior.replace(importAnchor, importAnchor + seam.removedImport);
}
module.exports = { restoreXhsReaderRoute, restoreXhsReaderService };
