// Real restart control flow with isolated files and simulated OS/process effects.
// The native evidence and scope protocols are covered independently; no host
// processes, services, application database or network are used here.
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const crypto = require('node:crypto'),
  vm = require('node:vm');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hash = (p) => sha(fs.readFileSync(p));
for (const failure of [
  'none',
  'capacity',
  'backup',
  'recover',
  'health',
  'active-release',
  'budget-release',
  'health-family',
  'health-family-stop',
  'health-fallback-diagnostic',
  'backup-diagnostic',
  'health-final-lock',
]) {
  test('prior-boot restart ordering and fallback: ' + failure, async () => {
    const base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-priorboot-')),
    );
    const root = path.join(base, 'project'),
      dir = path.join(root, 'scripts/local-release');
    fs.mkdirSync(dir, { recursive: true });
    const database = path.join(root, 'apps/server/data/wewe-rss.db');
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.writeFileSync(database, 'synthetic immutable database');
    const pointer = path.join(root, '.local-releases/active.json');
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, JSON.stringify({ format: 1, id: 'current' }));
    const marker = database + '.writer',
      oldRaw = JSON.stringify({ original: 'writer' });
    fs.writeFileSync(marker, oldRaw);
    const events = [],
      held = new Set(),
      attempts = [],
      children = new Map(),
      manifests = new Map();
    const release = path.join(root, '.local-releases/candidate'),
      previous = path.join(root, '.local-releases/current');
    for (const p of [release, previous]) {
      fs.mkdirSync(path.join(p, 'runtime'), { recursive: true });
      fs.writeFileSync(path.join(p, 'runtime/node.exe'), 'inert');
      fs.writeFileSync(
        path.join(p, 'project-writer-gate.cjs'),
        '// inert gate',
      );
      manifests.set(p, {
        id: path.basename(p),
        schemaCompatibility: 'current',
        desktopHelperIncluded: false,
        files: {
          'runtime/node.exe': hash(path.join(p, 'runtime/node.exe')),
          'project-writer-gate.cjs': hash(
            path.join(p, 'project-writer-gate.cjs'),
          ),
        },
      });
    }
    for (const f of ['normal-start-lock.cjs', 'writer-exit-recovery.cjs'])
      fs.writeFileSync(path.join(dir, f), '// inert adapter');
    const priorBoot = {
      database: { path: database, identity: sha('db-id') },
      writer: { sha256: sha(oldRaw) },
      lockSha256: hash(path.join(dir, 'normal-start-lock.cjs')),
      recoverySha256: hash(path.join(dir, 'writer-exit-recovery.cjs')),
    };
    let exported,
      nextPid = 100,
      summary;
    const gate = {
      binding: () => ({
        databaseIdentity: priorBoot.database.identity,
        file: marker,
      }),
      retireStoppedWriter: () => {
        events.push('retire-new');
      },
    };
    const proof = {
      gate,
      probe: () => {
        throw Error('mock recover must not call real native');
      },
    };
    const lease = {
      policy: {
        preservingUpdate: {
          operation: 'restart',
          processFamily: { format: 1 },
          priorBootExit: priorBoot,
          active: {
            currentManifestSha256: 'a'.repeat(64),
            candidateManifestSha256: 'b'.repeat(64),
          },
        },
      },
      authorizePackage() {},
      registerOutput() {},
      createdOutput() {},
      check() {},
      authorizeRecoveryPackage() {},
      preparePriorBootExit() {
        events.push('fresh');
        assert(!events.includes('archive'));
        return proof;
      },
      bindPreservingChild() {
        events.push('bind');
        if (
          failure.startsWith('health-family') &&
          events.includes('candidate-start') &&
          events.filter((v) => v === 'bind').length > 1
        )
          throw Error('synthetic-unknown-family');
      },
      sealPreservingProcessFamily() {
        events.push('seal');
        return true;
      },
      confirmPreservingProcessExit() {
        events.push('new-exit');
        return true;
      },
    };
    const identity = (pid) => {
      assert(children.has(pid), 'no Snapshot of absent old PID');
      const c = children.get(pid);
      return {
        pid,
        startUtc: '2026-01-02T01:00:00.0000000Z',
        executable: c.exe,
        commandLine: exported.launchCommandLine(c.exe, c.args),
        port: 4000,
      };
    };
    const lib = {
      hostEffects: {
        fs,
        processes: {
          spawn(exe, args) {
            assert(events.includes('backup') && events.includes('archive'));
            assert.equal(
              held.size,
              2,
              'both normal locks protect the new writer acquisition',
            );
            const child = { pid: nextPid++, exitCode: null, unref() {} };
            children.set(child.pid, { exe, args });
            const id = identity(child.pid),
              p = path.dirname(path.dirname(exe));
            fs.writeFileSync(
              marker,
              JSON.stringify({
                mode: 'writer',
                databaseIdentity: priorBoot.database.identity,
                pid: child.pid,
                startUtc: id.startUtc,
                executableHash: manifests.get(p).files['runtime/node.exe'],
                commandHash: sha(id.commandLine),
              }),
            );
            events.push(p === release ? 'candidate-start' : 'fallback-start');
            return child;
          },
        },
      },
      verifyRelease: (p) => manifests.get(p),
      verifyReleaseAsync: async (p) => manifests.get(p),
      fileHash: hash,
      cleanEnvironment: (v) => v,
      inside: (r, p) => p.startsWith(r + path.sep),
      writeJson(p, v) {
        if (
          (failure === 'backup-diagnostic' &&
            path.basename(p) === 'failure.json') ||
          (failure === 'health-fallback-diagnostic' &&
            path.basename(p) === 'fallback-failure.json')
        )
          throw Error('synthetic-diagnostic');
        if (path.basename(p) === 'summary.json') summary = v;
        fs.writeFileSync(p, JSON.stringify(v));
      },
      run(_exe, args) {
        if (args[0].endsWith('backup-space-status.py')) {
          events.push('capacity');
          return JSON.stringify({
            capacityAllowsNextBackup: failure !== 'capacity',
          });
        }
        if (args.includes('--backup-root')) {
          events.push('backup');
          assert.equal(held.size, 0);
          assert.equal(fs.readFileSync(marker, 'utf8'), oldRaw);
          if (failure.startsWith('backup')) throw Error('synthetic-backup');
          const backup = path.join(base, 'backup.db');
          fs.copyFileSync(database, backup);
          return JSON.stringify({
            integrityCheck: 'ok',
            backup,
            sha256: hash(backup),
          });
        }
        assert.equal(
          args[args.indexOf('--database') + 1],
          path.join(base, 'backup.db'),
        );
        return JSON.stringify({ pending: [] });
      },
    };
    const locks = {
      acquire(p) {
        assert(!held.has(p));
        held.add(p);
        events.push('lock');
        return {
          path: p,
          assertOwned() {
            assert(held.has(p));
          },
          release() {
            attempts.push(p);
            assert(held.has(p));
            held.delete(p);
            if (
              (failure === 'health-final-lock' &&
                p.endsWith('.active-release.lock')) ||
              (failure === 'active-release' &&
                p.endsWith('.active-release.lock')) ||
              (failure === 'budget-release' && p.endsWith('.build-budget.lock'))
            )
              throw Error('synthetic-release');
          },
        };
      },
    };
    const recover = {
      recover({ sessions }) {
        assert.equal(held.size, 2);
        assert.equal(sessions.length, 2);
        assert(events.includes('backup'));
        if (failure === 'recover') throw Error('synthetic-recover');
        const receipt = path.join(base, 'receipt');
        fs.mkdirSync(receipt);
        fs.renameSync(marker, path.join(receipt, 'lease.json'));
        fs.writeFileSync(path.join(receipt, 'intent.json'), '{}');
        fs.writeFileSync(path.join(receipt, 'complete.json'), '{}');
        events.push('archive');
        return {
          status: 'preserved-abnormal-exit-lease',
          reason: 'owner-from-prior-boot',
          receipt,
        };
      },
    };
    const localRequire = (p) => {
      if (p === './lib.cjs') return lib;
      if (p === './release-scope.cjs')
        return {
          session: () => lease,
          assertWritableSession() {},
          within: (_r, cb) => cb(lease),
        };
      if (p === './switch.cjs')
        return {
          loadProductionEnvironment() {},
          processIdentity: (action, pid) =>
            action === 'Port' ? [] : identity(pid),
          waitReady: async (_port, child) => {
            if (
              failure === 'health-fallback-diagnostic' &&
              children.get(child.pid).exe.includes('current')
            )
              throw Error('synthetic-fallback-health');
            if (
              failure.startsWith('health') &&
              children.get(child.pid).exe.includes('candidate')
            )
              throw Error('synthetic-health');
          },
          stopOwned: async (child) => {
            if (failure === 'health-family-stop') throw Error('synthetic-stop');
            if (child) {
              child.exitCode = 0;
              events.push('stop-new');
            }
          },
        };
      if (p === './preserving-contract.cjs')
        return { validateSameSchema: () => ({ verified: true }) };
      if (p === './startup-acceptance.cjs')
        return { accepted: () => false, recordAcceptance() {} };
      if (p === './active-release.cjs')
        return {
          writeActiveReleaseAsync: async () => {
            assert.equal(held.size, 0);
            events.push('pointer');
          },
        };
      if (p === './space-budget.cjs')
        return { productionRoot: () => path.join(base, 'backups') };
      if (p.endsWith('normal-start-lock.cjs')) return locks;
      if (p.endsWith('writer-exit-recovery.cjs')) return recover;
      if (p.endsWith('project-writer-gate.cjs')) return gate;
      return require(p);
    };
    localRequire.main = undefined;
    const fakeProcess = Object.create(process);
    Object.defineProperty(fakeProcess, 'platform', { value: 'win32' });
    const module = { exports: {} };
    try {
      vm.runInThisContext(
        '(function(require,module,exports,__dirname,process){' +
          fs.readFileSync(path.join(__dirname, 'restart.cjs'), 'utf8') +
          '\n})',
      )(localRequire, module, module.exports, dir, fakeProcess);
      exported = module.exports;
      priorBoot.commandHash = sha(
        exported.commandLine(previous, database, 4000),
      );
      const run = exported.controlledRestart({
        production: true,
        rehearsal: false,
        mode: 'restart',
        release,
        previous,
        database,
      });
      if (failure === 'none') {
        const result = await run;
        assert.equal(result.oldStopped, false);
        assert.equal(result.oldExitReason, 'owner-from-prior-boot');
        assert.equal(result.priorBootReceipt.leaseSha256, sha(oldRaw));
      } else
        await assert.rejects(run, (error) => {
          const messages = [];
          const visit = (e) => {
            messages.push(e.message);
            for (const inner of e.errors || []) visit(inner);
          };
          visit(error);
          if (failure.startsWith('health-'))
            assert(messages.includes('synthetic-health'), messages.join('|'));
          if (failure.startsWith('health-family')) {
            assert(messages.includes('synthetic-unknown-family'));
            assert(
              !events.includes('fallback-start'),
              'unknown family must still deny fallback',
            );
          }
          if (failure === 'health-family-stop')
            assert(messages.includes('synthetic-stop'));
          if (failure.endsWith('diagnostic'))
            assert(messages.includes('synthetic-diagnostic'));
          if (failure === 'backup-diagnostic')
            assert(messages.includes('synthetic-backup'));
          if (failure === 'health-fallback-diagnostic')
            assert(messages.includes('synthetic-fallback-health'));
          if (failure === 'health-final-lock')
            assert(messages.includes('synthetic-release'));
          return true;
        });
      assert.equal(held.size, 0);
      assert.equal(
        new Set(attempts).size,
        attempts.length,
        'never retry a release of uncertain outcome',
      );
      assert.equal(
        fs.readFileSync(database, 'utf8'),
        'synthetic immutable database',
      );
      if (['capacity', 'backup', 'recover'].includes(failure)) {
        assert(
          !events.includes('candidate-start') &&
            !events.includes('fallback-start'),
        );
        assert.equal(fs.readFileSync(marker, 'utf8'), oldRaw);
      }
      if (failure === 'health') {
        assert.equal(events.filter((v) => v === 'fallback-start').length, 1);
        assert.equal(summary.oldStopped, false);
        assert.equal(summary.rollbackUsed, true);
      }
      if (failure.endsWith('-release'))
        assert(
          !events.includes('fallback-start'),
          'uncertain lock release grants no fallback',
        );
      assert(
        events.indexOf('capacity') < events.indexOf('backup') ||
          failure === 'capacity',
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}
