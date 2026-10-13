// Fail closed; this module never removes historical data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name}`);
  return value;
}
function canonical(value) {
  let target = path.resolve(value),
    tail = [];
  while (!fs.existsSync(target)) {
    tail.unshift(path.basename(target));
    target = path.dirname(target);
  }
  return path.join(fs.realpathSync.native(target), ...tail);
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}
function legacyRoots() {
  if (process.env.SQLITE_BACKUP_KIND === 'test') return [];
  const roots = JSON.parse(process.env.SQLITE_PRODUCTION_LEGACY_ROOTS || '[]');
  if (
    !Array.isArray(roots) ||
    roots.some((value) => typeof value !== 'string' || !path.isAbsolute(value))
  )
    throw new Error('Invalid SQLITE_PRODUCTION_LEGACY_ROOTS');
  return roots.map((value) => canonical(value));
}
function usage(root) {
  let bytes = 0,
    databases = 0;
  const allowed = legacyRoots(),
    visited = new Set(),
    files = new Set();
  function visit(directory) {
    const target = fs.realpathSync.native(directory);
    if (visited.has(target))
      throw new Error('Nested or repeated backup directory refused');
    visited.add(target);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync.native(file);
        if (
          !fs.statSync(file).isDirectory() ||
          !allowed.some((folder) => inside(folder, resolved))
        )
          throw new Error(
            'SQLITE_BACKUP_LAYOUT_REQUIRES_REVIEW: refuses links ' + file,
          );
      }
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file);
      else {
        const resolved = fs.realpathSync.native(file);
        if (files.has(resolved)) continue;
        files.add(resolved);
        bytes += stat.size;
        if (/\.(db|sqlite|sqlite3)$/i.test(file)) databases++;
      }
    }
  }
  if (fs.existsSync(root)) visit(root);
  return { bytes, databases };
}
function estimate(database) {
  return (
    [database, database + '-wal'].reduce(
      (sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0),
      0,
    ) *
      2 +
    1024 * 1024
  );
}
function preflight(root, bytes, copies = 1, database) {
  root = canonical(root);
  if (database && inside(root, canonical(database)))
    throw new Error('Nested source/destination refused');
  let parent = root;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const test = process.env.SQLITE_BACKUP_KIND === 'test';
  const prefix = test ? 'SQLITE_TEST' : 'SQLITE_PRODUCTION';
  const maxBytes = positive(
    prefix + '_MAX_BYTES',
    test ? 512 * 1024 ** 2 : 32 * 1024 ** 3,
  );
  const maxCopies = positive(prefix + '_MAX_COPIES', test ? 12 : 48);
  const minFree = positive(
    prefix + '_MIN_FREE_BYTES',
    test ? 256 * 1024 ** 2 : 4 * 1024 ** 3,
  );
  const current = usage(root);
  const disk = fs.statfsSync(parent, { bigint: true });
  const free = Number(disk.bavail * disk.bsize);
  const allowed =
    current.bytes + bytes <= maxBytes &&
    current.databases + copies <= maxCopies &&
    free - bytes >= minFree;
  if (!test && fs.existsSync(root)) {
    const snapshotBytes = Math.max(
      1,
      Math.floor(Math.max(0, bytes - 1024 ** 2) / 2),
    );
    const more = Math.max(
      0,
      Math.min(
        maxCopies - current.databases,
        Math.floor((maxBytes - current.bytes - bytes) / snapshotBytes) + 1,
        Math.floor((free - minFree - bytes) / snapshotBytes) + 1,
      ),
    );
    replaceJson(path.join(root, '.space-budget-status.json'), {
      nextBackupAllowed: allowed,
      warning:
        !allowed ||
        current.bytes / maxBytes >= 0.5 ||
        current.databases / maxCopies >= 0.5 ||
        more / 96 < 1,
      estimatedDaysAtContinuousChanges: Math.round((more / 96) * 100) / 100,
      recordedAt: new Date().toISOString(),
    });
  }
  if (
    current.bytes + bytes > maxBytes ||
    current.databases + copies > maxCopies ||
    free - bytes < minFree
  )
    throw new Error(
      `SQLITE_SPACE_BUDGET_EXCEEDED: root=${root}, existingBytes=${current.bytes}, existingCopies=${current.databases}, requestedBytes=${bytes}, freeBytes=${free}. Review recovery points manually; nothing was deleted.`,
    );
  return {
    root,
    ...current,
    requestedBytes: bytes,
    freeBytes: free,
    maxBytes,
    maxCopies,
    minFree,
  };
}
function lease(root, name = '.space-budget.lock') {
  root = canonical(root);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx');
  } catch (error) {
    throw new Error(
      'Space budget is locked; review interrupted owner before retrying: ' +
        file,
      { cause: error },
    );
  }
  fs.writeFileSync(
    descriptor,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(file);
  };
}
function reuseFile(root, database) {
  return path.join(
    root,
    '.latest-' +
      crypto.createHash('sha256').update(database).digest('hex').slice(0, 24) +
      '.json',
  );
}
function sourceHashes(database) {
  return [database, database + '-wal'].map((file) => {
    if (!fs.existsSync(file)) return null;
    const digest = crypto.createHash('sha256'),
      buffer = Buffer.alloc(1024 * 1024);
    const descriptor = fs.openSync(file, 'r');
    try {
      let read;
      while (
        (read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0
      )
        digest.update(buffer.subarray(0, read));
    } finally {
      fs.closeSync(descriptor);
    }
    return digest.digest('hex');
  });
}
function replaceJson(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temporary, file);
}
function productionRoot(database) {
  const configured = process.env.SQLITE_PRODUCTION_BACKUP_ROOT;
  if (
    configured &&
    (!path.isAbsolute(configured) || /[\0\r\n]/.test(configured))
  )
    throw new Error('SQLite backup root must be an absolute local path');
  return canonical(configured || path.join(path.dirname(database), 'backups'));
}
module.exports = {
  productionRoot,
  positive,
  canonical,
  inside,
  usage,
  estimate,
  preflight,
  lease,
  reuseFile,
  sourceHashes,
  replaceJson,
};
