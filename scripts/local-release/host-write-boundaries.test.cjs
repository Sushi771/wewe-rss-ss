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
    'frontend-update',
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
    'switch-prewrite',
    'task-document-preflight',
    'updater/install-binding/role-aware/switch-prewrite',
    'updater/install-binding/role-aware/task-document-preflight',
  ],
  indirect: [
    'updater/installed-recovery-host',
    'lifecycle-owner-fixture',
    'recover-test-run',
    'startup-audit',
  ],
  pure: [
    'engine-audit',
    'refresh-wave-rollback-compat',
    'frontend-companion',
    'reference-diagnostics',
    'switch-contract',
    'updater/install-binding/role-aware/switch-contract',
    'switch-recovery',
  ],
  readonly: [
    'scope-inventory',
    'verify-source',
    'windows-release-references',
    'legacy-maintenance-loader',
    'preserving-contract',
    'preserving-process-family',
    'private-artifact-proof',
    'updater/legacy-maintenance-adapter',
    'updater/install-binding/restore-identity-binding',
  ],
  // Identity-bound native writer leases, locks and durable recovery receipts.
  writerCoordination: [
    'updater/installed-host',
    'updater/installed-lifecycle',
    'updater/installed-native-primitives',
    'updater/sqlite-hooks',
    'updater/install-binding/migration-recovery',
    'updater/installer/update-engine',
    'guarded-prisma',
    'normal-start-lock',
    'project-writer-gate',
    'start-current',
    'writer-exit-recovery',
  ],
  registry: ['release-scope'],
  // Read native identities, then delegate startup and update effects to reviewed hosts.
  nativeControl: [
    'installed-startup-gate',
    'updater/update-entry',
    'updater/maintenance-entry',
  ],
  gateway: ['lib', 'updater/install-binding/role-aware/lib'],
};

test('every host JavaScript module has a reviewed effect classification', () => {
  const expected = Object.values(catalog)
    .flat()
    .map((name) => name + '.cjs')
    .sort();
  const actual = fs
    .readdirSync(__dirname, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(
          __dirname,
          path.join(entry.parentPath || entry.path, entry.name),
        )
        .split(path.sep)
        .join('/'),
    )
    .filter((name) => name.endsWith('.cjs') && !name.endsWith('.test.cjs'))
    .sort();
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(actual, expected);
});

test('host effects use the common gateway; native imports are limited to named read/control exceptions', () => {
  const nativeExceptions = new Set([
    ...catalog.readonly,
    ...catalog.registry,
    ...catalog.writerCoordination,
    ...catalog.nativeControl,
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
