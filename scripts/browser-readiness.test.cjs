const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { debugPort, waitForBrowser } = require('./browser-readiness.cjs');
const page = {
  type: 'page',
  url: 'about:blank',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/synthetic',
};
function fixture(options = {}) {
  let time = 0;
  return {
    child: { exitCode: null, signalCode: null },
    profile: 'unused',
    stderr: () => '',
    now: () => time,
    pause: async (ms) => {
      time += ms;
    },
    timeoutMs: 1000,
    portReader: () => ({ port: 9222, source: 'stderr' }),
    fetchImpl: async () => ({ ok: true, json: async () => [page] }),
    ...options,
  };
}
test('published stderr endpoint is usable before port file; invalid ports cannot authorize requests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-browser-port-'));
  try {
    assert.deepEqual(
      debugPort(
        dir,
        'DevTools listening on ws://127.0.0.1:9222/devtools/browser/x',
      ),
      { port: 9222, source: 'stderr' },
    );
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '70000\n');
    assert.equal(debugPort(dir, ''), undefined);
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9223\n/browser/x');
    assert.deepEqual(debugPort(dir, ''), { port: 9223, source: 'port-file' });
  } finally {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true });
  }
});
test('cold startup and transient HTTP failure remain within one deadline', async () => {
  let calls = 0;
  const report = await waitForBrowser(
    fixture({
      fetchImpl: async () => {
        if (++calls === 1) throw new Error('connection refused');
        return { ok: true, json: async () => [page] };
      },
    }),
  );
  assert.equal(report.diagnostics.endpointAttempts, 2);
  assert.equal(report.diagnostics.elapsedMs, 100);
  assert.deepEqual(report.page, page);
});
test('port file alone, HTTP refusal or missing page never becomes readiness', async () => {
  for (const override of [
    { portReader: () => undefined },
    {
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    },
    { fetchImpl: async () => ({ ok: true, json: async () => [] }) },
  ])
    await assert.rejects(
      waitForBrowser(fixture(override)),
      /BROWSER_READINESS_DEADLINE.*"elapsedMs":1000/,
    );
});
test('child exit fails immediately and a foreign debugging URL is rejected', async () => {
  await assert.rejects(
    waitForBrowser(fixture({ child: { exitCode: 1, signalCode: null } })),
    /BROWSER_EXITED_BEFORE_READY/,
  );
  await assert.rejects(
    waitForBrowser(
      fixture({
        fetchImpl: async () => ({
          ok: true,
          json: async () => [
            {
              ...page,
              webSocketDebuggerUrl: 'ws://example.invalid:9222/devtools/page/x',
            },
          ],
        }),
      }),
    ),
    /BROWSER_READINESS_DEADLINE/,
  );
});
test('deadline cannot be unlimited or silently relaxed beyond 30 seconds', async () => {
  for (const timeoutMs of [0, Infinity, 30001])
    await assert.rejects(
      waitForBrowser(fixture({ timeoutMs })),
      /Invalid bounded/,
    );
});

test('a late cold start is accepted after ten seconds within the same thirty-second deadline', async () => {
  let time = 0,
    calls = 0;
  const result = await waitForBrowser(
    fixture({
      timeoutMs: 30000,
      now: () => time,
      pause: async (ms) => {
        time += ms;
      },
      portReader: () =>
        time >= 15000 ? { port: 9222, source: 'port-file' } : undefined,
      fetchImpl: async () => {
        calls++;
        return { ok: true, json: async () => [page] };
      },
    }),
  );
  assert.equal(result.diagnostics.elapsedMs, 15000);
  assert.equal(result.diagnostics.timeoutMs, 30000);
  assert.equal(result.diagnostics.phase, 'ready');
  assert.equal(calls, 1);
});

test('a response completing after the deadline cannot become ready', async () => {
  let time = 0;
  await assert.rejects(
    waitForBrowser(
      fixture({
        now: () => time,
        fetchImpl: async () => ({
          ok: true,
          json: async () => {
            time = 1000;
            return [page];
          },
        }),
      }),
    ),
    /BROWSER_READINESS_DEADLINE.*debug-endpoint-deadline/,
  );
});

test('startup diagnostics contain only bounded fixed stderr categories and endpoint failure codes', async () => {
  const secret = 'synthetic-private-token';
  const stderr =
    'Permission denied C:/private/profile https://example.invalid/?token=' +
    secret +
    '\n' +
    'x'.repeat(100000);
  let failure;
  try {
    await waitForBrowser(
      fixture({
        stderr: () => stderr,
        fetchImpl: async () => {
          throw Error('private response ' + secret);
        },
      }),
    );
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /BROWSER_READINESS_DEADLINE/);
  assert.match(failure.message, /debug-endpoint-unavailable/);
  assert.ok(failure.message.length < 1000);
  for (const value of [
    secret,
    'C:/private',
    'example.invalid',
    'private response',
  ])
    assert.ok(!failure.message.includes(value));
  const ready = await waitForBrowser(
    fixture({ stderr: () => 'Permission denied ' + secret }),
  );
  assert.deepEqual(ready.diagnostics.stderrSummary, {
    categories: ['permission-denied'],
    unclassified: false,
  });
  assert.ok(!JSON.stringify(ready).includes(secret));
});

