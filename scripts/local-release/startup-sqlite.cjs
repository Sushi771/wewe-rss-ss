const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hash, fileHash, writeJson } = require('./lib.cjs');

class UnsupportedBaselineValue extends Error {}
const required = {
  feeds: ['collection_channel'],
  articles: ['last_body_status', 'verified_source_url', 'last_body_retry'],
};
const xhsMigration = '20261009050000_add_xhs_local_archive';
const groupsMigration = '20261009063000_add_management_groups';
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
  for (const row of rows)
    for (const value of row)
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'bigint'
      )
        throw new UnsupportedBaselineValue(
          'Use the established Python baseline for REAL/BLOB values',
        );
  // Preserve every SQLite INTEGER, including those outside Number's safe range.
  // This produces the same compact UTF-8 JSON as Python for NULL/TEXT/INTEGER.
  return hash(
    JSON.stringify(rows, (_, value) =>
      typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value,
    ),
  );
}
function inspectConnection(
  connection,
  database,
  migrations,
  { schemaOnly = false, capture } = {},
) {
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
    if (!schemaOnly) {
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
    integrity: 'ok',
    pending,
    applied: [...applied].sort(),
    tables,
  };
}
function inspectDatabase(database, migrations, options) {
  database = fs.realpathSync(database);
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
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(
        String,
      );
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
}
async function prepareStart(database, migrations, backupRoot, baselineFile) {
  database = fs.realpathSync(database);
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
