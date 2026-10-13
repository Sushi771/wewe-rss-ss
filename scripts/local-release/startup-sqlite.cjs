const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hash, fileHash, writeJson } = require('./lib.cjs');
const budget = require('./space-budget.cjs');

class UnsupportedBaselineValue extends Error {}
class SourceChangedDuringPreparation extends Error {}
const required = {
  feeds: ['collection_channel'],
  articles: ['last_body_status', 'verified_source_url', 'last_body_retry'],
};
const xhsMigration = '20261009050000_add_xhs_local_archive';
const groupsMigration = '20261009063000_add_management_groups';
const videoMigration = '20261009080000_add_xhs_video_cache';
const videoColumns = [
  'kind',
  'video_bytes',
  'video_mime_type',
  'video_expected_bytes',
  'video_sha256',
];
const xhsRequired = {
  xhs_creators: [
    'id',
    'profile_url',
    'display_name',
    'external_author_id',
    'enabled',
    'last_status',
    'last_checked_at',
    'created_at',
  ],
  xhs_notes: [
    'id',
    'creator_id',
    'title',
    'publish_time',
    'status',
    'content_html',
  ],
};
const quote = (value) => '"' + value.replace(/"/g, '""') + '"';
function sqlite() {
  return require('node:sqlite');
}
function open(database) {
  const { DatabaseSync } = sqlite();
  const connection = new DatabaseSync(database, {
    readOnly: true,
    timeout: 10000,
  });
  connection.exec('PRAGMA query_only=ON; BEGIN');
  return connection;
}
function digestRows(rows) {
  // Stream the same compact JSON bytes as the Python baseline. A whole-table
  // string can exceed V8's string limit when cached article bodies grow.
  const digest = crypto.createHash('sha256');
  digest.update('[');
  let firstRow = true;
  for (const row of rows) {
    if (!firstRow) digest.update(',');
    firstRow = false;
    digest.update('[');
    let firstValue = true;
    for (const value of row) {
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'bigint' &&
        !(value instanceof Uint8Array)
      )
        throw new UnsupportedBaselineValue(
          'Use the established Python baseline for REAL values',
        );
      if (!firstValue) digest.update(',');
      firstValue = false;
      // Keep full-width SQLite integers and the established typed BLOB digest.
      digest.update(
        typeof value === 'bigint'
          ? value.toString()
          : JSON.stringify(
              value instanceof Uint8Array
                ? {
                    __wewe_sqlite_blob__: {
                      length: value.byteLength,
                      sha256: hash(value),
                    },
                  }
                : value,
            ),
      );
    }
    digest.update(']');
  }
  digest.update(']');
  return digest.digest('hex');
}
function inspectConnection(
  connection,
  database,
  migrations,
  { schemaOnly = false, capture, startupGate = false } = {},
) {
  if (!startupGate) {
    assert.deepEqual(
      connection
        .prepare('PRAGMA integrity_check')
        .all()
        .map((row) => row.integrity_check),
      ['ok'],
      'SQLite integrity check failed',
    );
    assert.deepEqual(
      connection.prepare('PRAGMA foreign_key_check').all(),
      [],
      'SQLite foreign key check failed',
    );
  }
  const expected = new Map();
  for (const entry of fs
    .readdirSync(migrations, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const original = fs.readFileSync(
      path.join(migrations, entry.name, 'migration.sql'),
    );
    const lf = original.toString('latin1').replace(/\r\n/g, '\n');
    expected.set(
      entry.name,
      new Set([
        hash(original),
        hash(Buffer.from(lf, 'latin1')),
        hash(Buffer.from(lf.replace(/\n/g, '\r\n'), 'latin1')),
      ]),
    );
  }
  const applied = new Set();
  for (const row of connection
    .prepare(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations',
    )
    .all()) {
    if (row.rolled_back_at !== null) continue;
    if (
      row.finished_at === null ||
      !expected.get(row.migration_name)?.has(row.checksum) ||
      applied.has(row.migration_name)
    )
      throw new Error(
        'Incomplete, unknown, duplicate or changed migration: ' +
          row.migration_name,
      );
    applied.add(row.migration_name);
  }
  const pending = [...expected.keys()]
    .filter((name) => !applied.has(name))
    .sort();
  assert.deepEqual(pending, [], 'Pending migrations are forbidden at startup');
  if (startupGate || capture) {
    // Reconstruct the packaged schema in memory. Migration receipts alone, or
    // a few selected columns, cannot establish compatibility with this client.
    const { DatabaseSync } = sqlite();
    const reference = new DatabaseSync(':memory:');
    try {
      for (const name of expected.keys())
        reference.exec(
          fs.readFileSync(path.join(migrations, name, 'migration.sql'), 'utf8'),
        );
      for (const { name } of reference
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()) {
        for (const pragma of ['table_info', 'foreign_key_list', 'index_list']) {
          const actual = connection
            .prepare(`PRAGMA ${pragma}(${quote(name)})`)
            .all();
          const wanted = reference
            .prepare(`PRAGMA ${pragma}(${quote(name)})`)
            .all();
          // Additive history can produce a different physical column/index
          // order with the same named schema. Prisma selects columns by name.
          const canonical = (rows) =>
            rows
              .map((row) => {
                const value = { ...row };
                if (pragma === 'table_info') delete value.cid;
                if (pragma === 'index_list') delete value.seq;
                if (pragma === 'foreign_key_list') delete value.id;
                return value;
              })
              .sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b)),
              );
          assert.deepEqual(
            canonical(actual),
            canonical(wanted),
            'Incompatible schema: ' + name + '.' + pragma,
          );
          if (pragma === 'index_list')
            for (const index of wanted)
              assert.deepEqual(
                connection
                  .prepare(`PRAGMA index_info(${quote(index.name)})`)
                  .all()
                  .map(({ seqno, name }) => ({ seqno, name })),
                reference
                  .prepare(`PRAGMA index_info(${quote(index.name)})`)
                  .all()
                  .map(({ seqno, name }) => ({ seqno, name })),
                'Incompatible index: ' + index.name,
              );
        }
        connection.prepare(`SELECT * FROM ${quote(name)} LIMIT 1`).get();
      }
    } finally {
      reference.close();
    }
  }
  const tables = {};
  // Applied migration records alone do not prove their tables still exist.
  const requiredTables = expected.has(xhsMigration)
    ? { ...required, ...xhsRequired }
    : required;
  if (expected.has(groupsMigration)) {
    requiredTables.management_groups = ['id', 'name', 'platform'];
    requiredTables.feeds = [...requiredTables.feeds, 'group_id'];
    requiredTables.xhs_creators = [...requiredTables.xhs_creators, 'group_id'];
  }
  if (expected.has(videoMigration))
    requiredTables.xhs_notes = [...requiredTables.xhs_notes, ...videoColumns];
  for (const [table, requiredColumns] of Object.entries(requiredTables)) {
    const columns = connection
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => row.name);
    for (const column of requiredColumns)
      assert(
        columns.includes(column),
        'Required column missing: ' + table + '.' + column,
      );
    tables[table] = { columns };
    if (!schemaOnly && !startupGate) {
      const statement = connection.prepare(
        `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY id`,
      );
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const rows = statement.all();
      if (capture) capture[table] = rows;
      Object.assign(tables[table], {
        rows: rows.length,
        sha256: digestRows(rows),
      });
    }
  }
  return {
    database,
    integrity: startupGate ? 'pending' : 'ok',
    pending,
    applied: [...applied].sort(),
    tables,
  };
}
function inspectDatabase(database, migrations, options) {
  database = fs.realpathSync.native(database);
  const connection = open(database);
  try {
    return inspectConnection(connection, database, migrations, options);
  } finally {
    connection.close();
  }
}
function sourceIdentity(database) {
  return [database, database + '-wal'].map((file) => {
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (file.endsWith('-wal') && stat.size === 0n) return null;
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(
        String,
      );
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
}
function snapshotEqual(source, copied) {
  const schema = (connection) =>
    connection
      .prepare(
        'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name',
      )
      .all();
  try {
    assert.deepEqual(schema(source), schema(copied));
  } catch {
    return false;
  }
  for (const { name } of source
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) {
    const info = source.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const primary = info
      .filter((row) => row.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => quote(row.name));
    const query = `SELECT ${info.map((row) => quote(row.name)).join(',')} FROM ${quote(name)} ORDER BY ${primary.length ? primary.join(',') : 'rowid'}`;
    const rows = (connection) => {
      const statement = connection.prepare(query);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      return statement.iterate();
    };
    const original = rows(source),
      duplicate = rows(copied);
    for (;;) {
      const left = original.next(),
        right = duplicate.next();
      if (left.done || right.done) {
        if (left.done !== right.done) return false;
        break;
      }
      if (left.value.length !== right.value.length) return false;
      for (let i = 0; i < left.value.length; i++) {
        const a = left.value[i],
          b = right.value[i];
        if (a instanceof Uint8Array && b instanceof Uint8Array) {
          if (!Buffer.from(a).equals(Buffer.from(b))) return false;
        } else if (!Object.is(a, b)) return false;
      }
    }
  }
  return true;
}
function verifyCurrentSnapshot(database, backup, stage) {
  // An unpinned observer notices commits made during the pinned row comparison.
  const observer = new (sqlite().DatabaseSync)(database, { readOnly: true });
  const current = open(database),
    copied = open(backup);
  try {
    const version = observer.prepare('PRAGMA data_version').get().data_version;
    if (
      !snapshotEqual(current, copied) ||
      observer.prepare('PRAGMA data_version').get().data_version !== version
    )
      throw new SourceChangedDuringPreparation(
        'SQLite source changed during startup ' + stage,
      );
  } finally {
    current.close();
    copied.close();
    observer.close();
  }
}
async function prepareStart(database, migrations, backupRoot, baselineFile) {
  database = fs.realpathSync.native(database);
  backupRoot = budget.canonical(backupRoot);
  if (budget.inside(backupRoot, database))
    throw new Error('Nested source/destination refused');
  const receipt = budget.reuseFile(backupRoot, database);
  const identity = sourceIdentity(database);
  try {
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (
      previous.source === database &&
      budget.inside(backupRoot, budget.canonical(previous.backup)) &&
      fileHash(previous.backup) === previous.sha256
    ) {
      const source = open(database),
        copied = open(previous.backup);
      try {
        if (snapshotEqual(source, copied)) {
          inspectConnection(copied, previous.backup, migrations, {
            schemaOnly: true,
          });
          const inspection = inspectConnection(source, database, migrations);
          if (fileHash(previous.backup) !== previous.sha256)
            throw new Error('Recovery point changed during verification');
          verifyCurrentSnapshot(database, previous.backup, 'reuse');
          writeJson(baselineFile, inspection);
          return {
            backup: {
              ...previous,
              reused: true,
              reuseProof: 'all-schema-and-typed-rows-pinned-snapshot-v1',
            },
            inspection,
          };
        }
      } finally {
        source.close();
        copied.close();
      }
    }
  } catch (error) {
    if (
      error instanceof SourceChangedDuringPreparation ||
      fs.existsSync(baselineFile)
    )
      throw error;
  }
  const scope =
    process.env.SQLITE_BACKUP_KIND === 'test'
      ? process.env.SQLITE_TEST_BUDGET_ROOT || backupRoot
      : backupRoot;
  if (!budget.inside(budget.canonical(scope), backupRoot))
    throw new Error('Backup escapes test budget root');
  budget.preflight(scope, budget.estimate(database));
  const unlock = budget.lease(scope);
  try {
    budget.preflight(scope, budget.estimate(database));
    const result = await freshPrepareStart(
      database,
      migrations,
      backupRoot,
      baselineFile,
    );
    Object.assign(result.backup, {
      sourceIdentity: identity,
      native: true,
      reused: false,
    });
    budget.replaceJson(receipt, result.backup);
    return result;
  } catch (error) {
    budget.replaceJson(path.join(backupRoot, 'last-failure.json'), {
      failure: error.message,
      existingFilesRetained: true,
    });
    throw error;
  } finally {
    unlock();
  }
}
async function freshPrepareStart(
  database,
  migrations,
  backupRoot,
  baselineFile,
) {
  database = fs.realpathSync.native(database);
  const identity = sourceIdentity(database);
  const connection = open(database);
  try {
    const records = {};
    const before = inspectConnection(connection, database, migrations, {
      capture: records,
    });
    const directory = path.join(
      backupRoot,
      'before-start-' + crypto.randomUUID(),
    );
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, 'wewe-rss.db');
    // The destination is new and empty; never overwrite an existing database.
    const descriptor = fs.openSync(destination, 'wx');
    fs.closeSync(descriptor);
    await sqlite().backup(connection, destination, { rate: 1000 });
    const duplicate = open(destination);
    try {
      const copied = inspectConnection(duplicate, destination, migrations, {
        schemaOnly: true,
      });
      for (const [table, protectedTable] of Object.entries(before.tables)) {
        assert.deepEqual(
          copied.tables[table].columns,
          protectedTable.columns,
          'Backup changed protected columns',
        );
        const statement = duplicate.prepare(
          `SELECT ${protectedTable.columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY id`,
        );
        statement.setReadBigInts(true);
        statement.setReturnArrays(true);
        // Exact typed values from independently queried source and backup;
        // avoids serializing every large body to JSON a second time.
        assert.deepEqual(
          statement.all(),
          records[table],
          'Backup changed protected fields',
        );
      }
    } finally {
      duplicate.close();
    }
    verifyCurrentSnapshot(database, destination, 'backup');
    connection.close();
    assert.deepEqual(
      sourceIdentity(database),
      identity,
      'SQLite source changed during startup backup',
    );
    const backup = {
      createdAtUtc: new Date().toISOString(),
      source: database,
      backup: destination,
      integrityCheck: 'ok',
      sha256: fileHash(destination),
      feeds: before.tables.feeds.rows,
      articles: before.tables.articles.rows,
    };
    writeJson(baselineFile, before);
    writeJson(path.join(directory, 'verification.json'), backup);
    return { backup, inspection: before };
  } finally {
    if (connection.isOpen) connection.close();
  }
}
module.exports = {
  inspectDatabase,
  prepareStart,
  digestRows,
  UnsupportedBaselineValue,
};
