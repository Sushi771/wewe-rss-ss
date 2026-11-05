'use strict';
// Read-only schema admission. It grants no writer-stop, migration or activation authority.
const path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const { hostEffects } = require('./lib.cjs');
const fs = hostEffects.fs;
const {
  validateRoles,
  migrationFiles,
  ADDED_MIGRATIONS,
  OBSERVED_RECEIPTS,
  assertReceiptChecksum,
} = require('./switch-contract.cjs');
const taskDocuments = require('./task-document-preflight.cjs');
const receipts = new WeakMap(),
  fixtures = new WeakMap();
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const textHash = (bytes) =>
  sha(
    Buffer.from(
      new TextDecoder('utf-8', { fatal: true })
        .decode(bytes)
        .replace(/\r\n/g, '\n'),
    ),
  );
const loadedModuleSha256 = textHash(fs.readFileSync(__filename));
const loadedDependencies = Object.fromEntries(
  ['lib.cjs', 'switch-contract.cjs', 'task-document-preflight.cjs'].map(
    (name) => [name, textHash(fs.readFileSync(path.join(__dirname, name)))],
  ),
);
function canonical(value) {
  if (typeof value === 'bigint') return { $integer: value.toString() };
  if (value instanceof Uint8Array)
    return { $blob: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const stable = (value) => JSON.stringify(canonical(value));
const digest = (value) => sha(Buffer.from(stable(value)));
const capture = (value) => JSON.parse(stable(value));
const fail = (code, details) => {
  const error = new Error(code);
  error.code = code;
  error.manualReviewRequired = true;
  if (details) error.diagnostics = details;
  throw error;
};
const same = (a, b) => stable(a) === stable(b);
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function normalized(file) {
  return path.resolve(file).toLowerCase();
}
function directoryStamp(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink())
    fail('SWITCH_SCHEMA_PATH_NOT_PLAIN');
  return [String(s.dev), String(s.ino), String(s.birthtimeNs)];
}
function plainPath(file) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    file.startsWith('\\\\')
  )
    fail('SWITCH_SCHEMA_PATH_INVALID');
  const parts = [];
  for (let at = path.dirname(file); ; at = path.dirname(at)) {
    parts.unshift(at);
    if (path.dirname(at) === at) break;
  }
  for (const parent of parts) directoryStamp(parent);
  if (
    normalized(fs.realpathSync.native(path.dirname(file))) !==
    normalized(path.dirname(file))
  )
    fail('SWITCH_SCHEMA_PATH_NOT_PLAIN');
}
function stamp(s) {
  return [
    'dev',
    'ino',
    'birthtimeNs',
    'mode',
    'nlink',
    'size',
    'mtimeNs',
    'ctimeNs',
  ].map((key) => String(s[key]));
}
function fileSnapshot(
  file,
  { optional = false, maxBytes = 512 * 1024 * 1024 } = {},
) {
  plainPath(file);
  const parent = directoryStamp(path.dirname(file));
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT')
      return { path: file, present: false, parent };
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes)
  )
    fail('SWITCH_SCHEMA_FILE_NOT_PLAIN_OR_BOUNDED');
  if (normalized(fs.realpathSync.native(file)) !== normalized(file))
    fail('SWITCH_SCHEMA_PATH_NOT_PLAIN');
  const fd = fs.openSync(file, 'r'),
    hash = crypto.createHash('sha256'),
    buffer = Buffer.alloc(1024 * 1024),
    deadline = performance.now() + 10000;
  try {
    if (!same(stamp(fs.fstatSync(fd, { bigint: true })), stamp(before)))
      fail('SWITCH_SCHEMA_FILE_REPLACED');
    for (;;) {
      if (performance.now() > deadline) fail('SWITCH_SCHEMA_READ_BUDGET');
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
    if (!same(stamp(fs.fstatSync(fd, { bigint: true })), stamp(before)))
      fail('SWITCH_SCHEMA_FILE_CHANGED');
  } finally {
    fs.closeSync(fd);
  }
  const after = fs.lstatSync(file, { bigint: true });
  if (
    !same(stamp(after), stamp(before)) ||
    !same(directoryStamp(path.dirname(file)), parent)
  )
    fail('SWITCH_SCHEMA_FILE_CHANGED');
  return {
    path: file,
    present: true,
    parent,
    identity: stamp(after),
    sha256: hash.digest('hex'),
  };
}
function databaseFiles(database) {
  // Database content can exceed the generic metadata-file bound.
  // Keep a finite 2 GiB bound and the existing identity/hash/time checks.
  const maxBytes = 2 * 1024 ** 3;
  return [
    fileSnapshot(database, { maxBytes }),
    fileSnapshot(database + '-wal', { optional: true, maxBytes }),
    fileSnapshot(database + '-journal', { optional: true, maxBytes }),
  ];
}
let runtime;
function sqliteRuntime() {
  hostEffects.assertRuntime();
  if (Number(process.versions.node.split('.')[0]) < 24)
    fail('SWITCH_SCHEMA_HOST_NODE24_REQUIRED');
  const { DatabaseSync } = require('node:sqlite');
  if (!runtime) {
    const memory = new DatabaseSync(':memory:');
    try {
      const statement = memory.prepare('SELECT sqlite_version() AS version');
      if (typeof statement.setReadBigInts !== 'function')
        fail('SWITCH_SCHEMA_SQLITE_CAPABILITY_REQUIRED');
      runtime = freeze({
        hostNode: process.version,
        executable: process.execPath,
        sqliteVersion: statement.get().version,
        readBigInts: true,
      });
    } finally {
      memory.close();
    }
  }
  return { DatabaseSync, runtime };
}
function numbers(value) {
  if (typeof value === 'bigint') {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    )
      fail('SWITCH_SCHEMA_METADATA_RANGE');
    return Number(value);
  }
  if (Array.isArray(value)) return value.map(numbers);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, numbers(item)]),
    );
  return value;
}
function all(db, sql) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all().map((row) => numbers({ ...row }));
}
const quote = (name) => '"' + name.replace(/"/g, '""') + '"';
function schemaSnapshot(db) {
  // No LIKE-prefix omission: include history DDL, autoindexes and shadow/internal objects.
  const objects = all(
    db,
    'SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name',
  );
  const tables = {};
  for (const item of objects.filter((row) => row.type === 'table')) {
    const xinfo = all(db, 'PRAGMA main.table_xinfo(' + quote(item.name) + ')');
    const foreignKeys = all(
      db,
      'PRAGMA main.foreign_key_list(' + quote(item.name) + ')',
    );
    const indexes = all(db, 'PRAGMA main.index_list(' + quote(item.name) + ')')
      .map(({ seq, ...index }) => ({
        ...index,
        xinfo: all(db, 'PRAGMA main.index_xinfo(' + quote(index.name) + ')'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    tables[item.name] = { xinfo, foreignKeys, indexes };
  }
  return { objects, tables };
}
function canonicalSchema(schema) {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    objects: [...schema.objects].sort(
      (a, b) => compare(a.type, b.type) || compare(a.name, b.name),
    ),
    tables: Object.fromEntries(
      Object.entries(schema.tables).map(([name, table]) => [
        name,
        {
          ...table,
          indexes: [...table.indexes].sort((a, b) => compare(a.name, b.name)),
        },
      ]),
    ),
  };
}
function catalog() {
  const file = path.join(__dirname, 'switch-schema-contract.json'),
    sourceIdentity = fileSnapshot(file, { maxBytes: 8 * 1024 * 1024 }),
    bytes = fs.readFileSync(file),
    data = JSON.parse(bytes);
  if (sha(bytes) !== sourceIdentity.sha256)
    fail('SWITCH_SCHEMA_CONTRACT_CHANGED');
  if (
    data.format !== 1 ||
    Object.keys(data.profiles || {})
      .sort()
      .join(',') !== 'canonical27,canonical33'
  )
    fail('SWITCH_SCHEMA_CONTRACT_INVALID');
  const a = data.profiles.canonical27,
    b = data.profiles.canonical33;
  if (a.migrations.length !== 27 || b.migrations.length !== 33)
    fail('SWITCH_SCHEMA_CONTRACT_INVALID');
  for (const profile of [a, b])
    if (
      !/^[a-f0-9]{64}$/.test(profile.schemaPrismaSha256 || '') ||
      new Set(profile.migrations.map((m) => m.name)).size !==
        profile.migrations.length
    )
      fail('SWITCH_SCHEMA_CONTRACT_INVALID');
  const old = Object.fromEntries(a.migrations.map((m) => [m.name, m.sha256])),
    next = Object.fromEntries(b.migrations.map((m) => [m.name, m.sha256]));
  if (
    !same(
      a.migrations.map((m) => m.name).sort(),
      Object.keys(OBSERVED_RECEIPTS).sort(),
    )
  )
    fail('SWITCH_SCHEMA_RECEIPT_BASELINE_CHANGED');
  for (const profile of [a, b])
    for (const m of profile.migrations)
      if (m.receiptSha256 !== (OBSERVED_RECEIPTS[m.name] ?? m.sha256))
        fail('SWITCH_SCHEMA_FIXED_RECEIPT_CHANGED');
  if (
    Object.entries(old).some(([name, sha]) => next[name] !== sha) ||
    !same(
      Object.fromEntries(
        Object.entries(next).filter(([name]) => !(name in old)),
      ),
      ADDED_MIGRATIONS,
    )
  )
    fail('SWITCH_SCHEMA_CONTRACT_INVALID');
  return { data, fileSha256: textHash(bytes), sourceIdentity };
}
function bindRoles(roles, contract) {
  validateRoles(roles);
  const bound = {};
  for (const name of ['current', 'candidate', 'rollback']) {
    const role = roles[name],
      declared = migrationFiles(role.manifest),
      selected = Object.entries(contract.data.profiles).find(([, profile]) =>
        same(
          declared,
          Object.fromEntries(profile.migrations.map((m) => [m.name, m.sha256])),
        ),
      );
    if (!selected)
      fail('SWITCH_SCHEMA_ROLE_HISTORY_UNAPPROVED', { role: name });
    if (
      role.manifest.files['server/prisma/schema.prisma'] !==
      selected[1].schemaPrismaSha256
    )
      fail('SWITCH_SCHEMA_ROLE_PRISMA_CHANGED', { role: name });
    if (typeof role.folder !== 'string' || !path.isAbsolute(role.folder))
      fail('SWITCH_SCHEMA_ROLE_PATH_REQUIRED');
    const manifestFile = path.join(role.folder, 'release.json'),
      manifestIdentity = fileSnapshot(manifestFile, {
        maxBytes: 8 * 1024 * 1024,
      }),
      manifestBytes = fs.readFileSync(manifestFile);
    if (
      manifestIdentity.sha256 !== role.manifestSha256 ||
      sha(manifestBytes) !== manifestIdentity.sha256 ||
      !same(JSON.parse(manifestBytes), role.manifest)
    )
      fail('SWITCH_SCHEMA_ROLE_MANIFEST_CHANGED', { role: name });
    const inputs = [];
    for (const m of selected[1].migrations) {
      const file = path.join(
          role.folder,
          'server/prisma/migrations',
          m.name,
          'migration.sql',
        ),
        identity = fileSnapshot(file, { maxBytes: 8 * 1024 * 1024 });
      if (identity.sha256 !== m.sha256)
        fail('SWITCH_SCHEMA_ROLE_SQL_CHANGED', { role: name });
      assertReceiptChecksum(m.name, fs.readFileSync(file), m.receiptSha256);
      inputs.push(identity);
    }
    const schema = fileSnapshot(
      path.join(role.folder, 'server/prisma/schema.prisma'),
      { maxBytes: 8 * 1024 * 1024 },
    );
    if (schema.sha256 !== selected[1].schemaPrismaSha256)
      fail('SWITCH_SCHEMA_ROLE_PRISMA_CHANGED', { role: name });
    bound[name] = {
      profile: selected[0],
      manifestSha256: role.manifestSha256,
      manifestIdentity,
      sourceCommit: role.manifest.sourceCommit,
      sourceHash: role.manifest.sourceHash,
      id: role.manifest.id,
      folder: role.folder,
      inputs,
      schema,
    };
  }
  if (
    bound.candidate.profile !== 'canonical33' ||
    bound.current.profile !== bound.rollback.profile
  )
    fail('SWITCH_SCHEMA_TRANSITION_UNAPPROVED');
  if (
    roles.candidate.manifest.files['switch-schema-contract.json'] !==
    contract.fileSha256
  )
    fail('SWITCH_SCHEMA_PACKAGED_CONTRACT_UNBOUND');
  if (
    !same(roles.candidate.manifest.prewriteSchemaContract, {
      format: 1,
      file: 'switch-schema-contract.json',
      sha256: contract.fileSha256,
      gateSha256: loadedModuleSha256,
    })
  )
    fail('SWITCH_SCHEMA_PACKAGED_CONTRACT_UNBOUND');
  const actual = fileSnapshot(
    path.join(roles.candidate.folder, 'switch-schema-contract.json'),
    { maxBytes: 8 * 1024 * 1024 },
  );
  if (actual.sha256 !== contract.fileSha256)
    fail('SWITCH_SCHEMA_PACKAGED_CONTRACT_CHANGED');
  const dependencies = {};
  for (const [name, expected] of Object.entries({
    'switch-prewrite.cjs': loadedModuleSha256,
    ...loadedDependencies,
  })) {
    if (roles.candidate.manifest.files[name] !== expected)
      fail('SWITCH_SCHEMA_PACKAGED_DEPENDENCY_UNBOUND', { file: name });
    const identity = fileSnapshot(path.join(roles.candidate.folder, name), {
      maxBytes: 8 * 1024 * 1024,
    });
    if (identity.sha256 !== expected)
      fail('SWITCH_SCHEMA_PACKAGED_DEPENDENCY_CHANGED', { file: name });
    dependencies[name] = identity;
  }
  bound.contract = {
    sha256: contract.fileSha256,
    sourceIdentity: contract.sourceIdentity,
    packageFile: actual,
    dependencies,
  };
  return bound;
}
function receiptSnapshot(db, profile) {
  const statement = db.prepare(
    'SELECT id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count FROM main._prisma_migrations ORDER BY migration_name,id',
  );
  statement.setReadBigInts(true);
  const rows = statement.all();
  const expected = new Map(
      profile.migrations.map((m) => [m.name, m.receiptSha256]),
    ),
    seen = new Set(),
    ids = new Set();
  for (const row of rows) {
    const validDate = (value) =>
      typeof value === 'bigint'
        ? value >= 0n
        : typeof value === 'number'
          ? Number.isSafeInteger(value) && value >= 0
          : typeof value === 'string' &&
            value.length > 0 &&
            Number.isFinite(Date.parse(value));
    if (
      typeof row.id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(row.id) ||
      ids.has(row.id) ||
      seen.has(row.migration_name) ||
      expected.get(row.migration_name) !== row.checksum ||
      row.rolled_back_at !== null ||
      !validDate(row.finished_at) ||
      !validDate(row.started_at) ||
      (typeof row.applied_steps_count !== 'bigint' &&
        typeof row.applied_steps_count !== 'number') ||
      BigInt(row.applied_steps_count) !== 1n ||
      row.logs !== null
    )
      fail('SWITCH_SCHEMA_MIGRATION_RECEIPT_INVALID');
    seen.add(row.migration_name);
    ids.add(row.id);
  }
  if (seen.size !== expected.size)
    fail('SWITCH_SCHEMA_MIGRATION_RECEIPT_INVALID');
  return {
    count: rows.length,
    sha256: digest(rows),
    names: [...seen].sort(),
    entries: rows.map((row) => ({
      name: row.migration_name,
      sha256: digest(row),
    })),
  };
}
function inspectSwitchDatabase({
  database,
  roles,
  stage = 'before-migration',
  operationId,
}) {
  if (
    !['before-migration', 'after-migration'].includes(stage) ||
    typeof operationId !== 'string' ||
    !/^[a-zA-Z0-9_-]{16,100}$/.test(operationId)
  )
    fail('SWITCH_SCHEMA_REQUEST_INVALID');
  const { DatabaseSync, runtime: host } = sqliteRuntime(),
    contract = catalog(),
    roleBinding = bindRoles(roles, contract),
    roleName = stage === 'before-migration' ? 'current' : 'candidate',
    profileName = roleBinding[roleName].profile,
    profile = contract.data.profiles[profileName];
  const before = databaseFiles(database);
  let db, schema, history, tasks;
  try {
    db = new DatabaseSync(database, {
      readOnly: true,
      timeout: 10000,
      enableLoadExtension: false,
    });
    db.exec('PRAGMA query_only=ON; BEGIN');
    const databases = all(db, 'PRAGMA database_list');
    if (
      databases.some(
        (row) =>
          row.name !== 'main' || normalized(row.file) !== normalized(database),
      )
    )
      fail('SWITCH_SCHEMA_ATTACHED_DATABASE_FORBIDDEN');
    schema = canonicalSchema(schemaSnapshot(db));
    if (
      !same(
        schema,
        canonicalSchema({ objects: profile.objects, tables: profile.tables }),
      )
    )
      fail('SWITCH_SCHEMA_CANONICAL_MISMATCH', { stage, profile: profileName });
    if (
      !same(all(db, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]) ||
      all(db, 'PRAGMA foreign_key_check').length
    )
      fail('SWITCH_SCHEMA_INTEGRITY_FAILED');
    history = receiptSnapshot(db, profile);
    tasks = taskDocuments.assertTaskDocumentsInConnection(db);
    db.exec('ROLLBACK');
  } finally {
    if (db?.isOpen) db.close();
  }
  const after = databaseFiles(database);
  if (!same(before, after))
    fail('SWITCH_SCHEMA_DATABASE_CHANGED_DURING_INSPECTION');
  const binding = freeze(
    capture({
      database,
      stage,
      operationId,
      host,
      roleBinding,
      profile: profileName,
      schemaSha256: digest(schema),
      history,
      tasks,
      files: after,
    }),
  );
  const proof = freeze({
    format: 1,
    kind: 'switch-canonical-schema-inspection',
    stage,
    operationId,
    profile: profileName,
    schemaSha256: binding.schemaSha256,
    migrationReceiptsSha256: history.sha256,
    taskDocumentsSha256: tasks.documentsSha256,
    host,
    readOnlyBusinessSql: true,
    allWritersStopped: false,
    auxiliaryFilesMayBeUsed: true,
  });
  receipts.set(proof, { binding, issuedAt: performance.now() });
  return proof;
}
function assertSwitchDatabaseUnchanged(
  { database, roles, stage = 'before-migration', operationId },
  proof,
) {
  const original = receipts.get(proof);
  if (
    !original ||
    proof.stage !== stage ||
    performance.now() - original.issuedAt > 120000
  )
    fail('SWITCH_SCHEMA_EVIDENCE_INVALID');
  const current = inspectSwitchDatabase({
      database,
      roles,
      stage,
      operationId,
    }),
    now = receipts.get(current);
  if (!same(original.binding, now.binding))
    fail('SWITCH_SCHEMA_EVIDENCE_CHANGED');
  return current;
}
function assertSwitchTransition(beforeProof, afterProof) {
  const a = receipts.get(beforeProof)?.binding,
    b = receipts.get(afterProof)?.binding;
  if (
    !a ||
    !b ||
    a.stage !== 'before-migration' ||
    b.stage !== 'after-migration' ||
    a.database !== b.database ||
    a.operationId !== b.operationId ||
    !same(a.roleBinding, b.roleBinding) ||
    !same(a.files[0].identity.slice(0, 3), b.files[0].identity.slice(0, 3))
  )
    fail('SWITCH_SCHEMA_TRANSITION_EVIDENCE_INVALID');
  const after = new Map(b.history.entries.map((row) => [row.name, row.sha256]));
  if (a.history.entries.some((row) => after.get(row.name) !== row.sha256))
    fail('SWITCH_SCHEMA_OLD_RECEIPTS_CHANGED');
  return true;
}
// Synthetic DI capability: it can only be issued for a new empty, plain directory.
// It never changes the production entry's unconditional all-writer gate.
function createSyntheticPrewriteScope(root) {
  plainPath(path.join(root, 'scope-placeholder'));
  directoryStamp(root);
  if (fs.readdirSync(root).length) fail('SWITCH_SCHEMA_FIXTURE_NOT_EMPTY');
  const token = {};
  fixtures.set(token, { root, identity: directoryStamp(root) });
  return token;
}
function assertSyntheticPrewriteScope(token, database) {
  const bound = fixtures.get(token);
  if (!bound || !same(bound.identity, directoryStamp(bound.root)))
    fail('SWITCH_SCHEMA_SYNTHETIC_SCOPE_REQUIRED');
  const relative = path.relative(bound.root, database);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    fail('SWITCH_SCHEMA_SYNTHETIC_SCOPE_REQUIRED');
  plainPath(database);
  return bound.root;
}
module.exports = {
  inspectSwitchDatabase,
  assertSwitchDatabaseUnchanged,
  assertSwitchTransition,
  createSyntheticPrewriteScope,
  assertSyntheticPrewriteScope,
};
