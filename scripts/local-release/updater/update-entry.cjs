'use strict';

// This file belongs in the fixed package's updater directory. The existing
// release builder supplies installed-host.cjs after its unchanged source gate.
// No git, package build, dependency install or source integration occurs here.
const fs = require('node:fs');
const path = require('node:path');
const { createUpdater } = require('./installer/update-engine.cjs');

const messages = {
  verified: '安装包已确认',
  stopping: '正在关闭应用',
  'backing-up': '正在备份数据',
  migrating: '正在升级数据',
  starting: '正在启动新版',
  checking: '正在确认启动结果',
  activating: '正在完成更新',
  completed: '新版已提交，正在完成启动',
  recovering: '正在恢复旧版',
  recovered: '已恢复旧版',
  'recovery-failed': '恢复未完成，请保留更新记录并联系维护者',
};

async function runUpdate({
  host,
  request,
  recoveryOnly = false,
  report = () => {},
}) {
  if (typeof host?.runMaintenance === 'function') {
    const result = await host.runMaintenance({ request, recoveryOnly, report });
    return result;
  }
  // The installed host retains existing package/source validation, shared
  // startup exclusion and private data locations. The user never enters them.
  if (
    !host ||
    typeof host.createAdapter !== 'function' ||
    typeof host.journalFile !== 'string' ||
    !path.isAbsolute(host.journalFile)
  )
    throw new Error('INSTALLED_UPDATE_HOST_REQUIRED');
  const adapter = await host.createAdapter();
  const updater = createUpdater({
    journalFile: host.journalFile,
    adapter,
    onProgress: ({ stage }) => report(messages[stage] || stage),
  });
  const result = recoveryOnly
    ? await updater.recover()
    : await updater.update(request);
  const summary = {
    completed: '更新完成，可以继续使用。',
    'already-current': '当前已是这个版本。',
    busy: '应用正在更新，请等待当前更新结束。',
    'failed-recovered': '更新未完成，已恢复旧版，原有数据已保留。',
    recovered: '已恢复中断前的版本，可以继续使用。',
    idle: '没有需要恢复的更新。',
    'completed-start-pending': '新版已提交，启动尚未完成；再次打开将继续启动。',
  };
  report(summary[result.status] || result.status);
  return result;
}

async function main() {
  const recoveryOnly = process.argv.slice(2).includes('--recover');
  if (process.argv.slice(2).some((v) => v !== '--recover'))
    throw new Error('UPDATE_ACCEPTS_NO_USER_CONFIGURATION');
  const hostFile = path.join(__dirname, 'installed-host.cjs');
  if (!fs.existsSync(hostFile))
    throw new Error('INSTALLED_UPDATE_HOST_REQUIRED');
  const bindingsFile = path.join(__dirname, 'installed-host-bindings.json');
  const mode = fs.existsSync(bindingsFile)
    ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8').replace(/^\uFEFF/, ''))
        .mode
    : undefined;
  const host =
    mode === 'maintenance-driver-v1'
      ? require('./maintenance-entry.cjs').createMaintenanceEntry({
          bindingsFile,
        })
      : require(hostFile);
  const request = recoveryOnly
    ? undefined
    : JSON.parse(
        fs.readFileSync(path.join(__dirname, 'update-request.json'), 'utf8'),
      );
  const result = await runUpdate({
    host,
    request,
    recoveryOnly,
    report: (message) => process.stdout.write(message + '\n'),
  });
  if (['failed-recovered', 'completed-start-pending'].includes(result.status))
    process.exitCode = 2;
}

if (require.main === module)
  main().catch((error) => {
    // Do not print arbitrary adapter error content (which may contain secrets).
    process.stderr.write(
      '更新未完成。请保留 updater 的事务记录，由维护者处理。\n',
    );
    process.stderr.write(
      /^[A-Z_]+$/.test(error.message)
        ? error.message + '\n'
        : 'UPDATE_FAILED\n',
    );
    process.exitCode = 1;
  });

module.exports = { runUpdate, messages };
