'use strict';

// Filesystem journal and orchestration only. Host adapters must provide genuine
// process exclusion, writer quiescence, consistent SQLite backup and restoration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIRED = [
  'acquireLock',
  'verifyPackage',
  'currentInstallation',
  'stopOld',
  'backup',
  'migrate',
  'startNew',
  'health',
  'activateNew',
  'stopNew',
  'restoreDatabase',
  'activateOld',
  'startOld',
  'oldHealth',
  'enableNew',
];
const STAGES = new Set([
  'verified',
  'stopping',
  'backing-up',
  'migrating',
  'starting',
  'checking',
  'activating',
  'completed',
  'recovering',
  'recovered',
  'recovery-failed',
]);

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Never delete the previous journal before replacement.
  fs.renameSync(temp, file);
}

function readJournal(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('UPDATE_JOURNAL_INVALID');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    j.format !== 1 ||
    !/^[a-f0-9-]{36}$/.test(j.transactionId) ||
    !STAGES.has(j.stage) ||
    !j.package ||
    !/^[a-f0-9]{64}$/.test(j.package.sha256) ||
    typeof j.package.id !== 'string' ||
    !j.old ||
    typeof j.old.id !== 'string'
  )
    throw new Error('UPDATE_JOURNAL_INVALID');
  return j;
}

