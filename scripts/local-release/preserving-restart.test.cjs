// Exercises the existing restart orchestration with owned files and simulated
// process/HTTP adapters. It is not a runnable-package or host-observation test.
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const vm = require('node:vm'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateSameSchema } = require('./preserving-contract.cjs');
const hash = (p) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for (const [eol, familyMode] of [
  [false, false],
  [true, false],
  [false, true],
])
  for (const failure of [
    'none',
    'health',
    'final-backup',
    'closed-inspection',
    'capacity',
    'identity',
    ...(familyMode
      ? [
          'family-admission',
          'family-bind',
          'family-seal',
          'family-exit',
          'family-late',
          'family-timeout',
          'family-timeout-unknown',
        ]
      : []),
  ])
    test(
      'existing restart preserves SQLite and restores active after failure=' +
        failure +
        ' CRLF=' +
        eol +
        ' family=' +
        familyMode,
      async () => {
        const failHealth = failure === 'health',
          mustRecover = !['none', 'family-late'].includes(failure),
          timedOut = failure.startsWith('family-timeout');
        const base = fs.realpathSync.native(
          fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-preserve-restart-')),
        );
        const project = path.join(base, 'project'),
          dir = path.join(project, 'scripts/local-release');
        const database = path.join(project, 'apps/server/data/wewe-rss.db'),
          pointer = path.join(project, 'active.json');
        fs.mkdirSync(path.dirname(database), { recursive: true });
        fs.mkdirSync(dir, { recursive: true });
        execFileSync('python', [
          '-c',
          'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table facts(value text)"); c.execute("insert into facts values (?)",("synthetic",)); c.commit(); c.close()',
          database,
        ]);
        const dbHash = hash(database),
          manifests = new Map();
        for (const id of ['current', 'candidate']) {
          const folder = path.join(project, id);
          fs.mkdirSync(path.join(folder, 'runtime'), { recursive: true });
          fs.writeFileSync(
            path.join(folder, 'runtime/node.exe'),
            'inert-runtime',
          );
          const m = {
            format: 1,
            id,
            schemaCompatibility: 'current',
            desktopHelperIncluded: false,
            files: {
              'server/prisma/schema.prisma': 'a'.repeat(64),
              'server/prisma/migrations/001/migration.sql': 'b'.repeat(64),
            },
            links: {},
          };
          if (eol) {
            for (const [name, text] of [
              ['server/prisma/schema.prisma', 'synthetic schema\n'],
              [
                'server/prisma/migrations/001/migration.sql',
                '-- synthetic migration\n',
              ],
              [
                'server/prisma/migrations/migration_lock.toml',
                'provider = \"sqlite\"\n',
              ],
            ]) {
              fs.mkdirSync(path.dirname(path.join(folder, name)), {
                recursive: true,
              });
              fs.writeFileSync(
                path.join(folder, name),
                id === 'current' ? text.replace(/\n/g, '\r\n') : text,
              );
              m.files[name] = hash(path.join(folder, name));
            }
          }
          manifests.set(folder, m);
          fs.writeFileSync(
            path.join(folder, 'release.json'),
            JSON.stringify(m),
          );
        }
        const previous = path.join(project, 'current'),
          release = path.join(project, 'candidate');
        if (!eol)
          validateSameSchema(manifests.get(previous), manifests.get(release));
        fs.writeFileSync(pointer, JSON.stringify({ format: 1, id: 'current' }));
        let auditSummary;
        const inspections = [],
          copies = [];
        const events = [],
          old = {
            pid: 7,
            startUtc: '2026-01-01T00:00:00Z',
            executable: path.join(previous, 'runtime/node.exe'),
            port: 4000,
          };
        const active = {
          pointer,
          currentId: 'current',
          candidateId: 'candidate',
          pointerSha256: hash(pointer),
          currentManifestSha256: hash(path.join(previous, 'release.json')),
          candidateManifestSha256: hash(path.join(release, 'release.json')),
          oldProcess: {
            pid: old.pid,
            startUtc: old.startUtc,
            executableSha256: hash(old.executable),
          },
        };
        const sealCalls = new Map();
        let clock = 0,
          candidateExitChecks = 0;
        const lease = {
          policy: {
            preservingUpdate: {
              format: 1,
              operation: 'restart',
              active,
              ...(familyMode ? { processFamily: { format: 1 } } : {}),
            },
          },
          authorizePackage() {},
          check() {},
          registerOutput() {
            events.push('output');
          },
          createdOutput() {},
          authorizeRecoveryPackage() {
            events.push('recovery-authorized');
          },
          preparePreservingProcessFamily(snapshot) {
            assert.equal(snapshot.pid, old.pid);
            assert(!events.includes('output'));
            if (failure === 'family-admission')
              throw Error('synthetic-family-admission-failure');
            events.push('family-preflight');
          },
          bindPreservingChild(snapshot, id, command) {
            assert.equal(snapshot.commandLine, command);
            if (
              failure === 'family-timeout-unknown' &&
              id === 'candidate' &&
              clock >= 15000
            )
              throw Error('synthetic-family-timeout-unknown-failure');
            if (failure === 'family-bind' && id === 'candidate')
              throw Error('synthetic-family-bind-failure');
            events.push('bind-' + id);
          },
          sealPreservingProcessFamily(snapshot, id, command) {
            assert.equal(snapshot.commandLine, command);
            assert(events.includes('bind-' + id));
            if (failure === 'family-seal' && id === 'candidate')
              throw Error('synthetic-family-seal-failure');
            const count = (sealCalls.get(id) || 0) + 1;
            sealCalls.set(id, count);
            assert(events.includes('healthy'));
            if (
              (timedOut && id === 'candidate') ||
              ((failure === 'family-late' || timedOut) && count === 1)
            ) {
              events.push('missing-helper-' + id);
              return false;
            }
            events.push('seal-' + id);
            return true;
          },
          confirmPreservingProcessExit(pid, evidence) {
            if (pid === old.pid) {
              assert.equal(evidence.stopped, true);
              events.push('old-exit-confirmed');
            } else if (timedOut) {
              assert(events.includes('candidate-stop'));
              if (++candidateExitChecks === 1) return false;
              events.push('candidate-exit-confirmed');
              return true;
            }
          },
        };
        const children = new Map();
        let nextPid = 20;
        const source = fs.readFileSync(
          path.join(__dirname, 'restart.cjs'),
          'utf8',
        );
        let exported;
        const protectedFs = Object.create(fs);
        for (const method of ['copyFileSync', 'renameSync', 'writeFileSync'])
          protectedFs[method] = (a, b, ...rest) => {
            const destination = method === 'writeFileSync' ? a : b;
            if (typeof destination === 'string')
              assert.notEqual(
                path.resolve(destination),
                database,
                'controller must never overwrite business DB',
              );
            return fs[method](a, b, ...rest);
          };
        const lib = {
          hostEffects: {
            fs: protectedFs,
            processes: {
              spawn(exe, args) {
                const child = { pid: nextPid++, exitCode: null, unref() {} };
                children.set(child.pid, { exe, args });
                events.push(
                  exe.includes('candidate') ? 'candidate-start' : 'old-start',
                );
                return child;
              },
            },
          },
          verifyRelease: (p) => manifests.get(p),
          verifyReleaseAsync: async (p) => manifests.get(p),
          fileHash: hash,
          cleanEnvironment: (x) => x,
          inside: (r, p) => p.startsWith(r + path.sep),
          writeJson: (p, x) => {
            if (path.basename(p) === 'summary.json') auditSummary = x;
            fs.writeFileSync(p, JSON.stringify(x));
          },
          run(exe, args) {
            if (args[0].endsWith('backup-space-status.py')) {
              events.push('capacity');
              if (failure === 'identity') {
                const copy = database + '.replacement';
                fs.copyFileSync(database, copy);
                fs.unlinkSync(database);
                fs.renameSync(copy, database);
              }
              return JSON.stringify({
                capacityAllowsNextBackup: failure !== 'capacity',
              });
            }
            if (args.includes('--backup-root')) {
              const afterStop = events.includes('old-stop');
              events.push('backup');
              if (afterStop && failure === 'final-backup')
                throw Error('synthetic-final-backup-failure');
              const folder = args[args.indexOf('--backup-root') + 1];
              fs.mkdirSync(folder, { recursive: true });
              const copy = path.join(
                folder,
                'snapshot-' + copies.length + '.db',
              );
              assert.notEqual(copy, database);
              fs.copyFileSync(database, copy);
              copies.push(copy);
              return JSON.stringify({
                integrityCheck: 'ok',
                backup: copy,
                sha256: hash(copy),
              });
            }
            const inspected = args[args.indexOf('--database') + 1];
            inspections.push(inspected);
            events.push('inspect');
            if (failure === 'closed-inspection' && events.includes('old-stop'))
              throw Error('synthetic-closed-inspection-failure');
            return JSON.stringify({
              pending: [],
              tables: { facts: { rows: 1 } },
            });
          },
        };
        const scope = {
          assertWritableSession() {},
          session: () => lease,
          within: async (r, callback) => callback(lease),
        };
        const switchAdapter = {
          loadProductionEnvironment() {},
          unusedPort: async () => 41001,
          portOwnersAsync: async () => [],
          processIdentity(action, pid, port) {
            if (action === 'Port') return [];
            if (action === 'Stop') {
              events.push('old-stop');
              return {
                ...old,
                commandLine: exported.commandLine(previous, database, 4000),
                stopped: true,
              };
            }
            if (pid === 7)
              return {
                ...old,
                commandLine: exported.commandLine(previous, database, 4000),
              };
            return {
              pid,
              startUtc: '2026-01-01T01:00:00Z',
              executable: children.get(pid).exe,
              commandLine: exported.launchCommandLine(
                children.get(pid).exe,
                children.get(pid).args,
              ),
              port,
            };
          },
          sameIdentity(actual, expected) {
            assert.equal(actual.pid, expected.pid);
            assert.equal(actual.startUtc, expected.startUtc);
          },
          waitReady: async (port, child) => {
            if (
              failure === 'family-exit' &&
              children.get(child.pid).exe.includes('candidate')
            ) {
              child.exitCode = 1;
              throw Error('synthetic-family-exit-failure');
            }
            if (failHealth && children.get(child.pid).exe.includes('candidate'))
              throw Error('synthetic-health-failure');
            events.push('healthy');
          },
          stopOwned: async (child) => {
            if (child) {
              events.push('candidate-stop');
              child.exitCode = 0;
            }
          },
        };
        const module = { exports: {} };
        const localRequire = (p) =>
          p === './lib.cjs'
            ? lib
            : p === './switch.cjs'
              ? switchAdapter
              : p === './release-scope.cjs'
                ? scope
                : p === './startup-acceptance.cjs'
                  ? { accepted: () => false, recordAcceptance() {} }
                  : p === './active-release.cjs'
                    ? {
                        writeActiveReleaseAsync: async (p) => {
                          events.push('active-' + path.basename(p));
                          fs.writeFileSync(
                            pointer,
                            JSON.stringify({ format: 1, id: path.basename(p) }),
                          );
                        },
                      }
                    : p === './space-budget.cjs'
                      ? { productionRoot: () => path.join(base, 'backups') }
                      : p === './preserving-contract.cjs'
                        ? require(p)
                        : require(p);
        localRequire.main = undefined;
        try {
          // This harness tests Windows orchestration with simulated OS adapters on
          // either CI host; it does not claim a native Windows process execution.
          const adapterProcess = Object.create(process);
          Object.defineProperty(adapterProcess, 'platform', { value: 'win32' });
          vm.runInThisContext(
            '(function(require,module,exports,__dirname,process,Date,setTimeout){' +
              source +
              '\n})',
          )(
            localRequire,
            module,
            module.exports,
            dir,
            adapterProcess,
            timedOut
              ? class extends Date {
                  static now() {
                    return clock;
                  }
                }
              : Date,
            timedOut
              ? (callback, ms) => {
                  clock += ms;
                  callback();
                }
              : setTimeout,
          );
          exported = module.exports;
          const promise = exported.controlledRestart({
            production: true,
            rehearsal: false,
            mode: 'restart',
            release,
            previous,
            database,
            expected: {
              ...old,
              commandLine: exported.commandLine(previous, database, 4000),
            },
          });
          const preStopFailure = [
            'capacity',
            'identity',
            'family-admission',
          ].includes(failure);
          const expectedError =
            failure === 'family-timeout'
              ? 'RELEASE_PRESERVING_PROCESS_SEAL_TIMEOUT'
              : failure === 'capacity'
                ? 'RELEASE_RESTART_BACKUP_CAPACITY_UNAVAILABLE'
                : failure === 'identity'
                  ? 'RELEASE_RESTART_SOURCE_IDENTITY_CHANGED'
                  : 'synthetic-' + failure + '-failure';
          if (mustRecover)
            await assert.rejects(promise, new RegExp(expectedError));
          else assert.equal((await promise).passed, true);
          if (preStopFailure) {
            if (failure === 'family-admission')
              assert(!events.includes('output'));
            assert(!events.includes('old-stop'));
            assert(!events.includes('candidate-start'));
            assert(!events.includes('old-start'));
            assert.equal(inspections.length, 0);
            assert.equal(copies.length, 0);
            assert.equal(hash(database), dbHash);
            assert.equal(JSON.parse(fs.readFileSync(pointer)).id, 'current');
            return;
          }
          if (
            failure === 'family-bind' ||
            failure === 'family-timeout-unknown'
          ) {
            assert(events.includes('candidate-stop'));
            assert(!events.includes('old-start'));
            assert.equal(hash(database), dbHash);
            assert.equal(copies.length, 1);
            assert.equal(JSON.parse(fs.readFileSync(pointer)).id, 'current');
            return;
          }
          assert.equal(
            auditSummary.schemaProof.comparison,
            eol ? 'crlf-to-lf-only' : 'raw-sha256',
          );
          assert.equal(hash(database), dbHash);
          assert.equal(
            JSON.parse(fs.readFileSync(pointer)).id,
            mustRecover ? 'current' : 'candidate',
          );
          assert(
            inspections.every(
              (file) => file !== database && copies.includes(file),
            ),
            'full inspections use closed backup copies only',
          );
          assert(
            events.indexOf('inspect') === -1 ||
              (events.indexOf('old-exit-confirmed') !== -1 &&
                events.indexOf('old-exit-confirmed') <
                  events.indexOf('inspect')),
            'heavy read must follow confirmed old exit',
          );
          if (failure === 'final-backup') assert.equal(inspections.length, 0);
          else assert.equal(inspections.length, 1);
          if (failure === 'final-backup' || failure === 'closed-inspection')
            assert(!events.includes('candidate-start'));
          if (mustRecover) {
            assert(events.includes('old-start'));
            assert.equal(auditSummary.databaseRestored, false);
            if (failure === 'family-exit')
              assert.equal(
                events.filter((x) => x === 'bind-candidate').length,
                1,
              );
          }
          assert(events.indexOf('capacity') < events.indexOf('old-stop'));
          assert(
            events.indexOf('old-exit-confirmed') < events.indexOf('backup'),
          );
          assert.equal(events.filter((x) => x === 'backup').length, 1);
          const finalId = mustRecover ? 'current' : 'candidate';
          assert(
            events.indexOf('seal-' + finalId) <
              events.indexOf('active-' + finalId),
          );
          if (mustRecover) assert(events.includes('recovery-authorized'));
          if (failure === 'family-late' || timedOut) {
            assert(
              events.indexOf('healthy') <
                events.indexOf('missing-helper-candidate'),
            );
            assert(
              events.indexOf('missing-helper-' + finalId) <
                events.indexOf('seal-' + finalId),
            );
          }
          if (failure === 'family-timeout') {
            assert(!events.includes('seal-candidate'));
            assert.equal(candidateExitChecks, 2);
            assert(
              events.indexOf('candidate-exit-confirmed') <
                events.indexOf('old-start'),
            );
            assert(sealCalls.get('current') >= 2);
          }
          assert(fs.existsSync(path.join(previous, 'release.json')));
          assert(fs.existsSync(path.join(release, 'release.json')));
        } finally {
          fs.rmSync(base, { recursive: true });
        }
      },
    );

