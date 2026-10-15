const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Exhaustive host-module inventory. A new module or a native I/O import must be
// reviewed explicitly rather than silently bypassing the observation boundary.
const catalog = {
  guarded: [
    'active-release',
    'benchmark-launch',
    'build-budget',
    'build-legacy-web',
    'build',
    'compact',
    'desktop-dependencies',
    'desktop-progress',
    'desktop-start',
    'identity-tool',
    'install-desktop',
    'install-lifecycle',
    'lifecycle-audit',
    'logon-start',
    'offline-guard',
    'rehearse',
    'restart',
    'resume-legacy',
    'runtime',
    'space-budget',
    'startup-acceptance',
    'startup-sqlite',
    'switch',
    'test-artifacts',
  ],
  indirect: ['lifecycle-owner-fixture', 'recover-test-run', 'startup-audit'],
  pure: ['engine-audit', 'refresh-wave-rollback-compat'],
  readonly: ['scope-inventory', 'verify-source', 'windows-release-references'],
  registry: ['release-scope', 'once-pair-admission'],
  gateway: ['lib'],
};

test('every host JavaScript module has a reviewed effect classification', () => {
  const expected = Object.values(catalog)
    .flat()
    .map((name) => name + '.cjs')
    .sort();
  const actual = fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith('.cjs') && !name.endsWith('.test.cjs'))
    .sort();
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(actual, expected);
});

test('host effects use the common gateway; native imports are limited to named read/control exceptions', () => {
  const nativeExceptions = new Set([
    ...catalog.readonly,
    ...catalog.registry,
    ...catalog.gateway,
  ]);
  for (const name of Object.values(catalog).flat()) {
    const source = fs.readFileSync(path.join(__dirname, name + '.cjs'), 'utf8');
    const rawImports =
      source.match(
        /require\(['"](?:node:)?(?:fs(?:\/promises)?|child_process)['"]\)/g,
      ) || [];
    if (!nativeExceptions.has(name)) assert.deepEqual(rawImports, [], name);
    if (catalog.guarded.includes(name))
      assert.match(source, /hostEffects\.(?:fs|processes)/, name);
  }
});

test('the native read-only exceptions contain no filesystem mutation calls', () => {
  const readMethods = new Set([
    'lstatSync',
    'statSync',
    'fstatSync',
    'existsSync',
    'realpathSync',
    'readdirSync',
    'opendirSync',
    'openSync',
    'readSync',
    'closeSync',
    'readFileSync',
  ]);
  for (const name of catalog.readonly) {
    const source = fs.readFileSync(path.join(__dirname, name + '.cjs'), 'utf8');
    for (const match of source.matchAll(/\bfs\.(\w+)\s*\(/g))
      assert(readMethods.has(match[1]), name + ': ' + match[1]);
    for (const match of source.matchAll(/\bfs\.openSync\(([^;]+?)\)/g))
      assert.match(match[1], /['"]r['"]/, name + ': writable open');
  }
});
