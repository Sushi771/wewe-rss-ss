// Stable Task Scheduler entry point. It never stops a listener on port 4000.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const {
  readActiveRelease,
  checkedRelease,
  writeActiveRelease,
} = require('./active-release.cjs');
const { controlledRestart, commandLine } = require('./restart.cjs');
const { processIdentity } = require('./switch.cjs');

const root = path.resolve(__dirname, '../..');
const database = path.join(root, 'apps/server/data/wewe-rss.db');
const reportDir = path.join(root, 'output/playwright/local-release-audit');

function classifyListener(owners, release, snapshot = processIdentity) {
  if (owners.length === 0) return { status: 'free' };
  if (owners.length !== 1) throw new Error('4000 端口存在多个监听进程');
  const identity = snapshot('Snapshot', owners[0].OwningProcess, 4000);
  const expected = commandLine(release, fs.realpathSync(database), 4000);
  if (
    identity.commandLine !== expected ||
    identity.executable.toLowerCase() !==
      path.join(release, 'runtime/node.exe').toLowerCase()
  )
    throw new Error(`4000 端口由非当前产物进程占用，PID ${identity.pid}`);
  return { status: 'already-running', identity };
}

async function startAtLogon() {
  if (process.platform !== 'win32') throw new Error('登录任务仅支持 Windows');
  // Login starts only the verified web server package.
  const { release, manifest } = readActiveRelease();
  const owners = processIdentity('Port', undefined, 4000);
  const listener = classifyListener(owners, release);
  if (listener.status === 'already-running')
    return {
      status: 'already-running',
      releaseId: manifest.id,
      pid: listener.identity.pid,
    };
  const summary = await controlledRestart({
    release,
    database,
    mode: 'start',
    production: true,
    rehearsal: false,
  });
  return {
    status: 'started',
    releaseId: manifest.id,
    pid: summary.newIdentity.pid,
    audit: summary.audit,
  };
}

function activateRunning(candidate) {
  const { release } = checkedRelease(candidate);
  const listener = classifyListener(
    processIdentity('Port', undefined, 4000),
    release,
  );
  if (listener.status !== 'already-running')
    throw new Error('只有当前产物正在独占 4000 端口时才能设置开机指针');
  return {
    status: 'activated',
    ...writeActiveRelease(release),
    pid: listener.identity.pid,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { release: { type: 'string' } },
  });
  const action = positionals[0] || 'start';
  let result;
  try {
    if (action === 'activate' && values.release)
      result = activateRunning(values.release);
    else if (action === 'start' && !values.release)
      result = await startAtLogon();
    else
      throw new Error(
        '用法: logon-start.cjs [start | activate --release <目录>]',
      );
    console.log(JSON.stringify(result));
  } catch (error) {
    result = { status: 'failed', action, error: error.message };
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
  fs.mkdirSync(reportDir, { recursive: true });
  fs.appendFileSync(
    path.join(reportDir, 'logon-start.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n',
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

module.exports = { classifyListener, startAtLogon, activateRunning };
