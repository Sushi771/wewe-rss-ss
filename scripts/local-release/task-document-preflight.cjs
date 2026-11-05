const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { hostEffects, fileHash } = require('./lib.cjs');
const fs = hostEffects.fs;

const taskTables = ['xhs_subscription_tasks', 'xhs_whole_creator_jobs'];
const states = new Set([
  'queued',
  'running',
  'completed',
  'paused',
  'failed',
  'blocked',
  'partial',
  'cancelled',
]);
const sourceStopStates = new Set([
  'paused',
  'failed',
  'blocked',
  'partial',
  'cancelled',
]);
const batchStates = new Set([
  'queued',
  'running',
  'paused',
  'cancelled',
  'completed',
]);
const batchItemStates = new Set([
  'queued',
  'needs_context',
  'resolving',
  'unknown',
  'subscribed',
  'duplicate',
  'failed',
]);
const rowStates = new Set([
  ...states,
  ...[...batchStates].map((state) => 'batch_' + state),
]);
const issuedEvidence = new WeakMap();
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const quote = (value) => '"' + value.replace(/"/g, '""') + '"';

class TaskDocumentPreflightError extends Error {
  constructor(code, diagnostics) {
    super(
      code +
        ': legacy task documents require review on a protected snapshot; no automatic JSON/state repair was performed',
    );
    this.name = 'TaskDocumentPreflightError';
    this.code = code;
    this.manualReviewRequired = true;
    this.retryAfterReview = true;
    this.diagnostics = diagnostics;
  }
}

// This checks only the persisted identity/state envelope and the source-risk SQL
// inputs. A pass does not establish complete business/runtime compatibility or
// permission to replay any old task. Never return a document or credential.
function diagnoseTaskDocument(row) {
  const bytes =
    row.documentBytes instanceof Uint8Array
      ? Buffer.from(row.documentBytes)
      : Buffer.alloc(0);
  const reasons = [];
  let document;
  if (row.documentType !== 'text') reasons.push('DOCUMENT_STORAGE_NOT_TEXT');
  if (!(row.documentBytes instanceof Uint8Array))
    reasons.push('DOCUMENT_BYTES_UNAVAILABLE');
  if (bytes.length > 16 * 1024 * 1024)
    reasons.push('DOCUMENT_REQUIRES_BOUNDED_MANUAL_REVIEW');
  if (reasons.length === 0) {
    try {
      document = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      );
    } catch {
      reasons.push('DOCUMENT_NOT_STRICT_UTF8_JSON');
    }
  }
  if (row.sqliteJsonValid !== undefined && row.sqliteJsonValid !== 1)
    reasons.push('SQLITE_JSON_INVALID');
  if (row.sqliteDuplicateKeyGroups > 0)
    reasons.push('DOCUMENT_DUPLICATE_OBJECT_KEYS');
  if (document !== undefined) {
    if (!document || Array.isArray(document) || typeof document !== 'object') {
      reasons.push('DOCUMENT_NOT_OBJECT');
    } else {
      const batch =
        row.table === 'xhs_subscription_tasks' &&
        (row.creatorId === '__batch__' ||
          (typeof row.id === 'string' && row.id.startsWith('batch:')));
      if (batch) {
        // The existing batch service stores batchId/state/items, not the
        // single-task taskId/creatorId envelope; its row state has a prefix.
        if (!batchStates.has(document.state))
          reasons.push('DOCUMENT_STATE_UNRECOGNIZED');
        if (row.state !== 'batch_' + document.state)
          reasons.push('DOCUMENT_STATE_MISMATCH');
        if (
          row.creatorId !== '__batch__' ||
          typeof document.batchId !== 'string' ||
          !document.batchId ||
          row.id !== 'batch:' + document.batchId
        )
          reasons.push('DOCUMENT_IDENTITY_MISMATCH');
        if (
          row.sqliteJsonValid === 1 &&
          row.sqliteBatchId !== (document.batchId ?? null)
        )
          reasons.push('JSON_IDENTITY_INTERPRETATION_MISMATCH');
        if (
          !Array.isArray(document.items) ||
          document.items.some(
            (item) =>
              !item ||
              typeof item !== 'object' ||
              Array.isArray(item) ||
              !batchItemStates.has(item.state) ||
              !Number.isSafeInteger(item.index) ||
              item.index < 0 ||
              typeof item.fingerprint !== 'string' ||
              !item.fingerprint ||
              !['note', 'author', 'short', 'invalid'].includes(item.kind) ||
              (item.code !== undefined && typeof item.code !== 'string'),
          )
        )
          reasons.push('BATCH_ITEMS_UNRECOGNIZED');
        if (
          Array.isArray(document.items) &&
          document.items.some(
            (item) =>
              item &&
              typeof item.code === 'string' &&
              /^XHS_SOURCE_.*_BLOCKED$/.test(item.code),
          )
        )
          reasons.push('BATCH_SOURCE_STOP_REQUIRES_REVIEW');
      } else {
        if (!states.has(row.state)) reasons.push('ROW_STATE_UNRECOGNIZED');
        if (!states.has(document.state))
          reasons.push('DOCUMENT_STATE_UNRECOGNIZED');
        if (document.state !== row.state)
          reasons.push('DOCUMENT_STATE_MISMATCH');
        const key = row.table === 'xhs_subscription_tasks' ? 'taskId' : 'id';
        if (typeof row.id !== 'string' || !row.id || document[key] !== row.id)
          reasons.push('DOCUMENT_IDENTITY_MISMATCH');
        if (
          typeof row.creatorId !== 'string' ||
          !row.creatorId ||
          document.creatorId !== row.creatorId
        )
          reasons.push('DOCUMENT_CREATOR_MISMATCH');
        if (
          row.sqliteJsonValid === 1 &&
          (row.table === 'xhs_subscription_tasks'
            ? row.sqliteTaskId
            : row.sqliteId) !== (document[key] ?? null)
        )
          reasons.push('JSON_IDENTITY_INTERPRETATION_MISMATCH');
        if (
          row.sqliteJsonValid === 1 &&
          row.sqliteCreatorId !== (document.creatorId ?? null)
        )
          reasons.push('JSON_CREATOR_INTERPRETATION_MISMATCH');
      }
      if (
        row.sqliteJsonValid === 1 &&
        row.sqliteState !== (document.state ?? null)
      )
        reasons.push('JSON_STATE_INTERPRETATION_MISMATCH');
      if (
        document.code !== undefined &&
        document.code !== null &&
        typeof document.code !== 'string'
      )
        reasons.push('DOCUMENT_CODE_UNRECOGNIZED');
      if (row.sqliteJsonType !== undefined && row.sqliteJsonType !== 'object')
        reasons.push('SQLITE_DOCUMENT_NOT_OBJECT');
      if (
        row.sqliteJsonValid === 1 &&
        row.sqliteCode !== (document.code ?? null)
      )
        reasons.push('JSON_CODE_INTERPRETATION_MISMATCH');
      // The historical SQL deliberately consults only these stopped states.
      // An otherwise recognizable document must not hide a source stop in a
      // completed/running row and thereby initialize source risk to clear.
      if (
        typeof document.code === 'string' &&
        /^XHS_SOURCE_.*_BLOCKED$/.test(document.code) &&
        !sourceStopStates.has(row.state)
      )
        reasons.push('SOURCE_STOP_STATE_REQUIRES_REVIEW');
    }
  }
  return {
    table: row.table,
    idSha256: digest(
      Buffer.from(typeof row.id === 'string' ? row.id : '<unrecognized-id>'),
    ),
    documentSha256: digest(bytes),
    documentBytes: bytes.length,
    storageType: ['text', 'blob', 'null', 'integer', 'real'].includes(
      row.documentType,
    )
      ? row.documentType
      : 'unrecognized',
    state: rowStates.has(row.state) ? row.state : 'unrecognized',
    reasons: [...new Set(reasons)],
  };
}

