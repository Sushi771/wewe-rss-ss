const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { copyPackages } = require('./build.cjs');
const { packageDir, inside, walk } = require('./lib.cjs');

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wewe-dependency-closure-'),
  );
  const source = path.join(root, 'source');
  const destination = path.join(root, 'bundle');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  return { root, source, destination };
}

function writePackage(directory, manifest, entry) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ main: 'index.js', version: '1.0.0', ...manifest }),
  );
  if (entry) fs.writeFileSync(path.join(directory, 'index.js'), entry);
}

function cleanup(root) {
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('wewe-dependency-closure-'));
  fs.rmSync(root, { recursive: true, force: true });
}

function assertClosed(destination) {
  walk(destination, (relative, kind) => {
    if (kind === 'link')
      assert.ok(
        inside(destination, fs.realpathSync(path.join(destination, relative))),
      );
  });
}

test('core-named npm shims remain in the dependency closure after the source installation is disconnected', () => {
  const { root, source, destination } = fixture();
  try {
    writePackage(source, {
      name: 'fixture',
      dependencies: { consumer: '1.0.0' },
    });
    const consumer = path.join(source, 'node_modules/consumer');
    writePackage(
      consumer,
      {
        name: 'consumer',
        dependencies: {
          process: '1.0.0',
          buffer: '1.0.0',
          string_decoder: '1.0.0',
        },
      },
      "module.exports = ['process/', 'buffer/', 'string_decoder/'].map(name => require(name));",
    );
    for (const name of ['process', 'buffer', 'string_decoder'])
      writePackage(
        path.join(consumer, 'node_modules', name),
        { name },
        `module.exports = ${JSON.stringify('packaged-' + name)};`,
      );
    const versions = copyPackages(
      destination,
      path.join(root, 'unused-client'),
      source,
    );
    assert.deepEqual(versions.map((item) => item.name).sort(), [
      'buffer',
      'consumer',
      'process',
      'string_decoder',
    ]);
    assertClosed(destination);
    fs.renameSync(
      path.join(source, 'node_modules'),
      path.join(source, 'installation-disconnected'),
    );
    const local = createRequire(path.join(destination, 'probe.cjs'));
    assert.deepEqual(local('consumer'), [
      'packaged-process',
      'packaged-buffer',
      'packaged-string_decoder',
    ]);
    for (const name of ['process', 'buffer', 'string_decoder']) {
      const copiedConsumer = path.dirname(local.resolve('consumer'));
      const shim = createRequire(path.join(copiedConsumer, 'index.js')).resolve(
        name + '/',
      );
      assert.ok(inside(destination, shim));
    }
  } finally {
    cleanup(root);
  }
});

test('a required core-named npm dependency cannot silently disappear; missing optional shims remain optional', () => {
  const { root, source, destination } = fixture();
  try {
    writePackage(source, {
      name: 'fixture',
      dependencies: { consumer: '1.0.0' },
    });
    const consumer = path.join(source, 'node_modules/consumer');
    writePackage(
      consumer,
      { name: 'consumer', dependencies: { process: '1.0.0' } },
      'module.exports = true;',
    );
    assert.throws(
      () => copyPackages(destination, '', source),
      /缺少本机依赖 process/,
    );
    const optionalDestination = path.join(root, 'optional-bundle');
    fs.mkdirSync(optionalDestination);
    writePackage(
      consumer,
      { name: 'consumer', optionalDependencies: { process: '1.0.0' } },
      'module.exports = true;',
    );
    assert.deepEqual(
      copyPackages(optionalDestination, '', source).map((item) => item.name),
      ['consumer'],
    );
    assertClosed(optionalDestination);
  } finally {
    cleanup(root);
  }
});

test('the installed readable-stream 4 closure loads with every npm shim resolved inside the copied bundle', () => {
  const { root, source, destination } = fixture();
  try {
    const server = path.resolve(__dirname, '../../apps/server');
    const archive = packageDir('archiver', server);
    const installed = packageDir('readable-stream', archive);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(installed, 'package.json'), 'utf8'),
    );
    assert.match(manifest.version, /^4\./);
    writePackage(source, {
      name: 'fixture',
      dependencies: { 'readable-stream': manifest.version },
    });
    fs.mkdirSync(path.join(source, 'node_modules'));
    fs.symlinkSync(
      installed,
      path.join(source, 'node_modules/readable-stream'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const versions = copyPackages(destination, '', source);
    assert.ok(versions.some((item) => item.name === 'process'));
    assert.ok(versions.some((item) => item.name === 'buffer'));
    assert.ok(versions.some((item) => item.name === 'string_decoder'));
    assertClosed(destination);
    const local = createRequire(path.join(destination, 'probe.cjs'));
    assert.equal(typeof local('readable-stream').Readable, 'function');
    const copied = path.dirname(local.resolve('readable-stream/package.json'));
    const dependency = createRequire(path.join(copied, 'package.json'));
    for (const name of ['process', 'buffer', 'string_decoder'])
      assert.ok(inside(destination, dependency.resolve(name + '/')));
  } finally {
    cleanup(root);
  }
});
