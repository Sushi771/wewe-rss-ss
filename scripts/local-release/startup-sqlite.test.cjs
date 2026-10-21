const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hash, run } = require('./lib.cjs');
const {
  inspectDatabase,
  prepareStart,
  UnsupportedBaselineValue,
  digestRows,
} = require('./startup-sqlite.cjs');
const sqlite = require('node:sqlite');

test('cached bodies exceeding the V8 whole-string limit retain the exact baseline digest', () => {
  const crypto = require('node:crypto');
  const { MAX_STRING_LENGTH } = require('node:buffer').constants;
  const body = 'x'.repeat(512 * 1024);
  const encodedRow = JSON.stringify([body]);
  const count = Math.floor(MAX_STRING_LENGTH / (encodedRow.length + 1)) + 1;
  assert(count * (encodedRow.length + 1) > MAX_STRING_LENGTH);
  const expected = crypto.createHash('sha256');
  expected.update('[');
  for (let index = 0; index < count; index++) {
    if (index) expected.update(',');
    expected.update(encodedRow);
  }
  expected.update(']');
  function* rows() {
    for (let index = 0; index < count; index++) yield [body];
  }
  assert.equal(digestRows(rows()), expected.digest('hex'));
});

function fixture(t, { current = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-startup-sqlite-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('wewe-startup-sqlite-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const database = path.join(root, 'fixture.db'),
    migrations = path.join(root, 'migrations');
  if (current) {
    fs.cpSync(
      path.resolve(__dirname, '../../apps/server/prisma/migrations'),
      migrations,
      {
        recursive: true,
      },
    );
    const db = new sqlite.DatabaseSync(database);
    db.exec(
      'CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at INT,rolled_back_at INT)',
    );
    for (const entry of fs
      .readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const sql = fs.readFileSync(
        path.join(migrations, entry.name, 'migration.sql'),
        'utf8',
      );
      db.exec(sql);
      db.prepare('INSERT INTO _prisma_migrations VALUES(?,?,1,NULL)').run(
        entry.name,
        hash(sql),
      );
    }
    db.prepare(
      'INSERT INTO xhs_creators(id,profile_url,display_name) VALUES(?,?,?)',
    ).run(
      'synthetic-author',
      'https://www.xiaohongshu.com/synthetic-startup',
      'Synthetic',
    );
    db.prepare(
      'INSERT INTO xhs_notes(id,creator_id,title,publish_time,status,content_html) VALUES(?,?,?,?,?,?)',
    ).run(
      'synthetic-note',
      'synthetic-author',
      'Synthetic',
      1,
      'complete',
      '<p>synthetic cached body</p>',
    );
    db.close();
    return { root, database, migrations };
  }
  const schema =
    'CREATE TABLE feeds(id TEXT PRIMARY KEY,name TEXT,collection_channel TEXT); CREATE TABLE articles(id TEXT PRIMARY KEY,body TEXT,metric,last_body_status TEXT,verified_source_url TEXT,last_body_retry TEXT);';
  fs.mkdirSync(path.join(migrations, '001'), { recursive: true });
  fs.writeFileSync(path.join(migrations, '001/migration.sql'), schema);
  const db = new sqlite.DatabaseSync(database);
  db.exec(
    schema +
      ' CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at INT,rolled_back_at INT);',
  );
  db.prepare('INSERT INTO _prisma_migrations VALUES(?,?,1,NULL)').run(
    '001',
    hash(schema),
  );
  db.prepare('INSERT INTO feeds VALUES(?,?,NULL)').run('f', '中文😀\u2028');
  const insert = db.prepare(
    'INSERT INTO articles VALUES(?,?,?,NULL,NULL,NULL)',
  );
  insert.run('a', '完整正文\n"\\😀', null);
  insert.run('b', '', 9223372036854775807n);
  db.close();
  return { root, database, migrations };
}
function pythonInspect(database, migrations, baseline) {
  return JSON.parse(
    run(
      process.env.SQLITE_BACKUP_PYTHON || 'python',
      [
        path.join(__dirname, 'inspect-sqlite.py'),
        '--database',
        database,
        '--migrations',
        migrations,
        '--require-current',
        ...(baseline ? ['--baseline', baseline] : []),
      ],
      { env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } },
    ),
  );
}

test('native inspection exactly matches established Python baselines including 64-bit integers, Unicode, empty and NULL', (t) => {
  const f = fixture(t),
    before = fs.readFileSync(f.database);
  assert.deepEqual(
    inspectDatabase(f.database, f.migrations),
    pythonInspect(f.database, f.migrations),
  );
  assert.deepEqual(fs.readFileSync(f.database), before);
});
test('native consistency backup retains all fields and cross-verifies with Python', async (t) => {
  const f = fixture(t),
    before = fs.readFileSync(f.database),
    baseline = path.join(f.root, 'baseline.json');
  const prepared = await prepareStart(
    f.database,
    f.migrations,
    path.join(f.root, 'backups'),
    baseline,
  );
  assert.deepEqual(
    pythonInspect(prepared.backup.backup, f.migrations, baseline).tables,
    prepared.inspection.tables,
  );
  assert.deepEqual(fs.readFileSync(f.database), before);
});
test('native migration and missing-column checks fail before baseline publication', async (t) => {
  const f = fixture(t),
    db = new sqlite.DatabaseSync(f.database);
  db.exec("UPDATE _prisma_migrations SET checksum='changed'");
  db.close();
  await assert.rejects(
    prepareStart(
      f.database,
      f.migrations,
      path.join(f.root, 'backups'),
      path.join(f.root, 'baseline.json'),
    ),
    /changed migration/,
  );
  assert.equal(fs.existsSync(path.join(f.root, 'baseline.json')), false);
});
test('native foreign-key checks reject corrupted data', (t) => {
  const f = fixture(t),
    db = new sqlite.DatabaseSync(f.database, {
      enableForeignKeyConstraints: false,
    });
  db.exec(
    "CREATE TABLE dependent(id TEXT,feed_id TEXT REFERENCES feeds(id));INSERT INTO dependent VALUES('x','missing');",
  );
  db.close();
  assert.throws(() => inspectDatabase(f.database, f.migrations), /foreign key/);
});
test('REAL values select the established Python fallback instead of losing baseline semantics', async (t) => {
  const f = fixture(t),
    db = new sqlite.DatabaseSync(f.database);
  db.exec("UPDATE articles SET metric=1.25 WHERE id='b'");
  db.close();
  await assert.rejects(
    prepareStart(
      f.database,
      f.migrations,
      path.join(f.root, 'backups'),
      path.join(f.root, 'baseline.json'),
    ),
    UnsupportedBaselineValue,
  );
  assert.equal(fs.existsSync(path.join(f.root, 'baseline.json')), false);
  assert.equal(pythonInspect(f.database, f.migrations).tables.articles.rows, 2);
});

test('typed BLOB cache baselines match Python and startup backups preserve exact bytes', async (t) => {
  const f = fixture(t),
    db = new sqlite.DatabaseSync(f.database);
  const bytes = Buffer.from([0, 255, 17, 0, 128]);
  db.prepare('UPDATE articles SET metric=? WHERE id=?').run(bytes, 'a');
  db.prepare('UPDATE articles SET metric=? WHERE id=?').run(
    Buffer.alloc(0),
    'b',
  );
  db.close();
  const native = inspectDatabase(f.database, f.migrations);
  assert.deepEqual(native, pythonInspect(f.database, f.migrations));
  const baseline = path.join(f.root, 'blob-baseline.json');
  const prepared = await prepareStart(
    f.database,
    f.migrations,
    path.join(f.root, 'backups'),
    baseline,
  );
  assert.deepEqual(
    pythonInspect(prepared.backup.backup, f.migrations, baseline).tables,
    native.tables,
  );
  const copied = new sqlite.DatabaseSync(prepared.backup.backup);
  assert.deepEqual(
    Buffer.from(
      copied.prepare("SELECT metric FROM articles WHERE id='a'").get().metric,
    ),
    bytes,
  );
  copied
    .prepare('UPDATE articles SET metric=? WHERE id=?')
    .run(Buffer.from([0, 254, 17, 0, 128]), 'a');
  copied.close();
  assert.throws(
    () => pythonInspect(prepared.backup.backup, f.migrations, baseline),
    /articles/,
  );
});
test('a concurrent WAL write cannot publish a stale native startup baseline', async (t) => {
  const f = fixture(t),
    writer = new sqlite.DatabaseSync(f.database);
  writer.exec('PRAGMA journal_mode=WAL');
  const original = sqlite.backup;
  sqlite.backup = (connection, destination, options) => {
    writer.exec("UPDATE articles SET body='concurrent' WHERE id='a'");
    return original(connection, destination, options);
  };
  try {
    await assert.rejects(
      prepareStart(
        f.database,
        f.migrations,
        path.join(f.root, 'backups'),
        path.join(f.root, 'baseline.json'),
      ),
      /source changed/,
    );
    assert.equal(fs.existsSync(path.join(f.root, 'baseline.json')), false);
  } finally {
    sqlite.backup = original;
    writer.close();
  }
});

test('all packaged migrations protect XHS cached rows in native and Python startup backups', async (t) => {
  const f = fixture(t, { current: true });
  const before = fs.readFileSync(f.database);
  const native = inspectDatabase(f.database, f.migrations);
  assert.deepEqual(native, pythonInspect(f.database, f.migrations));
  assert.equal(native.tables.xhs_notes.rows, 1);
  const baseline = path.join(f.root, 'baseline.json');
  const prepared = await prepareStart(
    f.database,
    f.migrations,
    path.join(f.root, 'backups'),
    baseline,
  );
  assert.deepEqual(
    pythonInspect(prepared.backup.backup, f.migrations, baseline).tables,
    native.tables,
  );
  const db = new sqlite.DatabaseSync(prepared.backup.backup);
  db.exec("UPDATE xhs_notes SET content_html='<p>truncated</p>'");
  db.close();
  assert.throws(
    () => pythonInspect(prepared.backup.backup, f.migrations, baseline),
    /xhs_notes/,
  );
  assert.deepEqual(fs.readFileSync(f.database), before);
});

for (const damage of ['both tables', 'notes table', 'content column']) {
  test(`complete migration records cannot hide missing XHS ${damage}`, (t) => {
    const f = fixture(t, { current: true });
    const db = new sqlite.DatabaseSync(f.database);
    if (damage === 'content column')
      db.exec('ALTER TABLE xhs_notes DROP COLUMN content_html');
    else {
      db.exec('DROP TABLE xhs_notes');
      if (damage === 'both tables') db.exec('DROP TABLE xhs_creators');
    }
    db.close();
    assert.throws(
      () => inspectDatabase(f.database, f.migrations, { schemaOnly: true }),
      /Required column missing: xhs_/,
    );
    assert.throws(
      () => pythonInspect(f.database, f.migrations),
      /Required (table|XHS columns) missing/,
    );
  });
}

for (const damage of ['group table', 'feed membership', 'creator membership']) {
  test(`complete migration records cannot hide missing management ${damage}`, (t) => {
    const f = fixture(t, { current: true });
    const db = new sqlite.DatabaseSync(f.database);
    if (damage === 'group table') db.exec('DROP TABLE management_groups');
    else {
      const table = damage === 'feed membership' ? 'feeds' : 'xhs_creators';
      db.exec(`DROP INDEX ${table}_group_id_idx`);
      db.exec(`ALTER TABLE ${table} DROP COLUMN group_id`);
    }
    db.close();
    assert.throws(
      () => inspectDatabase(f.database, f.migrations, { schemaOnly: true }),
      /Required column missing/,
    );
    assert.throws(
      () => pythonInspect(f.database, f.migrations),
      /Required (table|management group column) missing/,
    );
  });
}

for (const column of [
  'kind',
  'video_bytes',
  'video_mime_type',
  'video_expected_bytes',
  'video_sha256',
]) {
  test(`complete migration records cannot hide missing XHS video ${column}`, (t) => {
    const f = fixture(t, { current: true });
    const db = new sqlite.DatabaseSync(f.database);
    db.exec(`ALTER TABLE xhs_notes DROP COLUMN ${column}`);
    db.close();
    assert.throws(
      () => inspectDatabase(f.database, f.migrations, { schemaOnly: true }),
      /Required column missing/,
    );
    assert.throws(
      () => pythonInspect(f.database, f.migrations),
      /Required XHS video columns missing/,
    );
  });
}

test('reuse rejects a WAL commit after pinned equality even with frozen source metadata', async (t) => {
  const f = fixture(t),
    database = fs.realpathSync.native(f.database),
    writer = new sqlite.DatabaseSync(database);
  writer.exec('PRAGMA journal_mode=WAL');
  const backups = path.join(f.root, 'backups');
  const first = await prepareStart(
    f.database,
    f.migrations,
    backups,
    path.join(f.root, 'first.json'),
  );
  const saved = fs.readFileSync(first.backup.backup);
  const openOriginal = fs.openSync,
    statOriginal = fs.statSync;
  const pinned = new Map();
  for (const file of [database, database + '-wal'])
    if (fs.existsSync(file))
      pinned.set(file, statOriginal(file, { bigint: true }));
  let hashes = 0,
    injected = false;
  fs.statSync = function (file, options) {
    if (options?.bigint && pinned.has(file)) return pinned.get(file);
    return statOriginal.apply(this, arguments);
  };
  fs.openSync = function (file, ...args) {
    if (file === first.backup.backup && ++hashes === 2) {
      writer.exec("UPDATE articles SET body='late reuse commit' WHERE id='a'");
      injected = true;
    }
    return openOriginal.call(this, file, ...args);
  };
  try {
    await assert.rejects(
      prepareStart(
        f.database,
        f.migrations,
        backups,
        path.join(f.root, 'stale.json'),
      ),
      /source changed during startup reuse/,
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(path.join(f.root, 'stale.json')), false);
    assert.deepEqual(fs.readFileSync(first.backup.backup), saved);
  } finally {
    fs.openSync = openOriginal;
    fs.statSync = statOriginal;
    writer.close();
  }
});

const searchMigration = '20261020160000_local_body_search';
function rollbackFixture(t, schema21 = true) {
  const f = fixture(t, { current: true });
  fs.writeFileSync(
    path.join(f.migrations, 'search-rollback.json'),
    JSON.stringify({
      format: 1,
      baseSourceCommit: '48fdf73f4d770001bbb6de3e2383189811e56ccb',
      optionalMigration: searchMigration,
    }),
  );
  if (!schema21) {
    const db = new sqlite.DatabaseSync(f.database);
    db.exec(
      'DROP TRIGGER article_search_insert; DROP TRIGGER article_search_body_update; DROP TRIGGER article_search_delete; DROP TABLE article_search_documents',
    );
    db.prepare('DELETE FROM _prisma_migrations WHERE migration_name=?').run(
      searchMigration,
    );
    db.close();
  }
  return f;
}
for (const schema21 of [false, true])
  test(
    'strict rollback accepts schema' +
      (schema21 ? 21 : 20) +
      ' through native and Python gates',
    (t) => {
      const f = rollbackFixture(t, schema21),
        before = fs.readFileSync(f.database);
      assert.deepEqual(
        inspectDatabase(f.database, f.migrations, { startupGate: true })
          .pending,
        [],
      );
      assert.deepEqual(pythonInspect(f.database, f.migrations).pending, []);
      assert.deepEqual(fs.readFileSync(f.database), before);
    },
  );
for (const [name, sql] of [
  [
    'unknown migration',
    "INSERT INTO _prisma_migrations VALUES('future-danger','bad',1,NULL)",
  ],
  [
    'changed migration',
    "UPDATE _prisma_migrations SET checksum='bad' WHERE migration_name='20261020160000_local_body_search'",
  ],
  [
    'unfinished migration',
    "UPDATE _prisma_migrations SET finished_at=NULL WHERE migration_name='20261020160000_local_body_search'",
  ],
  [
    'duplicate migration',
    "INSERT INTO _prisma_migrations SELECT * FROM _prisma_migrations WHERE migration_name='20261020160000_local_body_search'",
  ],
  ['unknown table', 'CREATE TABLE future_business(id TEXT)'],
  ['unknown view', 'CREATE VIEW future_view AS SELECT id FROM articles'],
  [
    'changed trigger',
    'DROP TRIGGER article_search_delete; CREATE TRIGGER article_search_delete AFTER DELETE ON articles BEGIN DELETE FROM articles; END',
  ],
  [
    'changed partial index',
    'DROP INDEX article_search_cached_idx; CREATE INDEX article_search_cached_idx ON article_search_documents(body_cached) WHERE pending=0',
  ],
])
  test('strict rollback rejects ' + name + ' in both inspectors', (t) => {
    const f = rollbackFixture(t),
      db = new sqlite.DatabaseSync(f.database);
    db.exec(sql);
    db.close();
    assert.throws(
      () => inspectDatabase(f.database, f.migrations, { startupGate: true }),
      /migration|schema|drift/i,
    );
    assert.throws(
      () => pythonInspect(f.database, f.migrations),
      /migration|schema|drift/i,
    );
  });
test('rollback cannot widen the optional extension to an unreviewed base or SQL', (t) => {
  const f = rollbackFixture(t);
  fs.appendFileSync(
    path.join(f.migrations, searchMigration, 'migration.sql'),
    '\nCREATE TABLE dangerous(id TEXT);',
  );
  assert.throws(
    () => inspectDatabase(f.database, f.migrations, { startupGate: true }),
    /search migration changed/,
  );
  assert.throws(
    () => pythonInspect(f.database, f.migrations),
    /Rollback migrations changed/,
  );
});
