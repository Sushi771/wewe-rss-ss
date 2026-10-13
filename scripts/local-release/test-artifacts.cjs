// Bounded offline runs. Existing sources and unregistered interrupted files stay untouched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const budget = require('./space-budget.cjs');
const sqlite = /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i;
const manifestName = 'run-manifest.json';
function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error('Run lifecycle refuses links');
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birth: String(stat.birthtimeNs),
  };
}
function equalIdentity(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function scan(audit) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Run lifecycle refuses links');
      if (entry.isDirectory()) visit(file);
      else if (sqlite.test(entry.name)) files.push(file);
    }
  }
  visit(audit);
  return files;
}
function save(audit, manifest) {
  budget.replaceJson(path.join(audit, manifestName), manifest);
}
function removeRegistered(audit, manifest) {
  const removed = [],
    retained = [];
  // Validate every path and identity before deleting any file.
  for (const entry of manifest.files) {
    const file = path.resolve(audit, entry.path);
    if (!budget.inside(audit, file) || file === audit || !sqlite.test(file))
      throw new Error('Invalid run manifest file');
    if (!fs.existsSync(file)) continue;
    if (
      budget.canonical(file) !== file ||
      !equalIdentity(identity(file), entry.identity)
    )
      throw new Error(
        'Registered run file identity changed; preserved for review',
      );
    removed.push(file);
  }
  const known = new Set(removed);
  for (const file of scan(audit))
    if (!known.has(file)) retained.push(path.relative(audit, file));
  for (const file of removed) fs.unlinkSync(file);
  return { removed: removed.length, retained };
}
function restoreEnvironment(kind, root) {
  if (kind === undefined) delete process.env.SQLITE_BACKUP_KIND;
  else process.env.SQLITE_BACKUP_KIND = kind;
  if (root === undefined) delete process.env.SQLITE_TEST_BUDGET_ROOT;
  else process.env.SQLITE_TEST_BUDGET_ROOT = root;
}
function runLease(root, owner) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, '.test-run.lock'),
    bytes = Buffer.from(JSON.stringify(owner));
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  } catch (error) {
    throw new Error(
      'Space budget is locked; review interrupted owner before retrying: ' +
        file,
      { cause: error },
    );
  }
  return () => {
    if (!fs.readFileSync(file).equals(bytes))
      throw new Error('Run lock ownership changed; preserved for review');
    fs.unlinkSync(file);
  };
}
function begin({
  outputRoot,
  source,
  realCopy = false,
  migrations,
  legacy = false,
  keep = false,
  prepared = false,
}) {
  const root = budget.canonical(
    process.env.WEWE_TEST_OUTPUT_ROOT ||
      path.join(os.tmpdir(), 'wewe-rss-tests'),
  );
  const output = budget.canonical(outputRoot || root);
  if (!budget.inside(root, output))
    throw new Error(
      'Output root must be inside WEWE_TEST_OUTPUT_ROOT; all windows must share this managed root',
    );
  if (source && !realCopy)
    throw new Error(
      'Real SQLite sources require --real-copy / realCopy: true; omit the source for synthetic tests',
    );
  if (realCopy && !source)
    throw new Error('Real-copy mode requires an explicit source');
  if (source && budget.inside(root, budget.canonical(source)) && !prepared)
    throw new Error(
      'Nested test copies refused; use prepared fixture mode instead',
    );
  const previousKind = process.env.SQLITE_BACKUP_KIND;
  const previousRoot = process.env.SQLITE_TEST_BUDGET_ROOT;
  process.env.SQLITE_BACKUP_KIND = 'test';
  process.env.SQLITE_TEST_BUDGET_ROOT = root;
  let unlock,
    released = false;
  const release = () => {
    try {
      if (unlock && !released) {
        released = true;
        unlock();
      }
    } finally {
      restoreEnvironment(previousKind, previousRoot);
    }
  };
  try {
    const requestedBytes = source
      ? budget.estimate(source) * 8 + 16 * 1024 ** 2
      : 16 * 1024 ** 2;
    budget.preflight(root, requestedBytes, 8);
    const runId = crypto.randomUUID();
    const audit = path.join(output, 'run-' + runId);
    const lock = {
      format: 1,
      runId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      audit,
      token: crypto.randomUUID(),
    };
    unlock = runLease(root, lock);
    const planned = budget.preflight(root, requestedBytes, 8);
    // Refuse linked output layouts while holding the shared root lease.
    if (budget.canonical(output) !== output)
      throw new Error('Output layout changed');
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(audit);
    const database = source
      ? fs.realpathSync.native(source)
      : path.join(audit, 'synthetic.db');
    const manifest = {
      format: 1,
      runId,
      root,
      audit,
      owner: lock,
      directoryIdentity: identity(audit),
      synthetic: !source,
      keep: Boolean(keep),
      state: 'creating',
      files: [],
      budget: planned,
    };
    // Publish ownership before generating any database. No original source path is stored.
    save(audit, manifest);
    let finished = false;
    const checkpoint = () => {
      if (finished) throw new Error('Run already finished');
      if (
        budget.canonical(audit) !== audit ||
        !equalIdentity(identity(audit), manifest.directoryIdentity)
      )
        throw new Error('Run directory identity changed; preserve for review');
      const previous = new Map(
        manifest.files.map((entry) => [entry.path, entry.identity]),
      );
      manifest.files = scan(audit).map((file) => {
        const relative = path.relative(audit, file),
          current = identity(file);
        if (
          previous.has(relative) &&
          !equalIdentity(previous.get(relative), current)
        )
          throw new Error('Registered run file identity changed');
        return { path: relative, identity: current };
      });
      manifest.state = 'running';
      save(audit, manifest);
    };
    const finish = (error) => {
      if (finished) return;
      let cleanup = { removed: 0, retained: [] },
        cleanupError;
      try {
        checkpoint();
        if (keep) {
          try {
            budget.preflight(root, 0, 0);
          } catch (failure) {
            cleanup = removeRegistered(audit, manifest);
            throw failure;
          }
        } else cleanup = removeRegistered(audit, manifest);
        manifest.state = keep ? 'retained' : 'finished';
      } catch (failure) {
        cleanupError = failure;
        manifest.state = 'review-required';
      } finally {
        finished = true;
        try {
          manifest.failure =
            (error?.message || cleanupError?.message || '').slice(0, 4096) ||
            null;
          if (
            budget.canonical(audit) !== audit ||
            !equalIdentity(identity(audit), manifest.directoryIdentity)
          )
            throw new Error(
              'Run directory identity changed; preserve for review',
            );
          save(audit, manifest);
          fs.writeFileSync(
            path.join(audit, 'space-summary.json'),
            JSON.stringify(
              {
                synthetic: !source,
                retained: Boolean(keep || cleanupError),
                removedSyntheticFiles: cleanup.removed,
                retainedUnregisteredFiles: cleanup.retained,
                failure: manifest.failure,
                budget: planned,
                usage: cleanupError ? null : budget.usage(audit),
              },
              null,
              2,
            ),
          );
        } finally {
          release();
        }
      }
      if (cleanupError) throw cleanupError;
    };
    try {
      if (!source)
        execFileSync(
          process.env.SQLITE_BACKUP_PYTHON || 'python',
          [
            path.join(__dirname, 'synthetic-sqlite.py'),
            '--database',
            database,
            '--migrations',
            migrations,
            ...(legacy ? ['--legacy'] : []),
          ],
          {
            windowsHide: true,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          },
        );
      checkpoint();
    } catch (error) {
      finish(error);
      throw error;
    }
    return {
      root,
      audit,
      database,
      finish,
      checkpoint,
      backupEnvironment: {
        SQLITE_BACKUP_KIND: 'test',
        SQLITE_TEST_BUDGET_ROOT: root,
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
function recover({ root, audit, confirmChildrenStopped = false }) {
  root = budget.canonical(root);
  audit = path.resolve(audit);
  if (!confirmChildrenStopped)
    throw new Error(
      'Recovery requires explicit confirmation that this run children have stopped',
    );
  if (
    !budget.inside(root, audit) ||
    audit === root ||
    budget.canonical(audit) !== audit
  )
    throw new Error('Recovery refuses outside or linked audit');
  const lockFile = path.join(root, '.test-run.lock');
  const lockBytes = fs.readFileSync(lockFile);
  const lock = JSON.parse(lockBytes);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(audit, manifestName), 'utf8'),
  );
  if (
    manifest.format !== 1 ||
    manifest.audit !== audit ||
    manifest.root !== root ||
    JSON.stringify(manifest.owner) !== JSON.stringify(lock) ||
    !equalIdentity(identity(audit), manifest.directoryIdentity)
  )
    throw new Error('Run ownership mismatch; nothing removed');
  if (!['creating', 'running'].includes(manifest.state) || manifest.keep)
    throw new Error('Only interrupted disposable runs may be recovered');
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0)
    throw new Error('Invalid owner PID');
  try {
    process.kill(lock.pid, 0);
    throw new Error(
      'Owner PID is active or reused; recovery refused without killing it',
    );
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  // Separate recovery lease prevents two recovering windows from deleting concurrently.
  const unlock = budget.lease(root, '.test-recovery.lock');
  try {
    if (!fs.readFileSync(lockFile).equals(lockBytes))
      throw new Error('Owner lock changed; nothing removed');
    const cleanup = removeRegistered(audit, manifest);
    manifest.state = cleanup.retained.length ? 'review-required' : 'recovered';
    manifest.recovery = cleanup;
    save(audit, manifest);
    fs.writeFileSync(
      path.join(audit, 'space-summary.json'),
      JSON.stringify(
        {
          synthetic: manifest.synthetic,
          failure: 'interrupted owner recovered',
          removedSyntheticFiles: cleanup.removed,
          retainedUnregisteredFiles: cleanup.retained,
        },
        null,
        2,
      ),
    );
    // Retain the owner lease on unknown files pending manual review.
    if (cleanup.retained.length)
      throw new Error(
        'Unregistered SQLite files preserved; owner lock retained for review',
      );
    if (!fs.readFileSync(lockFile).equals(lockBytes))
      throw new Error('Owner lock changed; retained for review');
    fs.unlinkSync(lockFile);
    return cleanup;
  } finally {
    unlock();
  }
}
module.exports = { begin, recover };
