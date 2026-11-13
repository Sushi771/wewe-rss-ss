const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const entries = require('./fixtures/xhs-auth-connection-seams.json');

// Exact inverse of the two reviewed connection handlers. All previous inverse
// fixtures and the complete historical router AST remain authoritative.
module.exports = function restoreAuthConnection(ts, source) {
  assert.equal(
    crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    '06a3004bb0c2430c7ba2f84792e52465422ed1f1a6f08cf2168b8664e8dab15e',
  );
  const parse = (text) => {
    const ast = ts.createSourceFile(
      'router.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(
      ast.parseDiagnostics.length,
      0,
      'approved XHS source must parse',
    );
    return ast;
  };
  const canonical = (text) => {
    const ast = parse('({' + text + '})');
    const structure = (node) => {
      const children = node.getChildren(ast);
      return children.length
        ? [node.kind, children.map(structure)]
        : [node.kind, node.getText(ast)];
    };
    return JSON.stringify(structure(ast));
  };
  const ast = parse(source),
    cls = ast.statements.find(ts.isClassDeclaration);
  const routes = cls.members.find(
    (n) => n.name?.getText(ast) === 'xiaohongshuRouter',
  ).initializer.arguments[0].properties;
  const changes = entries.map((entry) => {
    const nodes = routes.filter((n) => n.name?.getText(ast) === entry.name);
    assert.equal(nodes.length, 1, 'exact approved XHS connection present');
    const node = nodes[0];
    assert.equal(
      canonical(node.getText(ast)),
      canonical(entry.after),
      'exact approved XHS connection',
    );
    return [node.getStart(ast), node.end, entry.before];
  });
  for (const [start, end, before] of changes.sort((a, b) => b[0] - a[0]))
    source = source.slice(0, start) + before + source.slice(end);
  return source;
};
