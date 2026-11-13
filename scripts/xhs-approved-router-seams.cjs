const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./fixtures/xhs-approved-router-seams.json');

// Exact inverse of individually reviewed XHS additions. Historical router pins
// still run after this layer; no unrelated member or route is discarded.
module.exports = function restoreApprovedRouter(ts, source) {
  source = require('./xhs-auth-connection-seams.cjs')(ts, source);
  const canonical = (text) => {
    const tree = ts.createSourceFile(
      'approved.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(
      tree.parseDiagnostics.length,
      0,
      'approved XHS source must parse',
    );
    // Syntax kinds and all syntax children retain ParenthesizedExpression and
    // its delimiters; positions/trivia are deliberately excluded.
    const structure = (node) => {
      const children = node.getChildren(tree);
      return children.length
        ? [node.kind, children.map(structure)]
        : [node.kind, node.getText(tree)];
    };
    return JSON.stringify(structure(tree));
  };
  assert.equal(
    crypto.createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
    '3a04c22d49e3ec9b57afe1f681c1476ddafb0cd76c2003ddd7e7256635418f4a',
    'fixed individually reviewed XHS inverse fixture',
  );
  const ast = ts.createSourceFile(
    'router.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(
    ast.parseDiagnostics.length,
    0,
    'approved XHS source must parse',
  );
  const cls = ast.statements.find(ts.isClassDeclaration);
  const router = cls.members.find(
    (n) => n.name?.getText(ast) === 'xiaohongshuRouter',
  );
  const nodes = new Map([
    ...ast.statements
      .filter((n) => ts.isVariableStatement(n))
      .map((n) => [
        'top:' + n.declarationList.declarations[0].name.getText(ast),
        n,
      ]),
    ...cls.members.map((n) => [
      'member:' + (n.name?.getText(ast) || 'constructor'),
      n,
    ]),
    ...router.initializer.arguments[0].properties.map((n) => [
      'route:' + n.name.getText(ast),
      n,
    ]),
  ]);
  const replacements = [];
  for (const entry of fixture.entries) {
    const node = nodes.get(entry.key);
    assert(node, 'exact approved XHS node present: ' + entry.key);
    assert.equal(
      crypto.createHash('sha256').update(entry.after).digest('hex'),
      entry.sha256,
      'fixed approved XHS source',
    );
    const wrap = (text) =>
      entry.key.startsWith('route:')
        ? '({' + text + '})'
        : entry.key.startsWith('member:')
          ? 'class C {' + text + '}'
          : text;
    assert.equal(
      canonical(wrap(node.getText(ast))),
      canonical(wrap(entry.after)),
      'exact approved XHS node: ' + entry.key,
    );
    if (entry.before === null) {
      const comma = entry.key.startsWith('route:');
      if (comma)
        assert.equal(source[node.end], ',', 'approved XHS route delimiter');
      replacements.push([node.getFullStart(), node.end + (comma ? 1 : 0), '']);
    } else replacements.push([node.getStart(ast), node.end, entry.before]);
  }
  for (const [start, end, before] of replacements.sort((a, b) => b[0] - a[0]))
    source = source.slice(0, start) + before + source.slice(end);
  return source;
};
