// Isolated test browser only: one bounded cold-start deadline, no launch retry.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function stderrSummary(value) {
  const text = String(value).slice(-8192);
  const categories = [
    ['devtools-listening', /DevTools listening on/],
    ['sandbox-error', /No usable sandbox|SUID sandbox/i],
    ['display-error', /Missing X server|cannot open display/i],
    ['profile-in-use', /ProcessSingleton|profile.*in use/i],
    ['resource-exhausted', /out of memory|No space left|Too many open files/i],
    ['permission-denied', /Permission denied|Access is denied/i],
    ['dbus-error', /Failed to connect to the bus/i],
    ['crashpad-error', /crashpad.*(?:error|failed)/i],
  ]
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  return {
    categories,
    unclassified: text.length > 0 && categories.length === 0,
  };
}

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
  spawnError = () => null,
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
    phase = 'debug-port',
    discovery;
  const diagnostics = () => ({
    elapsedMs: Math.round(now() - started),
    timeoutMs,
    endpointAttempts: attempts,
    portSource: discovery?.source ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    phase,
    spawnErrorCode: [
      'ENOENT',
      'EACCES',
      'ENOEXEC',
      'EMFILE',
      'ENFILE',
    ].includes(spawnError())
      ? spawnError()
      : spawnError() === null
        ? null
        : 'UNKNOWN',
    lastFailure,
    stderrSummary: stderrSummary(stderr()),
  });
  while (now() < deadline) {
    if (spawnError() !== null)
      throw new Error('BROWSER_SPAWN_FAILED ' + JSON.stringify(diagnostics()));
    if (child.exitCode !== null || child.signalCode != null)
      throw new Error(
        'BROWSER_EXITED_BEFORE_READY ' + JSON.stringify(diagnostics()),
      );
    discovery = portReader(profile, stderr());
    if (discovery) {
      attempts++;
      phase = 'debug-http';
      lastFailure = 'debug-endpoint-unavailable';
      try {
        const response = await fetchImpl(
          `http://127.0.0.1:${discovery.port}/json/list`,
          {
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(800, Math.floor(deadline - now()))),
            ),
          },
        );
        if (!response.ok) {
          lastFailure =
            Number.isInteger(response.status) &&
            response.status >= 100 &&
            response.status <= 599
              ? 'debug-http-' + response.status
              : 'debug-http-invalid-status';
          throw new Error(lastFailure);
        }
        lastFailure = 'debug-response-invalid';
        const tabs = await response.json();
        if (now() >= deadline) {
          lastFailure = 'debug-endpoint-deadline';
          throw new Error(lastFailure);
        }
        phase = 'blank-page';
        lastFailure = 'blank-page-not-ready';
        const page =
          Array.isArray(tabs) &&
          tabs.find((tab) => tab.type === 'page' && tab.url === 'about:blank');
        const url = page && new URL(page.webSocketDebuggerUrl);
        if (
          !url ||
          url.protocol !== 'ws:' ||
          url.hostname !== '127.0.0.1' ||
          Number(url.port) !== discovery.port ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !url.pathname.startsWith('/devtools/page/')
        )
          throw new Error('blank-page-not-ready');
        lastFailure = null;
        phase = 'ready';
        return { page, diagnostics: diagnostics() };
      } catch {
        // Report the fixed stage/code; endpoint errors may contain URLs or paths.
      }
    }
    if (now() < deadline) await pause(Math.min(100, deadline - now()));
  }
  throw new Error(
    'BROWSER_READINESS_DEADLINE ' + JSON.stringify(diagnostics()),
  );
}
module.exports = { debugPort, waitForBrowser };
