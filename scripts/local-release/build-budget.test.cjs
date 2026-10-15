const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./build-budget.cjs');
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-build-budget-'));
  const previous = process.env.WEWE_RELEASE_MAX_BYTES;
  process.env.WEWE_RELEASE_MAX_BYTES = '4096';
  try {
    run(root);
  } finally {
    if (previous === undefined) delete process.env.WEWE_RELEASE_MAX_BYTES;
    else process.env.WEWE_RELEASE_MAX_BYTES = previous;
    assert(path.basename(root).startsWith('wewe-build-budget-'));
    fs.rmSync(root, { recursive: true });
  }
}
test('repeated builds count previous packages and reject before generation', () =>
  fixture((root) => {
    const first = guard.begin(root, 2048);
    first.create(path.join(root, 'old'));
    fs.writeFileSync(path.join(root, 'old/package'), Buffer.alloc(3000));
    first.check();
    first.finish();
    assert.throws(
      () => guard.begin(root, 2048),
      /RELEASE_SPACE_BUDGET_EXCEEDED/,
    );
    assert.equal(fs.statSync(path.join(root, 'old/package')).size, 3000);
    assert(!fs.existsSync(path.join(root, '.build-budget.lock')));
  }));
test('failed build removes only its new directory and releases shared lease', () =>
  fixture((root) => {
    fs.mkdirSync(path.join(root, 'old'));
    fs.writeFileSync(path.join(root, 'old/package'), 'unchanged');
    const run = guard.begin(root, 2048);
    run.create(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'new/partial'), 'partial');
    assert.throws(() => guard.begin(root, 1), /locked/);
    run.finish(new Error('injected compiler failure'));
    assert(!fs.existsSync(path.join(root, 'new')));
    assert.equal(
      fs.readFileSync(path.join(root, 'old/package'), 'utf8'),
      'unchanged',
    );
    const retry = guard.begin(root, 2048);
    retry.finish();
  }));
test('final overflow refuses success and cleans only failed build', () =>
  fixture((root) => {
    const run = guard.begin(root, 1024);
    run.create(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'new/overflow'), Buffer.alloc(5000));
    assert.throws(() => run.check(), /RELEASE_SPACE_BUDGET_EXCEEDED/);
    run.finish(new Error('quota'));
    assert(!fs.existsSync(path.join(root, 'new')));
  }));
test('replaced failed-build directory is preserved for review', () =>
  fixture((root) => {
    const run = guard.begin(root, 1024);
    run.create(path.join(root, 'new'));
    fs.renameSync(path.join(root, 'new'), path.join(root, 'original'));
    fs.mkdirSync(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'new/unknown'), 'preserve');
    assert.throws(() => run.finish(new Error('failure')), /identity changed/);
    assert(fs.existsSync(path.join(root, 'new/unknown')));
  }));

test('foreign replacement of build lock is preserved', () =>
  fixture((root) => {
    const run = guard.begin(root, 1024);
    const lock = path.join(root, '.build-budget.lock');
    fs.writeFileSync(lock, 'foreign owner');
    assert.throws(() => run.finish(), /ownership changed/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign owner');
  }));

test('three package slots refuse further generation even with byte capacity remaining', () =>
  fixture((root) => {
    for (const name of ['current', 'rollback', 'candidate'])
      fs.mkdirSync(path.join(root, name));
    assert.throws(() => guard.begin(root, 1), /RELEASE_PACKAGE_LIMIT_EXCEEDED/);
    assert.equal(guard.packageDirectories(root).length, 3);
    assert(!fs.existsSync(path.join(root, '.build-budget.lock')));
  }));
test('one current package can reserve a candidate and compatibility rollback together', () =>
  fixture((root) => {
    fs.mkdirSync(path.join(root, 'current'));
    fs.writeFileSync(path.join(root, 'current/keep'), 'protected');
    const run = guard.begin(root, 128, { packages: 2 });
    run.create(path.join(root, 'candidate'));
    run.create(path.join(root, 'rollback'));
    run.check();
    assert.throws(() => run.create(path.join(root, 'fourth')), /Invalid owned/);
    run.finish(new Error('synthetic install failure'));
    assert.deepEqual(
      guard.packageDirectories(root).map((file) => path.basename(file)),
      ['current'],
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'current/keep'), 'utf8'),
      'protected',
    );
  }));
