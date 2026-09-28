// 当前 schema 的 Windows 本机启动/重启。仅停止精确核验的本项目进程。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const {
  verifyRelease,
  writeJson,
  fileHash,
  cleanEnvironment,
  run,
} = require('./lib.cjs');
const {
  processIdentity,
  sameIdentity,
  unusedPort,
  waitReady,
  stopOwned,
  loadProductionEnvironment,
} = require('./switch.cjs');

const root = path.resolve(__dirname, '../..');
const pauseFile = path.join(root, 'tools/wechat-desktop-collector/.paused');
const productionDatabase = path.join(root, 'apps/server/data/wewe-rss.db');

function portOwners(port) {
  return processIdentity('Port', undefined, port);
}

function requireFreePort(port) {
  const owners = portOwners(port);
  assert.deepEqual(owners, [], `端口 ${port} 已有监听进程，拒绝启动`);
}

function commandLine(release, database, port) {
  const node = path.join(release, 'runtime/node.exe');
  const args = [
    path.join(release, 'runtime.cjs'),
    'start',
    '--database',
    database,
    '--port',
    String(port),
    '--pause-file',
    pauseFile,
    '--production',
  ];
  // 该本机 checkout 的路径无空格。若迁移到含空格路径，应先重新演练命令行编码。
  if ([node, ...args].some((item) => /\s/.test(item)))
    throw new Error('产物或数据库路径含空格，当前身份白名单不适用');
  return `${node} ${args.join(' ')}`;
}

function assertPaused(hash) {
  assert.equal(fs.readFileSync(pauseFile, 'utf8').trim(), 'USER_PAUSED');
  assert.equal(fileHash(pauseFile), hash, '共享暂停文件发生变化');
}

