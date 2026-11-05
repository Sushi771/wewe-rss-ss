const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { assertTaskDocumentsForMigration, assertTaskDocumentPreflightUnchanged,
  diagnoseTaskDocument, TaskDocumentPreflightError } = require('./task-document-preflight.cjs');
const { inspectDatabase } = require('./startup-sqlite.cjs');
const migrations = path.resolve(__dirname, '../../apps/server/prisma/migrations');
const sqlFiles = fs.readdirSync(migrations).filter(name => fs.statSync(path.join(migrations, name)).isDirectory()).sort()
  .map(name => ({ name, file: path.join(migrations, name, 'migration.sql') }));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const originalMigrationHashes = sqlFiles.map(({ name, file }) => [name, sha(fs.readFileSync(file))]);
const sourceRiskSql = fs.readFileSync(path.join(migrations, '20261027100000_xhs_source_risk/migration.sql'), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-task-document-preflight-'));
const evidence = { root, node: process.version, syntheticOnly: true, productionAccess: false,
  prismaCliExecuted: false, networkOperations: false, servicesStarted: false,
  ioBoundary: 'Read-only business SQL is verified; native SQLite auxiliary-file I/O is not an OS-wide zero-write proof', cases: [] };
let sequence = 0;

function fixture({ history = false, current = false } = {}) {
  const database = path.join(root, String(++sequence).padStart(3, '0') + '.sqlite');
  assert.equal(fs.existsSync(database), false);
  const db = new DatabaseSync(database);
  if (history || current) {
    db.exec('CREATE TABLE _prisma_migrations(migration_name TEXT,checksum TEXT,finished_at INT,rolled_back_at INT)');
    for (const entry of sqlFiles) {
      if (!current && entry.name > '20261025120000_xhs_request_budget') continue;
      db.exec(fs.readFileSync(entry.file, 'utf8'));
      db.prepare('INSERT INTO _prisma_migrations VALUES(?,?,1,NULL)').run(entry.name, sha(fs.readFileSync(entry.file)));
    }
  } else {
    for (const table of ['xhs_subscription_tasks', 'xhs_whole_creator_jobs'])
      db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT,updated_at INTEGER)`);
  }
  db.close();
  return { database, ddlCalls: 0 };
}
function document(table, state = 'blocked', id = 'synthetic-task') {
  if (table === 'xhs_whole_creator_jobs') return { id, creatorId: 'synthetic-creator', state,
    updatedAt: 1, listEnd: false, items: {}, code: 'XHS_SOURCE_RATE_LIMIT_BLOCKED' };
  return { taskId: id, creatorId: 'synthetic-creator', kind: 'list', state,
    total: 0, completed: 0, skipped: 0, failed: 0, remaining: 0,
    message: 'synthetic', noteIds: [], items: {}, code: 'XHS_SOURCE_RATE_LIMIT_BLOCKED' };
}
function insert(f, table, state, value, { id = 'synthetic-task', creator = 'synthetic-creator' } = {}) {
  const db = new DatabaseSync(f.database);
  db.prepare(`INSERT INTO ${table}(id,creator_id,state,document,updated_at) VALUES(?,?,?,?,1)`)
    .run(id, creator, state, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value));
  db.close();
}
function rows(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return ['xhs_subscription_tasks', 'xhs_whole_creator_jobs'].map(table => [table,
    db.prepare(`SELECT id,creator_id,state,typeof(document) AS kind,hex(CAST(document AS BLOB)) AS raw FROM ${table} ORDER BY id`).all()]); }
  finally { db.close(); }
}
function attemptSourceRiskMigration(f) {
  const proof = assertTaskDocumentsForMigration(f.database);
  assertTaskDocumentPreflightUnchanged(f.database, proof);
  f.ddlCalls++;
  const db = new DatabaseSync(f.database);
  try { db.exec(sourceRiskSql); } finally { db.close(); }
}
function rejectedWithoutWrites(f, name) {
  const before = fs.readFileSync(f.database), originalRows = rows(f.database);
  let failure;
  assert.throws(() => attemptSourceRiskMigration(f), error => {
    failure = error;
    return error instanceof TaskDocumentPreflightError && error.code === 'XHS_TASK_DOCUMENT_REVIEW_REQUIRED';
  });
  assert.equal(f.ddlCalls, 0);
  assert.equal(failure.manualReviewRequired, true);
  assert.equal(failure.diagnostics.stableSnapshotVerified, true);
  assert.match(failure.diagnostics.databaseIdentity.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(f.database), before);
  assert.deepEqual(rows(f.database), originalRows);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='xhs_source_risk'").get(), undefined); }
  finally { db.close(); }
  evidence.cases.push({ name, database: f.database, status: 'blocked-before-DDL', ddlCalls: f.ddlCalls,
    exactDatabaseBytesPreserved: true, originalTaskBytesAndStatesPreserved: true, diagnostics: failure.diagnostics });
  return failure;
}

for (const table of ['xhs_subscription_tasks', 'xhs_whole_creator_jobs']) {
  for (const state of ['blocked', 'completed']) test(`${table}: malformed ${state} document blocks before the first migration DDL and retains every byte`, () => {
    const f = fixture({ history: true });
    insert(f, table, state, '{broken "credential":"SYNTHETIC_PRIVATE_SENTINEL"');
    const failure = rejectedWithoutWrites(f, table + ':' + state);
    assert.equal(JSON.stringify(failure.diagnostics).includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
    assert.equal(failure.message.includes('synthetic-task'), false);
  });
}

for (const [name, change] of [
  ['non-object JSON', () => '[]'],
  ['missing state', d => { delete d.state; return d; }],
  ['unknown state', d => ({ ...d, state: 'future_unrecognized' })],
  ['row/document state mismatch', d => ({ ...d, state: 'completed' })],
  ['missing identity', d => { delete d.taskId; return d; }],
  ['non-string risk code', d => ({ ...d, code: { unexpected: true } })],
]) test(`${name} fails closed without repairing a document`, () => {
  const f = fixture(); insert(f, 'xhs_subscription_tasks', 'blocked', change(document('xhs_subscription_tasks')));
  rejectedWithoutWrites(f, name);
});

test('a completed row retaining a source-stop code requires review instead of initializing clear risk', () => {
  const f = fixture(); insert(f, 'xhs_subscription_tasks', 'completed', document('xhs_subscription_tasks', 'completed'));
  const failure = rejectedWithoutWrites(f, 'completed-source-stop');
  assert(failure.diagnostics.issues[0].reasons.includes('SOURCE_STOP_STATE_REQUIRES_REVIEW'));
});

test('duplicate code keys with different SQLite/JSON.parse meanings cannot hide a source stop', () => {
  const f = fixture();
  const d = document('xhs_subscription_tasks');
  const raw = JSON.stringify({ ...d, code: 'OK' }).replace('"code":"OK"', '"code":"OK","code":"XHS_SOURCE_RATE_LIMIT_BLOCKED"');
  insert(f, 'xhs_subscription_tasks', 'blocked', raw);
  const failure = rejectedWithoutWrites(f, 'ambiguous-duplicate-code');
  assert(failure.diagnostics.issues[0].reasons.includes('JSON_CODE_INTERPRETATION_MISMATCH'));
});

for (const field of ['state', 'taskId', 'creatorId']) test(`duplicate ${field} meanings require review rather than trusting only JSON.parse`, () => {
  const f = fixture();
  const d = document('xhs_subscription_tasks');
  const expected = JSON.stringify(d[field]);
  const raw = JSON.stringify(d).replace(JSON.stringify(field) + ':' + expected,
    JSON.stringify(field) + ':"unrecognized-first-value",' + JSON.stringify(field) + ':' + expected);
  insert(f, 'xhs_subscription_tasks', 'blocked', raw);
  const failure = rejectedWithoutWrites(f, 'ambiguous-duplicate-' + field);
  assert(failure.diagnostics.issues[0].reasons.some(reason => /INTERPRETATION_MISMATCH/.test(reason)));
});

test('duplicate whole-creator id and batch state use their actual table-specific envelope', () => {
  const whole = fixture(), doc = document('xhs_whole_creator_jobs');
  insert(whole, 'xhs_whole_creator_jobs', 'blocked', JSON.stringify(doc).replace('"id":"synthetic-task"', '"id":"other-first-value","id":"synthetic-task"'));
  rejectedWithoutWrites(whole, 'ambiguous-whole-id');
  const batch = fixture();
  insert(batch, 'xhs_subscription_tasks', 'batch_running', '{"batchId":"synthetic-batch","state":"paused","state":"running","items":[]}', { id: 'batch:synthetic-batch', creator: '__batch__' });
  rejectedWithoutWrites(batch, 'ambiguous-batch-state');
});

for (const [name, rawExtra] of [
  ['non-critical duplicate key', '"message":"first","message":"second"'],
  ['escaped equivalent duplicate key', '"audit":"first","' + String.fromCharCode(92) + 'u0061udit":"second"'],
  ['nested duplicate key', '"audit":{"nested":{"marker":1,"marker":2}}'],
]) test(`${name} is rejected within its object scope`, () => {
  const f = fixture(), d = document('xhs_subscription_tasks'); delete d.message;
  const raw = JSON.stringify(d).slice(0, -1) + ',' + rawExtra + '}';
  insert(f, 'xhs_subscription_tasks', 'blocked', raw);
  const failure = rejectedWithoutWrites(f, name);
  assert(failure.diagnostics.issues[0].reasons.includes('DOCUMENT_DUPLICATE_OBJECT_KEYS'));
});

test('the same key in different parent objects and normal arrays remains legal', () => {
  const f = fixture(), d = document('xhs_subscription_tasks');
  d.audit = { first: { marker: 1 }, second: { marker: 2 }, items: [{ marker: 3 }, { marker: 4 }] };
  insert(f, 'xhs_subscription_tasks', 'blocked', d);
  const before = fs.readFileSync(f.database), proof = assertTaskDocumentsForMigration(f.database);
  assertTaskDocumentPreflightUnchanged(f.database, proof);
  assert.deepEqual(fs.readFileSync(f.database), before);
});

test('BLOB and invalid UTF8 document storage stay unchanged and require review', () => {
  const blob = fixture(); insert(blob, 'xhs_subscription_tasks', 'blocked', Buffer.from([0xff, 0x00, 0x7b]));
  rejectedWithoutWrites(blob, 'blob-storage');
  const invalidText = fixture(), db = new DatabaseSync(invalidText.database);
  db.exec("INSERT INTO xhs_subscription_tasks VALUES('synthetic-task','synthetic-creator','blocked',CAST(X'FF007B' AS TEXT),1)"); db.close();
  rejectedWithoutWrites(invalidText, 'invalid-utf8-text');
});

test('actual subscription and whole-creator envelope formats migrate with original source stops and task bytes intact', () => {
  const f = fixture({ history: true });
  for (const table of ['xhs_subscription_tasks', 'xhs_whole_creator_jobs']) insert(f, table, 'blocked', document(table));
  const before = rows(f.database);
  attemptSourceRiskMigration(f);
  assert.equal(f.ddlCalls, 1); assert.deepEqual(rows(f.database), before);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try { assert.deepEqual({ ...db.prepare('SELECT state,code FROM xhs_source_risk').get() }, { state: 'blocked', code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' }); }
  finally { db.close(); }
  evidence.cases.push({ name: 'recognized-legacy-source-stop', database: f.database, status: 'synthetic-source-risk-migration-passed', originalTaskBytesAndStatesPreserved: true });
});

test('actual batch_running storage uses batchId, __batch__, and prefixed row state without false corruption', () => {
  const f = fixture({ history: true });
  const batch = { batchId: 'synthetic-batch', state: 'running', items: [{ index: 0, fingerprint: 'a'.repeat(64), kind: 'author', state: 'queued' }] };
  insert(f, 'xhs_subscription_tasks', 'batch_running', batch, { id: 'batch:synthetic-batch', creator: '__batch__' });
  const before = rows(f.database), proof = assertTaskDocumentsForMigration(f.database);
  assert.equal(proof.checkedRows, 1); assertTaskDocumentPreflightUnchanged(f.database, proof);
  assert.deepEqual(rows(f.database), before);
  evidence.cases.push({ name: 'recognized-batch-running-envelope', database: f.database, status: 'read-only-preflight-passed', originalTaskBytesAndStatesPreserved: true });
});

test('preflight evidence cannot be forged, deserialized, or borrowed for an equal-content different DB', () => {
  const f = fixture(), proof = assertTaskDocumentsForMigration(f.database);
  for (const fake of [{ status: 'passed', readOnly: true }, JSON.parse(JSON.stringify(proof))])
    assert.throws(() => assertTaskDocumentPreflightUnchanged(f.database, fake), { code: 'XHS_TASK_DOCUMENT_EVIDENCE_INVALID' });
  const duplicate = path.join(root, 'different-identity.sqlite'); fs.copyFileSync(f.database, duplicate, fs.constants.COPYFILE_EXCL);
  assert.throws(() => assertTaskDocumentPreflightUnchanged(duplicate, proof), { code: 'XHS_TASK_DOCUMENT_SNAPSHOT_CHANGED' });
});

test('a valid document changed after preflight invalidates the evidence before migration DDL', () => {
  const f = fixture(); insert(f, 'xhs_subscription_tasks', 'blocked', document('xhs_subscription_tasks'));
  const proof = assertTaskDocumentsForMigration(f.database), db = new DatabaseSync(f.database);
  const changed = document('xhs_subscription_tasks'); changed.message = 'changed synthetic snapshot';
  db.prepare('UPDATE xhs_subscription_tasks SET document=?').run(JSON.stringify(changed)); db.close();
  assert.throws(() => assertTaskDocumentPreflightUnchanged(f.database, proof), { code: 'XHS_TASK_DOCUMENT_SNAPSHOT_CHANGED' });
  assert.equal(f.ddlCalls, 0);
});

test('a WAL-only committed task change invalidates the bound snapshot', () => {
  const f = fixture(), writer = new DatabaseSync(f.database);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  try {
    writer.prepare('INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?,1)').run('synthetic-task', 'synthetic-creator', 'blocked', JSON.stringify(document('xhs_subscription_tasks')));
    const proof = assertTaskDocumentsForMigration(f.database);
    assert(proof.databaseIdentity.files[1]);
    const changed = document('xhs_subscription_tasks'); changed.message = 'new synthetic WAL commit';
    writer.prepare('UPDATE xhs_subscription_tasks SET document=?').run(JSON.stringify(changed));
    assert.throws(() => assertTaskDocumentPreflightUnchanged(f.database, proof), { code: 'XHS_TASK_DOCUMENT_SNAPSHOT_CHANGED' });
  } finally { writer.close(); }
});

test('the actual native startup schema gate rejects bad current-task data without changing source risk', () => {
  const f = fixture({ current: true });
  insert(f, 'xhs_subscription_tasks', 'completed', '{broken');
  const db = new DatabaseSync(f.database); db.exec("UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED'"); db.close();
  const before = fs.readFileSync(f.database);
  assert.throws(() => inspectDatabase(f.database, migrations, { schemaOnly: true, startupGate: true }), { code: 'XHS_TASK_DOCUMENT_REVIEW_REQUIRED' });
  assert.deepEqual(fs.readFileSync(f.database), before);
});

test('pure diagnostic returns only hashes/reasons and recognizes actual ordinary/whole/batch envelopes', () => {
  const row = { table: 'xhs_subscription_tasks', id: 'synthetic-task', creatorId: 'synthetic-creator', state: 'blocked', documentType: 'text', documentBytes: Buffer.from(JSON.stringify(document('xhs_subscription_tasks'))) };
  const result = diagnoseTaskDocument(row);
  assert.deepEqual(result.reasons, []); assert.match(result.documentSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('synthetic-creator'), false);
});

test.after(() => {
  const after = sqlFiles.map(({ name, file }) => [name, sha(fs.readFileSync(file))]);
  assert.deepEqual(after, originalMigrationHashes);
  evidence.historicalMigrationSqlHashesUnchanged = true;
  evidence.migrationSqlHashes = after;
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ syntheticTaskDocumentEvidence: path.join(root, 'evidence.json') }));
});
