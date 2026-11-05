const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const artifacts = require('./test-artifacts.cjs');
const budget = require('./space-budget.cjs');
const migrations = path.resolve(
  __dirname,
  '../../apps/server/prisma/migrations',
);
function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(
      fs.realpathSync.native(os.tmpdir()),
      'wewe-lifecycle-regression-',
    ),
  );
  const old = process.env.WEWE_TEST_OUTPUT_ROOT;
  process.env.WEWE_TEST_OUTPUT_ROOT = root;
  t.after(() => {
    if (old === undefined) delete process.env.WEWE_TEST_OUTPUT_ROOT;
    else process.env.WEWE_TEST_OUTPUT_ROOT = old;
    assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
    assert(path.basename(root).startsWith('wewe-lifecycle-regression-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function readManifest(run) {
  return JSON.parse(fs.readFileSync(path.join(run.audit, 'run-manifest.json')));
}
test('manifest records ownership immediately; ordinary failure removes uppercase SQLite and opted-in disposable copies', (t) => {
  const root = fixture(t);
  const run = artifacts.begin({ migrations });
  const manifest = readManifest(run);
  assert.equal(manifest.owner.pid, process.pid);
  assert.equal(manifest.files.length, 1);
  const source = path.join(root, 'source.db');
  fs.copyFileSync(run.database, source);
  fs.copyFileSync(run.database, path.join(run.audit, 'copy.SQLITE'));
  run.finish();
  assert.equal(budget.usage(run.audit).databases, 0);
  const original = fs.readFileSync(source);
  const real = artifacts.begin({ source, realCopy: true, prepared: true });
  fs.copyFileSync(source, path.join(real.audit, 'rehearsal.db'));
  real.finish(new Error('ordinary failure'));
  assert.equal(budget.usage(real.audit).databases, 0);
  assert.deepEqual(fs.readFileSync(source), original);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(real.audit, 'space-summary.json')))
      .retained,
    false,
  );
});
test('sibling output folders share one root lease and cumulative byte/copy budget; arbitrary outside output is refused', (t) => {
  const root = fixture(t);
  const first = artifacts.begin({
    outputRoot: path.join(root, 'window-a'),
    migrations,
  });
  try {
    assert.throws(
      () =>
        artifacts.begin({
          outputRoot: path.join(root, 'window-b'),
          migrations,
        }),
      /locked/,
    );
    assert.throws(
      () =>
        artifacts.begin({
          outputRoot: path.join(root, '..', 'outside'),
          migrations,
        }),
      /managed root/,
    );
    assert(!fs.existsSync(path.join(root, 'window-b')));
  } finally {
    first.finish();
  }
  const oldRoot = path.join(root, 'old');
  fs.mkdirSync(oldRoot);
  for (let i = 0; i < 5; i++)
    fs.writeFileSync(path.join(oldRoot, i + '.db'), 'old');
  assert.throws(
    () =>
      artifacts.begin({ outputRoot: path.join(root, 'window-b'), migrations }),
    /SPACE_BUDGET_EXCEEDED/,
  );
  assert.equal(fs.readdirSync(oldRoot).length, 5);
});
test('explicit keep retains a small bounded fixture and reports it', (t) => {
  fixture(t);
  const run = artifacts.begin({ migrations, keep: true });
  run.finish(new Error('evidence explicitly requested'));
  assert.equal(readManifest(run).state, 'retained');
  assert.equal(budget.usage(run.audit).databases, 1);
  assert(!fs.existsSync(path.join(run.root, '.test-run.lock')));
});
test('cumulative small reports consume the managed byte budget before another output folder is created', (t) => {
  const root = fixture(t),
    old = process.env.SQLITE_TEST_MAX_BYTES;
  process.env.SQLITE_TEST_MAX_BYTES = String(16 * 1024 ** 2);
  t.after(() => {
    if (old === undefined) delete process.env.SQLITE_TEST_MAX_BYTES;
    else process.env.SQLITE_TEST_MAX_BYTES = old;
  });
  fs.writeFileSync(path.join(root, 'old-report.json'), 'retained report');
  assert.throws(
    () => artifacts.begin({ outputRoot: path.join(root, 'next'), migrations }),
    /SPACE_BUDGET_EXCEEDED/,
  );
  assert(!fs.existsSync(path.join(root, 'next')));
  assert.equal(
    fs.readFileSync(path.join(root, 'old-report.json'), 'utf8'),
    'retained report',
  );
});
test('changed owner lock is preserved and environment restored on finish', (t) => {
  const root = fixture(t),
    beforeKind = process.env.SQLITE_BACKUP_KIND,
    beforeRoot = process.env.SQLITE_TEST_BUDGET_ROOT;
  const run = artifacts.begin({ migrations });
  fs.writeFileSync(path.join(root, '.test-run.lock'), 'foreign lock');
  assert.throws(() => run.finish(), /ownership changed/);
  assert.equal(
    fs.readFileSync(path.join(root, '.test-run.lock'), 'utf8'),
    'foreign lock',
  );
  assert.equal(process.env.SQLITE_BACKUP_KIND, beforeKind);
  assert.equal(process.env.SQLITE_TEST_BUDGET_ROOT, beforeRoot);
});
test('cleanup refuses directory junctions and preserves their target', (t) => {
  const root = fixture(t),
    run = artifacts.begin({ migrations });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'old.db'), 'unique');
  fs.symlinkSync(
    outside,
    path.join(run.audit, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => run.finish(), /refuses links/);
  assert.equal(fs.readFileSync(path.join(outside, 'old.db'), 'utf8'), 'unique');
});
async function killedRun(t, root) {
  const child = fork(path.join(__dirname, 'lifecycle-owner-fixture.cjs'), [], {
    env: { ...process.env, WEWE_TEST_OUTPUT_ROOT: root },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      });
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child timeout')), 15000);
    child.once('message', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('child exited early'));
    });
    child.once('error', reject);
  });
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
  return result;
}
test('hard-kill recovery removes only registered current files, releases matching lock, and permits next run', async (t) => {
  const root = fixture(t),
    run = await killedRun(t, root);
  assert(fs.existsSync(path.join(run.audit, 'run-manifest.json')));
  assert.throws(
    () => artifacts.recover({ root, audit: run.audit }),
    /confirmation/,
  );
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, 'recover-test-run.cjs'),
        '--root',
        root,
        '--audit',
        run.audit,
        '--confirm-children-stopped',
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(result.removed, 1);
  assert.equal(budget.usage(run.audit).databases, 0);
  const next = artifacts.begin({ migrations });
  next.finish();
});
test('recovery never kills a live or reused PID', async (t) => {
  const root = fixture(t),
    run = await killedRun(t, root);
  const file = path.join(run.audit, 'run-manifest.json'),
    manifest = JSON.parse(fs.readFileSync(file));
  manifest.owner.pid = process.pid;
  fs.writeFileSync(file, JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(root, '.test-run.lock'),
    JSON.stringify(manifest.owner),
  );
  assert.throws(
    () =>
      artifacts.recover({
        root,
        audit: run.audit,
        confirmChildrenStopped: true,
      }),
    /active or reused/,
  );
  assert(fs.existsSync(run.database));
});
test('recovery preserves unknown SQLite and retains owner lock', async (t) => {
  const root = fixture(t),
    run = await killedRun(t, root);
  fs.writeFileSync(path.join(run.audit, 'unknown.db'), 'unique unknown');
  assert.throws(
    () =>
      artifacts.recover({
        root,
        audit: run.audit,
        confirmChildrenStopped: true,
      }),
    /Unregistered/,
  );
  assert.equal(
    fs.readFileSync(path.join(run.audit, 'unknown.db'), 'utf8'),
    'unique unknown',
  );
  assert(fs.existsSync(path.join(root, '.test-run.lock')));
  assert.equal(readManifest(run).state, 'review-required');
});
test('foreign ownership and changed registered identity are refused before removal', async (t) => {
  const root = fixture(t),
    run = await killedRun(t, root);
  const manifestFile = path.join(run.audit, 'run-manifest.json');
  const original = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(original);
  manifest.owner.token = 'foreign';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(
    () =>
      artifacts.recover({
        root,
        audit: run.audit,
        confirmChildrenStopped: true,
      }),
    /ownership mismatch/,
  );
  fs.writeFileSync(manifestFile, original);
  // Retain original inode in a different name so the replacement cannot reuse it.
  fs.renameSync(run.database, run.database + '.held');
  fs.writeFileSync(run.database, 'replacement user bytes');
  assert.throws(
    () =>
      artifacts.recover({
        root,
        audit: run.audit,
        confirmChildrenStopped: true,
      }),
    /identity changed/,
  );
  assert.equal(fs.readFileSync(run.database, 'utf8'), 'replacement user bytes');
  assert(fs.existsSync(path.join(root, '.test-run.lock')));
});

test('replaced audit directory cannot enroll or remove unknown databases', (t) => {
  fixture(t);
  const run = artifacts.begin({ migrations });
  fs.renameSync(run.audit, run.audit + '-original');
  fs.mkdirSync(run.audit);
  const unknown = path.join(run.audit, 'unknown.db');
  fs.writeFileSync(unknown, 'preserve');
  assert.throws(() => run.checkpoint(), /directory identity changed/);
  assert.throws(
    () => run.finish(new Error('failure')),
    /directory identity changed/,
  );
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve');
  assert(!fs.existsSync(path.join(run.audit, 'space-summary.json')));
});
