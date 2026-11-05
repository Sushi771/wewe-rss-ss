const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require(
  require.resolve('typescript', {
    paths: [path.join(__dirname, '../apps/server')],
  }),
);
function scan(source) {
  const tree = ts.createSourceFile(
      'span.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    ),
    rows = [];
  function visit(node) {
    const children = node.getChildren(tree);
    if (children.length) {
      children.forEach(visit);
      return;
    }
    if (node.kind !== ts.SyntaxKind.EndOfFileToken)
      rows.push({
        kind: node.kind,
        text: node.getText(tree),
        value: node.text,
        start: node.getStart(tree),
        end: node.end,
      });
  }
  visit(tree);
  const tokens = rows.filter((r) => r.end > r.start);
  for (let i = tokens.length - 4; i >= 0; i--)
    if (
      tokens[i].kind === ts.SyntaxKind.OpenParenToken &&
      tokens[i + 1].kind === ts.SyntaxKind.Identifier &&
      tokens[i + 2].kind === ts.SyntaxKind.CloseParenToken &&
      tokens[i + 3].kind === ts.SyntaxKind.EqualsGreaterThanToken
    ) {
      tokens.splice(i + 2, 1);
      tokens.splice(i, 1);
    }
  return tokens
    .filter(
      (r, i) =>
        !(
          r.kind === ts.SyntaxKind.CommaToken &&
          i > 0 &&
          tokens[i - 1].kind !== ts.SyntaxKind.CommaToken &&
          (i === tokens.length - 1 ||
            [
              ts.SyntaxKind.CloseBraceToken,
              ts.SyntaxKind.CloseBracketToken,
              ts.SyntaxKind.CloseParenToken,
            ].includes(tokens[i + 1]?.kind))
        ),
    )
    .filter(
      (r) =>
        ![ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken].includes(
          r.kind,
        ),
    );
}
function key(row) {
  return (
    (row.kind === ts.SyntaxKind.Identifier ||
    (row.kind >= ts.SyntaxKind.FirstKeyword &&
      row.kind <= ts.SyntaxKind.LastKeyword)
      ? 'word'
      : row.kind) +
    ':' +
    (row.kind === ts.SyntaxKind.StringLiteral ? row.value : row.text)
  );
}
function span(source, exact, message) {
  if (source.split(exact).length === 2) {
    const start = source.indexOf(exact);
    return { start, end: start + exact.length, text: exact };
  }
  const hay = scan(source),
    needle = scan(exact),
    matches = [];
  assert(needle.length, message);
  for (let i = 0; i <= hay.length - needle.length; i++)
    if (needle.every((r, j) => key(r) === key(hay[i + j]))) {
      let end = hay[i + needle.length - 1].end;
      if (exact.trimEnd().endsWith(',') && source.slice(end).match(/^\s*,/))
        end += source.slice(end).match(/^\s*,/)[0].length;
      matches.push({
        start: hay[i].start,
        end,
        text: source.slice(hay[i].start, end),
      });
    }
  assert.equal(matches.length, 1, message);
  return matches[0];
}
function replace(source, after, before, message) {
  const s = span(source, after, message);
  assert.ok(
    shape(source) ===
      shape(source.slice(0, s.start) + after + source.slice(s.end)),
    'exact reviewed platform directory seam: AST equivalent after',
  );
  return source.slice(0, s.start) + before + source.slice(s.end);
}
function shape(source) {
  const ast = ts.createSourceFile(
    'baseline.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(
    ast.parseDiagnostics.length,
    0,
    'exact reviewed platform directory seam: valid source AST',
  );
  function visit(n) {
    if (ts.isParenthesizedExpression(n)) return visit(n.expression);
    if (ts.isParenthesizedTypeNode(n)) return visit(n.type);
    const children = [];
    ts.forEachChild(n, (child) => {
      children.push(visit(child));
    });
    const literal =
      ts.isIdentifier(n) ||
      ts.isStringLiteral(n) ||
      ts.isNumericLiteral(n) ||
      ts.isBigIntLiteral(n) ||
      ts.isRegularExpressionLiteral(n) ||
      ts.isTemplateLiteralToken(n);
    const semantics = {};
    for (const name of ['isTypeOnly', 'isPostfix', 'operator'])
      if (typeof n[name] === 'boolean' || typeof n[name] === 'number')
        semantics[name] = n[name];
    if (ts.isVariableDeclarationList(n))
      semantics.declarationFlags =
        n.flags &
        (ts.NodeFlags.Let |
          ts.NodeFlags.Const |
          ts.NodeFlags.Using |
          ts.NodeFlags.AwaitUsing);
    return [
      n.kind,
      literal ? n.text : null,
      ts.isTemplateLiteralToken(n) ? (n.rawText ?? n.text) : null,
      semantics,
      children,
    ];
  }
  return JSON.stringify(visit(ast));
}
const crypto = require('node:crypto');
const seams = require('./fixtures/xhs-platform-directory-seams.json');
const originals = require('./fixtures/xhs-platform-originals.json');
const pins = {
  'apps/server/src/article-download.controller.ts':
    '4923fa9409ce762b28863e97788de0912dcb7060',
  'apps/server/src/article-export-source.ts':
    'c2e7642b52e4a3a15d684eec219e87e3ff260ade',
  'apps/server/src/collection/xiaohongshu.service.ts':
    'bb68cf3617dab43ff292575ab2e2061e40dc612a',
};
module.exports = function restorePlatformDirectory(file, source) {
  if (!originals[file]) return source;
  const original = originals[file],
    bytes = Buffer.from(original.source);
  assert.equal(original.sha1, pins[file], 'unchanged original pin');
  assert.equal(
    crypto
      .createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex'),
    pins[file],
    'original fixture fixed blob',
  );
  for (const [index, seam] of (seams[file] || []).entries())
    source = replace(
      source,
      seam.after,
      seam.before,
      'exact reviewed platform directory seam ' + file + ' #' + index,
    );
  if (file === 'apps/server/src/collection/xiaohongshu.service.ts') {
    const compat = require('./fixtures/xhs-platform-service-recovery-compat.json');
    assert.equal(
      compat.originalBlob,
      pins[file],
      'compat retains unchanged original blob',
    );
    for (const hunk of compat.hunks)
      source = replace(
        source,
        hunk.after,
        hunk.before,
        'one reviewed recovery compatibility member ' + hunk.name,
      );
  }
  assert.ok(
    shape(source) === shape(original.source),
    'exact reviewed platform directory seam: full original AST preserved',
  );
  return original.source;
};
module.exports.shape = shape;
