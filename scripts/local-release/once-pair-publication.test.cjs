const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const admission = require('./once-pair-admission.cjs'),
  publication = require('./once-pair-publication.cjs');
const { fingerprint, fileHash, hostEffects } = require('./lib.cjs');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const identity = (at) => {
  const s = fs.lstatSync(at, { bigint: true });
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
function pkg(parent, id) {
  const at = path.join(parent, id);
  fs.mkdirSync(path.join(at, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(at, 'runtime/node.exe'), 'inert');
  fs.writeFileSync(path.join(at, 'runtime.cjs'), 'inert');
  fs.mkdirSync(path.join(at, 'server/prisma/migrations/additive'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(at, 'server/prisma/migrations/additive/migration.sql'),
    'CREATE TABLE new_table (id TEXT);',
  );
  fs.writeFileSync(
    path.join(at, 'release.json'),
    JSON.stringify({
      format: 1,
      id,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: crypto.createHash('sha1').update(id).digest('hex'),
      sourceHash: 'b'.repeat(64),
      schemaCompatibility: 'current',
      desktopHelperIncluded: false,
      ...fingerprint(at),
    }),
  );
  return {
    id,
    path: fs.realpathSync.native(at),
    identity: identity(at),
    sourceCommit: JSON.parse(fs.readFileSync(path.join(at, 'release.json')))
      .sourceCommit,
    manifestSha256: fileHash(path.join(at, 'release.json')),
  };
}
async function fixture(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-publish-pair-'));
  try {
    const project = path.join(base, 'project'),
      root = path.join(project, '.local-releases'),
      sources = path.join(base, 'sources'),
      registry = path.join(base, 'registry'),
      audits = path.join(base, 'audits');
    for (const dir of [
      root,
      sources,
      registry,
      audits,
      path.join(project, 'apps/server/data'),
    ])
      fs.mkdirSync(dir, { recursive: true });
    const specs = [
      pkg(root, 'current'),
      pkg(root, 'held'),
      pkg(sources, 'candidate'),
      pkg(sources, 'rollback'),
    ];
    const database = path.join(project, 'apps/server/data/wewe-rss.db');
    fs.writeFileSync(
      database,
      JSON.stringify({
        articles: [{ id: 1, body: 'kept' }],
        claims: [{ id: 1, attempted: true, unknown: true }],
      }),
    );
    fs.writeFileSync(
      path.join(root, 'active.json'),
      JSON.stringify({ format: 1, id: 'current' }),
    );
    const pin = (at) => ({
      path: fs.realpathSync.native(at),
      sha256: fileHash(at),
    });
    const proof = path.join(base, 'compatibility.json');
    fs.writeFileSync(
      proof,
      JSON.stringify({
        format: 1,
        kind: 'additive-schema-unknown-claim-rollback',
        businessDatabaseRestored: false,
        checks: {
          additiveSchema: true,
          unknownClaimsPreserved: true,
          businessRowsPreserved: true,
          rollbackStarted: true,
        },
        ...Object.fromEntries(
          ['candidate', 'rollback'].map((role) => {
            const s = specs.find((i) => i.id === role);
            return [
              role,
              {
                id: s.id,
                sourceCommit: s.sourceCommit,
                manifestSha256: s.manifestSha256,
              },
            ];
          }),
        ),
      }),
    );
    const executable = path.join(root, 'current/runtime/node.exe'),
      line = (release) =>
        [
          path.join(release, 'runtime/node.exe'),
          path.join(release, 'runtime.cjs'),
          'start',
          '--database',
          database,
          '--port',
          '4000',
          '--production',
        ].join(' ');
    const policy = {
      format: 1,
      mode: admission.MODE,
      scopeId: crypto.randomUUID(),
      approval: {
        confirmed: true,
        id: 'synthetic-only',
        operations: ['install', 'publish', 'rollback'],
        candidateCommit: specs.find((s) => s.id === 'candidate').sourceCommit,
        rollbackCommit: specs.find((s) => s.id === 'rollback').sourceCommit,
      },
      limits: admission.LIMITS,
      codePins: admission.codePins(),
      roots: [root, sources, audits].map((at) => ({
        path: fs.realpathSync.native(at),
        identity: identity(at),
      })),
      registryDirectory: fs.realpathSync.native(registry),
      registryIdentity: identity(registry),
      installRoot: fs.realpathSync.native(root),
      currentId: 'current',
      heldId: 'held',
      pointerSha256: fileHash(path.join(root, 'active.json')),
      legacyIds: ['held'],
      protectedPackages: specs,
      protectedIds: specs.map((s) => s.id),
      packageProofs: Object.fromEntries(
        specs.map((s) => [s.id, s.manifestSha256]),
      ),
      pair: ['candidate', 'rollback'].map((role) => ({
        role,
        id: role,
        source: specs.find((s) => s.id === role).path,
        target: path.join(root, role),
      })),
      compatibilityProofSha256: fileHash(proof),
      windowsReferences: { compatibilityProof: pin(proof) },
      probe: pin(path.join(__dirname, 'windows-release-references.cjs')),
      publication: {
        format: 1,
        limits: publication.allowance(1024 * 1024),
        auditRoot: path.join(audits, 'one-upgrade'),
        database: fs.realpathSync.native(database),
        databaseIdentity: identity(database),
        expected: {
          pid: 10,
          startUtc: '2026-10-15T00:00:00Z',
          executable,
          commandLine: line(path.join(root, 'current')),
          port: 4000,
        },
        python: pin(executable),
        schemaEngine: pin(executable),
        powershellSha256:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        environmentFiles: [],
        expectedChildren: [],
        pendingMigrations: ['additive'],
        allowedNewTables: ['new_table'],
        health: {
          rssItems: 20,
          rssPath: '/feeds/fixture.rss?limit=20&mode=summary',
        },
      },
    };
    const file = path.join(base, 'policy.json');
    fs.writeFileSync(file, JSON.stringify(policy));
    let service = { ...policy.publication.expected },
      next = 100,
      backupCount = 0;
    const events = [];
    const initial = JSON.parse(fs.readFileSync(database));
    const f = {
      base,
      root,
      file,
      policy,
      database,
      events,
      initial,
      failAt: null,
      facts() {
        return {
          complete: true,
          categories: Object.fromEntries(
            [
              'processes',
              'tasks',
              'shortcuts',
              'pointers',
              'rollback',
              'inflight',
            ].map((k) => [k, true]),
          ),
          records: [],
          errors: [],
          uncertainChildren: [],
          compatibility: {
            verified: true,
            businessDatabaseRestored: false,
            proofSha256: policy.compatibilityProofSha256,
          },
        };
      },
      operations: {
        identity(action, pid, expected) {
          events.push(action);
          if (['AuxiliarySnapshot', 'WaitAuxiliary'].includes(action))
            return {
              format: 1,
              verifiedCount: policy.publication.expectedChildren.length,
              exited: action === 'WaitAuxiliary',
              remainingPids: [],
            };
          if (action === 'Port')
            return service ? [{ OwningProcess: service.pid }] : [];
          assert.equal(service?.pid, pid);
          if (action === 'Stop') {
            assert.deepEqual(expected, service);
            const result = { ...service, stopped: true };
            service = null;
            return result;
          }
          return { ...service };
        },
        backup() {
          events.push('backup');
          const dir = path.join(
            policy.publication.auditRoot,
            'backups',
            'b' + ++backupCount,
          );
          fs.mkdirSync(dir, { recursive: true });
          const backup = path.join(dir, 'snapshot.db');
          fs.copyFileSync(database, backup);
          return {
            backup,
            sha256: fileHash(backup),
            integrityCheck: 'ok',
            recoveryOrigin: { kind: 'protected' },
          };
        },
        state(db, baseline) {
          const value = JSON.parse(fs.readFileSync(db));
          if (baseline) {
            const before = JSON.parse(fs.readFileSync(baseline));
            for (const [key, val] of Object.entries(before))
              assert.deepEqual(value[key], val);
          }
          return value;
        },
        inspect(_, db, current) {
          events.push('inspect');
          if (f.failAt === 'after-stop' && !current)
            throw Error('SYNTHETIC_SWITCH_FAILURE');
          return { pending: current ? [] : ['additive'] };
        },
        async migrate() {
          events.push('migrate');
          const value = JSON.parse(fs.readFileSync(database));
          value.new_table = [];
          fs.writeFileSync(database, JSON.stringify(value));
          if (f.failAt === 'migration')
            throw Error('SYNTHETIC_MIGRATION_FAILURE');
          return { appliedMigrationNames: ['additive'] };
        },
        start(release) {
          events.push('start:' + path.basename(release));
          assert(!service);
          const child = { pid: ++next, exitCode: null, unref() {} };
          service = {
            pid: child.pid,
            startUtc: '2026-10-15T01:00:00Z',
            executable: path.join(release, 'runtime/node.exe'),
            commandLine: line(release),
            port: 4000,
          };
          return child;
        },
        async ready() {
          events.push('ready');
          if (
            f.failAt === 'candidate-health' &&
            path.dirname(service.executable).includes('candidate')
          )
            throw Error('SYNTHETIC_HEALTH_FAILURE');
          return { writesAllowed: true, rssItems: 20 };
        },
        async stopChild(child) {
          events.push('stop-child');
          if (child && service?.pid === child.pid) service = null;
        },
      },
      async execute(rollback = false) {
        const digest = fileHash(file);
        const cp = require('node:child_process'),
          saved = cp.execFileSync;
        cp.execFileSync = (exe, args) => {
          assert.equal(exe, process.execPath);
          assert.deepEqual(args, [
            policy.probe.path,
            fs.realpathSync.native(file),
          ]);
          return JSON.stringify(f.facts());
        };
        try {
          return await publication.execute(file, digest, {
            rollback,
            operations: f.operations,
            query: () => f.facts(),
          });
        } finally {
          cp.execFileSync = saved;
        }
      },
      backupCount: () => backupCount,
      service: () => service,
    };
    await run(f);
  } finally {
    assert(path.basename(base).startsWith('wewe-publish-pair-'));
    fs.rmSync(base, { recursive: true });
  }
}
test('full narrow deploy installs exact pair, preserves data and held fallback, publishes after health', () =>
  fixture(async (f) => {
    const held = fingerprint(path.join(f.root, 'held'));
    const result = await f.execute();
    assert.equal(result.status, 'passed');
    assert.equal(f.backupCount(), 1);
    assert(f.events.indexOf('Stop') < f.events.indexOf('backup'));
    assert(f.events.indexOf('Port') < f.events.indexOf('backup'));
    assert.deepEqual(
      f.events.filter((e) => e.startsWith('start:')),
      ['start:candidate'],
    );
    assert.deepEqual(fingerprint(path.join(f.root, 'held')), held);
    const data = JSON.parse(fs.readFileSync(f.database));
    assert.deepEqual(data.articles, f.initial.articles);
    assert.deepEqual(data.claims, f.initial.claims);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.root, 'active.json'))).id,
      'candidate',
    );
    assert(
      fs.existsSync(path.join(f.policy.publication.auditRoot, 'passed.json')),
    );
  }));
