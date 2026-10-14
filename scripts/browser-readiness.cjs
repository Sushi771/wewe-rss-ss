// Isolated test browser only: one bounded cold-start deadline, no launch retry.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function debugPort(profile, stderr) {
  let filePort;
  try {
    filePort = fs
      .readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8')
      .split('\n')[0]
      .trim();
  } catch {
    /* The file may not have been published yet. */
  }
  const stderrPort =
    /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//.exec(
      stderr,
    )?.[1];
  for (const [source, raw] of [
    ['port-file', filePort],
    ['stderr', stderrPort],
  ]) {
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0 && port <= 65535)
        return { port, source };
    }
  }
  return undefined;
}

async function waitForBrowser({
  child,
  profile,
  stderr,
  timeoutMs = 30000,
  fetchImpl = fetch,
  now = () => performance.now(),
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  portReader = debugPort,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error('Invalid bounded browser deadline');
  const started = now(),
    deadline = started + timeoutMs;
  let attempts = 0,
    lastFailure = 'debug-port-not-published',
    discovery;
  const diagnostics = () => ({
    elapsedMs: Math.round(now() - started),
    timeoutMs,
    endpointAttempts: attempts,
    portSource: discovery?.source ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    lastFailure,
    stderrTail: stderr().slice(-2000),
  });
  while (now() < deadline) {
    if (child.exitCode !== null || child.signalCode != null)
      throw new Error(
        'BROWSER_EXITED_BEFORE_READY ' + JSON.stringify(diagnostics()),
      );
    discovery = portReader(profile, stderr());
    if (discovery) {
      attempts++;
      try {
        const response = await fetchImpl(
          `http://127.0.0.1:${discovery.port}/json/list`,
          {
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(800, Math.floor(deadline - now()))),
            ),
          },
        );
        if (!response.ok) throw new Error('debug-http-' + response.status);
        const tabs = await response.json();
        const page =
          Array.isArray(tabs) &&
          tabs.find((tab) => tab.type === 'page' && tab.url === 'about:blank');
        const url = page && new URL(page.webSocketDebuggerUrl);
        if (
          !url ||
          url.protocol !== 'ws:' ||
          url.hostname !== '127.0.0.1' ||
          Number(url.port) !== discovery.port ||
          !url.pathname.startsWith('/devtools/page/')
        )
          throw new Error('blank-page-not-ready');
        lastFailure = null;
        return { page, diagnostics: diagnostics() };
      } catch (error) {
        lastFailure =
          String(error.name || 'Error') +
          ':' +
          String(error.message || '').slice(0, 160);
      }
    }
    if (now() < deadline) await pause(Math.min(100, deadline - now()));
  }
  throw new Error(
    'BROWSER_READINESS_DEADLINE ' + JSON.stringify(diagnostics()),
  );
}
module.exports = { debugPort, waitForBrowser };
