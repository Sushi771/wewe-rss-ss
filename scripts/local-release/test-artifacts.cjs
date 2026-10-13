// One bounded offline run. Only synthetic files created by this run are disposable.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const budget = require('./space-budget.cjs');
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
    outputRoot ||
      process.env.WEWE_TEST_OUTPUT_ROOT ||
      path.join(os.tmpdir(), 'wewe-rss-tests'),
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
  let unlock;
  try {
    const requestedBytes = source
      ? budget.estimate(source) * 8 + 16 * 1024 ** 2
      : 16 * 1024 ** 2;
    budget.preflight(root, requestedBytes, 8);
    unlock = budget.lease(root);
    const planned = budget.preflight(root, requestedBytes, 8);
    const audit = path.join(root, 'run-' + crypto.randomUUID());
    fs.mkdirSync(audit);
    const database = source
      ? fs.realpathSync(source)
      : path.join(audit, 'synthetic.db');
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      try {
        let removed = 0;
        if (!source && !keep) {
          const clean = (directory) => {
            for (const item of fs.readdirSync(directory, {
              withFileTypes: true,
            })) {
              const file = path.join(directory, item.name);
              if (item.isSymbolicLink()) continue;
              if (item.isDirectory()) clean(file);
              else if (
                /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/.test(item.name)
              ) {
                fs.unlinkSync(file);
                removed++;
              }
            }
          };
          clean(audit);
        }
        fs.writeFileSync(
          path.join(audit, 'space-summary.json'),
          JSON.stringify(
            {
              synthetic: !source,
              retained: Boolean(source || keep),
              removedSyntheticFiles: removed,
              failure: error?.message || null,
              budget: planned,
              usage: budget.usage(audit),
            },
            null,
            2,
          ),
        );
      } finally {
        unlock();
        if (previousKind === undefined) delete process.env.SQLITE_BACKUP_KIND;
        else process.env.SQLITE_BACKUP_KIND = previousKind;
        if (previousRoot === undefined)
          delete process.env.SQLITE_TEST_BUDGET_ROOT;
        else process.env.SQLITE_TEST_BUDGET_ROOT = previousRoot;
      }
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
    } catch (error) {
      finish(error);
      throw error;
    }
    return {
      root,
      audit,
      database,
      finish,
      backupEnvironment: {
        SQLITE_BACKUP_KIND: 'test',
        SQLITE_TEST_BUDGET_ROOT: root,
      },
    };
  } catch (error) {
    if (unlock && fs.existsSync(path.join(root, '.space-budget.lock')))
      unlock();
    if (previousKind === undefined) delete process.env.SQLITE_BACKUP_KIND;
    else process.env.SQLITE_BACKUP_KIND = previousKind;
    if (previousRoot === undefined) delete process.env.SQLITE_TEST_BUDGET_ROOT;
    else process.env.SQLITE_TEST_BUDGET_ROOT = previousRoot;
    throw error;
  }
}
module.exports = { begin };
