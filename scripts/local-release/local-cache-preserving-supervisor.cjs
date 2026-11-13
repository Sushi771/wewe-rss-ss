// Actual Windows child tree observations during the real Nest bootstrap.
// This does NOT fabricate task/shortcut/inflight facts or claim a release scope.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const families = require('./preserving-process-family.cjs');
const { argv } = require('./windows-release-references.cjs');
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const hash = (value) => digest(JSON.stringify(value));
const canonical = (value) => fs.realpathSync.native(value);
const samePath = (a, b) =>
  canonical(a).toLowerCase() === canonical(b).toLowerCase();

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        'PATH',
        'SYSTEMROOT',
        'WINDIR',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'HOME',
        'APPDATA',
        'LOCALAPPDATA',
        'PROGRAMDATA',
        'COMSPEC',
        'PATHEXT',
        'PROCESSOR_ARCHITECTURE',
        'NUMBER_OF_PROCESSORS',
      ].includes(key.toUpperCase()),
    ),
  );
async function main() {
  assert.equal(process.platform, 'win32');
  const [mode, ...parameters] = process.argv.slice(2);
  assert.ok(['prepare', 'execute'].includes(mode));
  assert.equal(parameters.length, mode === 'prepare' ? 2 : 4);
  const [companionSha, fixtureSha] = parameters.slice(-2);
  assert.ok(/^[a-f0-9]{64}$/.test(companionSha));
  assert.ok(/^[a-f0-9]{64}$/.test(fixtureSha));
  const companionFile = path.join(
    __dirname,
    'local-cache-preserving-scope.fixture.cjs',
  );
  assert.equal(digest(fs.readFileSync(companionFile)), companionSha);
  const companion = require(companionFile);
  const sourceFiles = [
    '../../apps/server/src/main.ts',
    '../../apps/server/src/collection/local-cache-reader.ts',
    'release-scope.cjs',
    'windows-release-references.cjs',
    'windows-release-reference-collector.ps1',
    'windows-reference-directory-identity.cs',
  ];
  const sourcePins = () =>
    Object.fromEntries(
      sourceFiles.map((relative) => {
        const file = path.resolve(__dirname, relative);
        return [file, digest(fs.readFileSync(file))];
      }),
    );
  const initialPins = sourcePins();

  const tool = require('./identity-tool.cjs').identityTool();
  assert.ok(tool, 'native observer required, no synthetic facts fallback');
  const python = cp
    .execFileSync('python', ['-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    .trim();
  const pythonHash = digest(fs.readFileSync(python));
  const fixture = path.join(
    __dirname,
    'local-cache-full-bootstrap.fixture.cjs',
  );
  const consolePath = path.join(process.env.SystemRoot, 'System32/conhost.exe');
  const consoleStat = fs.lstatSync(consolePath, { bigint: true });
  assert.ok(consoleStat.isFile() && !consoleStat.isSymbolicLink());
  const consoleSpec = {
    identity: [
      consoleStat.dev,
      consoleStat.ino,
      consoleStat.size,
      consoleStat.birthtimeNs,
      consoleStat.mtimeNs,
      consoleStat.ctimeNs,
    ].map(String),
    path: canonical(consolePath),
    sha256: digest(fs.readFileSync(consolePath)),
    argv: ['\\??\\' + canonical(consolePath), '0x4'],
  };
  assert.equal(digest(fs.readFileSync(fixture)), fixtureSha);
  async function run(extra = [], onReady = async () => {}, entry = fixture) {
    const child = cp.spawn(process.execPath, [entry, ...extra], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: cleanEnv(),
    });
    const priorSnapshots = new Map();
    const frames = [];
    let actualReady;
    let output = '',
      failure,
      lastPort,
      expected,
      snapshot,
      policy,
      ready = 0,
      stopped = 0;
    let observedExit = null,
      familyRemaining = null;
    try {
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      const ended = new Promise((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal })),
      );
      const observe = (port, targetPid = child.pid, timeout = 5000) => {
        const tree = JSON.parse(
          cp.execFileSync(
            tool,
            ['Tree', String(targetPid), String(port), '', '', ''],
            {
              encoding: 'utf8',
              windowsHide: true,
              timeout,
              maxBuffer: 1024 * 1024,
            },
          ),
        );
        assert.equal(tree.complete, true);
        frames.push(tree);
        return tree;
      };
      function records(tree, launchers, afterExit = false) {
        const root = tree.active.find((row) => row.pid === child.pid);
        if (!afterExit) assert.ok(root);
        return tree.active.map((row) => {
          const tokens = argv(row.commandLine);
          const index = launchers.findIndex(
            (l) => JSON.stringify(l.argv) === JSON.stringify(tokens),
          );
          if (index === -1) {
            assert.ok(
              samePath(row.executable, consolePath),
              'undeclared executable ' + row.executable,
            );
            assert.equal(
              digest(fs.readFileSync(row.executable)),
              consoleSpec.sha256,
            );
            assert.equal(tokens.length, 2);
            assert.ok(tokens[0].startsWith('\\??\\'));
            assert.ok(samePath(tokens[0].slice(4), consolePath));
            assert.equal(tokens[1], '0x4');
            const parent =
              tree.active.find((p) => p.pid === row.parentPid) ||
              priorSnapshots.get(row.parentPid);
            assert.ok(parent);
            const parentLaunch = launchers.find(
              (l) =>
                JSON.stringify(l.argv) ===
                JSON.stringify(argv(parent.commandLine)),
            );
            assert.ok(parentLaunch, 'unknown console parent');
            assert.ok(
              !tree.active.some((p) => p.parentPid === row.pid),
              'console has unknown descendants',
            );
            return {
              kind: 'processes',
              packageId: 'owned-nest-fixture',
              pid: row.pid,
              parentPid: row.parentPid,
              startUtc: row.startUtc,
              consoleHost: true,
              invocationSha256: hash(consoleSpec),
              parentInvocationSha256: hash(parentLaunch),
              identity: hash([
                row.pid,
                row.parentPid,
                row.startUtc,
                canonical(row.executable),
                consoleSpec.sha256,
                row.commandLine,
              ]),
            };
          }
          const launch = launchers[index];
          assert.ok(samePath(row.executable, launch.executable.path));
          assert.equal(
            digest(fs.readFileSync(row.executable)),
            launch.executable.sha256,
          );
          assert.equal(row.parentPid, index === 0 ? process.pid : child.pid);
          return {
            kind: 'processes',
            packageId: 'owned-nest-fixture',
            pid: row.pid,
            parentPid: row.parentPid,
            startUtc: row.startUtc,
            invocationSha256: hash(launch),
            parentInvocationSha256: index ? hash(launchers[0]) : null,
            identity: hash([
              row.pid,
              row.parentPid,
              row.startUtc,
              canonical(row.executable),
              digest(fs.readFileSync(row.executable)),
              row.commandLine,
            ]),
          };
        });
      }
      child.on('message', async (message) => {
        try {
          assert.equal(message.pid, child.pid);
          assert.ok(['ready', 'stopped'].includes(message.phase));
          if (message.phase === 'ready') {
            assert.ok(message.port > 0 && message.port !== 4000);
            lastPort = message.port;
            assert.ok(
              samePath(path.dirname(message.root), require('node:os').tmpdir()),
            );
            assert.ok(
              path.basename(message.root).startsWith('wewe-full-bootstrap-'),
            );
            assert.equal(
              digest(fs.readFileSync(message.script)),
              digest(
                fs.readFileSync(
                  path.resolve(
                    __dirname,
                    '../../apps/server/scripts/watch-wechat2rss-cache.py',
                  ),
                ),
              ),
            );
            assert.equal(
              digest(fs.readFileSync(message.snapshotScript)),
              digest(
                fs.readFileSync(
                  path.resolve(
                    __dirname,
                    '../../apps/server/scripts/sqlite-snapshot-guard.py',
                  ),
                ),
              ),
            );
            const launchers = [
              {
                packageId: 'owned-nest-fixture',
                entry,
                argv: [process.execPath, entry, ...extra],
                executable: {
                  path: process.execPath,
                  sha256: digest(fs.readFileSync(process.execPath)),
                },
              },
              {
                packageId: 'owned-nest-fixture',
                entry: message.script,
                parentEntry: entry,
                argv: [
                  'python',
                  '-u',
                  message.script,
                  '--database',
                  message.cache,
                  '--event-hints',
                ],
                executable: { path: python, sha256: pythonHash },
              },
            ];
            launchers.push({
              packageId: 'owned-nest-fixture',
              entry: message.snapshotScript,
              parentEntry: entry,
              argv: [
                'python',
                message.snapshotScript,
                '--database',
                message.database,
                '--backup-root',
                message.backupRoot,
                '--interval-seconds',
                '900',
                '--max-age-seconds',
                '900',
              ],
              executable: { path: python, sha256: pythonHash },
            });
            policy = {
              windowsReferences: { launchers },
              preservingUpdate: {
                processFamily: { format: 1, consoleHost: consoleSpec },
              },
            };
            const first = observe(lastPort);
            const consoleArgv = first.active
              .filter((row) => samePath(row.executable, consolePath))
              .map((row) => {
                const tokens = argv(row.commandLine);
                assert.equal(tokens.length, 2);
                assert.ok(tokens[0].startsWith('\\??\\'));
                assert.ok(samePath(tokens[0].slice(4), consolePath));
                assert.equal(tokens[1], '0x4');
                assert.equal(
                  digest(fs.readFileSync(row.executable)),
                  consoleSpec.sha256,
                );
                return tokens;
              });
            if (consoleArgv.length) {
              for (const tokens of consoleArgv)
                assert.deepEqual(tokens, consoleArgv[0]);
              consoleSpec.argv = [...consoleArgv[0]];
            }

            for (const row of first.active) priorSnapshots.set(row.pid, row);
            assert.ok(first.portOwners.length > 0);
            assert.ok(
              first.portOwners.every((r) => r.OwningProcess === child.pid),
            );
            snapshot = first.active.find((row) => row.pid === child.pid);
            const rows = records(first, launchers);
            expected = families.admit(
              [],
              rows,
              snapshot,
              'owned-nest-fixture',
              policy,
              false,
            );
            assert.equal(
              families
                .family(rows, child.pid, 'owned-nest-fixture', policy, true)
                .filter((r) => !r.consoleHost).length,
              3,
            );
            families.admit(
              expected,
              records(observe(lastPort), launchers),
              snapshot,
              'owned-nest-fixture',
              policy,
              true,
            );
            assert.equal(ready, 0);
            actualReady = {
              ...message,
              startUtc: snapshot.startUtc,
              executable: snapshot.executable,
              commandLine: snapshot.commandLine,
            };
            await onReady(actualReady, { snapshot, launchers, consoleSpec });
            families.admit(
              expected,
              records(observe(lastPort), launchers),
              snapshot,
              'owned-nest-fixture',
              policy,
              true,
            );
            ready++;
          } else {
            assert.equal(ready, 1);
            assert.equal(stopped, 0);
            assert.ok(expected);
            const tree = observe(lastPort);
            const rows = records(tree, policy.windowsReferences.launchers);
            assert.equal(
              rows.filter((r) => !r.consoleHost).length,
              1,
              'watcher/snapshot and descendants must be gone',
            );
            assert.ok(
              rows.every(
                (r) =>
                  r.pid === child.pid ||
                  (r.consoleHost && r.parentPid === child.pid),
              ),
            );
            assert.ok(rows.some((r) => r.pid === child.pid));
            assert.equal(tree.portOwners.length, 0);
            assert.equal(
              families.remaining(
                expected,
                rows,
                new Set(),
                tree.active.map(({ pid, parentPid }) => ({ pid, parentPid })),
              ),
              rows.length,
            );
            stopped++;
          }
          child.send({ continue: true });
        } catch (error) {
          failure ||= error;
          if (child.connected) child.send({ continue: false });
        }
      });
      let timer;
      const budget = 210000;
      try {
        await Promise.race([
          ended,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(Error('OWNED_MAIN_DEADLINE'));
            }, budget);
          }),
        ]);
      } catch (error) {
        failure ||= error;
        if (child.connected) child.send({ continue: false });
        const graceful = await Promise.race([
          ended,
          new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
        ]);
        if (!graceful && snapshot) {
          try {
            cp.execFileSync(
              tool,
              [
                'OwnedStop',
                String(child.pid),
                String(lastPort),
                snapshot.startUtc,
                snapshot.executable,
                snapshot.commandLine,
              ],
              { windowsHide: true, timeout: 20000, encoding: 'utf8' },
            );
          } catch (cleanup) {
            failure = new AggregateError(
              [failure, cleanup],
              'OWNED_MAIN_AND_CLEANUP_FAILED',
            );
          }
        }
        if (!graceful && !snapshot)
          throw new AggregateError(
            [
              failure,
              Error('NO_CAPTURED_ROOT_IDENTITY_MANUAL_REVIEW_REQUIRED'),
            ],
            'OWNED_MAIN_UNCERTAIN',
          );
      } finally {
        clearTimeout(timer);
      }
      const exit = (observedExit = await Promise.race([
        ended,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Error('OWNED_MAIN_EXIT_UNCONFIRMED')),
            10000,
          ).unref(),
        ),
      ]));
      try {
        if (expected && policy) {
          const until = Date.now() + 30000;
          const exited = new Set();
          for (;;) {
            const actual = new Map();
            for (const member of expected) {
              if (Date.now() > until) throw Error('OWNED_FAMILY_EXIT_DEADLINE');
              for (const row of observe(
                lastPort,
                member.pid,
                Math.min(5000, Math.max(1, until - Date.now())),
              ).active) {
                if (actual.has(row.pid))
                  assert.deepEqual(
                    actual.get(row.pid),
                    row,
                    'native identity changed between queries',
                  );
                actual.set(row.pid, row);
              }
            }
            const tree = { active: [...actual.values()] };
            const rows = records(
              tree,
              policy.windowsReferences.launchers,
              true,
            );
            const remaining = families.remaining(
              expected,
              rows,
              exited,
              tree.active.map(({ pid, parentPid }) => ({ pid, parentPid })),
            );
            familyRemaining = remaining;
            if (remaining === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      } catch (cleanup) {
        failure = failure
          ? new AggregateError(
              [failure, cleanup],
              'MAIN_FAILURE_AND_FAMILY_EXIT_UNCERTAIN',
            )
          : cleanup;
      }
      if (failure) throw failure;
      assert.equal(exit.code, 0, output);
      assert.equal(ready, 1);
      assert.equal(stopped, 1);
      assert.ok(output.includes('"childReads":0'));
      assert.ok(output.includes('"blockedChildren":0'));
      return {
        report: JSON.parse(
          output.split(/\r?\n/).find((line) => line.startsWith('{"ok":true,')),
        ),
        ready: actualReady,
        closed: { pid: child.pid, ...exit },
        nativeFrames: frames,
        postExitRemaining: familyRemaining,
      };
    } catch (error) {
      error.nativeEvidence = {
        pid: child.pid,
        ready: actualReady || null,
        closed: observedExit,
        postExitRemaining: familyRemaining,
        nativeFrames: frames,
        output,
      };
      throw error;
    }
  }
  if (mode === 'prepare') {
    const first = await run();
    assert.deepEqual(sourcePins(), initialPins);
    const bundle = companion.prepare(first.ready, first.closed);
    fs.writeFileSync(
      path.join(bundle.base, 'SOURCE_PINS.json'),
      JSON.stringify(initialPins, null, 2),
      { flag: 'wx' },
    );
    fs.writeFileSync(
      path.join(bundle.base, 'NATIVE_PREPARE.json'),
      JSON.stringify(first, null, 2),
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        prepared: path.join(bundle.base, 'PREPARED.json'),
        sha256: digest(
          fs.readFileSync(path.join(bundle.base, 'PREPARED.json')),
        ),
        policySha256: bundle.policySha256,
        proofSha256: bundle.proofSha256,
        executed: false,
      }),
    );
    return;
  }
  const [prepared, preparedSha] = parameters;
  assert.equal(path.basename(prepared), 'PREPARED.json');
  assert.ok(/^[a-f0-9]{64}$/.test(preparedSha));
  assert.equal(digest(fs.readFileSync(prepared)), preparedSha);
  const bundle = JSON.parse(fs.readFileSync(prepared));
  assert.equal(
    canonical(path.dirname(bundle.base)).toLowerCase(),
    canonical(require('node:os').tmpdir()).toLowerCase(),
  );
  assert.ok(path.basename(bundle.base).startsWith('wewe-preserving-scope-'));
  assert.equal(
    canonical(prepared),
    canonical(path.join(bundle.base, 'PREPARED.json')),
  );
  assert.equal(digest(fs.readFileSync(bundle.proofFile)), bundle.proofSha256);
  assert.equal(bundle.companionPin.sha256, companionSha);
  assert.equal(bundle.fixturePin.sha256, fixtureSha);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(bundle.base, 'SOURCE_PINS.json'))),
    initialPins,
  );
  assert.equal(
    bundle.wrapperPin.path,
    path.join(bundle.root, 'server', 'runtime.cjs'),
  );
  assert.equal(
    digest(fs.readFileSync(bundle.wrapperPin.path)),
    bundle.wrapperPin.sha256,
  );
  assert.deepEqual(bundle.nextArgv, [
    process.execPath,
    bundle.wrapperPin.path,
    '--reuse-root',
    bundle.root,
  ]);
  try {
    const live = await run(
      ['--reuse-root', bundle.root],
      async (ready, familyContext) => {
        const bindings = companion.bind(
          bundle,
          preparedSha,
          ready,
          familyContext,
        );
        return companion.execute(bundle, bindings);
      },
      bundle.wrapperPin.path,
    );
    assert.deepEqual(sourcePins(), initialPins);
    assert.equal(live.report.restartReplayIdentical, true);
    fs.writeFileSync(
      path.join(bundle.base, 'NATIVE_EXECUTE.json'),
      JSON.stringify(live, null, 2),
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        ok: true,
        base: bundle.base,
        nativeFamily: true,
        scopeReport: path.join(bundle.base, 'SCOPE_REPORT.json'),
        fixtureExited: true,
        productionTouched: false,
      }),
    );
  } catch (error) {
    const serialize = (e) => ({
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
      errors: e?.errors?.map(serialize),
      cause: e?.cause ? serialize(e.cause) : undefined,
      nativeEvidence: e?.nativeEvidence,
    });
    try {
      fs.writeFileSync(
        path.join(bundle.base, 'EXECUTION_FAILURE.json'),
        JSON.stringify(serialize(error), null, 2),
        { flag: 'wx' },
      );
    } catch (writeError) {
      throw new AggregateError(
        [error, writeError],
        'EXECUTION_AND_DIAGNOSTIC_WRITE_FAILED',
      );
    }
    throw error;
  }
}
main().catch((error) => {
  const serialize = (e) => ({
    name: e?.name,
    message: e?.message,
    stack: e?.stack,
    errors: e?.errors?.map(serialize),
    cause: e?.cause ? serialize(e.cause) : undefined,
    nativeEvidence: e?.nativeEvidence,
  });
  if (error.nativeEvidence) {
    try {
      const dir = fs.mkdtempSync(
        path.join(require('node:os').tmpdir(), 'wewe-native-failure-'),
      );
      fs.writeFileSync(
        path.join(dir, 'NATIVE_FAILURE.json'),
        JSON.stringify(serialize(error), null, 2),
        { flag: 'wx' },
      );
      console.error('Native failure evidence: ' + dir);
    } catch (writeError) {
      console.error(
        new AggregateError(
          [error, writeError],
          'FAILURE_EVIDENCE_WRITE_FAILED',
        ),
      );
    }
  }
  console.error(error.stack || error);
  process.exitCode = 1;
});
