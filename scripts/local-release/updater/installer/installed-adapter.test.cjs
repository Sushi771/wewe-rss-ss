'use strict';

// Real host/controller/update-engine and SQLite hooks, synthetic process effects.
// Fixture allowlists authorize only new temporary files created by this test.
// They are never installation authority for an application or a production DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createInstalledHost } = require('../installed-host.cjs');
const { createController } = require('../installed-lifecycle.cjs');
const { createSqliteHooks } = require('../sqlite-hooks.cjs');
const { createUpdater } = require('./update-engine.cjs');
// Exercise the real absolute-executable admission on every test host. A PATH
// command is only used to resolve the interpreter, never supplied as a binding.
const python = execFileSync(
  process.env.WEWE_TEST_PYTHON ||
    (process.platform === 'win32' ? 'python' : 'python3'),
  ['-c', 'import sys; print(sys.executable)'],
  { encoding: 'utf8', windowsHide: true },
).trim();
assert(path.isAbsolute(python), 'ABSOLUTE_FIXTURE_PYTHON_REQUIRED');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function sql(database, statement) {
  return execFileSync(
    python,
    [
      '-c',
      'import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit(); print(json.dumps(c.execute("select * from articles order by id").fetchall())); c.close()',
      database,
      statement,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
}

async function fixture(run) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(tempRoot, 'installed-adapter-fixture-')),
  );
  const releasesRoot = path.join(root, 'releases');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(releasesRoot);
  fs.mkdirSync(dataRoot);
  const database = path.join(dataRoot, 'fixture.sqlite');
  const journalFile = path.join(dataRoot, '.fixture-update.json');
  const pointer = path.join(releasesRoot, 'active.json');
  const config = { releasesRoot, dataRoot, database, journalFile };
  const packages = {};
  for (const id of ['fixture-old', 'fixture-new']) {
    const folder = path.join(releasesRoot, id);
    fs.mkdirSync(folder);
    const bytes = {
      'runtime/node.exe': 'synthetic executable, never launched',
      'runtime.cjs': 'synthetic runtime, never required',
      'server/prisma/schema.prisma': 'synthetic identical schema',
      'server/node_modules/prisma/build/index.js':
        'synthetic CLI, never executed',
      'engine.node': 'synthetic engine, never loaded',
      'installed-startup-gate.cjs': 'synthetic gate, never required',
    };
    const files = {};
    for (const [name, value] of Object.entries(bytes)) {
      const file = path.join(folder, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
      files[name] = hash(Buffer.from(value));
    }
    write(path.join(folder, 'release.json'), {
      format: 1,
      id,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: (id === 'fixture-old' ? 'a' : 'b').repeat(40),
      sourceHash: (id === 'fixture-old' ? 'a' : 'b').repeat(64),
      schemaCompatibility: 'current',
      desktopHelperIncluded: false,
      files,
      links: {},
      prisma: {
        clientVersion: '5.22.0',
        cliVersion: '5.22.0',
        engineSha256: files['engine.node'],
      },
      installedLifecycle: {
        protocol: 'wewe-installed-lifecycle-v1',
        writeHoldProtocol: 'project-writer-prisma-query-only-v1',
        journalBasename: path.basename(journalFile),
      },
    });
    packages[id] = {
      id,
      path: folder,
      sha256: hash(fs.readFileSync(path.join(folder, 'release.json'))),
    };
  }
  const trust = Object.fromEntries(
    Object.values(packages).map((p) => [p.id, p.sha256]),
  );
  write(pointer, { format: 1, id: 'fixture-old' });
  const unknown = path.join(dataRoot, 'historical-unknown.json');
  const queued = path.join(dataRoot, 'wechat-queued.json');
  write(unknown, [{ id: 'unknown-1', status: 'unknown', isolated: true }]);
  write(
    queued,
    Array.from({ length: 8 }, (_, i) => ({ id: i, status: 'queued' })),
  );
  const preserved = [unknown, queued].map((file) => [
    file,
    fs.readFileSync(file),
  ]);
  const originalRows = sql(
    database,
    "create table articles(id integer primary key, body text); insert into articles values(1,'preserved original');",
  );
  const identity = {
    pid: 41,
    executable: path.join(packages['fixture-old'].path, 'runtime/node.exe'),
    commandLine: 'synthetic never launched',
    startUtc: 'fixture-start-1',
  };
  const registryFile = journalFile + '.processes';
  write(registryFile, {
    format: 1,
    protocol: 'wewe-installed-lifecycle-v1',
    database,
    processes: [
      {
        transactionId: 'fixture-prior-transaction',
        releaseId: 'fixture-old',
        identity,
      },
    ],
  });
  const active = new Set([41]);
  const calls = {
    stops: 0,
    launches: 0,
    migrations: 0,
    http: 0,
    ordinarySmoke: 0,
    restores: 0,
    backups: 0,
  };
  let pid = 41;
  const faults = {};
  const native = {
    async processIdentity(action, target, port, expected) {
      if (action === 'OwnedStop') {
        calls.stops++;
        active.delete(target);
        return { stopped: true };
      }
      if (!active.has(target)) return { stopped: true };
      return expected;
    },
    sameIdentity: (a, b) => a?.pid === b?.pid && a?.startUtc === b?.startUtc,
    observeProjectWriters: async () => ({
      complete: true,
      active: [...active],
    }),
    waitReady: async () => {
      calls.ordinarySmoke++;
      throw Error('ordinary HTTP is held');
    },
    async execute() {
      calls.migrations++;
      sql(database, "update articles set body='fixture migration';");
      if (faults.migrate) throw Error('FIXTURE_MIGRATION_FAILURE');
      if (faults.holdMigration) await faults.holdMigration;
    },
    async launchRegistered(request) {
      calls.launches++;
      const next = {
        pid: ++pid,
        executable: request.node,
        commandLine: 'synthetic never launched',
        startUtc: 'fixture-start-' + pid,
      };
      active.add(pid);
      const registry = json(registryFile);
      registry.processes.push({
        transactionId: request.transactionId,
        releaseId: request.releaseId,
        identity: next,
      });
      write(registryFile, registry);
      assert.equal(request.env.WEWE_UPDATE_READ_ONLY, '1');
      return next;
    },
    async readUpdateHealth(ctx) {
      if (faults.health && ctx.release.id === 'fixture-new')
        throw Error('FIXTURE_HEALTH_FAILURE');
      return {
        transactionId: ctx.transactionId,
        id: ctx.release.id,
        sha256: ctx.release.sha256,
        database,
        readOnly: true,
        databaseReadable: true,
        httpReady: true,
      };
    },
    publishActive: async (release) =>
      write(pointer, { format: 1, id: release.id }),
  };
  const controller = createController(config, native);
  let adapter;
  const realHooks = createSqliteHooks({
    dataRoot,
    python,
    assertWritersStopped: (ctx) => adapter.assertWritersStopped(ctx),
  });
  const sqliteHooks = {
    async backup(ctx) {
      calls.backups++;
      if (faults.backup) throw Error('FIXTURE_BACKUP_FAILURE');
      return realHooks.backup(ctx);
    },
    async restoreDatabase(ctx) {
      calls.restores++;
      return realHooks.restoreDatabase(ctx);
    },
  };
  const host = createInstalledHost({
    ...config,
    trustedPackages: trust,
    controller,
    sqliteHooks,
  });
  adapter = await host.createAdapter();
  const updater = createUpdater({ journalFile, adapter });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.http++;
    throw Error('FIXTURE_NETWORK_FORBIDDEN');
  };
  try {
    await run({
      root,
      config,
      packages,
      trust,
      pointer,
      calls,
      faults,
      updater,
      adapter,
      controller,
      database,
      journalFile,
      originalRows,
      native,
    });
    for (const [file, bytes] of preserved)
      assert(fs.readFileSync(file).equals(bytes));
    assert.equal(calls.http, 0);
    assert.equal(calls.ordinarySmoke, 0);
  } finally {
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(root), tempRoot);
    assert(path.basename(root).startsWith('installed-adapter-fixture-'));
    fs.rmSync(root, { recursive: true });
  }
}

