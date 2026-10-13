const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { hash } = require('./lib.cjs');
const { inspectDatabase } = require('./startup-sqlite.cjs');
const { createStartupAudit } = require('./startup-audit.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-background-audit-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('wewe-background-audit-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const migrations = path.join(root, 'migrations');
  fs.mkdirSync(path.join(migrations, '001'), { recursive: true });
  const sql =
    'CREATE TABLE feeds(id TEXT PRIMARY KEY,collection_channel TEXT); CREATE TABLE articles(id TEXT PRIMARY KEY,feed_id TEXT REFERENCES feeds(id),last_body_status TEXT,verified_source_url TEXT,last_body_retry TEXT);';
  fs.writeFileSync(path.join(migrations, '001/migration.sql'), sql);
  const database = path.join(root, 'fixture.db');
  const db = new DatabaseSync(database);
  db.exec(
    sql +
      ' CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at INT,rolled_back_at INT);',
  );
  db.prepare('INSERT INTO _prisma_migrations VALUES(?,?,1,NULL)').run(
    '001',
    hash(sql),
  );
  db.exec(
    "INSERT INTO feeds VALUES('f',NULL); INSERT INTO articles VALUES('a','f',NULL,NULL,NULL)",
  );
  db.close();
  return { database, migrations, auditRoot: root };
}

test('quick gate reports pending, then an idempotent worker verifies a pinned WAL backup without changing data', async (t) => {
  const f = fixture(t);
  const writer = new DatabaseSync(f.database);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec("UPDATE articles SET last_body_status='cached' WHERE id='a'");
  const gate = inspectDatabase(f.database, f.migrations, { startupGate: true });
  assert.equal(gate.integrity, 'pending');
  assert.equal(gate.tables.articles.sha256, undefined);
  const state = createStartupAudit(f);
  assert.equal(state.status, 'verifying');
  let resolved = false;
  void state.ready.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);
  state.start();
  state.start();
  assert.equal(await state.ready, true);
  assert.equal(state.status, 'ready');
  // Give the transient worker time to close, then prove it never restarted.
  await new Promise((resolve) => setTimeout(resolve, 100));
  state.start();
  const backups = fs
    .readdirSync(path.join(f.auditRoot, 'background-backup'), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(
    path.join(f.auditRoot, 'background-backup', backups[0], 'wewe-rss.db'),
  );
  assert.equal(
    backup.prepare('SELECT last_body_status FROM articles').get()
      .last_body_status,
    'cached',
  );
  assert.equal(
    writer.prepare('SELECT last_body_status FROM articles').get()
      .last_body_status,
    'cached',
  );
  backup.close();
  writer.close();
});

for (const damage of [
  'migration failure',
  'unknown migration',
  'missing column',
  'wrong index',
])
  test('quick gate refuses ' + damage, (t) => {
    const f = fixture(t);
    const db = new DatabaseSync(f.database);
    if (damage === 'migration failure')
      db.exec('UPDATE _prisma_migrations SET finished_at=NULL');
    if (damage === 'unknown migration')
      db.exec("UPDATE _prisma_migrations SET migration_name='future'");
    if (damage === 'missing column')
      db.exec('ALTER TABLE feeds DROP COLUMN collection_channel');
    if (damage === 'wrong index')
      db.exec('CREATE INDEX unexpected ON articles(last_body_status)');
    db.close();
    assert.throws(
      () => inspectDatabase(f.database, f.migrations, { startupGate: true }),
      /migration|schema/,
    );
  });

test('malformed file and an exclusive database lock cannot pass quick startup', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.database);
  db.exec('BEGIN EXCLUSIVE');
  try {
    assert.throws(
      () => inspectDatabase(f.database, f.migrations, { startupGate: true }),
      /locked/,
    );
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
  fs.writeFileSync(f.database, 'invalid SQLite file');
  assert.throws(
    () => inspectDatabase(f.database, f.migrations, { startupGate: true }),
    /database/,
  );
});

test('compatible named columns survive a different additive physical order', (t) => {
  const f = fixture(t);
  const file = path.join(f.migrations, '001/migration.sql');
  const sql = fs
    .readFileSync(file, 'utf8')
    .replace(
      'feeds(id TEXT PRIMARY KEY,collection_channel TEXT)',
      'feeds(collection_channel TEXT,id TEXT PRIMARY KEY)',
    );
  fs.writeFileSync(file, sql);
  const db = new DatabaseSync(f.database);
  db.prepare('UPDATE _prisma_migrations SET checksum=?').run(hash(sql));
  db.close();
  assert.equal(
    inspectDatabase(f.database, f.migrations, { startupGate: true }).integrity,
    'pending',
  );
});

test('deferred foreign-key failure never opens the write gate or publishes a baseline', async (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.database, {
    enableForeignKeyConstraints: false,
  });
  db.exec("UPDATE articles SET feed_id='missing'");
  db.close();
  assert.equal(
    inspectDatabase(f.database, f.migrations, { startupGate: true }).integrity,
    'pending',
  );
  const state = createStartupAudit(f);
  state.start();
  assert.equal(await state.ready, false);
  assert.equal(state.status, 'failed');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    fs.existsSync(path.join(f.auditRoot, 'background-baseline.json')),
    false,
  );
});

test('worker error or exit before success remains failed and does not retry on reentry', async () => {
  for (const event of ['error', 'exit']) {
    let worker,
      launches = 0;
    class FakeWorker extends EventEmitter {
      constructor() {
        super();
        launches++;
        worker = this;
      }
    }
    const state = createStartupAudit({}, FakeWorker);
    state.start();
    state.start();
    worker.emit(event, new Error('synthetic interruption'));
    assert.equal(await state.ready, false);
    worker.emit('message', { status: 'ready' });
    state.start();
    assert.equal(state.status, 'failed');
    assert.equal(launches, 1);
  }
});
