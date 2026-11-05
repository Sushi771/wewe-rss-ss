const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const budget = require('./space-budget.cjs');
const artifacts = require('./test-artifacts.cjs');
const native = require('./startup-sqlite.cjs');
test('snapshot forecast validates daily and 15-minute intervals without permissive parsing', () => {
  assert.equal(budget.snapshotInterval('900'), 900);
  assert.equal(budget.snapshotInterval('86400'), 86400);
  for (const value of [
    '0',
    '59',
    '86401',
    '+900',
    '900.0',
    '900\n',
    'NaN',
    ' 900',
  ])
    assert.throws(() => budget.snapshotInterval(value), /POLICY_INVALID/);
});
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
test('Node and Python forecasts use configured 900/86400 cadence and retain the same hard ceilings', (t) => {
  const root = fixture(t),
    database = path.join(root, 'source.db'),
    backups = path.join(root, 'backups');
  fs.writeFileSync(database, 'owned size-only forecast fixture');
  fs.mkdirSync(backups);
  env(t, {
    SQLITE_BACKUP_KIND: 'production',
    SQLITE_PRODUCTION_MAX_COPIES: '48',
    SQLITE_PRODUCTION_MAX_BYTES: String(32 * 1024 ** 3),
    SQLITE_PRODUCTION_MIN_FREE_BYTES: '1',
    SQLITE_PRODUCTION_LEGACY_ROOTS: '[]',
    SQLITE_SNAPSHOT_INTERVAL_SECONDS: '900',
  });
  const forecasts = [];
  for (const interval of ['900', '86400']) {
    process.env.SQLITE_SNAPSHOT_INTERVAL_SECONDS = interval;
    const limits = budget.preflight(
      backups,
      budget.estimate(database),
      1,
      database,
    );
    assert.equal(limits.maxCopies, 48);
    assert.equal(limits.maxBytes, 32 * 1024 ** 3);
    const node = JSON.parse(
      fs.readFileSync(path.join(backups, '.space-budget-status.json')),
    );
    const python = JSON.parse(
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
    assert.equal(
      node.continuousChangedSnapshotIntervalSeconds,
      Number(interval),
    );
    assert.equal(
      python.continuousChangedSnapshotIntervalSeconds,
      Number(interval),
    );
    assert.equal(
      node.estimatedDaysAtContinuousChanges,
      python.estimatedDaysAtContinuousChanges,
    );
    assert.match(node.forecastBasis, /unchanged/);
    forecasts.push(node);
  }
  assert.equal(
    forecasts[1].estimatedDaysAtContinuousChanges,
    forecasts[0].estimatedDaysAtContinuousChanges * 96,
  );
  assert.equal(forecasts[0].warning, true);
  assert.equal(forecasts[1].warning, false);
});
test('synthetic runs clean their own SQLite files on success and failure, retaining reports and old files', (t) => {
  const root = fixture(t);
  env(t, { WEWE_TEST_OUTPUT_ROOT: root });
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
  env(t, { WEWE_TEST_OUTPUT_ROOT: root });
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
  const root = fixture(t);
  env(t, { WEWE_TEST_OUTPUT_ROOT: root });
  const run = artifacts.begin({ outputRoot: root, migrations });
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
  env(t, { WEWE_TEST_OUTPUT_ROOT: root });
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
  const pythonReuse = JSON.parse(
    execFileSync(
      'python',
      [
        path.resolve(__dirname, '../../apps/server/scripts/backup-sqlite.py'),
        '--database',
        database,
        '--backup-root',
        backups,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(pythonReuse.reused, true);
  assert.equal(pythonReuse.backup, first.backup.backup);
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
      identities.set(
        fs.realpathSync.native(file),
        original(file, { bigint: true }),
      );
  connection.exec("UPDATE articles SET title='same-size changed content'");
  fs.statSync = function (file, options) {
    if (options?.bigint && identities.has(fs.realpathSync.native(file)))
      return identities.get(fs.realpathSync.native(file));
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

function pythonLegacyUsage(root) {
  const script = [
    'import importlib.util,json,sys',
    'from pathlib import Path',
    's=importlib.util.spec_from_file_location("backup",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
    'files=m.managed_files(Path(sys.argv[2]))',
    'print(json.dumps({"bytes":sum(p.stat().st_size for p in files),"databases":sum(p.suffix.lower() in (".db",".sqlite",".sqlite3") for p in files)}))',
  ].join('\n');
  return JSON.parse(
    execFileSync(
      'python',
      [
        '-c',
        script,
        path.resolve(__dirname, '../../apps/server/scripts/backup-sqlite.py'),
        root,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    ),
  );
}
function pythonLegacyAdmission(root, database) {
  const script = [
    'import importlib.util,json,sys',
    'from pathlib import Path',
    's=importlib.util.spec_from_file_location("backup",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
    'try:',
    ' m.space_preflight(Path(sys.argv[3]),Path(sys.argv[2]));print(json.dumps({"allowed":True}))',
    'except ValueError as e: print(json.dumps({"allowed":False,"reason":str(e)}))',
  ].join('\n');
  return JSON.parse(
    execFileSync(
      'python',
      [
        '-c',
        script,
        path.resolve(__dirname, '../../apps/server/scripts/backup-sqlite.py'),
        root,
        database,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    ),
  );
}
test('Node and Python count unlinked physical history and reject the same small byte budget', (t) => {
  const fixtureRoot = fixture(t),
    legacy = fixture(t),
    root = path.join(fixtureRoot, 'not-created');
  const database = path.join(fixtureRoot, 'source.db'),
    history = path.join(legacy, 'recovery.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT)');
  db.close();
  fs.copyFileSync(database, history);
  const reserve = budget.estimate(database);
  env(t, {
    SQLITE_BACKUP_KIND: 'production',
    SQLITE_PRODUCTION_LEGACY_ROOTS: JSON.stringify([legacy, legacy]),
    SQLITE_PRODUCTION_MAX_BYTES: String(reserve + 1000),
    SQLITE_PRODUCTION_MIN_FREE_BYTES: '1',
  });
  const counted = budget.usage(root);
  assert.equal(counted.bytes, 8192);
  assert.equal(counted.databases, 1);
  assert.deepEqual(pythonLegacyUsage(root), counted);
  assert.throws(
    () => budget.preflight(root, reserve, 1, database),
    /SPACE_BUDGET_EXCEEDED/,
  );
  const python = pythonLegacyAdmission(root, database);
  assert.equal(python.allowed, false);
  assert.match(python.reason, /SPACE_BUDGET_EXCEEDED/);
  assert(!fs.existsSync(root));
  assert.equal(fs.statSync(history).size, 8192);
});
test('Node and Python both refuse a source inside a declared physical legacy root', (t) => {
  const legacy = fixture(t),
    parent = fixture(t),
    root = path.join(parent, 'not-created'),
    database = path.join(legacy, 'live.db');
  fs.writeFileSync(database, Buffer.alloc(8192));
  env(t, {
    SQLITE_BACKUP_KIND: 'production',
    SQLITE_PRODUCTION_LEGACY_ROOTS: JSON.stringify([legacy]),
  });
  assert.throws(
    () => budget.preflight(root, budget.estimate(database), 1, database),
    /Source inside legacy/,
  );
  const python = pythonLegacyAdmission(root, database);
  assert.equal(python.allowed, false);
  assert.match(python.reason, /Source inside legacy/);
  assert(!fs.existsSync(root));
});
test('Node and Python deduplicate declared aliases and still reject real cycles', (t) => {
  const root = fixture(t),
    legacy = fixture(t),
    point = path.join(legacy, 'point');
  fs.mkdirSync(point);
  fs.writeFileSync(path.join(point, 'unique.db'), Buffer.alloc(8192));
  for (const name of ['one', 'two'])
    fs.symlinkSync(
      point,
      path.join(root, name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  env(t, {
    SQLITE_BACKUP_KIND: 'production',
    SQLITE_PRODUCTION_LEGACY_ROOTS: JSON.stringify([legacy, legacy]),
  });
  assert.deepEqual(budget.usage(root), { bytes: 8192, databases: 1 });
  assert.deepEqual(pythonLegacyUsage(root), budget.usage(root));
  fs.symlinkSync(
    legacy,
    path.join(legacy, 'cycle'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => budget.usage(root), /Cyclic/);
  assert.throws(() => pythonLegacyUsage(root), /Cyclic/);
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