test('installation succeeds then failed switch before migration restores current service without restoring DB', () =>
  fixture(async (f) => {
    f.failAt = 'after-stop';
    const result = await f.execute();
    assert.equal(result.status, 'rolled-back');
    assert.equal(result.databaseRestored, false);
    assert.deepEqual(
      f.events.filter((e) => e.startsWith('start:')),
      ['start:current'],
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(f.database)), f.initial);
    assert(fs.existsSync(path.join(f.root, 'candidate/release.json')));
  }));
test('post-migration candidate failure starts compatible rollback and preserves attempted unknown claims', () =>
  fixture(async (f) => {
    f.failAt = 'candidate-health';
    const result = await f.execute();
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual(
      f.events.filter((e) => e.startsWith('start:')),
      ['start:candidate', 'start:rollback'],
    );
    const value = JSON.parse(fs.readFileSync(f.database));
    assert.deepEqual(value.claims, f.initial.claims);
    assert.deepEqual(value.new_table, []);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.root, 'active.json'))).id,
      'rollback',
    );
  }));
test('migration error uses compatible fallback on the live partially migrated database', () =>
  fixture(async (f) => {
    f.failAt = 'migration';
    const result = await f.execute();
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual(
      f.events.filter((e) => e.startsWith('start:')),
      ['start:rollback'],
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(f.database)).new_table, []);
  }));
