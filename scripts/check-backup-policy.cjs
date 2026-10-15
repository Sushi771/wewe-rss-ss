// Static engineering guard, not a security sandbox. No app import or database IO.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '..');
const ts = createRequire(path.join(repo, 'apps/server/package.json'))(
  'typescript',
);
const gates = new Set([
  'createVerifiedSqliteBackup',
  'protectedDelete',
  'protectedFeedDelete',
  'protectedArticleDelete',
]);

function scopeOf(node) {
  const parts = [];
  for (let p = node.parent; p; p = p.parent) {
    if (
      (ts.isMethodDeclaration(p) ||
        ts.isFunctionDeclaration(p) ||
        ts.isClassDeclaration(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isPropertyDeclaration(p)) &&
      p.name
    )
      parts.unshift(p.name.getText().replace(/^['"]|['"]$/g, ''));
  }
  return parts.join('.') || '<module>';
}
function inspectSource(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const aliases = new Map([...gates].map((name) => [name, name]));
  const calls = [],
    references = [];
  for (const item of tree.statements) {
    if (ts.isImportDeclaration(item)) {
      const bindings = item.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const entry of bindings.elements)
          if (gates.has((entry.propertyName || entry.name).text))
            aliases.set(
              entry.name.text,
              (entry.propertyName || entry.name).text,
            );
    }
  }
  function visit(node) {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      gates.has(node.argumentExpression.text) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    )
      references.push({
        file,
        scope: scopeOf(node),
        line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    const callee = ts.isCallExpression(node) && node.expression;
    const gate =
      callee &&
      (ts.isIdentifier(callee)
        ? aliases.get(callee.text)
        : ts.isPropertyAccessExpression(callee) && gates.has(callee.name.text)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) &&
              ts.isStringLiteral(callee.argumentExpression) &&
              gates.has(callee.argumentExpression.text)
            ? callee.argumentExpression.text
            : undefined);
    if (gate)
      calls.push({
        file,
        scope: scopeOf(node),
        gate,
        line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    if (
      ts.isIdentifier(node) &&
      aliases.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isFunctionDeclaration(node.parent)
    ) {
      const p = node.parent;
      if (
        !(ts.isCallExpression(p) && p.expression === node) &&
        !(
          ts.isPropertyAccessExpression(p) &&
          p.name === node &&
          ts.isCallExpression(p.parent) &&
          p.parent.expression === p
        )
      )
        references.push({
          file,
          scope: scopeOf(node),
          line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { calls, references };
}
function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sources(file)
      : /\.ts$/.test(entry.name) && !/\.(spec|test|d)\.ts$/.test(entry.name)
        ? [file]
        : [];
  });
}
function inventory(root = repo) {
  const result = { calls: [], references: [] };
  for (const file of sources(path.join(root, 'apps/server/src'))) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    const found = inspectSource(fs.readFileSync(file, 'utf8'), relative);
    result.calls.push(...found.calls);
    result.references.push(...found.references);
  }
  return result;
}
function violations(found, policy) {
  const allowed = new Map();
  const errors = [];
  for (const item of policy.boundaries) {
    const key = item.file + '::' + item.scope + '::' + item.gate;
    if (
      !item.file ||
      !item.scope ||
      !gates.has(item.gate) ||
      !Number.isInteger(item.maxCalls) ||
      item.maxCalls < 0 ||
      item.maxCalls > 1 ||
      !item.rationale?.trim()
    )
      errors.push(`Invalid explicit backup rule: ${key}`);
    if (allowed.has(key)) errors.push(`Duplicate backup rule: ${key}`);
    allowed.set(key, item);
  }
  const counts = new Map();
  errors.push(
    ...found.references.map(
      (item) =>
        `Unreviewed backup alias/reference at ${item.file}:${item.line}`,
    ),
  );
  for (const item of found.calls) {
    const key = item.file + '::' + item.scope + '::' + item.gate;
    counts.set(key, (counts.get(key) || 0) + 1);
    const rule = allowed.get(key);
    if (!rule)
      errors.push(
        `Unregistered full-snapshot boundary at ${item.file}:${item.line} (${item.scope})`,
      );
    else if (counts.get(key) > rule.maxCalls)
      errors.push(`Full-snapshot count exceeds ${rule.maxCalls} in ${key}`);
  }
  for (const [key, rule] of allowed)
    if (rule.maxCalls === 1 && !counts.has(key))
      errors.push(`Required protected boundary is missing: ${key}`);
  return errors;
}
if (require.main === module) {
  const found = inventory();
  if (process.argv.includes('--inventory'))
    console.log(JSON.stringify(found, null, 2));
  else {
    const policy = JSON.parse(
      fs.readFileSync(path.join(repo, 'docs/backup-call-policy.json'), 'utf8'),
    );
    const errors = violations(found, policy);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else
      console.log(
        `Backup call policy passed: ${found.calls.length} registered application boundaries; ordinary writers have no default snapshot gate.`,
      );
  }
}
module.exports = { inspectSource, inventory, violations };
