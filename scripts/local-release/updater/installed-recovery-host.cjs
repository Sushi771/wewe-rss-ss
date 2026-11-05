'use strict';
// Composition only. No maintenance authority, registry or observation is minted.
const { createInstalledHost } = require('./installed-host.cjs');
const {
  createMigrationRecovery,
} = require('./install-binding/migration-recovery.cjs');
function createRecoveryInstalledHost({
  recoveryHost,
  roles,
  python,
  ...bindings
}) {
  for (const method of [
    'check',
    'assertMaintenanceOwnership',
    'assertDatabaseRestoreAuthorized',
    'verifyStopReceipt',
    'authorizeDatabaseReplacement',
    'rebindDatabaseIdentity',
  ])
    if (typeof recoveryHost?.claim?.[method] !== 'function')
      throw Error('LIVE_RECOVERY_MAINTENANCE_AUTHORITY_REQUIRED');
  if (!roles?.current || !roles?.candidate || !roles?.rollback)
    throw Error('FIXED_RECOVERY_ROLES_REQUIRED');
  if (Object.hasOwn(bindings, 'sqliteHooks'))
    throw Error('RECOVERY_HOOK_REPLACEMENT_FORBIDDEN');
  const sqliteHooks = createMigrationRecovery({
    dataRoot: bindings.dataRoot,
    python,
    host: recoveryHost,
    roles,
  });
  return createInstalledHost({ ...bindings, sqliteHooks });
}
module.exports = { createRecoveryInstalledHost };
