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
async function fixture(t, extra = () => {}) {
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
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../fixtures/installed-pointer-lock.json'),
        'utf8',
      ),
    ).source,
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
  const p = await update.plan({ installation, web, artifacts, expected });
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
  const f = await fixture(t, ({ root, write }) => {
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
  assert.equal((await update.inventory(f.root)).slots, 147);
});
for (const field of ['pid', 'startUtc', 'executable', 'commandLine'])
  test('refuses wrong or reused process ' + field, async (t) => {
    const f = await fixture(t);
    f.adapter.snapshot = async () => ({
      ...f.p.expected,
      [field]: field === 'pid' ? 999 : 'wrong',
    });
    await assert.rejects(update.apply(f.p, f.adapter));
    assert.deepEqual(f.starts, []);
  });
test('old instance must be confirmed exited before any replacement', async (t) => {
  const f = await fixture(t);
  f.adapter.stop = async () => ({ stopped: true });
  await assert.rejects(update.apply(f.p, f.adapter), /ROLLBACK_FAILED/);
  assert.deepEqual(f.starts, []);
});
test('port conflict blocks new start and fallback; keeps database and packages', async (t) => {
  const f = await fixture(t);
  f.adapter.requireFreePort = async () => {
    throw Error('PORT_CONFLICT');
  };
  await assert.rejects(update.apply(f.p, f.adapter), /ROLLBACK_FAILED/);
  assert.deepEqual(f.starts, []);
  assert.equal(fs.readFileSync(f.p.database, 'utf8'), 'synthetic; not opened');
});
test('pointer race is never overwritten', async (t) => {
  const f = await fixture(t);
  f.adapter.verifyAssets = async () =>
    f.write(f.p.pointer.path, JSON.stringify({ format: 1, id: 'other-owner' }));
  await assert.rejects(update.apply(f.p, f.adapter), /ROLLBACK_FAILED/);
  assert.equal(JSON.parse(fs.readFileSync(f.p.pointer.path)).id, 'other-owner');
});
test('external candidate write is rejected instead of refreshing receipt', async (t) => {
  const f = await fixture(t);
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
  const f = await fixture(t);
  f.adapter.ready = async () => {
    if (f.starts.length === 1) throw Error('NEW_FAILED');
  };
  await assert.rejects(update.apply(f.p, f.adapter), /NEW_FAILED/);
  assert.deepEqual(f.starts, [f.p.candidateId, 'old']);
  assert.equal(fs.readFileSync(f.p.database, 'utf8'), 'synthetic; not opened');
});
test('rollback failure is explicit and never publishes the candidate', async (t) => {
  const f = await fixture(t);
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
  const f = await fixture(t);
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
  const f = await fixture(t);
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
  const f = await fixture(t);
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
      logicalDisks: [{ DeviceID: 'C:', DriveType: 3, ProviderName: null }],
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
    { resolveIdentity: () => ['synthetic-file-identity'] },
  );
  assert.deepEqual(observed.applicationPids, [101]);
  assert.deepEqual(observed.conflicts, [103]);
  assert.deepEqual(observed.unknown, [42]);
  assert.equal(observed.globalComplete, false);
});
test('same database is bound by actual identity across slashes, quoting, normalization and hard-link alias', async (t) => {
  const f = await fixture(t),
    alias = path.join(path.dirname(f.p.database), 'database-alias.db');
  fs.linkSync(f.p.database, alias);
  const values = [
    f.p.database,
    f.p.database.replace(/\\/g, '/'),
    '"' + f.p.database + '"',
    alias,
    path.join(path.dirname(f.p.database), '..', 'data', 'wewe-rss.db'),
  ];
  for (const value of values) {
    const raw = {
      querySucceeded: true,
      collectorPid: 900,
      logicalDisks: [{ DeviceID: 'C:', DriveType: 3, ProviderName: null }],
      processes: [
        {
          ProcessId: 777,
          ExecutablePath: 'C:\\external\\node.exe',
          CommandLine:
            'C:\\external\\node.exe C:\\other\\runtime.cjs start --database ' +
            value,
        },
      ],
    };
    const observation = update.classifyWriters(
      raw,
      f.p.installation,
      f.p.database,
      { databaseIdentity: f.p.databaseIdentity },
    );
    assert.deepEqual(observation.conflicts, [777], value);
    assert.throws(
      () => update.validateWriters(observation, null),
      /WRITER_CONFLICT/,
    );
  }
});
test('related unresolvable, relative, drive-relative and ambiguous database paths are refused', async (t) => {
  const f = await fixture(t);
  for (const value of [
    'data.db',
    'C:data.db',
    '\\data.db',
    'C:\\missing\\data.db',
    '"unterminated',
    '"' + f.p.database + '" --database other.db',
  ]) {
    const observation = update.classifyWriters(
      {
        querySucceeded: true,
        collectorPid: 900,
        logicalDisks: [{ DeviceID: 'C:', DriveType: 3, ProviderName: null }],
        processes: [
          {
            ProcessId: 777,
            ExecutablePath: 'C:\\external\\node.exe',
            CommandLine:
              'C:\\external\\node.exe C:\\other\\runtime.cjs start --database ' +
              value,
          },
        ],
      },
      f.p.installation,
      f.p.database,
    );
    assert.deepEqual(observation.conflicts, [777], value);
  }
});
test('rollback rechecks writers after ready and only stops its owned fallback on conflict', async (t) => {
  const f = await fixture(t),
    writers = f.adapter.writers,
    stopNew = f.adapter.stopNew,
    stopped = [];
  let afterReady = false,
    checks = 0;
  f.adapter.ready = async () => {
    if (f.starts.length === 1) throw Error('NEW_FAILED');
    afterReady = true;
  };
  f.adapter.writers = async () => {
    const value = await writers();
    if (afterReady) {
      checks++;
      return { ...value, conflicts: [888] };
    }
    return value;
  };
  f.adapter.stopNew = async (child) => {
    stopped.push(child.pid);
    await stopNew(child);
  };
  await assert.rejects(
    update.apply(f.p, f.adapter),
    /UPDATE_AND_ROLLBACK_FAILED/,
  );
  assert.equal(checks, 1);
  assert.deepEqual(stopped, [202, 203]);
  assert(!stopped.includes(888));
  assert.equal(JSON.parse(fs.readFileSync(f.p.pointer.path)).id, 'old');
});
test(
  'writer and exit queries enforce controller deadlines and output bounds without running PowerShell',
  { skip: process.platform !== 'win32' },
  async () => {
    const prior = lib.run,
      calls = [];
    try {
      lib.run = (exe, args, options) => {
        calls.push({ args, options });
        throw Object.assign(Error('synthetic timeout'), { code: 'ETIMEDOUT' });
      };
      const adapter = update.productionAdapter({
        config: [],
        installation: 'C:\\app',
        database: 'C:\\app\\data.db',
      });
      assert.throws(() => adapter.writers(), /synthetic timeout/);
      await assert.rejects(
        adapter.requireExited({ pid: 101 }),
        /synthetic timeout/,
      );
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.options.timeout, 15000);
        assert.equal(call.options.maxBuffer, 4194304);
      }
      assert(calls[1].args.at(-1).includes('-OperationTimeoutSec 10'));
      const source = fs.readFileSync(
        path.join(__dirname, 'frontend-writers.ps1'),
        'utf8',
      );
      assert(source.includes('-OperationTimeoutSec 10'));
      assert(source.includes('-First 4097'));
      assert(source.includes('-gt 4096'));
      assert(source.includes('-gt 4194304'));
    } finally {
      lib.run = prior;
    }
  },
);
test('oversized writer enumeration is refused before classification', () => {
  assert.throws(
    () =>
      update.classifyWriters(
        {
          querySucceeded: true,
          collectorPid: 900,
          logicalDisks: [{ DeviceID: 'C:', DriveType: 3, ProviderName: null }],
          processes: Array(4097).fill({}),
        },
        'C:\\app',
        'C:\\app\\data.db',
        { resolveIdentity: () => ['test'] },
      ),
    /ENTRY_LIMIT/,
  );
});
test('UNC, device namespaces, mapped network drives and unknown drives never reach identity resolver', () => {
  const values = [
    '\\\\server\\share\\data.db',
    '//server/share/data.db',
    '\\\\?\\UNC\\server\\share\\data.db',
    '\\\\?\\C:\\app\\data.db',
    '\\\\.\\C:\\app\\data.db',
    '\\??\\C:\\app\\data.db',
    'Z:\\data.db',
    'Y:/data.db',
    'E:\\data.db',
    'F:\\data.db',
    'C:\\app\\data.db:stream',
    'C:\\app\\NUL',
  ];
  for (const value of values) {
    const calls = [],
      resolveIdentity = (file) => {
        calls.push(file);
        return ['local-identity'];
      };
    const result = update.classifyWriters(
      {
        querySucceeded: true,
        collectorPid: 900,
        logicalDisks: [
          { DeviceID: 'C:', DriveType: 3, ProviderName: null },
          { DeviceID: 'Z:', DriveType: 4, ProviderName: '\\\\server\\share' },
          { DeviceID: 'E:', DriveType: 0, ProviderName: null },
          { DeviceID: 'F:', DriveType: 3, ProviderName: '\\\\server\\share' },
        ],
        processes: [
          {
            ProcessId: 777,
            ExecutablePath: 'C:\\external\\node.exe',
            CommandLine:
              'node C:\\other\\runtime.cjs start --database ' + value,
          },
        ],
      },
      'C:\\app',
      'C:\\app\\data.db',
      { resolveIdentity },
    );
    assert.deepEqual(result.conflicts, [777], value);
    assert.deepEqual(
      calls,
      ['C:\\app\\data.db'],
      value + ' must not trigger remote/path IO',
    );
  }
});
test('unproven target drive and UNC target fail before any identity lookup', () => {
  for (const database of ['\\\\server\\share\\data.db', 'Z:\\data.db']) {
    let calls = 0;
    assert.throws(
      () =>
        update.classifyWriters(
          {
            querySucceeded: true,
            collectorPid: 900,
            processes: [],
            logicalDisks: [
              { DeviceID: 'C:', DriveType: 3, ProviderName: null },
            ],
          },
          'C:\\app',
          database,
          {
            resolveIdentity: () => {
              calls++;
              return ['never'];
            },
          },
        ),
      /LOCAL_/,
    );
    assert.equal(calls, 0);
  }
});
test('bounded local-drive observation is required even with an injected resolver', () => {
  for (const logicalDisks of [
    undefined,
    [],
    [{ DeviceID: 'C:', DriveType: 3 }],
    Array(33).fill({ DeviceID: 'C:', DriveType: 3, ProviderName: null }),
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        update.classifyWriters(
          {
            querySucceeded: true,
            collectorPid: 900,
            processes: [],
            logicalDisks,
          },
          'C:\\app',
          'C:\\app\\data.db',
          {
            resolveIdentity: () => {
              calls++;
              return ['never'];
            },
          },
        ),
      /LOCAL_DRIVE_UNPROVEN/,
    );
    assert.equal(calls, 0);
  }
});
test('local junction is refused before looking up any child beneath it', async (t) => {
  const f = await fixture(t),
    redirect = path.join(path.dirname(f.p.database), 'redirect'),
    prior = fs.lstatSync;
  let childLookups = 0;
  try {
    fs.lstatSync = (file, ...args) => {
      if (String(file).toLowerCase() === redirect.toLowerCase())
        return { isSymbolicLink: () => true };
      if (
        String(file)
          .toLowerCase()
          .startsWith(redirect.toLowerCase() + '\\')
      ) {
        childLookups++;
        throw Error('remote child lookup forbidden');
      }
      return prior(file, ...args);
    };
    const result = update.classifyWriters(
      {
        querySucceeded: true,
        collectorPid: 900,
        logicalDisks: [{ DeviceID: 'C:', DriveType: 3, ProviderName: null }],
        processes: [
          {
            ProcessId: 777,
            ExecutablePath: 'C:\\external\\node.exe',
            CommandLine:
              'node C:\\other\\runtime.cjs start --database ' +
              path.join(redirect, 'data.db'),
          },
        ],
      },
      f.p.installation,
      f.p.database,
    );
    assert.deepEqual(result.conflicts, [777]);
    assert.equal(childLookups, 0);
  } finally {
    fs.lstatSync = prior;
  }
});
test('plan accepts only the reviewed installed publisher rather than the development module', async (t) => {
  const f = await fixture(t);
  assert.equal(
    f.p.publicationTool.sha256,
    '28bc6160cf040aa11c37e9413ea44e316eeb2923a482d12ba09b0c1458500009',
  );
  f.write(
    f.p.publicationTool.path,
    fs.readFileSync(path.join(__dirname, 'active-release.cjs')),
  );
  await assert.rejects(
    () =>
      update.plan({
        installation: f.p.installation,
        web: path.join(f.p.installation, 'web'),
        artifacts: path.join(f.p.installation, 'artifacts.json'),
        expected: f.p.expected,
      }),
    /STATE_CHANGED/,
  );
  assert.deepEqual(f.starts, []);
  assert(!fs.existsSync(path.join(f.root, '.build-budget.lock')));
});
test('publisher changed after plan is rejected before creating locks or candidate or stopping processes', async (t) => {
  const f = await fixture(t);
  let stops = 0;
  f.adapter.stop = async () => {
    stops++;
    return { stopped: true };
  };
  f.write(f.p.publicationTool.path, 'unreviewed host change');
  await assert.rejects(update.apply(f.p, f.adapter), /STATE_CHANGED/);
  assert.equal(stops, 0);
  assert.deepEqual(f.starts, []);
  for (const name of [
    '.build-budget.lock',
    '.frontend-update.lock',
    f.p.candidateId,
  ])
    assert(!fs.existsSync(path.join(f.root, name)));
});
test('changing the plan pin to match an arbitrary publisher cannot authorize it', async (t) => {
  const f = await fixture(t);
  f.write(
    f.p.publicationTool.path,
    'arbitrary lock-looking publisher .active-release.lock',
  );
  f.p.publicationTool.sha256 = lib.fileHash(f.p.publicationTool.path);
  await assert.rejects(update.apply(f.p, f.adapter), /STATE_CHANGED/);
  assert(!fs.existsSync(path.join(f.root, '.build-budget.lock')));
  assert.deepEqual(f.starts, []);
});
test('identical publisher bytes at a different path cannot replace the installed-path pin', async (t) => {
  const f = await fixture(t),
    alternate = path.join(f.p.installation, 'alternate-publisher.cjs');
  f.write(alternate, fs.readFileSync(f.p.publicationTool.path));
  f.p.publicationTool.path = alternate;
  await assert.rejects(update.apply(f.p, f.adapter), /STATE_CHANGED/);
  assert(!fs.existsSync(path.join(f.root, '.build-budget.lock')));
  assert.deepEqual(f.starts, []);
});
test('reviewed read-only companion remains recorded and its exit is required after stopping the parent', async (t) => {
  const f = await fixture(t),
    writers = f.adapter.writers,
    exited = f.adapter.requireExited,
    observed = [];
  const companion = {
    pid: 111,
    startUtc: '2026-10-21T00:01:00Z',
    parent: f.p.expected,
    role: 'read-only-business-database',
  };
  f.p.readOnlyCompanions = [companion];
  f.adapter.writers = async () => {
    const v = await writers();
    return {
      ...v,
      readOnlyCompanions: v.applicationPids[0] === 101 ? [companion] : [],
    };
  };
  f.adapter.requireExited = async (identity) => {
    observed.push(identity.pid);
    await exited(identity);
  };
  const result = await update.apply(f.p, f.adapter);
  assert(observed.includes(111));
  assert.equal(result.readOnlyCompanions[0].oldOwnerExitConfirmed, true);
});
test('unreviewed/restarted companion rejects before copying or stopping', async (t) => {
  const f = await fixture(t),
    writers = f.adapter.writers;
  f.adapter.writers = async () => ({
    ...(await writers()),
    readOnlyCompanions: [{ pid: 999, startUtc: 'new', parent: f.p.expected }],
  });
  await assert.rejects(update.apply(f.p, f.adapter), /STATE_CHANGED/);
  assert.deepEqual(f.starts, []);
  assert(!fs.existsSync(path.join(f.root, f.p.candidateId)));
});
test('a companion that outlives its stopped parent is not killed or ignored', async (t) => {
  const f = await fixture(t),
    writers = f.adapter.writers,
    exited = f.adapter.requireExited,
    killed = [];
  const companion = {
    pid: 111,
    startUtc: '2026-10-21T00:01:00Z',
    parent: f.p.expected,
  };
  f.p.readOnlyCompanions = [companion];
  f.adapter.writers = async () => ({
    ...(await writers()),
    readOnlyCompanions: [companion],
  });
  f.adapter.requireExited = async (identity) => {
    if (identity.pid === 111) throw Error('COMPANION_STILL_ALIVE');
    await exited(identity);
  };
  f.adapter.stopNew = async (child) => {
    killed.push(child.pid);
  };
  await assert.rejects(
    update.apply(f.p, f.adapter),
    /UPDATE_AND_ROLLBACK_FAILED/,
  );
  assert(!killed.includes(111));
  assert.deepEqual(f.starts, []);
});
test('changed companion creation identity or executable pin rejects before side effects', async (t) => {
  for (const field of ['pid', 'startUtc', 'executable', 'interpreter']) {
    const f = await fixture(t),
      writers = f.adapter.writers;
    const proof = {
      pid: 111,
      startUtc: '2026-10-21T00:01:00Z',
      executable: 'C:\\python\\python.exe',
      interpreter: {
        path: 'C:\\python\\python.exe',
        sha256:
          '467014615a5255aca450ae88100dd2caf887da87657f00e3c2171ec44a685aec',
      },
      parent: f.p.expected,
    };
    f.p.readOnlyCompanions = [proof];
    const changed = {
      ...proof,
      [field]:
        field === 'pid'
          ? 112
          : field === 'interpreter'
            ? { ...proof.interpreter, sha256: '0'.repeat(64) }
            : 'changed',
    };
    f.adapter.writers = async () => ({
      ...(await writers()),
      readOnlyCompanions: [changed],
    });
    await assert.rejects(update.apply(f.p, f.adapter), /STATE_CHANGED/);
    assert.deepEqual(f.starts, []);
    assert(!fs.existsSync(path.join(f.root, f.p.candidateId)));
  }
});
