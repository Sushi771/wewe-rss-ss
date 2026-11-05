'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// Installed host owns writer exclusion. This helper supplies actual SQLite
// backup/restore, instead of treating an application restart as data recovery.
function createSqliteHooks({ dataRoot, python, assertWritersStopped }) {
  if (
    !path.isAbsolute(dataRoot) ||
    !path.isAbsolute(python) ||
    typeof assertWritersStopped !== 'function'
  )
    throw new Error('SQLITE_UPDATE_BINDINGS_REQUIRED');
  const root = fs.realpathSync(dataRoot);
  const checked = (file) => {
    if (typeof file !== 'string' || !path.isAbsolute(file))
      throw new Error('DATABASE_PATH_REQUIRED');
    const relative = path.relative(root, path.resolve(file));
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
      throw new Error('DATABASE_PATH_OUTSIDE_DATA_ROOT');
    return path.resolve(file);
  };
  async function call(operation, source, target, digest) {
    const args = [
      path.join(__dirname, 'sqlite-update.py'),
      operation,
      '--root',
      root,
      '--source',
      checked(source),
    ];
    if (target) args.push('--target', checked(target));
    if (digest) args.push('--expected-sha256', digest);
    const result = await execute(python, args, {
      windowsHide: true,
      timeout: 75000,
      maxBuffer: 64 * 1024,
    });
    return JSON.parse(result.stdout);
  }
  return {
    async backup(context) {
      if ((await assertWritersStopped(context)) === false)
        throw new Error('DATABASE_WRITERS_NOT_STOPPED');
      if (!/^[a-f0-9-]{36}$/.test(context.transactionId))
        throw new Error('INVALID_UPDATE_TRANSACTION');
      const target = path.join(
        root,
        'update-backups',
        context.transactionId,
        'before.sqlite',
      );
      const receipt = await call('backup', context.old.database, target);
      return { path: target, sha256: receipt.sha256, bytes: receipt.bytes };
    },
    async restoreDatabase(context) {
      if ((await assertWritersStopped(context)) === false)
        throw new Error('DATABASE_WRITERS_NOT_STOPPED');
      if (
        !context.backup ||
        !/^[a-f0-9]{64}$/.test(context.backup.sha256 || '')
      )
        throw new Error('VERIFIED_BACKUP_REQUIRED');
      await call(
        'restore',
        context.backup.path,
        context.old.database,
        context.backup.sha256,
      );
      return { databaseRestored: true };
    },
  };
}

module.exports = { createSqliteHooks };
