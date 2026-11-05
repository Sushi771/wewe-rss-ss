'use strict';
// System adapter only; reuse the existing update transaction and SQLite hooks.
// Importing does not open a DB or enable production. No CLI.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { createSqliteHooks } = require('../sqlite-hooks.cjs');
const {
  createRestoreIdentityBinding,
  identity: databaseIdentity,
} = require('./restore-identity-binding.cjs');
const existingPrewrite = require('./role-aware/switch-prewrite.cjs');
const hash = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (code) => {
  throw Error(code);
};
const synthetic = new WeakMap();
function createSyntheticScope(root) {
  root = fs.realpathSync(root);
  if (fs.readdirSync(root).length) fail('SYNTHETIC_ROOT_NOT_EMPTY');
  const stat = fs.statSync(root),
    token = {};
  synthetic.set(token, { root, dev: stat.dev, ino: stat.ino });
  return token;
}
function createMigrationRecovery({
  dataRoot,
  python,
  host,
  roles,
  syntheticScope,
  prewrite = existingPrewrite,
}) {
  for (const method of [
    'assertMaintenance',
    'assertAllWritersStopped',
    'verifyStopReceipt',
    'verifyFixedRelease',
    'runPinnedMigration',
  ])
    if (typeof host?.[method] !== 'function')
      fail('TRUSTED_MAINTENANCE_HOST_REQUIRED');
  const fixture = synthetic.get(syntheticScope);
  if (!fixture && prewrite !== existingPrewrite)
    fail('PRODUCTION_PREWRITE_REPLACEMENT_FORBIDDEN');
  const before = new Map();
  async function guard(ctx) {
    const db = fs.realpathSync(ctx.old.database);
    if (fixture) {
      const stat = fs.statSync(fixture.root);
      if (
        stat.dev !== fixture.dev ||
        stat.ino !== fixture.ino ||
        !db.startsWith(fixture.root + path.sep)
      )
        fail('SYNTHETIC_SCOPE_CHANGED');
    } else {
      if (
        typeof host.claim?.check !== 'function' ||
        typeof host.claim?.assertDatabaseRestoreAuthorized !== 'function'
      )
        fail('PRODUCTION_DATABASE_RESTORE_NOT_AUTHORIZED');
      if (
        (await host.claim.check()) === false ||
        (await host.claim.assertDatabaseRestoreAuthorized({
          database: db,
          transactionId: ctx.transactionId,
        })) === false
      )
        fail('PRODUCTION_DATABASE_RESTORE_NOT_AUTHORIZED');
    }
    if ((await host.assertMaintenance(ctx)) === false)
      fail('MAINTENANCE_CONTEXT_LOST');
    for (const identity of [ctx.old, ctx.package]) {
      if (
        typeof identity.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(identity.id) ||
        !/^[a-f0-9]{64}$/.test(identity.sha256 || '') ||
        !path.isAbsolute(identity.path || '')
      )
        fail('REAL_FIXED_RELEASE_REQUIRED');
      const manifestFile = fixture
        ? identity.path
        : path.join(identity.path, 'release.json');
      if (hash(manifestFile) !== identity.sha256)
        fail('RELEASE_MANIFEST_CHANGED');
      const verified = await host.verifyFixedRelease(identity);
      if (
        !verified ||
        verified.id !== identity.id ||
        verified.sha256 !== identity.sha256
      )
        fail('FIXED_RELEASE_IDENTITY_CHANGED');
    }
    const receipt = await host.assertAllWritersStopped(ctx);
    if (
      !receipt ||
      receipt.database !== db ||
      receipt.transactionId !== ctx.transactionId ||
      receipt.allWritersStopped !== true ||
      (await host.verifyStopReceipt(receipt, ctx)) !== true
    )
      fail('ALL_WRITER_STOP_RECEIPT_REQUIRED');
    return db;
  }
  const sqlite = createSqliteHooks({
    dataRoot,
    python,
    assertWritersStopped: async (ctx) => {
      await guard(ctx);
      return true;
    },
  });
  const request = (ctx, stage) => ({
    database: ctx.old.database,
    roles,
    stage,
    operationId: ctx.transactionId,
  });
  let identityBridge;
  const bridge = () =>
    (identityBridge ??= createRestoreIdentityBinding({
      claim: host.claim,
      dataRoot,
      python,
      assertAllWritersStopped: (ctx) => host.assertAllWritersStopped(ctx),
      verifyRestoredDatabase: async (ctx) => {
        // This is derived from the real schema/integrity inspector, not caller JSON.
        prewrite.inspectSwitchDatabase(request(ctx, 'before-migration'));
        return {
          integrity: 'ok',
          oldSchemaMatched: true,
          databaseIdentity: databaseIdentity(ctx.old.database),
          backupSha256: ctx.backup.sha256,
        };
      },
    }));
  return {
    async backup(ctx) {
      await guard(ctx);
      bridge();
      const proof = prewrite.inspectSwitchDatabase(
        request(ctx, 'before-migration'),
      );
      const backup = await sqlite.backup(ctx);
      if (hash(backup.path) !== backup.sha256)
        fail('BACKUP_CHANGED_AFTER_CREATION');
      prewrite.assertSwitchDatabaseUnchanged(
        request(ctx, 'before-migration'),
        proof,
      );
      before.set(ctx.transactionId, proof);
      return backup;
    },
    async migrate(ctx) {
      await guard(ctx);
      if (!ctx.backup || hash(ctx.backup.path) !== ctx.backup.sha256)
        fail('PINNED_BACKUP_REQUIRED');
      const proof = before.get(ctx.transactionId);
      if (!proof) fail('PREWRITE_RECEIPT_REQUIRED');
      prewrite.assertSwitchDatabaseUnchanged(
        request(ctx, 'before-migration'),
        proof,
      );
      await host.runPinnedMigration(ctx); // Host executes only the verified package's existing migration entry.
      await guard(ctx);
      const after = prewrite.inspectSwitchDatabase(
        request(ctx, 'after-migration'),
      );
      prewrite.assertSwitchTransition(proof, after);
    },
    async restoreDatabase(ctx) {
      await guard(ctx);
      const recovery = bridge();
      const receipt = await recovery.restore(ctx);
      const result = await recovery.rebind(receipt, ctx);
      await guard(ctx);
      return result;
    },
  };
}
module.exports = { createMigrationRecovery, createSyntheticScope };