test('installed adapter commits only after real SQLite backup and read-only bound health; repeat is idempotent', () =>
  fixture(async (f) => {
    const result = await f.updater.update(f.packages['fixture-new']);
    assert.equal(result.status, 'completed');
    assert.equal(json(f.pointer).id, 'fixture-new');
    assert.equal(f.calls.backups, 1);
    assert.equal(f.calls.migrations, 1);
    assert.equal(f.calls.launches, 1);
    assert.equal(sql(result.journal.backup.path, ''), f.originalRows);
    assert.equal(json(f.journalFile + '.permit').stage, 'completed');
    assert.equal(
      (await f.updater.update(f.packages['fixture-new'])).status,
      'already-current',
    );
    assert.equal(f.calls.backups, 1);
    assert.equal(f.calls.migrations, 1);
    assert.equal(f.calls.launches, 1);
  }));

for (const fault of ['migrate', 'health'])
  test(
    'installed adapter restores real fixture DB after ' + fault + ' failure',
    () =>
      fixture(async (f) => {
        f.faults[fault] = true;
        const result = await f.updater.update(f.packages['fixture-new']);
        assert.equal(result.status, 'failed-recovered');
        assert.equal(result.journal.databaseRestored, true);
        assert.equal(sql(f.database, ''), f.originalRows);
        assert.equal(json(f.pointer).id, 'fixture-old');
        assert.equal(f.calls.restores, 1);
        assert.equal(json(f.journalFile + '.permit').stage, 'recovered');
      }),
  );

test('backup failure prevents migration and never claims database restoration', () =>
  fixture(async (f) => {
    f.faults.backup = true;
    const result = await f.updater.update(f.packages['fixture-new']);
    assert.equal(result.status, 'failed-recovered');
    assert.equal(result.journal.databaseRestored, false);
    assert.equal(f.calls.migrations, 0);
    assert.equal(f.calls.restores, 0);
    assert.equal(sql(f.database, ''), f.originalRows);
  }));

