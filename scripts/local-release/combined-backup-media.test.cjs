const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const native = require('./startup-sqlite.cjs');
const budget = require('./space-budget.cjs');
const { cleanEnvironment } = require('./lib.cjs');

test(
  'combined startup audit allocates no copy; required preparation creates one protected point reused by lifecycle',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'combined-startup-owned-'),
    );
    t.after(() => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert(path.basename(root).startsWith('combined-startup-owned-'));
      fs.rmSync(root, { recursive: true });
    });
    const settings = {
      SQLITE_BACKUP_KIND: 'test',
      SQLITE_TEST_MAX_BYTES: String(16 * 1024 ** 2),
      SQLITE_TEST_MAX_COPIES: '12',
      SQLITE_TEST_MIN_FREE_BYTES: '1',
      SQLITE_PRODUCTION_LEGACY_ROOTS: '[]',
      SQLITE_PERIODIC_LIFECYCLE_ENABLED: '1',
      SQLITE_PERIODIC_RETENTION_ENABLED: '0',
      SQLITE_PERIODIC_RETENTION_COPIES: '3',
      SQLITE_SNAPSHOT_INTERVAL_SECONDS: '86400',
      SQLITE_SNAPSHOT_MAX_AGE_SECONDS: '86400',
      WECHAT2RSS_CACHE_MEDIA: '0',
      WEWE_SAVED_MEDIA_ROOT: path.join(root, 'owned-assets'),
      WEWE_SAVED_MEDIA_MANIFEST_SHA256: 'a'.repeat(64),
    };
    for (const [key, value] of Object.entries(settings)) {
      const old = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (old === undefined) delete process.env[key];
        else process.env[key] = old;
      });
    }
    const inherited = cleanEnvironment();
    for (const key of [
      'SQLITE_PERIODIC_LIFECYCLE_ENABLED',
      'WEWE_SAVED_MEDIA_ROOT',
      'WEWE_SAVED_MEDIA_MANIFEST_SHA256',
      'WECHAT2RSS_CACHE_MEDIA',
    ])
      assert.equal(inherited[key], settings[key]);
    const database = path.join(root, 'source.db'),
      backups = path.join(root, 'backups');
    fs.mkdirSync(backups);
    const migrations = path.resolve(
      __dirname,
      '../../apps/server/prisma/migrations',
    );
    const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
    execFileSync(
      python,
      [
        path.join(__dirname, 'synthetic-sqlite.py'),
        '--database',
        database,
        '--migrations',
        migrations,
      ],
      {
        windowsHide: true,
        timeout: 15000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    const audit = native.auditCurrentDatabase(
      database,
      migrations,
      path.join(root, 'audit.json'),
    );
    assert.equal(audit.integrity, 'ok');
    assert.equal(audit.tables.articles.sha256, undefined);
    assert.equal(budget.usage(backups).databases, 0);
    const prepared = await native.prepareStart(
      database,
      migrations,
      backups,
      path.join(root, 'prepared.json'),
    );
    assert.equal(prepared.backup.reused, false);
    assert.equal(prepared.backup.recoveryOrigin.kind, 'protected');
    assert.equal(budget.usage(backups).databases, 1);
    const output = execFileSync(
      python,
      [
        path.resolve(
          __dirname,
          '../../apps/server/scripts/sqlite-snapshot-guard.py',
        ),
        '--database',
        database,
        '--backup-root',
        backups,
        '--interval-seconds',
        '86400',
        '--max-age-seconds',
        '86400',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        input: '{"id":1,"operation":"query"}\n',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    const rows = output
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(
      rows.find((row) => row.event === 'periodic-snapshot-status').ok,
      true,
    );
    assert.equal(rows.find((row) => row.id === 1).result.fresh, true);
    const ownerFile = fs
      .readdirSync(backups)
      .find((name) => name.startsWith('snapshot-owner-'));
    const owner = JSON.parse(
      fs.readFileSync(path.join(backups, ownerFile), 'utf8'),
    );
    assert.equal(owner.backupReused, true);
    assert.equal(owner.backup, prepared.backup.backup);
    assert.equal(budget.usage(backups).databases, 1);
    const stateFile = fs
      .readdirSync(backups)
      .find((name) => /^\.periodic-lifecycle-.*\.json$/.test(name));
    const state = JSON.parse(
      fs.readFileSync(path.join(backups, stateFile), 'utf8'),
    ).payload;
    assert.equal(state.status, 'ready');
    assert.equal(state.normal.length, 0);
    assert.equal(state.pending, null);
  },
);
