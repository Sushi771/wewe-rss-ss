const path = require('node:path');

function actualEngineCommit(file, load = require) {
  const commit = load(path.resolve(file)).version().commit;
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error('Native Prisma engine version is invalid');
  return commit;
}

function sqliteRuntimeUrl(database) {
  // A single process-wide connection serializes deferred transaction upgrades.
  // Multiple SQLite pool connections can deadlock on read -> write promotion,
  // which the pinned 5.10 engine incorrectly maps to a Rust panic.
  return 'file:' + database.replace(/\\/g, '/') + '?connection_limit=1';
}

module.exports = { actualEngineCommit, sqliteRuntimeUrl };
