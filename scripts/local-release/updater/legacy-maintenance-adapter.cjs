'use strict';
// Explicit acquisition only. Importing performs no process, DB or lease operation.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { identity } = require('./install-binding/restore-identity-binding.cjs');
const schema = require('./install-binding/role-aware/switch-prewrite.cjs');
const {
  validateRoles,
} = require('./install-binding/role-aware/switch-contract.cjs');
const fail = (code) => {
  throw Error(code);
};
const stamp = (file) => {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n)
    fail('MAINTENANCE_INPUT_NOT_PLAIN');
  return [s.dev, s.ino, s.birthtimeNs, s.size, s.mtimeNs, s.ctimeNs]
    .map(String)
    .join(':');
};
function hashFile(file) {
  const h = crypto.createHash('sha256'),
    fd = fs.openSync(file, 'r'),
    b = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const n = fs.readSync(fd, b, 0, b.length, null);
      if (!n) break;
      h.update(b.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}
function createLegacyMaintenance({
  database,
  dataRoot,
  roles,
  scopeLease,
  writerGate,
  checkpoint,
  observe,
}) {
  for (const method of ['check', 'assertWritable', 'legacyMaintenanceBoundary'])
    if (typeof scopeLease?.[method] !== 'function')
      fail('REAL_SCOPE_LEASE_REQUIRED');
  if (
    typeof writerGate?.acquireMaintenance !== 'function' ||
    typeof observe !== 'function'
  )
    fail('REAL_MAINTENANCE_ENTRY_REQUIRED');
  if (
    !roles?.current?.manifestSha256 ||
    !roles?.candidate?.manifestSha256 ||
    !roles?.rollback?.manifestSha256
  )
    fail('FIXED_ROLES_REQUIRED');
  validateRoles(roles);
  database = fs.realpathSync.native(database);
  dataRoot = fs.realpathSync.native(dataRoot);
  if (checkpoint?.scopeLease !== scopeLease)
    fail('SAME_SCOPE_CHECKPOINT_REQUIRED');
  const originalIdentity = identity(database),
    stops = new WeakMap(),
    permits = new WeakMap(),
    backups = new Map();
  let lease, boundary;
  function check() {
    if (!lease) fail('LIVE_MAINTENANCE_NOT_ACQUIRED');
    scopeLease.assertWritable(['restart', 'switch']);
    scopeLease.check(true);
    lease.check();
    boundary.check();
    if (identity(database) !== originalIdentity)
      fail('MAINTENANCE_DATABASE_IDENTITY_CHANGED');
    return true;
  }
  function context(ctx) {
    check();
    if (
      (ctx.old
        ? ctx.old.database !== database ||
          ctx.old.sha256 !== roles.current.manifestSha256 ||
          ctx.package?.sha256 !== roles.candidate.manifestSha256
        : ctx.database !== database) ||
      typeof ctx.transactionId !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(ctx.transactionId)
    )
      fail('MAINTENANCE_TRANSACTION_BINDING_CHANGED');
    return true;
  }
  function stopped(ctx) {
    context(ctx);
    boundary.observe();
    check();
    const proof = Object.freeze({
      database,
      transactionId: ctx.transactionId,
      databaseIdentity: identity(database),
      allWritersStopped: true,
    });
    stops.set(proof, {
      transactionId: ctx.transactionId,
      identity: proof.databaseIdentity,
    });
    return proof;
  }
  function verify(proof, ctx) {
    const b = stops.get(proof);
    if (
      !b ||
      b.transactionId !== ctx.transactionId ||
      b.identity !== identity(database)
    )
      return false;
    stopped(ctx);
    return true;
  }
  function backup(ctx) {
    context(ctx);
    if (!ctx.backup) return; // Initial authorization precedes snapshot creation.
    const expected = path.join(
      dataRoot,
      'update-backups',
      ctx.transactionId,
      'before.sqlite',
    );
    if (
      path.resolve(ctx.backup.path) !== expected ||
      fs.realpathSync.native(expected) !== expected ||
      !/^[a-f0-9]{64}$/.test(ctx.backup.sha256 || '')
    )
      fail('EXACT_TRANSACTION_BACKUP_REQUIRED');
    const before = stamp(expected),
      cached = backups.get(ctx.transactionId);
    if (cached) {
      if (cached.stamp !== before || cached.sha256 !== ctx.backup.sha256)
        fail('RESTORE_BACKUP_CHANGED');
      return;
    }
    if (hashFile(expected) !== ctx.backup.sha256)
      fail('RESTORE_BACKUP_HASH_CHANGED');
    schema.inspectSwitchDatabase({
      database: expected,
      roles,
      stage: 'before-migration',
      operationId: ctx.transactionId,
    });
    if (stamp(expected) !== before) fail('RESTORE_BACKUP_CHANGED');
    backups.set(ctx.transactionId, {
      path: expected,
      stamp: before,
      sha256: ctx.backup.sha256,
    });
  }
  const claim = {
    check,
    assertMaintenanceOwnership: (ctx) => context(ctx),
    assertDatabaseRestoreAuthorized(ctx) {
      context(ctx);
      backup(ctx);
      return true;
    },
    verifyStopReceipt: verify,
    authorizeDatabaseReplacement(binding) {
      check();
      const b = backups.get(binding.transactionId);
      if (
        !b ||
        binding.database !== database ||
        binding.oldIdentity !== originalIdentity ||
        binding.backupSha256 !== b.sha256 ||
        stamp(b.path) !== b.stamp
      )
        fail('VERIFIED_RESTORE_BACKUP_REQUIRED');
      const permit = Object.freeze({});
      permits.set(permit, { ...binding });
      return permit;
    },
    rebindDatabaseIdentity(permit, binding) {
      check();
      const approved = permits.get(permit);
      if (
        !approved ||
        approved.database !== binding.database ||
        approved.transactionId !== binding.transactionId ||
        approved.backupSha256 !== binding.backupSha256 ||
        approved.oldIdentity !== binding.oldIdentity ||
        binding.newIdentity !== originalIdentity
      )
        fail('OPAQUE_SAME_IDENTITY_RESTORE_REQUIRED');
      const ctx = {
        transactionId: binding.transactionId,
        old: { database, sha256: roles.current.manifestSha256 },
        package: { sha256: roles.candidate.manifestSha256 },
      };
      const proof = stopped(ctx);
      permits.delete(permit);
      return proof;
    },
  };
  return {
    claim,
    assertAllWritersStopped: stopped,
    verifyStopReceipt: verify,
    acquire() {
      if (lease) fail('MAINTENANCE_ALREADY_ACQUIRED');
      scopeLease.assertWritable(['restart', 'switch']);
      scopeLease.check(true);
      boundary = scopeLease.legacyMaintenanceBoundary(
        checkpoint.identity,
        observe,
      );
      lease = writerGate.acquireMaintenance(database, checkpoint);
      check();
      return true;
    },
    close() {
      if (!lease) fail('LIVE_MAINTENANCE_NOT_ACQUIRED');
      scopeLease.assertWritable(['restart', 'switch']);
      scopeLease.check(true);
      lease.check();
      lease.close();
      lease = undefined;
    },
  };
}
module.exports = { createLegacyMaintenance };