async function controlledRestart(options) {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows 本机');
  if (options.production === options.rehearsal)
    throw new Error('须且只能选择 --production 或 --rehearsal');
  if (options.mode !== 'start' && options.mode !== 'restart')
    throw new Error('须指定 --mode start 或 --mode restart');
  if (options.injectFailure && !options.rehearsal)
    throw new Error('故障注入仅允许隔离演练');
  if (options.production && options.port !== undefined)
    throw new Error('生产端口固定为 4000');
  if (
    options.rehearsal &&
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 1024 ||
      options.port > 65535 ||
      options.port === 4000)
  )
    throw new Error('演练须使用 4000 之外的有效端口');
  const release = fs.realpathSync(options.release);
  const previous = fs.realpathSync(options.previous || options.release);
  const source = fs.realpathSync(options.database);
  const manifest = verifyRelease(release);
  const previousManifest =
    previous === release ? manifest : verifyRelease(previous);
  for (const item of [manifest, previousManifest]) {
    assert.equal(item.schemaCompatibility, 'current', '只允许当前 schema 产物');
    assert.equal(item.desktopHelperIncluded, true);
  }
  if (options.production) {
    assert.equal(source, fs.realpathSync(productionDatabase));
    loadProductionEnvironment();
  }
  assert.equal(fs.readFileSync(pauseFile, 'utf8').trim(), 'USER_PAUSED');
  const pauseHash = fileHash(pauseFile);
  const audit = path.join(
    root,
    'output/playwright/local-release-audit',
    `controlled-restart-${Date.now()}-${process.pid}`,
  );
  fs.mkdirSync(audit, { recursive: false });
  const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
  const env = cleanEnvironment({
    NODE_ENV: 'production',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  });
  if (options.rehearsal)
    Object.assign(env, {
      AUTH_CODE: '',
      FEED_MODE: '',
      WECHAT_DESKTOP_MP_IDS: '',
      WECHAT_DESKTOP_ALLOW_SCHEDULED: '0',
      DISABLE_SCHEDULED_UPDATES: '1',
      PLATFORM_URL: 'http://127.0.0.1:1',
    });
  const inspect = (database, flags = []) =>
    JSON.parse(
      run(
        python,
        [
          path.join(release, 'inspect-sqlite.py'),
          '--database',
          database,
          '--migrations',
          path.join(release, 'server/prisma/migrations'),
          '--require-current',
          ...flags,
        ],
        { env },
      ),
    );
  const backup = (database, folder) => {
    const result = JSON.parse(
      run(
        python,
        [
          path.join(release, 'server/scripts/backup-sqlite.py'),
          '--database',
          database,
          '--backup-root',
          path.join(audit, folder),
        ],
        { env },
      ),
    );
    assert.equal(result.integrityCheck, 'ok');
    assert.equal(fileHash(result.backup), result.sha256);
    return result;
  };
  const sourceBefore = inspect(source, [
    '--output',
    path.join(audit, 'source-before.json'),
  ]);
  assert.deepEqual(sourceBefore.pending, [], '数据库仍有待应用迁移');
  let database = source;
  let port = 4000;
  if (options.rehearsal) {
    const copy = backup(source, 'source-backup');
    database = path.join(audit, 'rehearsal.db');
    fs.copyFileSync(copy.backup, database, fs.constants.COPYFILE_EXCL);
    port = options.port || (await unusedPort());
  } else backup(source, 'before-stop');

  const marker = (bundle) => {
    if (options.rehearsal)
      fs.writeFileSync(
        database + '.rehearsal.json',
        JSON.stringify({ releaseId: bundle.id, database }),
      );
  };
  const start = (bundlePath, bundle, label) => {
    assertPaused(pauseHash);
    requireFreePort(port);
    marker(bundle);
    const log = fs.openSync(path.join(audit, `${label}.log`), 'wx');
    const args = [
      path.join(bundlePath, 'runtime.cjs'),
      'start',
      '--database',
      database,
      '--port',
      String(port),
      '--pause-file',
      pauseFile,
    ];
    if (options.rehearsal)
      args.push(
        '--rehearsal',
        '--obsidian-root',
        path.join(audit, `${label}-vault`),
        '--guard-report',
        path.join(audit, `${label}-guard.json`),
      );
    else args.push('--production');
    const child = spawn(path.join(bundlePath, 'runtime/node.exe'), args, {
      cwd: audit,
      env: { ...env, LOCAL_RELEASE_CONTROLLED_START: bundle.id },
      windowsHide: true,
      shell: false,
      detached: options.production,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    return child;
  };
  let oldChild;
  let newChild;
  let fallbackChild;
  let stopped = false;
  let finalBackup;
  try {
    let identity;
    if (options.mode === 'restart') {
      if (options.rehearsal) {
        oldChild = start(previous, previousManifest, 'old-before');
        await waitReady(port, oldChild);
        identity = processIdentity('Snapshot', oldChild.pid, port);
      } else {
        if (!options.expected || !Number.isInteger(options.expected.pid))
          throw new Error('生产重启须提供完整的旧进程预期身份');
        identity = processIdentity('Snapshot', options.expected.pid, port);
        sameIdentity(identity, { ...options.expected, port });
        assert.equal(
          identity.commandLine,
          commandLine(previous, database, port),
          '旧进程不是指定的当前 schema 产物启动命令',
        );
        assert.equal(
          identity.executable.toLowerCase(),
          path.join(previous, 'runtime/node.exe').toLowerCase(),
          '旧进程程序不属于指定产物',
        );
      }
      const result = processIdentity('Stop', identity.pid, port, identity);
      assert.equal(result.stopped, true);
      stopped = true;
      finalBackup = backup(database, 'after-stop');
    } else {
      requireFreePort(port);
      finalBackup = backup(database, 'before-start');
    }
    const baseline = path.join(audit, 'final-baseline.json');
    const finalBefore = inspect(database, ['--output', baseline]);
    assert.deepEqual(finalBefore.pending, []);
    inspect(finalBackup.backup, ['--baseline', baseline]);
    if (options.injectFailure) throw new Error('INJECTED_NEW_START_FAILURE');
    newChild = start(release, manifest, 'new');
    await waitReady(port, newChild);
    const newIdentity = processIdentity('Snapshot', newChild.pid, port);
    assert.equal(newIdentity.pid, newChild.pid);
    assertPaused(pauseHash);
    const summary = {
      passed: true,
      mode: options.production ? 'production' : 'rehearsal',
      action: options.mode,
      audit,
      database,
      finalBackup: finalBackup.backup,
      oldStopped: stopped,
      newIdentity,
      rollbackUsed: false,
    };
    writeJson(path.join(audit, 'summary.json'), summary);
    if (options.production) newChild.unref();
    return summary;
  } catch (error) {
    await stopOwned(newChild);
    if (stopped) {
      try {
        fallbackChild = start(previous, previousManifest, 'previous-fallback');
        await waitReady(port, fallbackChild);
        const fallbackIdentity = processIdentity(
          'Snapshot',
          fallbackChild.pid,
          port,
        );
        assertPaused(pauseHash);
        const summary = {
          passed: options.rehearsal && options.injectFailure === true,
          mode: options.production ? 'production' : 'rehearsal',
          action: options.mode,
          audit,
          database,
          finalBackup: finalBackup?.backup,
          oldStopped: true,
          rollbackUsed: true,
          failure: error.message,
          fallbackIdentity,
          databaseRestored: false,
        };
        writeJson(path.join(audit, 'summary.json'), summary);
        if (options.production) fallbackChild.unref();
        if (options.production) throw error;
        return summary;
      } catch (fallbackError) {
        if (fallbackError !== error)
          writeJson(path.join(audit, 'fallback-failure.json'), {
            failure: error.message,
            fallbackFailure: fallbackError.message,
            databaseRestored: false,
          });
        throw fallbackError;
      }
    }
    writeJson(path.join(audit, 'failure.json'), {
      failure: error.message,
      oldStopped: false,
      databaseRestored: false,
    });
    throw error;
  } finally {
    if (options.rehearsal)
      for (const child of [oldChild, newChild, fallbackChild])
        await stopOwned(child);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      previous: { type: 'string' },
      database: { type: 'string' },
      mode: { type: 'string' },
      rehearsal: { type: 'boolean', default: false },
      production: { type: 'boolean', default: false },
      port: { type: 'string' },
      'inject-new-start-failure': { type: 'boolean', default: false },
      'expected-pid': { type: 'string' },
      'expected-start-utc': { type: 'string' },
      'expected-executable': { type: 'string' },
      'expected-command-line': { type: 'string' },
    },
  });
  if (!values.release || !values.database)
    throw new Error('须指定 --release 和 --database');
  const result = await controlledRestart({
    release: values.release,
    previous: values.previous,
    database: values.database,
    mode: values.mode,
    rehearsal: values.rehearsal,
    production: values.production,
    port: values.port === undefined ? undefined : Number(values.port),
    injectFailure: values['inject-new-start-failure'],
    expected:
      values.production && values.mode === 'restart'
        ? {
            pid: Number(values['expected-pid']),
            startUtc: values['expected-start-utc'],
            executable: values['expected-executable'],
            commandLine: values['expected-command-line'],
          }
        : undefined,
  });
  console.log(JSON.stringify(result));
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
module.exports = { controlledRestart, commandLine, requireFreePort };