function createUpdater({ journalFile, adapter, onProgress = () => {} }) {
  if (!path.isAbsolute(journalFile))
    throw new Error('ABSOLUTE_JOURNAL_REQUIRED');
  for (const name of REQUIRED)
    if (typeof adapter[name] !== 'function')
      throw new Error('MISSING_ADAPTER_' + name);
  // Host hooks conventionally throw, but a number of system probes return a
  // boolean. Explicit failure must never be accepted as successful quiescence,
  // restoration or health. Undefined remains a valid successful effect result.
  const invoke = async (name, ...args) => {
    const result = await adapter[name](...args);
    if (result === false) throw new Error('ADAPTER_FAILED_' + name);
    return result;
  };
  let localBusy = false;
  const persist = (j, stage, extra = {}) => {
    const next = { ...j, ...extra, stage, updatedAt: new Date().toISOString() };
    atomicWrite(journalFile, next);
    Object.assign(j, next);
    // UI reporting cannot invalidate a committed transition.
    try {
      onProgress({ stage, transactionId: j.transactionId });
    } catch {}
  };
  const context = (j) => ({
    transactionId: j.transactionId,
    package: j.package,
    old: j.old,
    backup: j.backup,
    journalFile,
  });

  async function recover(j) {
    if (j.stage === 'completed') {
      // Commit point has passed. Database rollback is forbidden from here.
      const actual = await invoke('currentInstallation');
      if (actual?.id !== j.package.id || actual?.sha256 !== j.package.sha256)
        throw new Error('COMMITTED_INSTALLATION_MISMATCH');
      await invoke('enableNew', context(j));
      return j;
    }
    if (j.stage === 'recovered') return j;
    const stopMayHaveRun = j.stage !== 'verified';
    if (!stopMayHaveRun) {
      persist(j, 'recovered', { recovered: true, databaseRestored: false });
      return j;
    }
    persist(j, 'recovering');
    const c = context(j);
    try {
      // Must be idempotent, locate this transaction's process across updater
      // restarts, and prove it has exited before restoration can proceed.
      await invoke('stopNew', c);
      // A prior recovery may have crashed after restarting the old process.
      // Quiesce that process too before retrying a database restoration.
      await invoke('stopOld', c);
      if (j.backup) {
        // Restore to a fresh file, verify, then replace while ALL writers are
        // stopped. Adapter must handle SQLite WAL/SHM and be restart-safe.
        await invoke('restoreDatabase', c);
      }
      await invoke('activateOld', c);
      await invoke('startOld', c);
      await invoke('oldHealth', c);
      persist(j, 'recovered', {
        recovered: true,
        databaseRestored: Boolean(j.backup),
      });
      return j;
    } catch (error) {
      persist(j, 'recovery-failed', {
        recoveryError: error.code || error.message,
      });
      const failure = new Error('UPDATE_RECOVERY_FAILED');
      failure.cause = error;
      failure.journal = j;
      throw failure;
    }
  }

  async function exclusive(fn) {
    if (localBusy) return { status: 'busy' };
    localBusy = true;
    let release;
    try {
      // Host lock must cover normal startup, update and recovery. It must reject
      // active owners and allow proven dead owners to recover after interruption.
      release = await adapter.acquireLock({ journalFile });
      if (!release) return { status: 'busy' };
      if (typeof release !== 'function') throw new Error('INVALID_UPDATE_LOCK');
      return await fn();
    } finally {
      try {
        if (typeof release === 'function') await release();
      } finally {
        localBusy = false;
      }
    }
  }

  return {
    recover: () =>
      exclusive(async () => {
        const j = readJournal(journalFile);
        if (!j) return { status: 'idle' };
        try {
          await recover(j);
        } catch (error) {
          if (j.stage === 'completed')
            return {
              status: 'completed-start-pending',
              journal: j,
              error: error.code || error.message,
            };
          throw error;
        }
        return { status: j.stage, journal: j };
      }),
    update: (request) =>
      exclusive(async () => {
        if (
          !request ||
          typeof request.path !== 'string' ||
          !/^[a-f0-9]{64}$/.test(request.sha256 || '')
        )
          throw new Error('FIXED_PACKAGE_DIGEST_REQUIRED');
        let prior = readJournal(journalFile);
        if (prior && !['completed', 'recovered'].includes(prior.stage)) {
          await recover(prior);
          // Recovery is its own visible outcome. Do not immediately stop the
          // restored application for another attempt after a crash.
          return { status: 'recovered', journal: prior };
        }
        const pkg = await invoke('verifyPackage', request);
        if (!pkg || typeof pkg.id !== 'string' || pkg.sha256 !== request.sha256)
          throw new Error('PACKAGE_VERIFICATION_FAILED');
        const old = await invoke('currentInstallation');
        if (!old || typeof old.id !== 'string')
          throw new Error('OLD_INSTALLATION_REQUIRED');
        if (prior?.stage === 'completed') {
          if (
            old.id !== prior.package.id ||
            old.sha256 !== prior.package.sha256
          )
            throw new Error('COMMITTED_INSTALLATION_MISMATCH');
          try {
            await invoke('enableNew', context(prior));
          } catch (error) {
            return {
              status: 'completed-start-pending',
              journal: prior,
              error: error.code || error.message,
            };
          }
          if (prior.package.sha256 === pkg.sha256)
            return { status: 'already-current', journal: prior };
        }
        if (old.sha256 === pkg.sha256) return { status: 'already-current' };
        const j = {
          format: 1,
          transactionId: crypto.randomUUID(),
          package: pkg,
          old,
          createdAt: new Date().toISOString(),
        };
        persist(j, 'verified');
        try {
          persist(j, 'stopping');
          await invoke('stopOld', context(j));
          persist(j, 'backing-up');
          const backup = await invoke('backup', context(j));
          if (
            !backup ||
            typeof backup.path !== 'string' ||
            !/^[a-f0-9]{64}$/.test(backup.sha256 || '')
          )
            throw new Error('DURABLE_BACKUP_REQUIRED');
          // Save recovery identity before the first database mutation.
          persist(j, 'migrating', { backup });
          await invoke('migrate', context(j));
          persist(j, 'starting');
          await invoke('startNew', context(j));
          persist(j, 'checking');
          await invoke('health', context(j));
          persist(j, 'activating');
          await invoke('activateNew', context(j));
          persist(j, 'completed', { recovered: false });
        } catch (error) {
          persist(j, j.stage, { updateError: error.code || error.message });
          await recover(j);
          return {
            status: 'failed-recovered',
            error: j.updateError,
            journal: j,
          };
        }
        // activateNew only publishes the pointer. New business writes are enabled
        // after the durable commit, and an enable failure must NEVER restore DB.
        try {
          await invoke('enableNew', context(j));
          return { status: 'completed', journal: j };
        } catch (error) {
          return {
            status: 'completed-start-pending',
            journal: j,
            error: error.code || error.message,
          };
        }
      }),
  };
}

module.exports = { createUpdater, readJournal, atomicWrite };