test('an untrusted self-reported digest is refused before stop, backup or migration', () =>
  fixture(async (f) => {
    await assert.rejects(
      f.updater.update({
        ...f.packages['fixture-new'],
        sha256: 'f'.repeat(64),
      }),
      /PACKAGE_NOT_IN_TRUSTED_RELEASE_ROOT/,
    );
    assert.equal(f.calls.stops, 0);
    assert.equal(f.calls.backups, 0);
    assert.equal(f.calls.migrations, 0);
  }));

test('candidate bytes changed after fixture authorization cannot execute', () =>
  fixture(async (f) => {
    fs.appendFileSync(
      path.join(f.packages['fixture-new'].path, 'runtime.cjs'),
      '\nchanged',
    );
    await assert.rejects(
      f.updater.update(f.packages['fixture-new']),
      /RELEASE_INTEGRITY_FAILED/,
    );
    assert.equal(f.calls.stops, 0);
    assert.equal(f.calls.launches, 0);
  }));

test('concurrent advance is busy and performs one migration and launch', () =>
  fixture(async (f) => {
    let release, entered;
    const atMigration = new Promise((resolve) => {
      entered = resolve;
    });
    f.faults.holdMigration = new Promise((resolve) => {
      release = resolve;
    });
    const original = f.native.execute;
    f.native.execute = async (...args) => {
      entered();
      return original(...args);
    };
    const first = f.updater.update(f.packages['fixture-new']);
    await atMigration;
    try {
      assert.equal(
        (await f.updater.update(f.packages['fixture-new'])).status,
        'busy',
      );
    } finally {
      release();
    }
    assert.equal((await first).status, 'completed');
    assert.equal(f.calls.migrations, 1);
    assert.equal(f.calls.launches, 1);
  }));

test('independent updater instances share the same exclusive startup barrier', () =>
  fixture(async (f) => {
    const host = createInstalledHost({
      ...f.config,
      trustedPackages: f.trust,
      controller: createController(f.config, f.native),
      sqliteHooks: {
        backup: () => assert.fail('second updater must not back up'),
        restoreDatabase: () => assert.fail('second updater must not restore'),
      },
    });
    const other = createUpdater({
      journalFile: f.journalFile,
      adapter: await host.createAdapter(),
    });
    let release, entered;
    const atMigration = new Promise((resolve) => {
      entered = resolve;
    });
    f.faults.holdMigration = new Promise((resolve) => {
      release = resolve;
    });
    const original = f.native.execute;
    f.native.execute = async (...args) => {
      entered();
      return original(...args);
    };
    const first = f.updater.update(f.packages['fixture-new']);
    await atMigration;
    try {
      assert.equal(
        (await other.update(f.packages['fixture-new'])).status,
        'busy',
      );
    } finally {
      release();
    }
    assert.equal((await first).status, 'completed');
    assert.equal(f.calls.backups, 1);
    assert.equal(f.calls.launches, 1);
  }));

test('postcommit enable failure retains committed data and recovery only enables the same version', () =>
  fixture(async (f) => {
    const original = f.controller.enable;
    f.controller.enable = () => {
      throw Error('FIXTURE_ENABLE_FAILURE');
    };
    const result = await f.updater.update(f.packages['fixture-new']);
    assert.equal(result.status, 'completed-start-pending');
    assert.equal(json(f.pointer).id, 'fixture-new');
    assert.equal(f.calls.restores, 0);
    assert.match(sql(f.database, ''), /fixture migration/);
    f.controller.enable = original;
    assert.equal((await f.updater.recover()).status, 'completed');
    assert.equal(f.calls.restores, 0);
    assert.equal(f.calls.launches, 1);
  }));

test('tampered recovery snapshot preserves a failed journal and blocks unsafe restoration', () =>
  fixture(async (f) => {
    const original = f.native.readUpdateHealth;
    f.native.readUpdateHealth = async (ctx) => {
      if (ctx.release.id === 'fixture-new') {
        fs.appendFileSync(json(f.journalFile).backup.path, 'tampered');
        throw Error('FIXTURE_HEALTH_FAILURE');
      }
      return original(ctx);
    };
    await assert.rejects(
      f.updater.update(f.packages['fixture-new']),
      /UPDATE_RECOVERY_FAILED/,
    );
    assert.equal(json(f.journalFile).stage, 'recovery-failed');
    assert(fs.existsSync(f.journalFile + '.startup-lock'));
    assert.match(sql(f.database, ''), /fixture migration/);
  }));

test('unknown native writer observation prevents backup and restoration', () =>
  fixture(async (f) => {
    f.native.observeProjectWriters = async () => ({
      complete: false,
      active: [],
    });
    await assert.rejects(
      f.updater.update(f.packages['fixture-new']),
      /UPDATE_RECOVERY_FAILED/,
    );
    assert.equal(json(f.journalFile).stage, 'recovery-failed');
    assert.equal(f.calls.backups, 0);
    assert.equal(f.calls.restores, 0);
    assert.equal(f.calls.migrations, 0);
    assert(fs.existsSync(f.journalFile + '.startup-lock'));
  }));
