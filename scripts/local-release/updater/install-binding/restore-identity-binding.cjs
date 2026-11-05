'use strict';
// Opaque in-process receipts, not a JSON flag or a new update protocol.
const fs = require('node:fs'),
  crypto = require('node:crypto');
const { createSqliteHooks } = require('../sqlite-hooks.cjs');
const fail = (code) => {
  throw Error(code);
};
function identity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n)
    fail('RESTORE_DATABASE_NOT_PLAIN');
  return [s.dev, s.ino, s.birthtimeNs].map(String).join(':');
}
function createRestoreIdentityBinding({
  claim,
  dataRoot,
  python,
  assertAllWritersStopped,
  verifyRestoredDatabase,
}) {
  for (const method of [
    'assertMaintenanceOwnership',
    'assertDatabaseRestoreAuthorized',
    'verifyStopReceipt',
    'authorizeDatabaseReplacement',
    'rebindDatabaseIdentity',
  ])
    if (typeof claim?.[method] !== 'function')
      fail('LIVE_RESTORE_MAINTENANCE_CLAIM_REQUIRED');
  if (
    typeof assertAllWritersStopped !== 'function' ||
    typeof verifyRestoredDatabase !== 'function'
  )
    fail('RESTORE_VERIFIERS_REQUIRED');
  const receipts = new WeakMap();
  const own = async (ctx) => {
    if (
      (await claim.assertMaintenanceOwnership(ctx)) === false ||
      (await claim.assertDatabaseRestoreAuthorized(ctx)) === false
    )
      fail('RESTORE_MAINTENANCE_AUTHORITY_LOST');
  };
  async function stopped(ctx) {
    await own(ctx);
    const proof = await assertAllWritersStopped(ctx);
    if (
      !proof ||
      proof.allWritersStopped !== true ||
      proof.transactionId !== ctx.transactionId ||
      proof.databaseIdentity !== identity(ctx.old.database) ||
      (await claim.verifyStopReceipt(proof, ctx)) !== true
    )
      fail('LIVE_STOP_RECEIPT_REQUIRED');
    return true;
  }
  const sqlite = createSqliteHooks({
    dataRoot,
    python,
    assertWritersStopped: stopped,
  });
  return {
    async restore(ctx) {
      await stopped(ctx);
      const oldIdentity = identity(ctx.old.database);
      const permit = await claim.authorizeDatabaseReplacement({
        transactionId: ctx.transactionId,
        database: ctx.old.database,
        oldIdentity,
        backupSha256: ctx.backup?.sha256,
      });
      if (!permit || typeof permit !== 'object')
        fail('LIVE_REPLACEMENT_PERMIT_REQUIRED');
      await sqlite.restoreDatabase(ctx);
      await own(ctx);
      const newIdentity = identity(ctx.old.database),
        checked = await verifyRestoredDatabase(ctx);
      if (
        !checked ||
        checked.integrity !== 'ok' ||
        checked.oldSchemaMatched !== true ||
        checked.databaseIdentity !== newIdentity ||
        checked.backupSha256 !== ctx.backup.sha256
      )
        fail('RESTORED_DATABASE_PROOF_REQUIRED');
      await own(ctx);
      if (identity(ctx.old.database) !== newIdentity)
        fail('RESTORED_IDENTITY_CHANGED');
      const receipt = Object.freeze({});
      receipts.set(receipt, {
        permit,
        transactionId: ctx.transactionId,
        database: ctx.old.database,
        oldIdentity,
        newIdentity,
        backupSha256: ctx.backup.sha256,
      });
      return receipt;
    },
    async rebind(receipt, ctx) {
      const bound = receipts.get(receipt);
      if (
        !bound ||
        bound.transactionId !== ctx.transactionId ||
        bound.database !== ctx.old.database ||
        bound.newIdentity !== identity(ctx.old.database) ||
        bound.backupSha256 !== ctx.backup?.sha256
      )
        fail('OPAQUE_RESTORE_RECEIPT_REQUIRED');
      await own(ctx);
      const proof = await claim.rebindDatabaseIdentity(bound.permit, {
        ...bound,
        permit: undefined,
      });
      if (
        !proof ||
        proof.databaseIdentity !== bound.newIdentity ||
        proof.transactionId !== ctx.transactionId ||
        proof.allWritersStopped !== true ||
        (await claim.verifyStopReceipt(proof, ctx)) !== true
      )
        fail('REBOUND_STOP_PROOF_REQUIRED');
      if (identity(ctx.old.database) !== bound.newIdentity)
        fail('RESTORED_IDENTITY_CHANGED');
      receipts.delete(receipt);
      return {
        databaseRestored: true,
        identityRebound: true,
        oldIdentity: bound.oldIdentity,
        newIdentity: bound.newIdentity,
      };
    },
  };
}
module.exports = { createRestoreIdentityBinding, identity };