test('family exit wait is bounded and never swallows an uncertain observation', async () => {
  const { confirmFamilyExit } = require('./restart.cjs');
  let clock = 0,
    calls = 0;
  const timing = {
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    timeoutMs: 250,
  };
  await confirmFamilyExit(
    {
      confirmPreservingProcessExit() {
        return ++calls === 3;
      },
    },
    1,
    {},
    undefined,
    timing,
  );
  assert.equal(calls, 3);
  await assert.rejects(
    confirmFamilyExit(
      {
        confirmPreservingProcessExit() {
          return false;
        },
      },
      1,
      {},
      undefined,
      timing,
    ),
    /EXIT_TIMEOUT/,
  );
  await assert.rejects(
    confirmFamilyExit(
      {
        confirmPreservingProcessExit() {
          throw Error('unknown-child');
        },
      },
      1,
      {},
      undefined,
      timing,
    ),
    /unknown-child/,
  );
});

test('family seal retries only exact false; unknown or incomplete observations throw without waiting', async () => {
  const { sealFamily } = require('./restart.cjs');
  for (const reason of [
    'REFERENCE_PROCESS_APPEARED',
    'RELEASE_SCOPE_REFERENCE_INCOMPLETE',
    'RELEASE_PRESERVING_PROCESS_FAMILY_CHANGED',
  ]) {
    let calls = 0,
      waits = 0;
    await assert.rejects(
      sealFamily(
        {
          sealPreservingProcessFamily() {
            calls++;
            throw Error(reason);
          },
        },
        {},
        'candidate',
        'exact',
        {
          now: () => 0,
          wait: async () => {
            waits++;
          },
        },
      ),
      new RegExp(reason),
    );
    assert.equal(calls, 1);
    assert.equal(waits, 0);
  }
  let clock = 0,
    calls = 0;
  await assert.rejects(
    sealFamily(
      {
        sealPreservingProcessFamily() {
          calls++;
          clock += 16000; // Original synchronous query keeps its own separate timeout.
          return false;
        },
      },
      {},
      'candidate',
      'exact',
      {
        now: () => clock,
        wait: async () => {
          throw Error('must not wait beyond retry budget');
        },
      },
    ),
    /SEAL_TIMEOUT/,
  );
  assert.equal(calls, 1);
});