function assertTaskDocumentsInConnection(connection) {
  const report = {
    format: 1,
    status: 'passed',
    readOnly: true,
    checkedRows: 0,
    checkedTables: {},
    issueCount: 0,
    issues: [],
    ioBoundary:
      'Business SQL is read-only; SQLite may use/create SHM/WAL auxiliary files. This is not an OS-wide zero-write guarantee. A stable snapshot and the writer gate remain required.',
    compatibility:
      'Only JSON syntax, object envelope, identity/state and historical source-risk inputs were checked; task replay/business compatibility is not established',
  };
  const documents = crypto.createHash('sha256');
  for (const table of taskTables) {
    const object = connection
      .prepare('SELECT type FROM sqlite_master WHERE name=?')
      .get(table);
    if (!object) {
      report.checkedTables[table] = { present: false, rows: 0 };
      continue;
    }
    if (object.type !== 'table') {
      report.issueCount++;
      report.issues.push({ table, reasons: ['TASK_SCHEMA_UNRECOGNIZED'] });
      continue;
    }
    const columns = connection
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => row.name);
    if (
      !['id', 'creator_id', 'state', 'document'].every((name) =>
        columns.includes(name),
      )
    ) {
      report.issueCount++;
      report.issues.push({ table, reasons: ['TASK_SCHEMA_UNRECOGNIZED'] });
      continue;
    }
    let count = 0;
    // CASE, rather than a WHERE/AND evaluation-order assumption, protects every
    // json_extract/json_type from malformed input. Read all rows, including
    // completed rows which the historical source-risk predicate does not visit.
    const statement = connection.prepare(`SELECT id,creator_id,state,
      typeof(document) AS document_type,CAST(document AS BLOB) AS document_bytes,
      json_valid(document) AS sqlite_json_valid,
      CASE WHEN json_valid(document) THEN json_type(document) END AS sqlite_json_type,
      CASE WHEN json_valid(document) THEN json_extract(document,'$.code') END AS sqlite_code,
      CASE WHEN json_valid(document) THEN json_extract(document,'$.state') END AS sqlite_state,
      CASE WHEN json_valid(document) THEN json_extract(document,'$.taskId') END AS sqlite_task_id,
      CASE WHEN json_valid(document) THEN json_extract(document,'$.id') END AS sqlite_id,
      CASE WHEN json_valid(document) THEN json_extract(document,'$.creatorId') END AS sqlite_creator_id,
      CASE WHEN json_valid(document) THEN json_extract(document,'$.batchId') END AS sqlite_batch_id,
      CASE WHEN json_valid(document) THEN
        CASE WHEN length(CAST(document AS BLOB)) <= 16777216 THEN
          (SELECT count(*) FROM
            (SELECT parent,key FROM json_tree(document)
             WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*) > 1))
        END
      END AS sqlite_duplicate_key_groups
      FROM ${quote(table)} ORDER BY id`);
    for (const row of statement.iterate()) {
      const diagnostic = diagnoseTaskDocument({
        table,
        id: row.id,
        creatorId: row.creator_id,
        state: row.state,
        documentType: row.document_type,
        documentBytes: row.document_bytes,
        sqliteJsonValid: row.sqlite_json_valid,
        sqliteJsonType: row.sqlite_json_type,
        sqliteCode: row.sqlite_code,
        sqliteState: row.sqlite_state,
        sqliteTaskId: row.sqlite_task_id,
        sqliteId: row.sqlite_id,
        sqliteCreatorId: row.sqlite_creator_id,
        sqliteBatchId: row.sqlite_batch_id,
        sqliteDuplicateKeyGroups: row.sqlite_duplicate_key_groups,
      });
      documents.update(JSON.stringify(diagnostic));
      count++;
      report.checkedRows++;
      if (diagnostic.reasons.length) {
        report.issueCount++;
        if (report.issues.length < 20) report.issues.push(diagnostic);
      }
    }
    report.checkedTables[table] = { present: true, rows: count };
  }
  report.documentsSha256 = documents.digest('hex');
  if (report.issueCount) {
    report.status = 'blocked';
    throw new TaskDocumentPreflightError(
      'XHS_TASK_DOCUMENT_REVIEW_REQUIRED',
      report,
    );
  }
  return report;
}

