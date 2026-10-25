const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copyRuntimeClosure,
  SERVER_HELPERS,
  RUNTIME_WRAPPERS,
  isolatedViteConfig,
} = require('./build.cjs');
const { fingerprint, verifyRelease, hostEffects } = require('./lib.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-release-repro-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('wewe-release-repro-'));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

test('all fourteen helpers and nine wrappers rebuild identically from LF or CRLF source', (t) => {
  const root = fixture(t);
  const results = [];
  for (const [kind, eol] of [
    ['lf', '\n'],
    ['crlf', '\r\n'],
  ]) {
    const source = path.join(root, kind, 'source');
    const release = path.join(root, kind, 'release');
    fs.mkdirSync(release, { recursive: true });
    for (const [directory, names] of [
      ['apps/server/scripts', SERVER_HELPERS],
      ['scripts/local-release', RUNTIME_WRAPPERS],
    ])
      for (const name of names) {
        fs.mkdirSync(path.join(source, directory), { recursive: true });
        fs.writeFileSync(
          path.join(source, directory, name),
          `// fixture ${name}${eol}// second line${eol}`,
        );
      }
    results.push(copyRuntimeClosure(source, release));
    assert.equal(
      fs.readdirSync(path.join(release, 'server/scripts')).length,
      14,
    );
    const manifest = {
      format: 1,
      platform: process.platform,
      arch: process.arch,
      ...fingerprint(release),
    };
    // Manifest key insertion order is not filesystem content order.
    manifest.files = Object.fromEntries(
      Object.entries(manifest.files).reverse(),
    );
    fs.writeFileSync(
      path.join(release, 'release.json'),
      JSON.stringify(manifest),
    );
    verifyRelease(release);
    fs.appendFileSync(
      path.join(release, 'server/scripts/periodic-lifecycle.py'),
      'changed',
    );
    assert.throws(() => verifyRelease(release));
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(Object.keys(results[0]).length, 23);
});

test('a missing history helper cannot produce a successful five-helper package', (t) => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  const release = path.join(root, 'release');
  fs.mkdirSync(release);
  fs.mkdirSync(path.join(source, 'apps/server/scripts'), { recursive: true });
  for (const name of SERVER_HELPERS.filter(
    (name) => name !== 'article_history.py',
  ))
    fs.writeFileSync(
      path.join(source, 'apps/server/scripts', name),
      '# synthetic\n',
    );
  assert.throws(() => copyRuntimeClosure(source, release), /ENOENT/);
  assert(!fs.existsSync(path.join(release, 'release.json')));
});

test('isolated Vite config loads installed packages without rebundling module formats', async (t) => {
  const root = fixture(t);
  const web = path.resolve(__dirname, '../../apps/web');
  const config = path.join(root, 'vite.config.mts');
  fs.writeFileSync(config, isolatedViteConfig(web, root));
  const { packageDir } = require('./lib.cjs');
  const { pathToFileURL } = require('node:url');
  const vite = await import(
    pathToFileURL(path.join(packageDir('vite', web), 'dist/node/index.js')).href
  );
  const loaded = await vite.loadConfigFromFile(
    { command: 'build', mode: 'production' },
    config,
  );
  assert.equal(loaded.config.root, web.replace(/\\/g, '/'));
  assert.equal(loaded.config.envDir, root.replace(/\\/g, '/'));
  assert.equal(loaded.config.base, '/dash');
  assert(
    loaded.config.plugins
      .flat()
      .some((plugin) => plugin?.name?.includes('react')),
  );
});

test('guarded writes publish artifact evidence only after success and bind opened descriptors', (t) => {
  const root = fixture(t),
    target = path.join(root, 'artifact');
  const events = [];
  const lease = {
    assertWritable() {},
    prepareArtifactMutation(method) {
      events.push('prepare:' + method);
      return () => events.push('commit:' + fs.readFileSync(target, 'utf8'));
    },
    approveDescriptor(fd, file, writing) {
      events.push({ file, writing, fd: typeof fd });
    },
  };
  hostEffects.context.run(lease, () => {
    hostEffects.fs.writeFileSync(target, 'saved');
    const fd = hostEffects.fs.openSync(target, 'r');
    hostEffects.fs.closeSync(fd);
    assert.throws(() =>
      hostEffects.fs.writeFileSync(path.join(root, 'absent/child'), 'failure'),
    );
  });
  assert.deepEqual(events, [
    'prepare:writeFile',
    'commit:saved',
    { file: target, writing: false, fd: 'number' },
    'prepare:writeFile',
  ]);
});
