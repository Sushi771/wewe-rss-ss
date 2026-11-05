'use strict';
// Shared by normal runtime startup and the updater. This module does not open
// SQLite or stop processes. The release builder pins it in release.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function install({ release, manifest, database, environment = process.env }) {
  const metadata = manifest.installedLifecycle;
  if (
    metadata?.protocol !== 'wewe-installed-lifecycle-v1' ||
    !/^[A-Za-z0-9_.-]+$/.test(metadata.journalBasename || '')
  )
    throw Error('FIXED_STARTUP_JOURNAL_REQUIRED');
  const journalFile = path.join(
    path.dirname(fs.realpathSync.native(database)),
    metadata.journalBasename,
  );
  const lockFile = journalFile + '.startup-lock',
    permitFile = journalFile + '.permit';
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(release, 'release.json')))
    .digest('hex');
  const transactionId = environment.WEWE_UPDATE_TRANSACTION;
  const lease = environment.WEWE_UPDATE_LEASE;
  if (fs.existsSync(lockFile)) {
    const owner = read(lockFile);
    if (!transactionId || !lease || owner.token !== lease)
      throw Error('STARTUP_BLOCKED_BY_UPDATE');
    const j = read(journalFile);
    if (
      j.transactionId !== transactionId ||
      ![j.package, j.old].some(
        (p) => p?.id === manifest.id && p.sha256 === sha256,
      )
    )
      throw Error('UPDATE_STARTUP_RELEASE_MISMATCH');
  } else if (transactionId || lease) throw Error('UPDATE_STARTUP_LEASE_LOST');
  function permitAllowsWrites() {
    if (!fs.existsSync(journalFile)) return !fs.existsSync(lockFile);
    const j = read(journalFile);
    if (!['completed', 'recovered'].includes(j.stage)) return false;
    const selected = j.stage === 'completed' ? j.package : j.old;
    if (selected?.id !== manifest.id || selected.sha256 !== sha256)
      return false;
    if (!fs.existsSync(permitFile)) return false;
    const p = read(permitFile);
    return (
      p.transactionId === j.transactionId &&
      p.id === manifest.id &&
      p.sha256 === sha256 &&
      p.stage === j.stage
    );
  }
  let databaseReady = !transactionId,
    writerApi,
    realWriter;
  function writerPermitted() {
    if (!permitAllowsWrites()) return false;
    if (writerApi && !realWriter) {
      try {
        realWriter = writerApi.acquireWriter(database);
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    }
    realWriter?.check();
    return true;
  }
  function writesAllowed() {
    return writerPermitted() && databaseReady;
  }
  function waitUntilPermitted() {
    if (writerPermitted()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        try {
          if (writerPermitted()) {
            clearInterval(timer);
            resolve(true);
          }
        } catch {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
      timer.unref();
    });
  }
  function holdWriterGate(api) {
    if (writerApi || typeof api?.acquireWriter !== 'function')
      throw Error('UPDATE_WRITER_HOLD_INVALID');
    writerApi = api;
    const deferred = Object.freeze({
      check() {
        if (permitAllowsWrites()) {
          if (!writerPermitted())
            throw Error('UPDATE_WRITER_LEASE_NOT_RELEASED');
        } else if (realWriter) throw Error('UPDATE_WRITER_PERMISSION_LOST');
      },
    });
    const acquireWriter = (file) => {
      if (fs.realpathSync.native(file) !== fs.realpathSync.native(database))
        throw Error('UPDATE_WRITER_DATABASE_CHANGED');
      deferred.check();
      return deferred;
    };
    const facade = Object.freeze({
      ...api,
      acquireWriter,
      writerForUrl(url, base = process.cwd()) {
        if (typeof url !== 'string' || !url.startsWith('file:'))
          return undefined;
        return acquireWriter(
          path.resolve(base, decodeURIComponent(url.slice(5).split('?')[0])),
        );
      },
    });
    globalThis[Symbol.for('wewe.project-writer-api.v1')] = facade;
    return facade;
  }
  function waitUntilEnabled() {
    if (writesAllowed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        try {
          if (writesAllowed()) {
            clearInterval(timer);
            resolve(true);
          }
        } catch {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
      timer.unref();
    });
  }
  const gate = {
    journalFile,
    writesAllowed,
    waitUntilEnabled,
    waitUntilPermitted,
    holdWriterGate,
    markDatabaseWritable() {
      if (!writerPermitted())
        throw Error('UPDATE_DATABASE_ENABLE_NOT_PERMITTED');
      databaseReady = true;
    },
    health(databaseReadable) {
      return {
        transactionId,
        id: manifest.id,
        sha256,
        database,
        readOnly: !writesAllowed(),
        databaseReadable: databaseReadable === true,
        httpReady: true,
      };
    },
  };
  globalThis[Symbol.for('wewe.installed-startup-gate.v1')] = gate;
  return gate;
}
module.exports = { install };