test('count refusal happens before any recursive historical-byte scan', () =>
  fixture((root) => {
    for (let i = 0; i < 28; i++) fs.mkdirSync(path.join(root, 'old-' + i));
    const original = fs.readdirSync;
    fs.readdirSync = (directory, ...args) => {
      assert.equal(
        path.resolve(directory),
        path.resolve(root),
        'must not descend into old packages',
      );
      return original(directory, ...args);
    };
    try {
      assert.throws(
        () => guard.begin(root, 1, { packages: 2 }),
        /RELEASE_PACKAGE_LIMIT_EXCEEDED/,
      );
    } finally {
      fs.readdirSync = original;
    }
    assert.equal(fs.readdirSync(root).length, 28);
  }));
test('registered helper caches are not package slots but still consume byte capacity', () =>
  fixture((root) => {
    fs.mkdirSync(path.join(root, '.identity-tools'));
    fs.writeFileSync(
      path.join(root, '.identity-tools/cache'),
      Buffer.alloc(4096),
    );
    assert.equal(guard.packageDirectories(root).length, 0);
    assert.throws(
      () => guard.begin(root, 128),
      /RELEASE_SPACE_BUDGET_EXCEEDED/,
    );
  }));
test('multi-output cleanup validates every identity before removing any directory', () =>
  fixture((root) => {
    const run = guard.begin(root, 128, { packages: 2 });
    run.create(path.join(root, 'first'));
    run.create(path.join(root, 'second'));
    fs.renameSync(path.join(root, 'second'), path.join(root, 'preserved'));
    fs.mkdirSync(path.join(root, 'second'));
    assert.throws(() => run.finish(new Error('failure')), /identity changed/);
    assert(fs.existsSync(path.join(root, 'first')));
    assert(fs.existsSync(path.join(root, 'second')));
    assert(fs.existsSync(path.join(root, 'preserved')));
  }));
function release(root, name, changes = {}) {
  const { fingerprint, fileHash } = require('./lib.cjs'),
    directory = path.join(root, name);
  fs.mkdirSync(path.join(directory, 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'runtime/node.exe'),
    'tiny synthetic runtime; never executed',
  );
  const manifest = {
    format: 1,
    id: name,
    platform: process.platform,
    arch: process.arch,
    sourceHash: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    nodeVersion: process.version,
    schemaCompatibility: 'current',
    executionLayout: 'compact-cjs-v1',
    ...fingerprint(directory),
    ...changes,
  };
  fs.writeFileSync(
    path.join(directory, 'release.json'),
    JSON.stringify(manifest),
  );
  return {
    directory,
    key: {
      sourceHash: manifest.sourceHash,
      sourceCommit: manifest.sourceCommit,
      nodeVersion: manifest.nodeVersion,
      runtimeSha256: fileHash(path.join(directory, 'runtime/node.exe')),
      schemaCompatibility: manifest.schemaCompatibility,
      executionLayout: manifest.executionLayout,
    },
  };
}
test('the same exact verified candidate is reused without another directory or runtime', () =>
  fixture((root) => {
    const r = release(root, 'frozen');
    const before = guard.bytes(root);
    for (let i = 0; i < 5; i++)
      assert.equal(guard.findReusable(root, r.key).directory, r.directory);
    assert.equal(guard.bytes(root), before);
    assert.equal(guard.packageDirectories(root).length, 1);
    assert(!fs.existsSync(path.join(root, '.build-budget.lock')));
  }));
