const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const budget = require('./space-budget.cjs');
const artifacts = require('./test-artifacts.cjs');
const native = require('./startup-sqlite.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-space-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('wewe-space-test-'));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
const migrations = path.resolve(
  __dirname,
  '../../apps/server/prisma/migrations',
);
function env(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
}
test('synthetic runs clean their own SQLite files on success and failure, retaining reports and old files', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'old.db'), 'unique old recovery point');
  for (let index = 0; index < 8; index++) {
    const run = artifacts.begin({ outputRoot: root, migrations });
    assert(fs.statSync(run.database).size < 1024 ** 2);
    const inspect = native.inspectDatabase(run.database, migrations);
    assert.equal(inspect.tables.articles.rows, 40);
    fs.copyFileSync(run.database, path.join(run.audit, 'rehearsal.db'));
    run.finish(index % 2 ? new Error('injected failure') : undefined);
    assert.equal(budget.usage(run.audit).databases, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(run.audit, 'space-summary.json')))
        .failure,
      index % 2 ? 'injected failure' : null,
    );
  }
  assert.equal(
    fs.readFileSync(path.join(root, 'old.db'), 'utf8'),
    'unique old recovery point',
  );
  assert.equal(budget.usage(root).databases, 1);
});
test('real-copy opt-in, nested source and invalid policy are rejected before generating a run', (t) => {
  const root = fixture(t),
    source = path.join(root, 'existing.db');
  fs.writeFileSync(source, 'original');
  assert.throws(
    () => artifacts.begin({ outputRoot: root, source, migrations }),
    /real-copy/,
  );
  assert.throws(
    () =>
      artifacts.begin({ outputRoot: root, source, realCopy: true, migrations }),
    /Nested/,
  );
  env(t, { SQLITE_TEST_MAX_BYTES: '0' });
  assert.throws(
    () => artifacts.begin({ outputRoot: root, migrations }),
    /Invalid/,
  );
  assert.deepEqual(fs.readdirSync(root), ['existing.db']);
});
test('aggregate byte, copy and disk reserve budgets refuse new files without deleting recovery points', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'old.db'), 'untouched');
  env(t, { SQLITE_BACKUP_KIND: 'test', SQLITE_TEST_MAX_BYTES: '1' });
  assert.throws(() => budget.preflight(root, 1), /SPACE_BUDGET_EXCEEDED/);
  process.env.SQLITE_TEST_MAX_BYTES = String(512 * 1024 ** 2);
  process.env.SQLITE_TEST_MAX_COPIES = '1';
  t.after(() => delete process.env.SQLITE_TEST_MAX_COPIES);
  assert.throws(() => budget.preflight(root, 1), /SPACE_BUDGET_EXCEEDED/);
  process.env.SQLITE_TEST_MAX_COPIES = '12';
  process.env.SQLITE_TEST_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
  t.after(() => delete process.env.SQLITE_TEST_MIN_FREE_BYTES);
  assert.throws(() => budget.preflight(root, 1), /SPACE_BUDGET_EXCEEDED/);
  assert.equal(fs.readFileSync(path.join(root, 'old.db'), 'utf8'), 'untouched');
});
test('exclusive run lease prevents overlapping budget reservations and fails closed after interruption', (t) => {
  const root = fixture(t),
    run = artifacts.begin({ outputRoot: root, migrations });
  assert.throws(
    () => artifacts.begin({ outputRoot: root, migrations }),
    /locked/,
  );
  run.finish();
  fs.writeFileSync(path.join(root, '.test-run.lock'), 'interrupted owner');
  assert.throws(
    () => artifacts.begin({ outputRoot: root, migrations }),
    /locked/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, '.test-run.lock'), 'utf8'),
    'interrupted owner',
  );
});
test('failed fixture creation releases lease and retains a small failure report', (t) => {
  const root = fixture(t);
  assert.throws(() =>
    artifacts.begin({
      outputRoot: root,
      migrations: path.join(root, 'missing'),
    }),
  );
  assert(!fs.existsSync(path.join(root, '.test-run.lock')));
  const report = fs.readdirSync(root).find((name) => name.startsWith('run-'));
  assert(
    JSON.parse(fs.readFileSync(path.join(root, report, 'space-summary.json')))
      .failure,
  );
  assert.equal(budget.usage(root).databases, 0);
});
test('native production preparation reuses verified snapshots, detects mutation, and preserves old recovery points at quota', async (t) => {
  const root = fixture(t),
    database = path.join(root, 'source.db'),
    backups = path.join(root, 'backups');
  execFileSync('python', [
    path.join(__dirname, 'synthetic-sqlite.py'),
    '--database',
    database,
    '--migrations',
    migrations,
  ]);
  const first = await native.prepareStart(
    database,
    migrations,
    backups,
    path.join(root, 'first.json'),
  );
  const second = await native.prepareStart(
    database,
    migrations,
    backups,
    path.join(root, 'second.json'),
  );
  assert.equal(second.backup.reused, true);
  assert.equal(second.backup.backup, first.backup.backup);
  assert.equal(budget.usage(backups).databases, 1);
  const stat = fs.statSync(database);
  fs.utimesSync(database, stat.atime, new Date(stat.mtimeMs + 10000));
  const touched = await native.prepareStart(
    database,
    migrations,
    backups,
    path.join(root, 'touched.json'),
  );
  assert.equal(touched.backup.reused, true);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(database);
  db.exec("UPDATE articles SET title='modified'");
  db.close();
  env(t, { SQLITE_PRODUCTION_MAX_COPIES: '1' });
  const preserved = fs.readFileSync(first.backup.backup);
  await assert.rejects(
    native.prepareStart(
      database,
      migrations,
      backups,
      path.join(root, 'third.json'),
    ),
    /SPACE_BUDGET_EXCEEDED/,
  );
  assert.deepEqual(fs.readFileSync(first.backup.backup), preserved);
  assert(!fs.existsSync(path.join(root, 'third.json')));
  delete process.env.SQLITE_PRODUCTION_MAX_COPIES;
  const changed = await native.prepareStart(
    database,
    migrations,
    backups,
    path.join(root, 'changed.json'),
  );
  assert.equal(changed.backup.reused, false);
  assert.equal(budget.usage(backups).databases, 2);
  assert.deepEqual(fs.readFileSync(first.backup.backup), preserved);
});
test('junctions cannot hide nested copies or quota usage', (t) => {
  const root = fixture(t),
    outside = fixture(t);
  fs.symlinkSync(
    outside,
    path.join(root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => budget.preflight(root, 1), /refuses links/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test('frozen Windows-style metadata cannot authorize reuse after DB or WAL content changes', async (t) => {
  const root = fixture(t),
    database = path.join(root, 'source.db'),
    backups = path.join(root, 'backups');
  execFileSync('python', [
    path.join(__dirname, 'synthetic-sqlite.py'),
    '--database',
    database,
    '--migrations',
    migrations,
  ]);
  const { DatabaseSync } = require('node:sqlite');
  const connection = new DatabaseSync(database);
  connection.exec('PRAGMA journal_mode=WAL');
  connection.exec('UPDATE feeds SET mp_name=mp_name');
  const first = await native.prepareStart(
    database,
    migrations,
    backups,
    path.join(root, 'first.json'),
  );
  const original = fs.statSync,
    identities = new Map();
  for (const file of [database, database + '-wal'])
    if (fs.existsSync(file))
      identities.set(file, original(file, { bigint: true }));
  connection.exec("UPDATE articles SET title='same-size changed content'");
  fs.statSync = function (file, options) {
    if (options?.bigint && identities.has(file)) return identities.get(file);
    return original.apply(this, arguments);
  };
  try {
    const changed = await native.prepareStart(
      database,
      migrations,
      backups,
      path.join(root, 'changed.json'),
    );
    assert.equal(changed.backup.reused, false);
    assert.notEqual(first.backup.backup, changed.backup.backup);
    const same = await native.prepareStart(
      database,
      migrations,
      backups,
      path.join(root, 'same.json'),
    );
    assert.equal(same.backup.reused, true);
    assert.match(same.backup.reuseProof, /pinned-snapshot/);
  } finally {
    fs.statSync = original;
    connection.close();
  }
});

test('only explicit production legacy roots are counted through migration junctions', (t) => {
  const root = fixture(t),
    legacy = fixture(t);
  fs.writeFileSync(path.join(legacy, 'unique.db'), 'historical recovery point');
  fs.symlinkSync(
    legacy,
    path.join(root, 'old'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  env(t, { SQLITE_PRODUCTION_LEGACY_ROOTS: JSON.stringify([legacy]) });
  assert.equal(budget.usage(root).databases, 1);
  assert.equal(
    fs.readFileSync(path.join(legacy, 'unique.db'), 'utf8'),
    'historical recovery point',
  );
  process.env.SQLITE_BACKUP_KIND = 'test';
  t.after(() => delete process.env.SQLITE_BACKUP_KIND);
  assert.throws(() => budget.usage(root), /LAYOUT_REQUIRES_REVIEW/);
});

test('finite production defaults and half-full/under-one-day warnings agree with read-only Python status', (t) => {
  const root = fixture(t),
    database = path.join(root, 'source.db'),
    backups = path.join(root, 'backups');
  execFileSync('python', [
    path.join(__dirname, 'synthetic-sqlite.py'),
    '--database',
    database,
    '--migrations',
    migrations,
  ]);
  fs.mkdirSync(backups);
  const policy = budget.preflight(
    backups,
    budget.estimate(database),
    1,
    database,
  );
  assert.equal(policy.maxBytes, 32 * 1024 ** 3);
  assert.equal(policy.maxCopies, 48);
  assert.equal(policy.minFree, 4 * 1024 ** 3);
  const status = () =>
    JSON.parse(
      execFileSync(
        'python',
        [
          path.resolve(
            __dirname,
            '../../apps/server/scripts/backup-space-status.py',
          ),
          '--database',
          database,
          '--backup-root',
          backups,
        ],
        { encoding: 'utf8' },
      ),
    );
  let report = status();
  assert.equal(report.maxBytes, policy.maxBytes);
  assert.equal(report.maxCopies, policy.maxCopies);
  assert.equal(report.minFreeBytes, policy.minFree);
  assert.equal(report.warning, true); // 48 copies at 15 minutes is less than one day.
  assert.equal(report.nextBackupAllowed, true);
  env(t, {
    SQLITE_PRODUCTION_MAX_COPIES: '200',
    SQLITE_PRODUCTION_MAX_BYTES: '1000000000',
  });
  budget.preflight(backups, budget.estimate(database), 1, database);
  assert.equal(status().warning, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(backups, '.space-budget-status.json')))
      .warning,
    false,
  );
  for (let i = 0; i < 100; i++)
    fs.writeFileSync(path.join(backups, i + '.db'), 'synthetic');
  budget.preflight(backups, budget.estimate(database), 1, database);
  assert.equal(status().warning, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(backups, '.space-budget-status.json')))
      .warning,
    true,
  );
});
