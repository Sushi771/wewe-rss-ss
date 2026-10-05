// Hidden WSH entry and the compatible batch launcher share the guarded startup.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startAtLogon } = require('./logon-start.cjs');

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
  process.env.ENABLE_SCHEDULED_UPDATES = '0';
  process.env.DISABLE_SCHEDULED_UPDATES = '1';
  const start = performance.now();
  const result = await startAtLogon();
  const readyMs = Math.round(performance.now() - start);
  if (!process.argv.includes('--check')) await openBrowser();
  const report = path.resolve(
    __dirname,
    '../../output/playwright/local-release-audit',
  );
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
    const report = path.resolve(
      __dirname,
      '../../output/playwright/local-release-audit',
    );
    fs.mkdirSync(report, { recursive: true });
    fs.appendFileSync(
      path.join(report, 'desktop-start.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        status: 'failed',
        error: error.message,
      }) + '\n',
    );
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { openBrowser, url };