test('reuse does not cross commit, source, runtime, layout or schema boundaries', () =>
  fixture((root) => {
    const r = release(root, 'frozen');
    for (const extra of [
      { sourceCommit: 'c'.repeat(40) },
      { sourceHash: 'c'.repeat(64) },
      { runtimeSha256: 'c'.repeat(64) },
      { nodeVersion: 'v24.0.0-synthetic' },
      { executionLayout: undefined },
      { schemaCompatibility: 'legacy-additive' },
    ])
      assert.equal(guard.findReusable(root, { ...r.key, ...extra }), undefined);
  }));
test('a corrupt matching package is rejected and never rebuilt over the old directory', () =>
  fixture((root) => {
    const r = release(root, 'frozen');
    fs.writeFileSync(path.join(r.directory, 'unexpected'), 'unknown bytes');
    assert.throws(() => guard.findReusable(root, r.key), /files/);
    assert.equal(
      fs.readFileSync(path.join(r.directory, 'unexpected'), 'utf8'),
      'unknown bytes',
    );
    assert.equal(guard.packageDirectories(root).length, 1);
  }));
test('an in-flight or interrupted build claim cannot authorize candidate reuse', () =>
  fixture((root) => {
    const r = release(root, 'frozen');
    fs.writeFileSync(path.join(root, '.build-budget.lock'), 'foreign owner');
    assert.throws(() => guard.findReusable(root, r.key), /locked/);
    assert.equal(
      fs.readFileSync(path.join(root, '.build-budget.lock'), 'utf8'),
      'foreign owner',
    );
  }));
test('a large file rejects before walking later historical subdirectories', () =>
  fixture((root) => {
    fs.writeFileSync(path.join(root, '00-over-limit'), Buffer.alloc(4096));
    fs.mkdirSync(path.join(root, 'zz-later'));
    const original = fs.readdirSync;
    fs.readdirSync = (directory, ...args) => {
      assert.notEqual(path.basename(directory), 'zz-later');
      return original(directory, ...args);
    };
    try {
      assert.throws(
        () => guard.begin(root, 128),
        /RELEASE_SPACE_BUDGET_EXCEEDED/,
      );
    } finally {
      fs.readdirSync = original;
    }
  }));

test('completed reservations and negative checks cannot create later output or extend capacity', () =>
  fixture((root) => {
    const run = guard.begin(root, 128);
    assert.throws(() => run.check(-1), /Invalid/);
    run.finish();
    assert.throws(() => run.create(path.join(root, 'late')), /Invalid/);
    assert.throws(() => run.check(), /completed/);
    assert(!fs.existsSync(path.join(root, 'late')));
  }));
test(
  'the real build entry returns a verified reuse before estimation, compilation or runtime copy',
  { skip: process.platform !== 'win32' },
  () =>
    fixture((root) => {
      const r = release(root, 'frozen'),
        saved = {
          find: guard.findReusable,
          estimate: guard.estimate,
          begin: guard.begin,
        };
      let calls = 0;
      try {
        guard.findReusable = (directory, key) => {
          assert.equal(path.basename(directory), '.local-releases');
          assert.match(key.sourceCommit, /^[a-f0-9]{40}$/);
          assert.match(key.runtimeSha256, /^[a-f0-9]{64}$/);
          assert.equal(key.nodeVersion, process.version);
          calls++;
          return {
            directory: r.directory,
            manifest: { id: 'frozen', sourceCommit: key.sourceCommit },
          };
        };
        guard.estimate = () => {
          throw new Error('must not estimate/rebuild verified candidate');
        };
        guard.begin = () => {
          throw new Error('must not create a new generation');
        };
        assert.equal(
          require('./build.cjs').build({ compact: true }),
          r.directory,
        );
        assert.equal(calls, 1);
        assert.equal(guard.packageDirectories(root).length, 1);
      } finally {
        guard.findReusable = saved.find;
        guard.estimate = saved.estimate;
        guard.begin = saved.begin;
      }
    }),
);
