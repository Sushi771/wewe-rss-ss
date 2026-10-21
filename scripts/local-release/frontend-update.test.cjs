'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('./lib.cjs');
const update = require('./frontend-update.cjs');
const SOURCE = 'f618e48f48ff0e3df1c646cb8a666a2461815732';
const BASE = '48fdf73f4d770001bbb6de3e2383189811e56ccb';
function fixture(t, extra = () => {}) {
  const installation = fs.mkdtempSync(
    path.join(os.tmpdir(), 'frontend-retain-'),
  );
  t.after(() => fs.rmSync(installation, { recursive: true, force: true }));
  const root = path.join(installation, '.local-releases'),
    previous = path.join(root, 'old');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(
    path.join(installation, 'scripts/local-release/active-release.cjs'),
    fs.readFileSync(path.join(__dirname, 'active-release.cjs')),
  );
  write(path.join(previous, 'runtime/node.exe'), 'fixed-runtime');
  write(path.join(previous, 'runtime.cjs'), 'fixed-startup');
  write(path.join(previous, 'server/main.cjs'), 'fixed-backend');
  write(
    path.join(previous, 'server/prisma/migrations/20/migration.sql'),
    'fixed-schema',
  );
  write(path.join(previous, 'client/index.hbs'), 'old template');
  write(path.join(previous, 'client/assets/index-old.js'), 'retain old asset');
  write(
    path.join(root, 'active.json'),
    JSON.stringify({ format: 1, id: 'old' }),
  );
  write(
    path.join(installation, 'apps/server/data/wewe-rss.db'),
    'synthetic; not opened',
  );
  const old = {
    format: 1,
    id: 'old',
    platform: process.platform,
    arch: process.arch,
    sourceCommit: BASE,
    sourceHash: 'f'.repeat(64),
    schemaCompatibility: 'current',
    desktopHelperIncluded: false,
    ...lib.fingerprint(previous),
  };
  write(path.join(previous, 'release.json'), JSON.stringify(old));
  const web = path.join(installation, 'web'),
    names = [
      'index.hbs',
      'assets/index-a.js',
      'assets/index-b.js',
      'assets/index-c.css',
    ];
  names.forEach((n, i) => write(path.join(web, n), 'new frontend ' + i));
  const artifacts = path.join(installation, 'artifacts.json');
  write(
    artifacts,
    JSON.stringify({
      sourceCommit: SOURCE,
      baseCommit: BASE,
      files: names.map((n) => ({
        path: n,
        sha256: lib.fileHash(path.join(web, n)),
        bytes: fs.statSync(path.join(web, n)).size,
      })),
    }),
  );
  const executable = path.join(previous, 'runtime/node.exe'),
    database = path.join(installation, 'apps/server/data/wewe-rss.db');
  const expected = {
    pid: 101,
    startUtc: '2026-10-21T00:00:00Z',
    executable,
    commandLine: [
      executable,
      path.join(previous, 'runtime.cjs'),
      'start',
      '--database',
      database,
      '--port',
      '4000',
      '--production',
    ].join(' '),
    port: 4000,
  };
  extra({ root, write, previous });
  const p = update.plan({ installation, web, artifacts, expected });
  let current = { ...expected };
  const starts = [];
  const adapter = {
    snapshot: async (pid) => {
      assert(current && current.pid === pid);
      return { ...current };
    },
    writers: async () => ({
      querySucceeded: true,
      applicationPids: current ? [current.pid] : [],
      conflicts: [],
      unknown: [999],
    }),
    stop: async () => {
      current = null;
      return { stopped: true };
    },
    requireExited: async (identity) => {
      assert(!current || current.pid !== identity.pid, 'OLD_STILL_RUNNING');
    },
    requireFreePort: async () => {
      assert.equal(current, null);
    },
    start: async (release, releaseId) => {
      assert.equal(current, null);
      starts.push(releaseId);
      const pid = starts.length + 201,
        exe = path.join(release, 'runtime/node.exe');
      current = {
        pid,
        startUtc: 'new-' + pid,
        executable: exe,
        commandLine: [
          exe,
          path.join(release, 'runtime.cjs'),
          'start',
          '--database',
          database,
          '--port',
          '4000',
          '--production',
        ].join(' '),
        port: 4000,
      };
      return { pid, startUtc: current.startUtc };
    },
    ready: async () => {},
    stopNew: async () => {
      current = null;
    },
    verifyAssets: async () => {},
    detach: () => {},
  };
  return {
    p,
    adapter,
    root,
    previous,
    starts,
    setCurrent: (v) => {
      current = v;
    },
    write,
  };
}
test('retain-only update preserves 146 historical slots including unmanifested directories', async (t) => {
  const f = fixture(t, ({ root, write }) => {
    for (let i = 0; i < 145; i++)
      write(path.join(root, 'history-' + i, 'kept'), 'history');
  });
  assert.equal(f.p.baseline.slots, 146);
  const result = await update.apply(f.p, f.adapter);
  assert.equal(result.passed, true);
  assert.equal(result.databaseRestored, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, 'active.json'))).id,
    f.p.candidateId,
  );
  assert.equal(
    fs.readFileSync(path.join(f.previous, 'server/main.cjs'), 'utf8'),
    'fixed-backend',
  );
  const candidate = path.join(f.root, f.p.candidateId);
  assert.equal(
    fs.readFileSync(path.join(candidate, 'client/assets/index-old.js'), 'utf8'),
    'retain old asset',
  );
  assert.equal(
    fs.readFileSync(path.join(candidate, 'server/main.cjs'), 'utf8'),
    'fixed-backend',
  );
  assert.equal(update.inventory(f.root).slots, 147);
});
for (const field of ['pid', 'startUtc', 'executable', 'commandLine'])
  test('refuses wrong or reused process ' + field, async (t) => {
    const f = fixture(t);
    f.adapter.snapshot = async () => ({
      ...f.p.expected,
      [field]: field === 'pid' ? 999 : 'wrong',
    });
    await assert.rejects(update.apply(f.p, f.adapter));
    assert.deepEqual(f.starts, []);
  });