test('spawn failure and child signal terminate before any endpoint probe without reflecting arbitrary errors', async () => {
  for (const spawnError of ['ENOENT', 'private/path/token']) {
    let probes = 0;
    await assert.rejects(
      waitForBrowser(
        fixture({
          spawnError: () => spawnError,
          portReader: () => {
            probes++;
            return { port: 9222, source: 'stderr' };
          },
        }),
      ),
      (error) => {
        assert.match(error.message, /BROWSER_SPAWN_FAILED/);
        assert.match(
          error.message,
          spawnError === 'ENOENT'
            ? /"spawnErrorCode":"ENOENT"/
            : /"spawnErrorCode":"UNKNOWN"/,
        );
        assert.ok(!error.message.includes('private/path'));
        return true;
      },
    );
    assert.equal(probes, 0);
  }
  await assert.rejects(
    waitForBrowser(
      fixture({ child: { exitCode: null, signalCode: 'SIGTERM' } }),
    ),
    /BROWSER_EXITED_BEFORE_READY.*SIGTERM/,
  );
});

test('credentials, query parameters and fragments cannot enter a prepared local CDP endpoint', async () => {
  for (const webSocketDebuggerUrl of [
    'ws://user:secret@127.0.0.1:9222/devtools/page/synthetic',
    page.webSocketDebuggerUrl + '?token=secret',
    page.webSocketDebuggerUrl + '#secret',
  ]) {
    await assert.rejects(
      waitForBrowser(
        fixture({
          fetchImpl: async () => ({
            ok: true,
            json: async () => [{ ...page, webSocketDebuggerUrl }],
          }),
        }),
      ),
      /BROWSER_READINESS_DEADLINE.*blank-page-not-ready/,
    );
  }
});

test('responsive startup failure spawns once and cleans its child, stderr and local server without entering layout checks', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(
    path.join(__dirname, 'responsive-layout-browser.test.cjs'),
    'utf8',
  );
  for (const code of [
    'BROWSER_EXITED_BEFORE_READY',
    'BROWSER_READINESS_DEADLINE',
    'BROWSER_SPAWN_FAILED',
  ]) {
    const counts = {
      spawn: 0,
      wait: 0,
      kill: 0,
      destroy: 0,
      close: 0,
      connections: 0,
      profiles: 0,
    };
    let launch, errorHandler;
    const child = {
      exitCode: null,
      signalCode: null,
      stderr: {
        on() {},
        destroy() {
          counts.destroy++;
        },
      },
      on(event, handler) {
        assert.equal(event, 'error');
        errorHandler = handler;
      },
      kill() {
        counts.kill++;
      },
    };
    const server = {
      listen(port, host, done) {
        assert.equal(port, 0);
        assert.equal(host, '127.0.0.1');
        done();
      },
      address: () => ({ port: 12345 }),
      closeAllConnections() {
        counts.connections++;
      },
      close(done) {
        counts.close++;
        done();
      },
    };
    const modules = {
      'node:fs': {
        mkdirSync() {},
        mkdtempSync(prefix) {
          counts.profiles++;
          return prefix + counts.profiles;
        },
      },
      'node:path': path,
      os: { tmpdir: () => path.resolve('synthetic-temp') },
      'node:http': { createServer: () => server },
      'node:assert/strict': assert,
      'node:child_process': {
        spawn(...args) {
          counts.spawn++;
          launch = args;
          return child;
        },
      },
      './browser-readiness.cjs': {
        waitForBrowser: async (options) => {
          counts.wait++;
          assert.equal(options.child, child);
          assert.match(options.profile, /profile-/);
          assert.equal(options.stderr(), '');
          errorHandler({ code: 'ENOENT', message: 'must not be retained' });
          assert.equal(options.spawnError(), 'ENOENT');
          assert.equal(options.stderr(), '');
          throw Error(code);
        },
      },
    };
    const errors = [],
      processMock = {
        env: {
          RESPONSIVE_TEST_BROWSER: 'synthetic-browser',
          PATH: 'unchanged',
        },
        exitCode: 0,
      };
    await vm.runInNewContext(source, {
      require: (name) => {
        assert.ok(name in modules, 'unexpected test dependency ' + name);
        return modules[name];
      },
      __dirname,
      process: processMock,
      console: {
        error: (message) => errors.push(message),
        info() {},
        log() {},
      },
      setTimeout: (fn) => {
        queueMicrotask(fn);
      },
      WebSocket: class {
        static OPEN = 1;
        constructor() {
          assert.fail('layout must not start before readiness');
        }
      },
    });
    assert.deepEqual(counts, {
      spawn: 1,
      wait: 1,
      kill: 1,
      destroy: 1,
      close: 1,
      connections: 1,
      profiles: 2,
    });
    assert.equal(launch[0], 'synthetic-browser');
    assert.equal(launch[2].windowsHide, true);
    assert.ok(
      launch[1].includes(
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ),
    );
    assert.ok(launch[1].includes('--remote-debugging-port=0'));
    assert.equal(launch[1].at(-1), 'about:blank');
    assert.equal(processMock.env.PATH, 'unchanged');
    assert.equal(processMock.exitCode, 1);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(code));
  }
});
