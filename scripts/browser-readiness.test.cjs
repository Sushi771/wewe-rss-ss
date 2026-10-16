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