test('explicit rollback preserves later writes in the same DB without another backup; repeats reuse the pair', () =>
  fixture(async (f) => {
    await f.execute();
    const ids = ['candidate', 'rollback'].map((id) =>
      identity(path.join(f.root, id)),
    );
    const deployed = await f.execute();
    assert(deployed.reused);
    assert.equal(f.backupCount(), 1);
    const later = JSON.parse(fs.readFileSync(f.database));
    later.claims.push({
      id: 2,
      accepted: true,
      attempted: true,
      unknown: true,
    });
    fs.writeFileSync(f.database, JSON.stringify(later));
    const originalBackup = path.join(
      f.policy.publication.auditRoot,
      'backups/b1/snapshot.db',
    );
    const backupSha = fileHash(originalBackup);
    assert.equal(JSON.parse(fs.readFileSync(originalBackup)).claims.length, 1);
    const result = await f.execute(true);
    assert.equal(result.status, 'rolled-back');
    assert.equal(f.backupCount(), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.database)), later);
    assert.equal(fileHash(originalBackup), backupSha);
    assert((await f.execute(true)).reused);
    assert((await f.execute()).reused);
    assert.equal(f.backupCount(), 1);
    assert.deepEqual(
      ['candidate', 'rollback'].map((id) => identity(path.join(f.root, id))),
      ids,
    );
  }));