test('old instance must be confirmed exited before any replacement', async (t) => {
  const f = fixture(t);
  f.adapter.stop = async () => ({ stopped: true });
  await assert.rejects(update.apply(f.p, f.adapter), /ROLLBACK_FAILED/);
  assert.deepEqual(f.starts, []);
});
test('port conflict blocks new start and fallback; keeps database and packages', async (t) => {
  const f = fixture(t);
  f.adapter.requireFreePort = async () => {
    throw Error('PORT_CONFLICT');
  };
  await assert.rejects(update.apply(f.p, f.adapter), /ROLLBACK_FAILED/);
  assert.deepEqual(f.starts, []);
  assert.equal(fs.readFileSync(f.p.database, 'utf8'), 'synthetic; not opened');
});
test('pointer race is never overwritten', async (t) => {
  const f = fixture(t);
  f.adapter.verifyAssets = async () =>
    f.write(f.p.pointer.path, JSON.stringify({ format: 1, id: 'other-owner' }));
  await assert.rejects(update.apply(f.p, f.adapter), /ROLLBACK_FAILED/);
  assert.equal(JSON.parse(fs.readFileSync(f.p.pointer.path)).id, 'other-owner');
});
test('external candidate write is rejected instead of refreshing receipt', async (t) => {
  const f = fixture(t);
  const ready = f.adapter.ready;
  f.adapter.ready = async (child) => {
    await ready(child);
    if (f.starts.length === 1)
      f.write(
        path.join(f.root, f.p.candidateId, 'server/main.cjs'),
        'unowned write',
      );
  };
  await assert.rejects(update.apply(f.p, f.adapter), /STATE_CHANGED/);
  assert.deepEqual(f.starts, [f.p.candidateId, 'old']);
  assert.equal(JSON.parse(fs.readFileSync(f.p.pointer.path)).id, 'old');
});
test('new start failure starts the unchanged old package without database restore', async (t) => {
  const f = fixture(t);
  f.adapter.ready = async () => {
    if (f.starts.length === 1) throw Error('NEW_FAILED');
  };
  await assert.rejects(update.apply(f.p, f.adapter), /NEW_FAILED/);
  assert.deepEqual(f.starts, [f.p.candidateId, 'old']);
  assert.equal(fs.readFileSync(f.p.database, 'utf8'), 'synthetic; not opened');
});
test('rollback failure is explicit and never publishes the candidate', async (t) => {
  const f = fixture(t);
  f.adapter.ready = async () => {
    throw Error('START_FAILED');
  };
  await assert.rejects(
    update.apply(f.p, f.adapter),
    /UPDATE_AND_ROLLBACK_FAILED/,
  );
  assert.equal(JSON.parse(fs.readFileSync(f.p.pointer.path)).id, 'old');
});
test('ordinary unknown system properties do not claim global completeness', () => {
  assert.doesNotThrow(() =>
    update.validateWriters(
      {
        querySucceeded: true,
        applicationPids: [101],
        conflicts: [],
        unknown: [42],
      },
      { pid: 101 },
    ),
  );
  assert.throws(
    () =>
      update.validateWriters(
        {
          querySucceeded: true,
          applicationPids: [101],
          conflicts: [42],
          unknown: [],
        },
        { pid: 101 },
      ),
    /WRITER_CONFLICT/,
  );
});
test('changed history and changed source artifact are rejected before stop', async (t) => {
  const f = fixture(t);
  f.write(path.join(f.previous, 'server/main.cjs'), 'changed history');
  await assert.rejects(update.apply(f.p, f.adapter));
  assert.deepEqual(f.starts, []);
});
test('forged extra backend entry cannot be adopted into a frontend manifest', () => {
  assert.throws(() =>
    update.equivalent(
      { files: { 'server/main.cjs': 'old' }, links: {} },
      { files: { 'server/main.cjs': 'changed' }, links: {} },
      [],
    ),
  );
});
test('source artifact mutation is rejected before stopping the old instance', async (t) => {
  const f = fixture(t);
  let stops = 0;
  f.adapter.stop = async () => {
    stops++;
    return { stopped: true };
  };
  f.write(f.p.files[0].input, 'changed frontend artifact');
  await assert.rejects(update.apply(f.p, f.adapter));
  assert.equal(stops, 0);
});
test('foreign publication lock is preserved and blocks every effect', async (t) => {
  const f = fixture(t);
  const file = path.join(f.p.installation, '.active-release.lock');
  f.write(file, 'another publisher');
  await assert.rejects(update.apply(f.p, f.adapter), /EEXIST/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'another publisher');
  assert.deepEqual(f.starts, []);
});
test('actual production writer classification retains unknowns and rejects related conflicts', () => {
  const observed = update.classifyWriters(
    {
      querySucceeded: true,
      collectorPid: 100,
      processes: [
        {
          ProcessId: 100,
          ExecutablePath: 'C:\\Windows\\powershell.exe',
          CommandLine: 'collector --database C:\\app\\data.db',
        },
        {
          ProcessId: 101,
          ExecutablePath: 'C:\\app\\.local-releases\\old\\runtime\\node.exe',
          CommandLine:
            'C:\\app\\.local-releases\\old\\runtime\\node.exe C:\\app\\.local-releases\\old\\runtime.cjs start --database C:\\app\\data.db --port 4000 --production',
        },
        { ProcessId: 42, ExecutablePath: null, CommandLine: null },
        {
          ProcessId: 103,
          ExecutablePath: 'C:\\app\\other.exe',
          CommandLine: null,
        },
      ],
    },
    'C:\\app',
    'C:\\app\\data.db',
  );
  assert.deepEqual(observed.applicationPids, [101]);
  assert.deepEqual(observed.conflicts, [103]);
  assert.deepEqual(observed.unknown, [42]);
  assert.equal(observed.globalComplete, false);
});
