const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const budget = require('./space-budget.cjs');
test('snapshot forecast validates daily and 15-minute intervals without permissive parsing', () => {
  assert.equal(budget.snapshotInterval('900'), 900);
  assert.equal(budget.snapshotInterval('86400'), 86400);
  for (const value of [
    '0',
    '59',
    '86401',
    '+900',
    '900.0',
    '900\n',
    'NaN',
    ' 900',
  ])
    assert.throws(() => budget.snapshotInterval(value), /POLICY_INVALID/);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-space-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('wewe-space-test-'));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
const migrations = path.resolve(
  __dirname,
  '../../apps/server/prisma/migrations',
);
function env(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
}
test('Node and Python forecasts use configured 900/86400 cadence and retain the same hard ceilings', (t) => {
  const root = fixture(t),
    database = path.join(root, 'source.db'),
    backups = path.join(root, 'backups');
  fs.writeFileSync(database, 'owned size-only forecast fixture');
  fs.mkdirSync(backups);
  env(t, {
    SQLITE_BACKUP_KIND: 'production',
    SQLITE_PRODUCTION_MAX_COPIES: '48',
    SQLITE_PRODUCTION_MAX_BYTES: String(32 * 1024 ** 3),
    SQLITE_PRODUCTION_MIN_FREE_BYTES: '1',
    SQLITE_PRODUCTION_LEGACY_ROOTS: '[]',
    SQLITE_SNAPSHOT_INTERVAL_SECONDS: '900',
  });
  const forecasts = [];
  for (const interval of ['900', '86400']) {
    process.env.SQLITE_SNAPSHOT_INTERVAL_SECONDS = interval;
    const limits = budget.preflight(
      backups,
      budget.estimate(database),
      1,
      database,
    );
    assert.equal(limits.maxCopies, 48);
    assert.equal(limits.maxBytes, 32 * 1024 ** 3);
    const node = JSON.parse(
      fs.readFileSync(path.join(backups, '.space-budget-status.json')),
    );
    const python = JSON.parse(
      execFileSync(
        'python',
        [
          path.resolve(
            __dirname,
            '../../apps/server/scripts/backup-space-status.py',
          ),
          '--database',
          database,
          '--backup-root',
          backups,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(
      node.continuousChangedSnapshotIntervalSeconds,
      Number(interval),
    );
    assert.equal(
      python.continuousChangedSnapshotIntervalSeconds,
      Number(interval),
    );
    assert.equal(
      node.estimatedDaysAtContinuousChanges,
      python.estimatedDaysAtContinuousChanges,
    );
    assert.match(node.forecastBasis, /unchanged/);
    forecasts.push(node);
  }
  assert.equal(
    forecasts[1].estimatedDaysAtContinuousChanges,
    forecasts[0].estimatedDaysAtContinuousChanges * 96,
  );
  assert.equal(forecasts[0].warning, true);
  assert.equal(forecasts[1].warning, false);
});
