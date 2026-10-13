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
  return path.join(fs.realpathSync(target), ...tail);
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
function usage(root) {
  let bytes = 0,
    databases = 0;
  if (!fs.existsSync(root)) return { bytes, databases };
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isSymbolicLink())
      throw new Error('Space budget refuses links: ' + file);
    if (item.isDirectory()) {
      const nested = usage(file);
      bytes += nested.bytes;
      databases += nested.databases;
    } else {
      bytes += fs.statSync(file).size;
      if (/\.(db|sqlite|sqlite3)$/i.test(file)) databases++;
    }
  }
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
    test ? 512 * 1024 ** 2 : 64 * 1024 ** 3,
  );
  const maxCopies = positive(prefix + '_MAX_COPIES', test ? 12 : 32);
  const minFree = positive(
    prefix + '_MIN_FREE_BYTES',
    test ? 256 * 1024 ** 2 : 2 * 1024 ** 3,
  );
  const current = usage(root);
  const disk = fs.statfsSync(parent, { bigint: true });
  const free = Number(disk.bavail * disk.bsize);
  if (
    current.bytes + bytes > maxBytes ||
    current.databases + copies > maxCopies ||
    free - bytes < minFree
  )
    throw new Error(
      `Space budget exceeded: root=${root}, existingBytes=${current.bytes}, existingCopies=${current.databases}, requestedBytes=${bytes}, freeBytes=${free}. Review recovery points manually; nothing was deleted.`,
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
function lease(root) {
  root = canonical(root);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, '.space-budget.lock');
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
module.exports = {
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