test('combined reservation shortage rejects before installation, metadata, backup or stop', () =>
  fixture(async (f) => {
    const saved = fs.statfsSync;
    fs.statfsSync = (...args) => ({
      ...saved(...args),
      bsize: 1n,
      bavail: BigInt(
        4 * 1024 ** 3 +
          admission.LIMITS.bytes +
          f.policy.publication.limits.additionalBytes -
          1,
      ),
    });
    try {
      await assert.rejects(f.execute(), /PHYSICAL_RESERVE/);
    } finally {
      fs.statfsSync = saved;
    }
    assert.deepEqual(f.events, []);
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
    assert.deepEqual(fs.readdirSync(f.policy.registryDirectory), []);
  }));
test('observation cannot obtain publication capability and install-only approval cannot publish', () =>
  fixture(async (f) => {
    await assert.rejects(
      hostEffects.context.run(
        {
          assertWritable() {
            throw Error('observation');
          },
        },
        () => f.execute(),
      ),
      /OBSERVATION_OR_NESTED/,
    );
    delete f.policy.approval.operations;
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    await assert.rejects(f.execute(), /EXPLICIT_OPERATIONS/);
    assert.deepEqual(f.events, []);
  }));
for (const kind of [
  'ledger-replaced',
  'ledger-in-place',
  'same-token-lock',
  'policy-replaced',
  'registry-replaced',
])
  test('publication preserves foreign authority: ' + kind, () =>
    fixture(async (f) => {
      const original = f.operations.identity;
      let foreign,
        bytes,
        changed = false;
      f.operations.identity = (...args) => {
        const result = original(...args);
        if (args[0] === 'Snapshot' && !changed) {
          changed = true;
          const registry = f.policy.registryDirectory,
            ledger = path.join(registry, f.policy.scopeId + '.state.json'),
            lock = path.join(registry, f.policy.scopeId + '.lock');
          if (kind === 'ledger-replaced') {
            fs.renameSync(ledger, ledger + '.prior');
            fs.writeFileSync(ledger, 'FOREIGN_PUBLICATION_LEDGER');
            foreign = ledger;
          }
          if (kind === 'ledger-in-place') {
            fs.writeFileSync(ledger, 'FOREIGN_PUBLICATION_IN_PLACE');
            foreign = ledger;
          }
          if (kind === 'same-token-lock') {
            const text = fs.readFileSync(lock);
            fs.renameSync(lock, lock + '.prior');
            fs.writeFileSync(lock, text);
            foreign = ledger;
          }
          if (kind === 'policy-replaced') {
            fs.renameSync(f.file, f.file + '.prior');
            fs.copyFileSync(f.file + '.prior', f.file);
            foreign = ledger;
          }
          if (kind === 'registry-replaced') {
            fs.renameSync(registry, registry + '.prior');
            fs.mkdirSync(registry);
            fs.writeFileSync(ledger, 'FOREIGN_PUBLICATION_REGISTRY');
            foreign = ledger;
          }
          bytes = fs.readFileSync(foreign);
        }
        return result;
      };
      await assert.rejects(f.execute());
      assert(changed);
      assert.deepEqual(fs.readFileSync(foreign), bytes);
      assert(!f.events.includes('Stop'));
      assert.equal(f.service().pid, 10);
    }),
  );
test('capacity loss after migration releases unused primary reservation for bounded compatible recovery', () =>
  fixture(async (f) => {
    const saved = fs.statfsSync,
      original = f.operations.migrate;
    f.operations.migrate = async (...args) => {
      const result = await original(...args);
      fs.statfsSync = (...argv) => ({
        ...saved(...argv),
        bsize: 1n,
        bavail: BigInt(4 * 1024 ** 3 + 70 * 1024 ** 2),
      });
      return result;
    };
    try {
      const result = await f.execute();
      assert.equal(result.status, 'rolled-back');
      assert.deepEqual(
        f.events.filter((e) => e.startsWith('start:')),
        ['start:rollback'],
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(f.database)).claims,
        f.initial.claims,
      );
    } finally {
      fs.statfsSync = saved;
    }
  }));
test('an approval bound to another application commit cannot publish a new frozen candidate', () =>
  fixture(async (f) => {
    f.policy.approval.candidateCommit = 'd'.repeat(40);
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    await assert.rejects(f.execute(), /APPLICATION_APPROVAL_BINDING/);
    assert.deepEqual(f.events, []);
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
  }));

