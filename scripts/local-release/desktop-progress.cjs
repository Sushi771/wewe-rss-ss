// UI state contains only allowlisted messages; credentials and response bodies stay out.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { failure } = require('./desktop-dependencies.cjs');
const stages = {
  available: '页面已打开，数据检查进度请查看页面提示。',
  waiting: '正在准备启动…',
  docker: '正在检查 Docker…',
  engine: '正在等待 Docker 就绪…',
  dependency: '正在检查原有订阅服务…',
  dependencyReady: '正在等待订阅服务就绪…',
  app: '正在启动并检查 WeWe-RSS… 首次启动可能需要几分钟。',
  browser: '服务已就绪，正在打开网页…',
  ready: 'WeWe-RSS 已就绪。',
};
function progressState(stage, error) {
  if (!Object.hasOwn(stages, stage)) throw new Error('Unknown startup stage');
  return {
    parentPid: process.pid,
    stage,
    message: error ? `${error.code}：${error.message}` : stages[stage],
    status: error
      ? 'failed'
      : stage === 'available'
        ? 'available'
        : stage === 'ready'
          ? 'ready'
          : 'starting',
    backendReady: ['app', 'browser', 'available', 'ready'].includes(stage),
    updatedAt: new Date().toISOString(),
  };
}
function writeProgress(directory, stage, error) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'desktop-start-status.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(progressState(stage, error)), {
      flag: 'wx',
    });
    // Windows can reject replacement during the UI's short file read, even
    // with delete sharing. Retry that observed sharing violation briefly;
    // preserve atomic publication and surface persistent I/O failures.
    const deadline = Date.now() + 250;
    for (;;) {
      try {
        fs.renameSync(temporary, file);
        break;
      } catch (error) {
        if (!['EPERM', 'EACCES'].includes(error.code) || Date.now() >= deadline)
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
async function showProgress(directory) {
  const receipt = path.join(directory, `desktop-ui-${randomUUID()}.json`);
  const log = fs.openSync(
    path.join(directory, 'desktop-progress-errors.log'),
    'a',
  );
  let child;
  try {
    child = await new Promise((resolve, reject) => {
      const child = spawn(
        path.join(
          process.env.SystemRoot,
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-File',
          path.join(__dirname, 'desktop-progress.ps1'),
          '-StateFile',
          path.join(directory, 'desktop-start-status.json'),
          '-ReceiptFile',
          receipt,
        ],
        {
          windowsHide: true,
          detached: false,
          shell: false,
          stdio: ['ignore', log, log],
        },
      );
      child.once('error', reject);
      child.once('spawn', () => {
        resolve(child);
      });
    });
  } finally {
    fs.closeSync(log);
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(receipt)) return;
    if (child.exitCode !== null) throw failure('STARTUP_WINDOW_FAILED');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw failure('STARTUP_WINDOW_FAILED');
}
module.exports = { stages, progressState, writeProgress, showProgress };
