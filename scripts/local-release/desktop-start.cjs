// WSH and the compatible batch launcher share the guarded startup.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startAtLogon } = require('./logon-start.cjs');
const { writeProgress, showProgress } = require('./desktop-progress.cjs');
const {
  discoverDocker,
  readPin,
  realAdapter,
  ensureDependencies,
  withLaunchLock,
  safeFailure,
  failure,
} = require('./desktop-dependencies.cjs');
const report = path.resolve(
  __dirname,
  '../../output/playwright/local-release-audit',
);

const url = 'http://127.0.0.1:4000/dash/tools/article-download';
const backendUrl = 'http://127.0.0.1:18080/#/';
function openBrowser() {
  const candidates = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
  ]
    .filter(Boolean)
    .map((base) => path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
  const edge = candidates.find((candidate) => fs.existsSync(candidate));
  const executable = edge || path.join(process.env.SystemRoot, 'explorer.exe');
  const launch = (args) => {
    const child = spawn(executable, args, {
      // This is the user's browser window, not a hidden background helper.
      windowsHide: false,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  };
  return edge
    ? launch([url, backendUrl])
    : Promise.all([launch([url]), launch([backendUrl])]);
}

async function main() {
  const start = performance.now();
  const phases = [];
  const check = process.argv.includes('--check');
  let joined = false;
  let ownsProgress = false;
  const phase = (stage) => {
    phases.push({ stage, elapsedMs: Math.round(performance.now() - start) });
    if (ownsProgress) writeProgress(report, stage);
  };
  try {
    const result = await withLaunchLock(
      path.join(report, 'desktop-start.lock'),
      async () => {
        let windowReady;
        if (!check && !joined) {
          ownsProgress = true;
          phase('waiting');
          windowReady = showProgress(report);
        }
        // Window initialization and read-only dependency discovery do not depend
        // on each other. Await both outcomes before starting the application;
        // a failed window must still fail launch, never silently lose feedback.
        const [window, dependencies] = await Promise.allSettled([
          windowReady,
          (async () => {
            phase('docker');
            const pin = readPin();
            const installation = await discoverDocker();
            return ensureDependencies(realAdapter(installation), pin, {
              reuseOnly: process.argv.includes('--reuse-only'),
              onProgress: phase,
            });
          })(),
        ]);
        if (window.status === 'rejected') throw window.reason;
        if (dependencies.status === 'rejected') throw dependencies.reason;
        const dependency = dependencies.value;
        if (
          process.argv.includes('--reuse-only') &&
          !require('./switch.cjs').processIdentity('Discover', undefined, 4000)
        )
          throw failure('WEWE_START_FAILED');
        let app;
        phase('app');
        try {
          app = await startAtLogon();
        } catch {
          throw failure('WEWE_START_FAILED');
        }
        if (!check && !joined) {
          phase('browser');
          try {
            await openBrowser();
          } catch {
            throw failure('BROWSER_FAILED');
          }
        }
        phase('ready');
        return {
          status: app.status,
          releaseId: app.releaseId,
          pid: app.pid,
          dependency,
        };
      },
      {
        onWait: async () => {
          joined = true;
          if (!check) await showProgress(report);
        },
      },
    );
    const readyMs = Math.round(performance.now() - start);
    fs.mkdirSync(report, { recursive: true });
    fs.appendFileSync(
      path.join(report, 'desktop-start.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        ...result,
        readyMs,
        phases,
        browserRequested: !check && !joined,
        joined,
      }) + '\n',
    );
  } catch (error) {
    if (ownsProgress) writeProgress(report, 'waiting', safeFailure(error));
    error.launchPhases = phases;
    error.elapsedMs = Math.round(performance.now() - start);
    throw error;
  }
}
if (require.main === module)
  main().catch((error) => {
    const safe = safeFailure(error);
    fs.mkdirSync(report, { recursive: true });
    fs.appendFileSync(
      path.join(report, 'desktop-start.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        status: 'failed',
        ...safe,
        phases: error.launchPhases,
        elapsedMs: error.elapsedMs,
      }) + '\n',
    );
    fs.writeFileSync(
      path.join(report, 'desktop-start-error.txt'),
      `${safe.code}\r\n${safe.message}\r\n日志：${path.join(report, 'desktop-start.jsonl')}\r\n`,
      'utf8',
    );
    console.error(`${safe.code}: ${safe.message}`);
    process.exitCode = 1;
  });
module.exports = { openBrowser, url, backendUrl };