// Compile the private native adapter only for this owned-fixture test. Native
// process imports are replaced explicitly; no fallback to real child_process.
function captureStarts(f) {
  const sourceFile = require.resolve('./once-pair-publication.cjs');
  const systemRoot = path.join(f.base, 'system-root');
  const powershell = path.join(
    systemRoot,
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  fs.mkdirSync(path.dirname(powershell), { recursive: true });
  fs.writeFileSync(powershell, 'inert-native-command-never-executed');
  f.policy.publication.powershellSha256 = fileHash(powershell);
  const envFile = path.join(path.dirname(f.root), 'apps/server/.env.local');
  const enabled =
    'ENABLE_SCHEDULED_UPDATES=1\nDISABLE_SCHEDULED_UPDATES=0\nWECHAT2RSS_ENABLED=1\nWECHAT2RSS_CACHE_SYNC=1\n';
  fs.writeFileSync(envFile, enabled);
  f.policy.publication.environmentFiles = [
    { path: envFile, sha256: fileHash(envFile) },
  ];
  fs.writeFileSync(f.file, JSON.stringify(f.policy));
  const starts = [],
    load = createRequire(sourceFile);
  const mockRequire = (name) => {
    if (name === 'node:child_process')
      return {
        execFileSync(executable, args) {
          assert.equal(executable, powershell);
          assert.equal(args[args.indexOf('-Action') + 1], 'Port');
          return '[]';
        },
        spawn(executable, args, options) {
          starts.push({ executable, args, env: options.env });
          return new EventEmitter();
        },
      };
    return load(name);
  };
  const factory = new Function(
    'require',
    '__dirname',
    'module',
    fs.readFileSync(sourceFile, 'utf8') + '\nreturn nativeOperations;',
  )(mockRequire, __dirname, { exports: {} });
  const originalRoot = process.env.SystemRoot,
    originalStart = f.operations.start;
  process.env.SystemRoot = systemRoot;
  const native = factory(
    f.policy,
    f.policy.publication,
    f.policy.publication.auditRoot,
    () => {},
  );
  f.operations.start = (release, options) => {
    native.start(release, options);
    return originalStart(release, options);
  };
  return {
    starts,
    enabled,
    envFile,
    restore() {
      f.operations.start = originalStart;
      if (originalRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalRoot;
    },
  };
}

for (const explicit of [false, true])
  test(
    (explicit ? 'explicit' : 'automatic') +
      ' recovery overrides inherited enabled upstream and scheduling after environment load',
    () =>
      fixture(async (f) => {
        const captured = captureStarts(f);
        try {
          if (!explicit) f.failAt = 'candidate-health';
          const result = await f.execute();
          assert.equal(result.status, explicit ? 'passed' : 'rolled-back');
          if (explicit)
            assert.equal((await f.execute(true)).status, 'rolled-back');
          assert.equal(captured.starts.length, 2);
          const [candidate, recovery] = captured.starts;
          assert(
            candidate.executable.includes(path.sep + 'candidate' + path.sep),
          );
          assert(
            recovery.executable.includes(path.sep + 'rollback' + path.sep),
          );
          assert.equal(candidate.env.ENABLE_SCHEDULED_UPDATES, '1');
          assert.equal(candidate.env.DISABLE_SCHEDULED_UPDATES, '0');
          assert.equal(candidate.env.WECHAT2RSS_ENABLED, '1');
          assert.equal(candidate.env.WECHAT2RSS_CACHE_SYNC, '1');
          assert.equal(recovery.env.ENABLE_SCHEDULED_UPDATES, '0');
          assert.equal(recovery.env.DISABLE_SCHEDULED_UPDATES, '1');
          assert.equal(recovery.env.WECHAT2RSS_ENABLED, '0');
          assert.equal(recovery.env.WECHAT2RSS_CACHE_SYNC, '0');
          const schedule = require('./runtime.cjs').scheduledUpdatesEnabled;
          const manifest = {
            schemaCompatibility: 'current',
            desktopHelperIncluded: false,
          };
          assert(
            schedule(manifest, {
              enabled: candidate.env.ENABLE_SCHEDULED_UPDATES,
              mp2RssFeedKey: 'synthetic-config',
            }),
          );
          assert(
            !schedule(manifest, {
              enabled: recovery.env.ENABLE_SCHEDULED_UPDATES,
              mp2RssFeedKey: 'synthetic-config',
            }),
          );
          assert.equal(
            fs.readFileSync(captured.envFile, 'utf8'),
            captured.enabled,
          );
        } finally {
          captured.restore();
        }
      }),
  );

test('pre-migration current recovery also disables inherited upstream and scheduling', () =>
  fixture(async (f) => {
    const captured = captureStarts(f);
    try {
      f.failAt = 'after-stop';
      assert.equal((await f.execute()).status, 'rolled-back');
      assert.equal(captured.starts.length, 1);
      const recovery = captured.starts[0];
      assert(recovery.executable.includes(path.sep + 'current' + path.sep));
      assert.equal(recovery.env.ENABLE_SCHEDULED_UPDATES, '0');
      assert.equal(recovery.env.DISABLE_SCHEDULED_UPDATES, '1');
      assert.equal(recovery.env.WECHAT2RSS_ENABLED, '0');
      assert.equal(recovery.env.WECHAT2RSS_CACHE_SYNC, '0');
      assert.equal(fs.readFileSync(captured.envFile, 'utf8'), captured.enabled);
      assert(!f.events.includes('migrate'));
    } finally {
      captured.restore();
    }
  }));

for (const nested of [false, true])
  test(`audit ${nested ? 'intervening' : 'policy-root'} parent replacement preserves the leaf but refuses before stop`, () =>
    fixture(async (f) => {
      if (nested) {
        const parent = path.join(
          path.dirname(f.policy.publication.auditRoot),
          'nested',
        );
        fs.mkdirSync(parent);
        f.policy.publication.auditRoot = path.join(parent, 'one-upgrade');
        fs.writeFileSync(f.file, JSON.stringify(f.policy));
      }
      const snapshot = f.operations.identity;
      let replaced = false,
        leaf;
      f.operations.identity = (...args) => {
        const result = snapshot(...args);
        if (args[0] === 'Snapshot' && !replaced) {
          replaced = true;
          const audit = f.policy.publication.auditRoot,
            parent = path.dirname(audit);
          leaf = identity(audit);
          fs.renameSync(parent, parent + '.prior');
          fs.mkdirSync(parent);
          fs.renameSync(
            path.join(parent + '.prior', path.basename(audit)),
            audit,
          );
          fs.writeFileSync(
            path.join(parent, 'foreign-parent-marker'),
            'FOREIGN_PARENT',
          );
          assert.deepEqual(identity(audit), leaf);
        }
        return result;
      };
      await assert.rejects(f.execute(), /OWNER_OR_INPUT_CHANGED/);
      assert(replaced);
      assert(!f.events.includes('Stop'));
      assert(!f.events.some((e) => e.startsWith('start:')));
      assert(
        fs.existsSync(
          path.join(f.policy.registryDirectory, f.policy.scopeId + '.lock'),
        ),
      );
      assert.equal(
        fs.readFileSync(
          path.join(
            path.dirname(f.policy.publication.auditRoot),
            'foreign-parent-marker',
          ),
          'utf8',
        ),
        'FOREIGN_PARENT',
      );
    }));

for (const kind of ['replacement', 'in-place', 'same-bytes-replacement'])
  test(`active pointer ${kind} after rename cannot be blessed or overwritten by fallback`, () =>
    fixture(async (f) => {
      const pointer = path.join(f.root, 'active.json'),
        rename = fs.renameSync;
      let replaced = false,
        foreign;
      fs.renameSync = (from, to) => {
        const out = rename(from, to);
        if (to === pointer && !replaced) {
          replaced = true;
          foreign =
            kind === 'same-bytes-replacement'
              ? fs.readFileSync(pointer)
              : Buffer.from(JSON.stringify({ format: 1, id: 'held' }) + '\n');
          if (kind !== 'in-place') rename(pointer, pointer + '.foreign-prior');
          fs.writeFileSync(pointer, foreign);
        }
        return out;
      };
      try {
        await assert.rejects(f.execute(), /OWNER_OR_INPUT_CHANGED/);
      } finally {
        fs.renameSync = rename;
      }
      assert(replaced);
      assert.deepEqual(fs.readFileSync(pointer), foreign);
      assert.deepEqual(
        f.events.filter((e) => e.startsWith('start:')),
        ['start:candidate'],
      );
      assert(!f.events.includes('stop-child'));
      assert(
        !fs.existsSync(
          path.join(f.policy.publication.auditRoot, 'passed.json'),
        ),
      );
      const registry = f.policy.registryDirectory;
      assert(fs.existsSync(path.join(registry, f.policy.scopeId + '.lock')));
      const state = JSON.parse(
        fs.readFileSync(path.join(registry, f.policy.scopeId + '.state.json')),
      ).payload;
      assert.equal(state.publication.status, 'running');
      assert(state.claim);
    }));

test('completed replay refuses a same-bytes replacement of the published pointer', () =>
  fixture(async (f) => {
    assert.equal((await f.execute()).status, 'passed');
    const pointer = path.join(f.root, 'active.json'),
      bytes = fs.readFileSync(pointer),
      count = f.events.length;
    fs.renameSync(pointer, pointer + '.prior');
    fs.writeFileSync(pointer, bytes);
    await assert.rejects(f.execute(), /REPLAY_POINTER_CHANGED/);
    assert.equal(f.events.length, count);
    assert.deepEqual(fs.readFileSync(pointer), bytes);
  }));

test('single-backup and installation allowances match the fixed reviewed ceilings', () => {
  const limit = publication.allowance(805306368);
  assert.equal(admission.LIMITS.bytes, 245837824);
  assert.equal(admission.LIMITS.copy, 244789248);
  assert.equal(admission.LIMITS.metadata, 1048576);
  assert.equal(limit.backupBytes, 1611661312);
  assert.equal(limit.migrationBytes, 872415232);
  assert.equal(limit.auditBytes, 16777216);
  assert.equal(limit.maxBackups, 1);
  assert.equal(admission.LIMITS.bytes + limit.additionalBytes, 2746691584);
  assert.equal(
    admission.LIMITS.free + admission.LIMITS.bytes + limit.additionalBytes,
    7041658880,
  );
  assert.throws(
    () => publication.allowance(805306368 + 4096),
    /SOURCE_CEILING/,
  );
});

test('an older multi-backup publication allowance is refused before install or stop', () =>
  fixture(async (f) => {
    f.policy.publication.limits.maxBackups = 3;
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    await assert.rejects(f.execute(), /FINITE_ALLOWANCE/);
    assert.deepEqual(f.events, []);
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
  }));

test('operation coverage is accepted by the exact install, publish and same-DB rollback call sites', () =>
  fixture(async (f) => {
    const scope = {
      format: 1,
      kind: 'non-retiring-once-pair-v1',
      preserveLegacy: true,
      globalReferenceComplete: false,
      uninspectedProfiles: [],
    };
    f.policy.windowsReferences.operationCoverage = scope;
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    const facts = f.facts;
    f.facts = () => {
      const r = facts();
      return {
        ...r,
        complete: false,
        globalReferenceComplete: false,
        operationSufficient: true,
        categories: { ...r.categories, shortcuts: false },
        operationCoverage: {
          kind: scope.kind,
          contractSha256: crypto
            .createHash('sha256')
            .update(JSON.stringify(scope))
            .digest('hex'),
          startupComplete: true,
          pinnedLaunchersVerified: true,
          uninspectedProfiles: [],
          uninspectedStaticJunctions: [],
        },
      };
    };
    assert.equal((await f.execute()).status, 'passed');
    assert.equal((await f.execute(true)).status, 'rolled-back');
    assert.equal(f.backupCount(), 1);
    assert.equal(f.events.filter((e) => e === 'migrate').length, 1);
  }));

for (const mode of ['success', 'timeout', 'identity-changed'])
  test(`exact parent-bound auxiliary processes ${mode} before the only backup`, () =>
    fixture(async (f) => {
      f.policy.publication.expectedChildren = [
        'watch-wechat2rss-cache.py',
        'sqlite-snapshot-guard.py',
      ].map((script, index) => ({
        pid: 21 + index,
        parentPid: 10,
        startUtc: '2026-10-15T00:00:01.0000000Z',
        executable: f.policy.publication.python.path,
        commandLine:
          'python ' + path.join(f.root, 'current/server/scripts', script),
      }));
      fs.writeFileSync(f.file, JSON.stringify(f.policy));
      const original = f.operations.identity;
      f.operations.identity = (action, ...args) => {
        if (mode === 'timeout' && action === 'WaitAuxiliary')
          throw Error('SYNTHETIC_AUX_TIMEOUT');
        if (mode === 'identity-changed' && action === 'AuxiliarySnapshot')
          throw Error('SYNTHETIC_AUX_IDENTITY');
        return original(action, ...args);
      };
      if (mode === 'success') {
        assert.equal((await f.execute()).status, 'passed');
        assert(
          f.events.indexOf('AuxiliarySnapshot') < f.events.indexOf('Stop'),
        );
        assert(f.events.indexOf('Stop') < f.events.indexOf('WaitAuxiliary'));
        assert(f.events.indexOf('WaitAuxiliary') < f.events.indexOf('backup'));
        assert.equal(f.backupCount(), 1);
      } else {
        await assert.rejects(f.execute(), /SYNTHETIC_AUX_/);
        assert.equal(f.backupCount(), 0);
        assert(!f.events.includes('migrate'));
        assert(!f.events.some((e) => e.startsWith('start:')));
        assert.equal(f.events.includes('Stop'), mode === 'timeout');
      }
    }));

test('failed backup spends the only attempt, preserves its partial output, and restores current without migration', () =>
  fixture(async (f) => {
    const original = f.operations.backup;
    let attempts = 0,
      partial;
    f.operations.backup = (...args) => {
      attempts++;
      partial = original(...args).backup;
      fs.writeFileSync(partial, 'SYNTHETIC_FAILED_BACKUP');
      throw Error('SYNTHETIC_BACKUP_FAILED');
    };
    const result = await f.execute();
    assert.equal(result.status, 'rolled-back');
    assert.equal(result.backups, 1);
    assert.equal(result.databaseRestored, false);
    assert.equal(attempts, 1);
    assert(!f.events.includes('migrate'));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.database)), f.initial);
    assert.deepEqual(
      f.events.filter((e) => e.startsWith('start:')),
      ['start:current'],
    );
    assert.equal(fs.readFileSync(partial, 'utf8'), 'SYNTHETIC_FAILED_BACKUP');
    assert((await f.execute()).reused);
    assert((await f.execute(true)).reused);
    assert.equal(attempts, 1);
  }));

