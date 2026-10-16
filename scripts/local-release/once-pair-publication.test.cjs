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
const fixedMaintenance = require('./fixed-maintenance.cjs');
async function maintenanceFixture(run) {
  return fixture(async (f) => {
    const rollbackFile = path.join(f.base, 'synthetic-rollback.json');
    fs.writeFileSync(
      rollbackFile,
      JSON.stringify({
        format: 1,
        packages: [f.policy.protectedPackages.find((s) => s.id === 'rollback')],
      }),
    );
    const startup = ['Startup', 'CommonStartup'].map((kind) => {
      const at = path.join(f.base, kind);
      fs.mkdirSync(at);
      return { kind, path: at, identity: identity(at), status: 'enumerated' };
    });
    Object.assign(f.policy.windowsReferences, {
      format: 1,
      packages: f.policy.protectedPackages.map(({ id, path }) => ({
        id,
        path,
      })),
      launchers: [],
      rollbackFiles: [{ path: rollbackFile, sha256: fileHash(rollbackFile) }],
      operationCoverage: {
        format: 1,
        kind: 'non-retiring-once-pair-v1',
        staticScopeMode: 'startup-and-pinned-launchers-v1',
        preserveLegacy: true,
        globalReferenceComplete: false,
        uninspectedProfiles: [],
        processCoverage: {
          format: 1,
          kind: 'once-related-processes-v1',
          globalDbWriterExclusion: false,
          coverageClaim:
            'related-processes-only;uninspected-background-db-access-unproven',
          backgroundGaps: [],
        },
      },
    });
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    f.observation = (p, r) => {
      const quote = (s) => '"' + s + '"',
        svc = f.service();
      const rows = [
        {
          pid: process.pid,
          parentPid: 1,
          name: 'node.exe',
          executable: process.execPath,
          commandLine: [
            process.execPath,
            path.join(__dirname, 'fixed-maintenance.cjs'),
            '--execute',
            f.file,
            fileHash(f.file),
          ]
            .map(quote)
            .join(' '),
          startUtc: '2026-10-16T00:00:00.000Z',
        },
      ];
      if (svc)
        rows.push({
          ...svc,
          parentPid: svc.pid === p.publication.expected.pid ? 1 : process.pid,
          name: 'node.exe',
        });
      return {
        format: 1,
        complete: false,
        globalReferenceComplete: false,
        operationSufficient: true,
        categories: { processes: true, tasks: true, shortcuts: false },
        errors: [],
        policySha256: fileHash(f.file),
        processesBefore: structuredClone(rows),
        processesAfter: structuredClone(rows),
        processCoverage: {
          format: 1,
          port: 4000,
          listenersBefore: svc
            ? [{ port: 4000, pid: svc.pid, address: '127.0.0.1' }]
            : [],
          listenersAfter: svc
            ? [{ port: 4000, pid: svc.pid, address: '127.0.0.1' }]
            : [],
        },
        tasks: [],
        tasksAfter: [],
        shortcuts: [],
        shortcutDirectories: startup.map((s) => ({
          path: s.path,
          identity: s.identity,
          entries: [],
        })),
        shortcutCoverage: [
          ...['Desktop', 'CommonDesktop', 'StartMenu', 'CommonStartMenu'].map(
            (kind) => ({
              kind,
              status: 'not-inspected-operation-scope',
              inspected: false,
              reason: 'outside-non-retiring-operation',
            }),
          ),
          ...startup,
        ],
        operationCoverage: {
          kind: 'non-retiring-once-pair-v1',
          staticScopeMode: 'startup-and-pinned-launchers-v1',
          profilesBefore: [],
          profilesAfter: [],
          staticJunctions: [],
        },
      };
    };
    const facts = f.facts;
    f.facts = () => ({
      ...facts(),
      complete: false,
      errors: ['REFERENCE_BACKGROUND_GAP_UNBOUND'],
    });
    await assert.rejects(f.execute(), /REFERENCE_QUERY_INCOMPLETE/);
    const ledger = path.join(
      f.policy.registryDirectory,
      f.policy.scopeId + '.state.json',
    );
    const spec = (at) => ({
      path: fs.realpathSync.native(at),
      sha256: fileHash(at),
      identity: identity(at),
    });
    const previous = path.join(f.base, 'previous-policy.json'),
      outcome = path.join(f.base, 'outcome.json');
    fs.copyFileSync(f.file, previous);
    fs.writeFileSync(
      outcome,
      JSON.stringify({
        outcome: 'HELD_BEFORE_PACKAGE_COPY',
        executionPolicySha256: fileHash(previous),
      }),
    );
    const c = {
      format: 1,
      kind: 'verified-pre-copy-continuation-v1',
      id: crypto.randomUUID(),
      previousPolicy: spec(previous),
      previousLedger: spec(ledger),
      previousSentinel: spec(ledger + '.adopted'),
      previousOutcome: spec(outcome),
    };
    f.policy.preCopyContinuation = c;
    f.policy.approval.id += '-continuation';
    f.policy.approval.continuation = {
      id: c.id,
      fromConfigSha: c.previousPolicy.sha256,
      fromLedgerSha: c.previousLedger.sha256,
      fromSentinelSha: c.previousSentinel.sha256,
    };
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    await assert.rejects(f.execute(), /REFERENCE_QUERY_INCOMPLETE/);
    assert.equal(
      JSON.parse(fs.readFileSync(ledger)).payload.continuationAttempt.status,
      'held',
    );
    const source = path.join(f.base, 'held-policy.json');
    fs.copyFileSync(f.file, source);
    const sourceFiles = {
      ledger: spec(ledger),
      adopted: spec(ledger + '.adopted'),
      continuation: spec(admission.continuationPath(f.policy)),
    };
    f.policy.maintenance = {
      format: 1,
      kind: fixedMaintenance.KIND,
      planPath: fs.realpathSync.native(f.file),
      sourcePolicy: spec(source),
      sourceFiles,
      toolPins: fixedMaintenance.toolPins(),
      approval: { id: 'synthetic-maintenance', confirmed: true },
    };
    f.facts = facts;
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    f.maintenance = () =>
      fixedMaintenance.execute(f.file, fileHash(f.file), {
        operations: f.operations,
        query: (p, r) => {
          const lock = JSON.parse(
            fs.readFileSync(
              path.join(p.registryDirectory, p.scopeId + '.lock'),
            ),
          );
          fixedMaintenance.validateOwner(
            p,
            fileHash(f.file),
            lock,
            r,
            process.pid,
          );
          f.queryHook?.(p, r);
          if (f.parserQuery) return f.parserQuery(p, r);
          return {
            ...f.facts(),
            maintenanceOwner: {
              kind: fixedMaintenance.KIND,
              configSha: fileHash(f.file),
              nonce: r.nonce,
              recordSha256: lock.recordPin.sha256,
              recordIdentity: lock.recordPin.identity,
            },
          };
        },
      });
    f.maintenanceRecord = () =>
      JSON.parse(fs.readFileSync(fixedMaintenance.recordPath(f.policy)))
        .payload;
    const originals = Object.values(sourceFiles).map((s) => ({
      s,
      text: fs.readFileSync(s.path),
    }));
    try {
      await run(f);
    } finally {
      for (const { s, text } of originals)
        assert.deepEqual(
          fs.readFileSync(s.path),
          text,
          'old authority unchanged',
        );
      assert(f.backupCount() <= 1);
      assert(
        f.events.filter((e) => e === 'start:rollback' || e === 'start:current')
          .length <= 1,
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(f.database)).articles,
        f.initial.articles,
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(f.database)).claims,
        f.initial.claims,
      );
    }
  });
}
const identity = (at) => {
  const s = fs.lstatSync(at, { bigint: true });
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
function pkg(parent, id) {
  const at = path.join(parent, id);
  fs.mkdirSync(path.join(at, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(at, 'runtime/node.exe'), 'inert');
  fs.writeFileSync(path.join(at, 'runtime.cjs'), 'inert');
  if (['candidate', 'rollback'].includes(id))
    fs.symlinkSync(
      path.join(at, 'runtime'),
      path.join(at, 'internal-runtime'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
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
      sourceCommit:
        {
          candidate: '0ac65de954ab0ba0be5f1174d2307c28ddaf2440',
          rollback: '0b5892ec8036553daaf8989e70990b1e464c62b1',
        }[id] || crypto.createHash('sha1').update(id).digest('hex'),
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
            throw Object.assign(Error('SYNTHETIC_MIGRATION_FAILURE'), {
              migrationExitConfirmed: true,
            });
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
test('fixed maintenance unrelated background churn remains visible risk without blocking the fixed sequence', () =>
  maintenanceFixture(async (f) => {
    const api = require('./windows-release-references.cjs'),
      validate = require('./release-scope.cjs').validateReferences;
    let checks = 0,
      negatives = false;
    f.parserQuery = (p, r) => {
      const base = f.observation(p, r),
        pid = 9000001;
      const row = {
        pid,
        parentPid: 1,
        name: 'node.exe',
        executable: process.execPath,
        commandLine:
          '"' +
          process.execPath +
          '" "' +
          path.join(f.base, 'unrelated-background.cjs') +
          '"',
        startUtc: '2026-10-16T00:00:00Z',
      };
      const run = (n) => api.probe(p, n, { callerPid: process.pid });
      if (!negatives) {
        negatives = true;
        for (const change of ['add', 'remove', 'restart', 'same-pid-restart']) {
          const n = structuredClone(base);
          if (change !== 'add') n.processesBefore.push({ ...row });
          if (change !== 'remove')
            n.processesAfter.push({
              ...row,
              pid: change === 'restart' ? pid + 1 : pid,
              startUtc: '2026-10-16T00:01:00Z',
            });
          const out = run(n);
          assert.deepEqual(out.errors, [], change);
          assert.equal(typeof validate(out, p, 'install'), 'string');
          assert(
            out.operationCoverage.processCoverage.backgroundGaps.length > 0,
          );
          assert.equal(
            out.operationCoverage.processCoverage.globalDbWriterExclusion,
            false,
          );
        }
        for (const fault of [
          'related-identity',
          'port',
          'related-path',
          'parent-chain',
          'opaque-host',
          'startup-directory',
        ]) {
          const n = structuredClone(base);
          if (fault === 'related-identity')
            n.processesAfter.find(
              (x) => x.pid === p.publication.expected.pid,
            ).startUtc = '2026-10-16T00:02:00Z';
          else if (fault === 'port')
            n.processCoverage.listenersAfter[0].pid = pid;
          else if (fault === 'startup-directory')
            n.shortcutDirectories[0].identity[1] = '0';
          else {
            n.processesBefore.push({ ...row });
            n.processesAfter.push({ ...row });
            for (const list of [n.processesBefore, n.processesAfter]) {
              const x = list.find((x) => x.pid === pid);
              if (fault === 'related-path') x.workingDirectory = p.installRoot;
              if (fault === 'parent-chain')
                x.parentPid = p.publication.expected.pid;
              if (fault === 'opaque-host') {
                x.executable = '';
                x.commandLine = '';
              }
            }
          }
          assert(run(n).errors.length, fault);
        }
      }
      // Every real check in the finite fixture sees a different unrelated PID.
      base.processesBefore.push({ ...row, pid: pid + checks });
      base.processesAfter.push({ ...row, pid: pid + checks++ });
      const out = run(base);
      assert.deepEqual(out.errors, []);
      return out;
    };
    assert.equal((await f.maintenance()).status, 'passed');
    assert(checks > 2);
    assert(negatives);
  }));
test('fixed maintenance related database writer cannot become unrelated background', () =>
  maintenanceFixture(async (f) => {
    const api = require('./windows-release-references.cjs');
    let observed = false;
    f.parserQuery = (p, r) => {
      const n = f.observation(p, r);
      if (!f.service()) {
        const writer = {
          ...p.publication.expected,
          pid: 9000001,
          parentPid: 1,
          name: 'node.exe',
        };
        n.processesBefore.push({ ...writer });
        n.processesAfter.push({ ...writer });
        observed = true;
      }
      const out = api.probe(p, n, { callerPid: process.pid });
      if (observed && out.errors.length === 0)
        assert(
          out.records.some((x) => x.kind === 'processes' && x.pid === 9000001),
        );
      return out;
    };
    await assert.rejects(
      f.maintenance(),
      /WRITERS_NOT_STOPPED|REFERENCE_QUERY_INCOMPLETE/,
    );
    assert(observed);
    assert.equal(f.backupCount(), 0);
    assert(!f.events.includes('migrate'));
  }));
for (const target of ['directory', 'database'])
  test(
    'fixed maintenance background simplification retains ' +
      target +
      ' identity refusal',
    () =>
      maintenanceFixture(async (f) => {
        let original, held;
        f.queryHook = () => {
          f.queryHook = null;
          original = target === 'directory' ? f.root : f.database;
          held = original + '.held-fixture';
          fs.renameSync(original, held);
          if (target === 'directory') fs.mkdirSync(original);
          else fs.writeFileSync(original, fs.readFileSync(held));
        };
        try {
          await assert.rejects(
            f.maintenance(),
            /DIRECTORY_CHANGED|DATABASE_CHANGED/,
          );
          assert(!f.events.includes('Stop'));
          assert.equal(f.backupCount(), 0);
        } finally {
          if (held) {
            if (target === 'directory') fs.rmdirSync(original);
            else fs.unlinkSync(original);
            fs.renameSync(held, original);
          }
        }
      }),
  );
test('fixed maintenance parser validates actual fixed owner and rejects caller, nonce and record identity changes', () =>
  maintenanceFixture(async (f) => {
    const api = require('./windows-release-references.cjs');
    let exercised = false;
    f.parserQuery = (p, r) => {
      const native = f.observation(p, r),
        run = () => api.probe(p, native, { callerPid: process.pid });
      const good = run();
      assert.deepEqual(good.errors, []);
      assert.equal(good.operationSufficient, true);
      if (!exercised) {
        exercised = true;
        const command = native.processesBefore[0].commandLine;
        native.processesBefore[0].commandLine += ' changed';
        assert(run().errors.includes('REFERENCE_MAINTENANCE_CALLER_UNCERTAIN'));
        native.processesBefore[0].commandLine = command;
        const lock = path.join(p.registryDirectory, p.scopeId + '.lock'),
          bytes = fs.readFileSync(lock),
          doc = JSON.parse(bytes);
        try {
          doc.nonce += 'changed';
          fs.writeFileSync(lock, JSON.stringify(doc));
          assert(run().errors.length);
          doc.nonce = r.nonce;
          doc.recordPin.identity[1] = '0';
          fs.writeFileSync(lock, JSON.stringify(doc));
          assert(run().errors.length);
        } finally {
          fs.writeFileSync(lock, bytes);
        }
      }
      return good;
    };
    assert.equal((await f.maintenance()).status, 'passed');
    assert(exercised);
  }));
test('fixed maintenance migration list changes after backup before migration refuses migration', () =>
  maintenanceFixture(async (f) => {
    const inspect = f.operations.inspect;
    let calls = 0;
    f.operations.inspect = (...a) => {
      const r = inspect(...a);
      if (++calls === 2) r.pending = ['changed'];
      return r;
    };
    const result = await f.maintenance();
    assert.equal(result.status, 'recovered');
    assert.equal(result.migrationAttempted, false);
    assert(!f.events.includes('migrate'));
    assert(f.events.includes('start:current'));
  }));
test('fixed maintenance retains bounded private chain diagnosis and emits only safe CLI fields', () =>
  maintenanceFixture(async (f) => {
    const row = {
      pid: 500,
      parentPid: process.pid,
      name: 'node.exe',
      executable: 'C:/private/runtime.exe',
      commandLine: 'C:/private/runtime.exe SECRET-ARGV',
      startUtc: '2026-10-16T00:00:00Z',
    };
    f.facts = () => ({
      complete: false,
      errors: ['REFERENCE_PROBE_CHILD_UNCERTAIN'],
      referenceDiagnostic: {
        stage: 'collector-chain',
        codes: ['REFERENCE_PROBE_CHILD_UNCERTAIN'],
        chainBranch: 'unexpected-descendant',
      },
      privateReferenceDiagnostic: {
        format: 1,
        branch: 'unexpected-descendant',
        before: [row],
        after: [row],
      },
    });
    let error;
    try {
      await f.maintenance();
    } catch (e) {
      error = e;
    }
    assert(error);
    assert.deepEqual(
      f.maintenanceRecord().error.privateReferenceDiagnostic.before,
      [row],
    );
    const text = fixedMaintenance.formatCliError(error);
    assert(text.includes('REFERENCE_PROBE_CHILD_UNCERTAIN'));
    assert(!text.includes('SECRET-ARGV'));
    assert(!text.includes('C:/private'));
  }));
test('fixed maintenance completes once using original remaining credits and rejects replay', () =>
  maintenanceFixture(async (f) => {
    const r = await f.maintenance();
    assert.equal(r.status, 'passed');
    assert.equal(f.backupCount(), 1);
    assert.equal(f.events.filter((e) => e === 'migrate').length, 1);
    assert.equal(f.maintenanceRecord().recoverySpent, false);
    await assert.rejects(
      f.maintenance(),
      /EXISTING_OUTPUT_OR_OWNER|CURRENT_POINTER/,
    );
  }));
test('fixed maintenance unapproved review creates no authority and automatic effects reject before lock', () =>
  maintenanceFixture(async (f) => {
    f.policy.maintenance.approval.confirmed = false;
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    fixedMaintenance.review(f.file, fileHash(f.file));
    assert(!fs.existsSync(fixedMaintenance.recordPath(f.policy)));
    for (const action of ['--apply', '--deploy', '--rollback'])
      await assert.rejects(
        Promise.resolve().then(() =>
          admission.main([action, f.file, fileHash(f.file)]),
        ),
        /MAINTENANCE_ENTRY_REQUIRED/,
      );
    await assert.rejects(f.maintenance(), /PLAN_BINDING/);
    assert.deepEqual(f.events, []);
  }));
for (const failure of ['migration', 'candidate-health'])
  test(
    'fixed maintenance ' +
      failure +
      ' spends sole recovery on compatible package and same live DB',
    () =>
      maintenanceFixture(async (f) => {
        f.failAt = failure;
        const r = await f.maintenance();
        assert.equal(r.status, 'recovered');
        assert.equal(r.migrationAttempted, true);
        assert.equal(r.recoverySpent, true);
        assert(f.events.includes('start:rollback'));
        assert.equal(f.backupCount(), 1);
        assert.deepEqual(JSON.parse(fs.readFileSync(f.database)).new_table, []);
      }),
  );
test('fixed maintenance backup failure remains spent and recovers current without retry', () =>
  maintenanceFixture(async (f) => {
    let calls = 0;
    f.operations.backup = () => {
      calls++;
      throw Error('SYNTHETIC_BACKUP_FAILURE');
    };
    const r = await f.maintenance();
    assert.equal(r.status, 'recovered');
    assert.equal(calls, 1);
    assert.equal(r.backupSpent, true);
    assert.equal(r.migrationAttempted, false);
    assert(f.events.includes('start:current'));
    await assert.rejects(f.maintenance());
    assert.equal(calls, 1);
  }));
test('fixed maintenance concurrent invocation cannot acquire a second credit', () =>
  maintenanceFixture(async (f) => {
    let concurrent;
    f.queryHook = () => {
      f.queryHook = null;
      concurrent = assert.rejects(
        hostEffects.context.run(undefined, () => f.maintenance()),
        /EXISTING_OUTPUT_OR_OWNER/,
      );
    };
    assert.equal((await f.maintenance()).status, 'passed');
    await concurrent;
    assert.equal(f.backupCount(), 1);
  }));
test('fixed maintenance partial copy stays held without stop, backup or retry', () =>
  maintenanceFixture(async (f) => {
    const original = fs.writeSync;
    let failed = false;
    fs.writeSync = (...args) => {
      if (!failed) {
        failed = true;
        original(...args);
        throw Error('SYNTHETIC_PARTIAL_COPY');
      }
      return original(...args);
    };
    try {
      await assert.rejects(f.maintenance(), /SYNTHETIC_PARTIAL_COPY/);
    } finally {
      fs.writeSync = original;
    }
    assert.equal(f.maintenanceRecord().status, 'hold');
    assert(!f.events.includes('Stop'));
    assert.equal(f.backupCount(), 0);
    await assert.rejects(f.maintenance());
  }));
test('fixed maintenance foreign record replacement during temporary write remains untouched and held', () =>
  maintenanceFixture(async (f) => {
    const open = fs.openSync,
      sync = fs.fsyncSync,
      files = new Map();
    let foreign,
      changed = false;
    fs.openSync = (at, ...args) => {
      const fd = open(at, ...args);
      files.set(fd, String(at));
      return fd;
    };
    fs.fsyncSync = (fd) => {
      const result = sync(fd);
      if (
        !changed &&
        files.get(fd)?.startsWith(fixedMaintenance.recordPath(f.policy) + '.')
      ) {
        changed = true;
        const at = fixedMaintenance.recordPath(f.policy),
          temporary = at + '.foreign-fixture';
        foreign = Buffer.concat([fs.readFileSync(at), Buffer.from(' ')]);
        fs.writeFileSync(temporary, foreign);
        fs.renameSync(temporary, at);
      }
      return result;
    };
    try {
      await assert.rejects(f.maintenance(), /CONTINUATION_INPUT_PIN/);
    } finally {
      fs.openSync = open;
      fs.fsyncSync = sync;
    }
    assert(changed);
    assert.deepEqual(
      fs.readFileSync(fixedMaintenance.recordPath(f.policy)),
      foreign,
    );
    assert(!f.events.includes('Stop'));
    assert.equal(f.backupCount(), 0);
    await assert.rejects(f.maintenance());
  }));
test('fixed maintenance credit persistence failure performs no backup and no recovery', () =>
  maintenanceFixture(async (f) => {
    const write = fs.writeFileSync,
      sync = fs.fsyncSync;
    let creditFd,
      failed = false;
    fs.writeFileSync = (fd, data, ...rest) => {
      if (
        typeof fd === 'number' &&
        String(data).includes('"backupSpent":true') &&
        !String(data).includes('"migrationAttempted":true')
      )
        creditFd = fd;
      return write(fd, data, ...rest);
    };
    fs.fsyncSync = (fd) => {
      if (fd === creditFd) {
        failed = true;
        throw Error('SYNTHETIC_CREDIT_FSYNC');
      }
      return sync(fd);
    };
    try {
      await assert.rejects(f.maintenance(), /SYNTHETIC_CREDIT_FSYNC/);
    } finally {
      fs.writeFileSync = write;
      fs.fsyncSync = sync;
    }
    assert(failed);
    assert.equal(f.backupCount(), 0);
    assert(!f.events.some((e) => e.startsWith('start:')));
    await assert.rejects(f.maintenance());
  }));
test('fixed maintenance unknown publication stays held and never starts recovery', () =>
  maintenanceFixture(async (f) => {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const r = rename(from, to);
      if (to === path.join(f.root, 'active.json'))
        throw Error('SYNTHETIC_PUBLICATION_UNKNOWN');
      return r;
    };
    try {
      await assert.rejects(f.maintenance(), /SYNTHETIC_PUBLICATION_UNKNOWN/);
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(f.maintenanceRecord().publicationSpent, true);
    assert.equal(f.maintenanceRecord().recoverySpent, false);
    assert.deepEqual(
      f.events.filter((e) => e.startsWith('start:')),
      ['start:candidate'],
    );
    await assert.rejects(f.maintenance());
  }));
test('fixed maintenance old source pin change refuses before creating authority', () =>
  maintenanceFixture(async (f) => {
    const at = f.policy.maintenance.sourcePolicy.path,
      text = fs.readFileSync(at);
    fs.appendFileSync(at, ' ');
    try {
      await assert.rejects(f.maintenance(), /CONTINUATION_INPUT_CHANGED/);
    } finally {
      fs.writeFileSync(at, text);
    }
    assert(!fs.existsSync(fixedMaintenance.recordPath(f.policy)));
    assert.deepEqual(f.events, []);
  }));
for (const confirmed of [true, false])
  test(
    'fixed maintenance migration timeout ' +
      (confirmed
        ? 'after confirmed exit uses sole compatible recovery'
        : 'with unknown child exit holds'),
    () =>
      maintenanceFixture(async (f) => {
        f.operations.migrate = async () => {
          f.events.push('migrate');
          throw Object.assign(
            Error(confirmed ? 'MIGRATION_TIMEOUT' : 'MIGRATION_KILL_TIMEOUT'),
            { migrationExitConfirmed: confirmed },
          );
        };
        if (confirmed) {
          assert.equal((await f.maintenance()).status, 'recovered');
          assert(f.events.includes('start:rollback'));
        } else {
          await assert.rejects(f.maintenance(), /MIGRATION_KILL_TIMEOUT/);
          assert(!f.events.some((e) => e.startsWith('start:')));
          assert.equal(f.maintenanceRecord().migrationAttempted, true);
          assert.equal(f.maintenanceRecord().recoverySpent, false);
        }
      }),
  );
test('fixed maintenance record plus temporary control bytes share old metadata ceiling', () =>
  maintenanceFixture(async (f) => {
    const receipt = f.policy.maintenance.sourceFiles.continuation.path,
      ledger = f.policy.maintenance.sourceFiles.ledger.path;
    const originals = [receipt, ledger].map((at) => [at, fs.readFileSync(at)]);
    const hash = (value) =>
      crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    try {
      fs.appendFileSync(
        receipt,
        ' '.repeat(
          admission.LIMITS.metadata - fs.statSync(receipt).size - 8192,
        ),
      );
      const e = JSON.parse(fs.readFileSync(ledger));
      e.payload.continuation.receiptSha256 = fileHash(receipt);
      e.digest = hash(e.payload);
      fs.writeFileSync(ledger, JSON.stringify(e));
      for (const k of ['ledger', 'continuation'])
        f.policy.maintenance.sourceFiles[k].sha256 = fileHash(
          f.policy.maintenance.sourceFiles[k].path,
        );
      fs.writeFileSync(f.file, JSON.stringify(f.policy));
      await assert.rejects(f.maintenance(), /METADATA_LIMIT/);
      assert.deepEqual(f.events, []);
    } finally {
      for (const [at, text] of originals) fs.writeFileSync(at, text);
    }
  }));
test('continued pre-copy ledger uses the same old adopted anchor through install, publication and sole-backup rollback', () =>
  fixture(async (f) => {
    const facts = f.facts;
    f.facts = () => ({
      ...facts(),
      complete: false,
      errors: ['REFERENCE_BACKGROUND_GAP_UNBOUND'],
    });
    await assert.rejects(f.execute(), /REFERENCE_QUERY_INCOMPLETE/);
    assert.deepEqual(f.events, []);
    f.facts = facts;
    const ledger = path.join(
        f.policy.registryDirectory,
        f.policy.scopeId + '.state.json',
      ),
      sentinel = ledger + '.adopted',
      previous = path.join(f.base, 'previous-policy.json'),
      outcome = path.join(f.base, 'old-outcome.json');
    fs.copyFileSync(f.file, previous);
    const spec = (at) => ({
        path: at,
        sha256: fileHash(at),
        identity: identity(at),
      }),
      oldSha = fileHash(previous),
      oldText = fs.readFileSync(ledger, 'utf8');
    fs.writeFileSync(
      outcome,
      JSON.stringify({
        outcome: 'HELD_BEFORE_PACKAGE_COPY',
        executionPolicySha256: oldSha,
      }),
    );
    const c = {
      format: 1,
      kind: 'verified-pre-copy-continuation-v1',
      id: crypto.randomUUID(),
      previousPolicy: spec(previous),
      previousLedger: spec(ledger),
      previousSentinel: spec(sentinel),
      previousOutcome: spec(outcome),
    };
    f.policy.preCopyContinuation = c;
    f.policy.approval.id += '-continuation';
    f.policy.approval.continuation = {
      id: c.id,
      fromConfigSha: oldSha,
      fromLedgerSha: c.previousLedger.sha256,
      fromSentinelSha: c.previousSentinel.sha256,
    };
    fs.writeFileSync(f.file, JSON.stringify(f.policy));
    assert.equal((await f.execute()).status, 'passed');
    assert.equal((await f.execute(true)).status, 'rolled-back');
    assert.equal(f.backupCount(), 1);
    assert.equal(f.events.filter((x) => x === 'migrate').length, 1);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), oldSha);
    assert.equal(
      JSON.parse(fs.readFileSync(admission.continuationPath(f.policy), 'utf8'))
        .previousLedgerText,
      oldText,
    );
    assert.throws(
      () =>
        require('./release-scope.cjs').validateReferences(f.facts(), f.policy),
      /CONTINUATION_OPERATION_INVALID/,
    );
  }));
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

test('private chain diagnostic persists before publication stop without exposing raw CLI fields', () =>
  fixture(async (f) => {
    const original = f.facts.bind(f),
      ledger = path.join(
        f.policy.registryDirectory,
        f.policy.scopeId + '.state.json',
      );
    const row = {
      pid: 201,
      parentPid: 200,
      name: 'conhost.exe',
      executable: 'C:/PRIVATE/conhost.exe',
      commandLine: 'SECRET_ARGV',
      startUtc: '2026-01-01T00:00:00Z',
    };
    f.facts = () => {
      const good = original();
      if (
        !fs.existsSync(ledger) ||
        !JSON.parse(fs.readFileSync(ledger)).payload.publication
      )
        return good;
      return {
        ...good,
        complete: false,
        errors: ['REFERENCE_PROBE_CHILD_UNCERTAIN'],
        referenceDiagnostic: {
          stage: 'collector-chain',
          chainBranch: 'unexpected-descendant',
        },
        privateReferenceDiagnostic: {
          format: 1,
          branch: 'unexpected-descendant',
          before: [row],
          after: [row],
        },
      };
    };
    let error;
    try {
      await f.execute();
    } catch (e) {
      error = e;
    }
    assert.equal(error.message, 'RELEASE_SCOPE_REFERENCE_QUERY_INCOMPLETE');
    assert.equal(error.referenceDiagnostic.diagnosticStored, true);
    const state = JSON.parse(fs.readFileSync(ledger)).payload;
    assert.deepEqual(state.referenceFailures[0].privateDiagnostic.after, [row]);
    assert(!/SECRET|PRIVATE/.test(admission.formatCliError(error)));
    assert(!f.events.includes('Stop'));
    assert.equal(f.backupCount(), 0);
    assert(!f.events.includes('migrate'));
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

for (const processScoped of [false, true])
  test(
    'operation coverage is accepted by the exact install, publish and same-DB rollback call sites' +
      (processScoped ? ' with related-process coverage' : ''),
    () =>
      fixture(async (f) => {
        const scope = {
          format: 1,
          kind: 'non-retiring-once-pair-v1',
          staticScopeMode: 'startup-and-pinned-launchers-v1',
          preserveLegacy: true,
          globalReferenceComplete: false,
          uninspectedProfiles: [],
        };
        if (processScoped)
          scope.processCoverage = {
            format: 1,
            kind: 'once-related-processes-v1',
            globalDbWriterExclusion: false,
            coverageClaim:
              'related-processes-only;uninspected-background-db-access-unproven',
            backgroundGaps: [],
          };
        f.policy.windowsReferences.operationCoverage = scope;
        if (processScoped)
          scope.taskCoverage = {
            format: 1,
            kind: 'once-background-task-actions-v1',
            globalTaskInvocationCoverageComplete: false,
            coverageClaim:
              'bound-background-actions-only;indirect-db-access-unproven',
            backgroundActions: [],
          };
        fs.writeFileSync(f.file, JSON.stringify(f.policy));
        const facts = f.facts;
        f.facts = () => {
          const r = facts();
          return {
            ...r,
            complete: false,
            globalReferenceComplete: false,
            operationSufficient: true,
            categories: {
              ...r.categories,
              shortcuts: false,
              ...(processScoped ? { processes: false, tasks: false } : {}),
            },
            operationCoverage: {
              kind: scope.kind,
              staticScopeMode: scope.staticScopeMode,
              contractSha256: crypto
                .createHash('sha256')
                .update(JSON.stringify(scope))
                .digest('hex'),
              startupComplete: true,
              pinnedLaunchersVerified: true,
              uninspectedProfiles: [],
              uninspectedStaticScopes: [
                'Desktop',
                'CommonDesktop',
                'StartMenu',
                'CommonStartMenu',
              ].map((kind) => ({
                kind,
                inspected: false,
                reason: 'outside-non-retiring-operation',
              })),
              uninspectedStaticJunctions: [],
              ...(processScoped
                ? {
                    processCoverage: {
                      kind: scope.processCoverage.kind,
                      contractSha256: crypto
                        .createHash('sha256')
                        .update(JSON.stringify(scope.processCoverage))
                        .digest('hex'),
                      relatedChecksComplete: true,
                      requiredPortChecked: true,
                      globalDbWriterExclusion: false,
                      globalProcessVisibilityComplete: false,
                      globalInvocationCoverageComplete: false,
                      backgroundGaps: [],
                    },
                    taskCoverage: {
                      kind: scope.taskCoverage.kind,
                      contractSha256: crypto
                        .createHash('sha256')
                        .update(JSON.stringify(scope.taskCoverage))
                        .digest('hex'),
                      globalTaskInvocationCoverageComplete: false,
                      backgroundDbAccessExcluded: false,
                      backgroundActions: [],
                    },
                  }
                : {}),
            },
          };
        };
        assert.equal((await f.execute()).status, 'passed');
        assert.equal((await f.execute(true)).status, 'rolled-back');
        assert.equal(f.backupCount(), 1);
        assert.equal(f.events.filter((e) => e === 'migrate').length, 1);
      }),
  );

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
