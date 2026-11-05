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
  const namespaces = new Set();
  const declarations = new Set();
  const reported = new Set();
  const calls = [],
    references = [];
  const staticText = (node) =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const protectedModule = (node) =>
    /(?:^|\/)(?:sqlite-backup|protected-delete|protected-feed-delete|protected-article-delete)(?:\.[cm]?[jt]s)?$/i.test(
      (staticText(node) || '').replaceAll('\\', '/').split(/[?#]/, 1)[0],
    );
  const wrapper = (node) =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAwaitExpression(node);
  function unwrap(node) {
    while (node && wrapper(node)) node = node.expression;
    return node;
  }
  function outer(node) {
    while (node.parent && wrapper(node.parent)) node = node.parent;
    return node;
  }
  function moduleLoad(node) {
    node = unwrap(node);
    return (
      node &&
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      protectedModule(node.arguments[0])
    );
  }
  function gateOf(node) {
    node = unwrap(node);
    if (!node) return;
    if (ts.isIdentifier(node)) return aliases.get(node.text);
    const key = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node)
        ? staticText(node.argumentExpression)
        : undefined;
    return gates.has(key) ? key : undefined;
  }
  function directCall(node) {
    node = outer(node);
    return ts.isCallExpression(node.parent) && node.parent.expression === node;
  }
  function reference(node, reason) {
    const position = node.getStart();
    if (reported.has(position)) return;
    reported.add(position);
    references.push({
      file,
      scope: scopeOf(node),
      line: tree.getLineAndCharacterOfPosition(position).line + 1,
      reason,
    });
  }
  for (const item of tree.statements) {
    if (ts.isImportDeclaration(item) && !item.importClause?.isTypeOnly) {
      const bindings = item.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const entry of bindings.elements)
          if (
            !entry.isTypeOnly &&
            gates.has((entry.propertyName || entry.name).text)
          )
            aliases.set(
              entry.name.text,
              (entry.propertyName || entry.name).text,
            );
      if (protectedModule(item.moduleSpecifier)) {
        if (bindings && ts.isNamespaceImport(bindings)) {
          namespaces.add(bindings.name.text);
          declarations.add(bindings.name);
        }
        if (item.importClause?.name) {
          namespaces.add(item.importClause.name.text);
          declarations.add(item.importClause.name);
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(item) &&
      !item.isTypeOnly &&
      ts.isExternalModuleReference(item.moduleReference) &&
      protectedModule(item.moduleReference.expression)
    ) {
      namespaces.add(item.name.text);
      declarations.add(item.name);
    }
  }
  function collect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      moduleLoad(node.initializer)
    ) {
      namespaces.add(node.name.text);
      declarations.add(node.name);
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  function namespaceUse(node) {
    const value = outer(node),
      parent = value.parent;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === value &&
      ts.isIdentifier(parent.name) &&
      moduleLoad(value)
    )
      return;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === value
    ) {
      // A known member is checked as a complete expression below. All unresolved
      // keys, including const identifiers and interpolated templates, need review.
      if (!gateOf(parent))
        reference(parent, 'Unresolved backup namespace access');
    } else
      reference(
        value,
        'Backup module capability escapes a direct registered call',
      );
  }
  function visit(node) {
    const gate = ts.isCallExpression(node) && gateOf(node.expression);
    if (gate)
      calls.push({
        file,
        scope: scopeOf(node),
        gate,
        line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      gateOf(node) &&
      !directCall(node)
    )
      reference(node, 'Extracted backup function');
    if (
      ts.isIdentifier(node) &&
      !declarations.has(node) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      if (aliases.has(node.text) && !directCall(node))
        reference(node, 'Extracted backup function');
      if (namespaces.has(node.text)) namespaceUse(node);
    }
    if (moduleLoad(node) && ts.isCallExpression(node)) namespaceUse(node);
    if (ts.isExportDeclaration(node) && protectedModule(node.moduleSpecifier))
      reference(node, 'Re-exported backup capability requires explicit review');
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
        `Unreviewed backup alias/reference at ${item.file}:${item.line}${item.reason ? `: ${item.reason}` : ''}`,
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