test('backup baseline mismatch cannot migrate or consume a second attempt', () =>
  fixture(async (f) => {
    const original = f.operations.backup;
    f.operations.backup = (...args) => {
      const b = original(...args);
      fs.writeFileSync(b.backup, JSON.stringify({ ...f.initial, claims: [] }));
      return { ...b, sha256: fileHash(b.backup) };
    };
    assert.equal((await f.execute()).status, 'rolled-back');
    assert.equal(f.backupCount(), 1);
    assert(!f.events.includes('migrate'));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.database)), f.initial);
    assert(f.events.includes('start:current'));
  }));

test('unconfirmed stop with a live old writer never creates a backup', () =>
  fixture(async (f) => {
    const identity = f.operations.identity;
    f.operations.identity = (action, ...args) =>
      action === 'Stop'
        ? { ...f.service(), stopped: false }
        : identity(action, ...args);
    await assert.rejects(f.execute(), /STOP_UNCONFIRMED/);
    assert.equal(f.backupCount(), 0);
    assert(!f.events.includes('migrate'));
    assert.equal(f.service().pid, 10);
    assert(!f.events.some((e) => e.startsWith('start:')));
  }));

for (const timing of ['after-stop', 'after-backup'])
  test(`a foreign writer ${timing} holds before migration without a second snapshot`, () =>
    fixture(async (f) => {
      const identity = f.operations.identity,
        backup = f.operations.backup;
      let busy = timing === 'after-stop';
      f.operations.identity = (action, ...args) =>
        action === 'Port' && busy
          ? [{ OwningProcess: 999 }]
          : identity(action, ...args);
      f.operations.backup = (...args) => {
        const b = backup(...args);
        busy = true;
        return b;
      };
      const start = f.operations.start;
      f.operations.start = (...args) => {
        if (busy) throw Error('SYNTHETIC_PORT_BUSY');
        return start(...args);
      };
      await assert.rejects(f.execute(), /WRITERS_NOT_STOPPED/);
      assert.equal(f.backupCount(), timing === 'after-stop' ? 0 : 1);
      assert(!f.events.includes('migrate'));
      assert(!f.events.some((e) => e.startsWith('start:')));
      const ledger = JSON.parse(
        fs.readFileSync(
          path.join(
            f.policy.registryDirectory,
            f.policy.scopeId + '.state.json',
          ),
        ),
      ).payload;
      assert.equal(ledger.publication.status, 'held');
      assert(ledger.claim);
      await assert.rejects(
        f.execute(),
        /INSTALLATION_NOT_COMPLETE|INTERRUPTED_PUBLICATION_HELD/,
      );
      assert.equal(f.backupCount(), timing === 'after-stop' ? 0 : 1);
    }));

test('empty port alone is insufficient when the complete reference query retains another package process', () =>
  fixture(async (f) => {
    const facts = f.facts;
    f.facts = () => ({
      ...facts(),
      records: f.events.includes('Stop')
        ? [
            {
              kind: 'processes',
              packageId: 'held',
              packagePath: path.join(f.root, 'held'),
              identity: 'synthetic-other-writer',
              pid: 999,
              startUtc: 'synthetic',
              executableSha256: 'a'.repeat(64),
            },
          ]
        : [],
    });
    f.operations.start = () => {
      throw Error('SYNTHETIC_WRITER_PRESENT');
    };
    await assert.rejects(f.execute(), /WRITERS_NOT_STOPPED/);
    assert.equal(f.backupCount(), 0);
    assert(!f.events.includes('migrate'));
    assert(!f.events.some((e) => e.startsWith('start:')));
  }));
