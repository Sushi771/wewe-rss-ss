// Hidden WSH entry and the compatible batch launcher share the guarded startup.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startAtLogon } = require('./logon-start.cjs');
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
function openBrowser() {
  const candidates = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
  ]
    .filter(Boolean)
    .map((base) => path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
  const edge = candidates.find((candidate) => fs.existsSync(candidate));
  const executable = edge || path.join(process.env.SystemRoot, 'explorer.exe');
  const child = spawn(executable, [url], {
    windowsHide: true,
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
}

async function main() {
  const start = performance.now();
  const result = await withLaunchLock(
    path.join(report, 'desktop-start.lock'),
    async () => {
      const pin = readPin();
      const installation = await discoverDocker();
      const dependency = await ensureDependencies(
        realAdapter(installation),
        pin,
        {
          reuseOnly: process.argv.includes('--reuse-only'),
        },
      );
      if (
        process.argv.includes('--reuse-only') &&
        !require('./switch.cjs').processIdentity('Discover', undefined, 4000)
      )
        throw failure('WEWE_START_FAILED');
      let app;
      try {
        app = await startAtLogon();
      } catch {
        throw failure('WEWE_START_FAILED');
      }
      if (!process.argv.includes('--check')) {
        try {
          await openBrowser();
        } catch {
          throw failure('BROWSER_FAILED');
        }
      }
      return {
        status: app.status,
        releaseId: app.releaseId,
        pid: app.pid,
        dependency,
      };
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
      browserRequested: !process.argv.includes('--check'),
    }) + '\n',
  );
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
module.exports = { openBrowser, url };