function databaseIdentity(database) {
  database = fs.realpathSync(database);
  const files = [database, database + '-wal', database + '-journal'].map(
    (file) => {
      try {
        const before = fs.statSync(file, { bigint: true });
        if (!before.isFile() || !before.ino)
          throw new Error('DATABASE_IDENTITY_UNPROVED');
        const sha256 = fileHash(file);
        const after = fs.statSync(file, { bigint: true });
        const fields = (stat) =>
          [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(
            String,
          );
        if (JSON.stringify(fields(before)) !== JSON.stringify(fields(after)))
          throw new Error('DATABASE_CHANGED_DURING_IDENTITY_READ');
        return { file, identity: fields(after), sha256 };
      } catch (error) {
        if (file !== database && error.code === 'ENOENT') return null;
        throw error;
      }
    },
  );
  return { database, files };
}

function assertTaskDocumentsForMigration(database) {
  let connection;
  try {
    const before = databaseIdentity(database);
    const { DatabaseSync } = require('node:sqlite');
    connection = new DatabaseSync(before.database, {
      readOnly: true,
      timeout: 10000,
    });
    connection.exec('PRAGMA query_only=ON; BEGIN');
    let evidence, rejected;
    try {
      evidence = assertTaskDocumentsInConnection(connection);
    } catch (error) {
      if (!(error instanceof TaskDocumentPreflightError)) throw error;
      rejected = error;
    }
    connection.close();
    connection = undefined;
    const after = databaseIdentity(database);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new TaskDocumentPreflightError(
        'XHS_TASK_DOCUMENT_SNAPSHOT_CHANGED',
        {
          status: 'blocked',
          reasons: ['DATABASE_CHANGED_DURING_READ_ONLY_PREFLIGHT'],
        },
      );
    if (rejected) {
      rejected.diagnostics.databaseIdentity = after;
      rejected.diagnostics.stableSnapshotVerified = true;
      throw rejected;
    }
    evidence.databaseIdentity = after;
    evidence.stableSnapshotVerified = true;
    // The same in-process evidence object must be revalidated immediately before
    // migration. A caller-supplied boolean or deserialized audit cannot authorize it.
    issuedEvidence.set(evidence, JSON.stringify(after));
    return evidence;
  } catch (error) {
    if (error instanceof TaskDocumentPreflightError) throw error;
    throw new TaskDocumentPreflightError(
      'XHS_TASK_DOCUMENT_PREFLIGHT_UNAVAILABLE',
      {
        status: 'blocked',
        reasons: ['READ_ONLY_INSPECTION_FAILED'],
        causeCode:
          typeof error.code === 'string'
            ? error.code
            : 'UNRECOGNIZED_DATABASE_OR_SCHEMA',
      },
    );
  } finally {
    if (connection?.isOpen) connection.close();
  }
}

function assertTaskDocumentPreflightUnchanged(database, evidence) {
  const original =
    evidence && typeof evidence === 'object' && issuedEvidence.get(evidence);
  if (!original)
    throw new TaskDocumentPreflightError('XHS_TASK_DOCUMENT_EVIDENCE_INVALID', {
      status: 'blocked',
      reasons: ['FRESH_IN_PROCESS_PREFLIGHT_REQUIRED'],
    });
  const current = assertTaskDocumentsForMigration(database);
  if (
    original !== JSON.stringify(current.databaseIdentity) ||
    evidence.documentsSha256 !== current.documentsSha256
  )
    throw new TaskDocumentPreflightError('XHS_TASK_DOCUMENT_SNAPSHOT_CHANGED', {
      status: 'blocked',
      reasons: ['DATABASE_CHANGED_AFTER_PREFLIGHT'],
    });
  return current;
}

module.exports = {
  TaskDocumentPreflightError,
  diagnoseTaskDocument,
  assertTaskDocumentsInConnection,
  assertTaskDocumentsForMigration,
  assertTaskDocumentPreflightUnchanged,
};
