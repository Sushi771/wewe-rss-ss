// Windows 本机受控切换：一致性备份、迁移、新版启动；失败只回滚应用进程，不覆盖数据库。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { parseArgs } = require('node:util');
const {
  verifyRelease,
  writeJson,
  fileHash,
  cleanEnvironment,
  run,
} = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const expectedPending = [
  '20260927110000_collection_channel',
  '20260928020000_article_body_status',
  '20260928030000_article_body_retry',
];

function processIdentity(action, pid, port, expected) {
  if (
    process.platform === 'win32' &&
    process.env.LOCAL_RELEASE_FORCE_POWERSHELL !== '1'
  ) {
    const tool = require('./identity-tool.cjs').identityTool();
    if (tool)
      return JSON.parse(
        run(
          tool,
          [
            action,
            String(pid || 0),
            String(port),
            expected?.startUtc || '',
            expected?.executable || '',
            expected?.commandLine || '',
          ],
          { env: cleanEnvironment() },
        ),
      );
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(__dirname, 'process-identity.ps1'),
    '-Action',
    action,
    '-Port',
    String(port),
  ];
  if (action !== 'Port' && action !== 'Discover')
    args.push('-TargetPid', String(pid));
  if (expected)
    args.push(
      '-ExpectedStartUtc',
      expected.startUtc,
      '-ExpectedExecutable',
      expected.executable,
      '-ExpectedCommandLine',
      expected.commandLine,
    );
  // Task Scheduler does not inherit Codex's bundled pwsh path. Use Windows' fixed executable.
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  return JSON.parse(run(powershell, args, { env: cleanEnvironment() }));
}

function sameIdentity(actual, expected) {
  assert.equal(actual.pid, expected.pid, 'PID 不匹配');
  assert.equal(actual.startUtc, expected.startUtc, '启动时间不匹配');
  assert.equal(
    actual.executable.toLowerCase(),
    expected.executable.toLowerCase(),
    '程序路径不匹配',
  );
  assert.equal(actual.commandLine, expected.commandLine, '命令行不匹配');
  assert.equal(actual.port, expected.port, '监听端口不匹配');
}

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

// Bundled startup re-hashes thousands of release files before HTTP binds.
// On this host the new bundle spent 7.5 minutes verifying before app startup;
// leave time for module loading and HTTP readiness after that point.
async function waitReady(port, child, seconds = 900) {
  const base = `http://127.0.0.1:${port}`;
  const rssUrl = base + '/feeds/MP_WXS_3895431412.rss?limit=20&mode=summary';
  const privateMode = process.env.PRIVATE_ONLINE_MODE === '1';
  // Login material stays in memory and never enters errors, audit logs or redirects.
  const code = privateMode ? process.env.AUTH_CODE : undefined;
  if (privateMode && (!code || code.length < 24))
    throw new Error('私人模式就绪检查缺少有效 AUTH_CODE');
  class PrivateReadinessError extends Error {}
  let cookie;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`服务提前退出，代码 ${child.exitCode}`);
    try {
      const response = await fetch(base + '/dash', {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        if (privateMode) {
          const anonymous = await fetch(rssUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
          });
          if (anonymous.status !== 401)
            throw new PrivateReadinessError(
              '私人模式匿名 RSS 未被拒绝，服务未通过就绪检查',
            );
          if (!cookie) {
            const login = await fetch(base + '/auth/login', {
              method: 'POST',
              redirect: 'manual',
              signal: AbortSignal.timeout(1500),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code }),
            });
            if (login.status !== 204)
              throw new PrivateReadinessError('私人模式就绪检查登录失败');
            cookie = (login.headers.get('set-cookie') || '').split(';')[0];
            if (
              !/^wewe_private_session=\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(
                cookie,
              )
            )
              throw new PrivateReadinessError('私人模式就绪检查未取得有效会话');
          }
        }
        const result = await fetch(rssUrl, {
          signal: AbortSignal.timeout(10000),
          ...(privateMode
            ? { redirect: 'manual', headers: { Cookie: cookie } }
            : {}),
        });
        if (privateMode && result.status === 401)
          throw new PrivateReadinessError('私人模式就绪检查会话未获授权');
        if (
          result.status === 200 &&
          ((await result.text()).match(/<item>/g) || []).length === 20
        )
          return;
      }
    } catch (error) {
      if (error instanceof PrivateReadinessError) throw error;
      /* 等待校验、数据库连接和 HTTP 监听 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`服务 ${port} 启动或 RSS 冒烟超时`);
}

async function stopOwned(child) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

function loadProductionEnvironment() {
  const server = path.join(root, 'apps/server');
  // Node 内置 envFile 只填充缺失值；本机 .env.local 优先，文件内容不写入审计。
  for (const file of ['.env.local', '.env']) {
    const target = path.join(server, file);
    if (fs.existsSync(target)) process.loadEnvFile(target);
  }
  // 保持现有配置语义：当前实例允许 AUTH_CODE 为空；不在切换时更改鉴权策略。
}

async function controlledSwitch(options) {
  if (process.platform !== 'win32') throw new Error('只支持 Windows 本机切换');
  const rehearsal = options.rehearsal === true;
  if (!rehearsal && !options.production)
    throw new Error('必须显式选择 --production 或 --rehearsal');
  if (rehearsal && options.production) throw new Error('切换模式不能同时启用');
  if (options.injectFailure && !rehearsal)
    throw new Error('故障注入只允许隔离演练');
  const release = fs.realpathSync(options.release);
  const legacy = fs.realpathSync(options.legacy);
  const source = fs.realpathSync(options.database);
  const current = verifyRelease(release);
  const old = verifyRelease(legacy);
  assert.equal(current.schemaCompatibility, 'current');
  assert.equal(old.schemaCompatibility, 'legacy-additive');
  assert.equal(old.sourceCommit, '9755d166e398f77baf52317f63ef36024037881d');
  assert.equal(current.desktopHelperIncluded, true);
  assert.equal(old.desktopHelperIncluded, true);
  if (!rehearsal) {
    assert.equal(
      source,
      fs.realpathSync(path.join(root, 'apps/server/data/wewe-rss.db')),
    );
    loadProductionEnvironment();
  }
  const pauseFile = path.join(root, 'tools/wechat-desktop-collector/.paused');
  assert.equal(
    fs.readFileSync(pauseFile, 'utf8').trim(),
    'USER_PAUSED',
    '用户暂停状态不符',
  );
  const pauseHash = fileHash(pauseFile);
  const audit = path.join(
    root,
    'output/playwright/local-release-audit',
    `controlled-switch-${Date.now()}-${process.pid}`,
  );
  fs.mkdirSync(audit, { recursive: false });
  const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
  const env = cleanEnvironment({
    NODE_ENV: 'production',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  });
  if (rehearsal)
    Object.assign(env, {
      AUTH_CODE: '',
      FEED_MODE: '',
      WECHAT_DESKTOP_MP_IDS: '',
      WECHAT_DESKTOP_ALLOW_SCHEDULED: '0',
      DISABLE_SCHEDULED_UPDATES: '1',
      PLATFORM_URL: 'http://127.0.0.1:1',
    });
  const inspection = (database, flags = []) =>
    JSON.parse(
      run(
        python,
        [
          path.join(release, 'inspect-sqlite.py'),
          '--database',
          database,
          '--migrations',
          path.join(release, 'server/prisma/migrations'),
          ...flags,
        ],
        { env },
      ),
    );
  const backup = (database, name) => {
    const result = JSON.parse(
      run(
        python,
        [
          path.join(release, 'server/scripts/backup-sqlite.py'),
          '--database',
          database,
          '--backup-root',
          path.join(audit, name),
        ],
        { env },
      ),
    );
    assert.equal(result.integrityCheck, 'ok');
    assert.equal(fileHash(result.backup), result.sha256);
    return result;
  };
  const sourceBefore = inspection(source, [
    '--output',
    path.join(audit, 'source-before.json'),
  ]);
  const sourceObservation = () => {
    try {
      const after = inspection(source, [
        '--output',
        path.join(audit, 'source-after.json'),
      ]);
      return {
        unchanged:
          JSON.stringify(after.tables) === JSON.stringify(sourceBefore.tables),
        feeds: after.tables.feeds.rows,
        articles: after.tables.articles.rows,
      };
    } catch (error) {
      return { unchanged: null, error: error.message };
    }
  };
  assert.deepEqual(
    sourceBefore.pending,
    expectedPending,
    '仅允许预期的三项加性迁移',
  );
  let database = source;
  let port = 4000;
  let oldChild = null;
  if (rehearsal) {
    const copy = backup(source, 'source-backup');
    database = path.join(audit, 'rehearsal.db');
    fs.copyFileSync(copy.backup, database, fs.constants.COPYFILE_EXCL);
    inspection(database, [
      '--baseline',
      path.join(audit, 'source-before.json'),
    ]);
    port = await unusedPort();
  } else {
    backup(source, 'before-stop');
  }
  function marker(manifest) {
    if (rehearsal)
      fs.writeFileSync(
        database + '.rehearsal.json',
        JSON.stringify({ releaseId: manifest.id, database }),
      );
  }
  function start(bundle, label) {
    const manifest = bundle === legacy ? old : current;
    marker(manifest);
    const log = fs.openSync(path.join(audit, `${label}.log`), 'wx');
    const args = [
      path.join(bundle, 'runtime.cjs'),
      'start',
      '--database',
      database,
      '--port',
      String(port),
      '--pause-file',
      pauseFile,
    ];
    if (rehearsal)
      args.push(
        '--rehearsal',
        '--obsidian-root',
        path.join(audit, `${label}-vault`),
        '--guard-report',
        path.join(audit, `${label}-guard.json`),
      );
    else args.push('--production');
    const child = spawn(path.join(bundle, 'runtime/node.exe'), args, {
      cwd: audit,
      env: {
        ...env,
        LOCAL_RELEASE_CONTROLLED_START: manifest.id,
        ...(bundle === legacy ? { CRON_EXPRESSION: '0 0 1 1 *' } : {}),
      },
      windowsHide: true,
      shell: false,
      detached: !rehearsal,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    return child;
  }
  let identity;
  if (rehearsal) {
    try {
      marker(old);
      oldChild = start(legacy, 'old-before');
      await waitReady(port, oldChild);
      identity = processIdentity('Snapshot', oldChild.pid, port);
    } catch (error) {
      await stopOwned(oldChild);
      throw error;
    }
  } else {
    if (!options.expected || !Number.isInteger(options.expected.pid))
      throw new Error('生产切换须指定旧进程的完整预期身份');
    identity = processIdentity('Snapshot', options.expected.pid, port);
    sameIdentity(identity, { ...options.expected, port });
    assert.match(identity.executable, /[\\/]node\.exe$/i);
    assert.equal(
      identity.commandLine,
      `"${identity.executable}" dist/apps/server/src/main`,
      '旧命令并非本项目当前启动命令',
    );
  }
  let stopped = false;
  let migrated = false;
  let newChild;
  let fallbackChild;
  try {
    const stoppedIdentity = processIdentity(
      'Stop',
      identity.pid,
      port,
      identity,
    );
    assert.equal(stoppedIdentity.stopped, true);
    stopped = true;
    // 停止后再取一致性备份，捕捉预检与停止之间可能发生的写入。
    const finalBackup = backup(database, 'after-stop');
    const finalBaseline = path.join(audit, 'final-baseline.json');
    const finalBefore = inspection(database, ['--output', finalBaseline]);
    assert.deepEqual(finalBefore.pending, expectedPending);
    inspection(finalBackup.backup, ['--baseline', finalBaseline]);
    const node = path.join(release, 'runtime/node.exe');
    const server = path.join(release, 'server');
    const migrateEnv = {
      ...env,
      DATABASE_URL: 'file:' + database.replace(/\\/g, '/'),
    };
    fs.writeFileSync(
      path.join(audit, 'migrate.log'),
      run(
        node,
        [
          path.join(server, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--schema',
          path.join(server, 'prisma/schema.prisma'),
        ],
        { cwd: server, env: migrateEnv },
      ),
    );
    inspection(database, [
      '--baseline',
      finalBaseline,
      '--require-current',
      '--output',
      path.join(audit, 'after-migration.json'),
    ]);
    migrated = true;
    if (options.injectFailure) throw new Error('INJECTED_NEW_START_FAILURE');
    newChild = start(release, 'new');
    await waitReady(port, newChild);
    const newIdentity = processIdentity('Snapshot', newChild.pid, port);
    assert.equal(newIdentity.pid, newChild.pid);
    assert.equal(fileHash(pauseFile), pauseHash);
    const summary = {
      passed: true,
      mode: rehearsal ? 'rehearsal' : 'production',
      audit,
      database,
      finalBackup: finalBackup.backup,
      migrated,
      oldStopped: true,
      newIdentity,
      rollbackUsed: false,
      sourceObservation: rehearsal ? sourceObservation() : null,
    };
    writeJson(path.join(audit, 'summary.json'), summary);
    if (!rehearsal) newChild.unref();
    return summary;
  } catch (error) {
    if (!stopped) throw error;
    await stopOwned(newChild);
    // 数据库即便已部分迁移也保留；旧版只读新列兼容性由副本演练证明。
    try {
      fallbackChild = start(legacy, 'old-fallback');
      await waitReady(port, fallbackChild);
      const fallbackIdentity = processIdentity(
        'Snapshot',
        fallbackChild.pid,
        port,
      );
      const summary = {
        passed: rehearsal && options.injectFailure === true,
        mode: rehearsal ? 'rehearsal' : 'production',
        audit,
        database,
        migrated,
        oldStopped: true,
        rollbackUsed: true,
        failure: error.message,
        fallbackIdentity,
        databaseRestored: false,
        sourceObservation: rehearsal ? sourceObservation() : null,
      };
      assert.equal(fileHash(pauseFile), pauseHash);
      writeJson(path.join(audit, 'summary.json'), summary);
      if (!rehearsal) fallbackChild.unref();
      if (!rehearsal) throw error;
      return summary;
    } catch (fallbackError) {
      if (fallbackError !== error) {
        writeJson(path.join(audit, 'fallback-failure.json'), {
          newFailure: error.message,
          fallbackFailure: fallbackError.message,
          databaseRestored: false,
          database,
        });
      }
      throw fallbackError;
    }
  } finally {
    if (rehearsal) {
      for (const child of [oldChild, newChild, fallbackChild])
        await stopOwned(child);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      legacy: { type: 'string' },
      database: { type: 'string' },
      rehearsal: { type: 'boolean', default: false },
      production: { type: 'boolean', default: false },
      'inject-new-start-failure': { type: 'boolean', default: false },
      'expected-pid': { type: 'string' },
      'expected-start-utc': { type: 'string' },
      'expected-executable': { type: 'string' },
      'expected-command-line': { type: 'string' },
    },
  });
  if (!values.release || !values.legacy || !values.database)
    throw new Error('须指定 --release、--legacy、--database 和切换模式');
  const expected = values.production
    ? {
        pid: Number(values['expected-pid']),
        startUtc: values['expected-start-utc'],
        executable: values['expected-executable'],
        commandLine: values['expected-command-line'],
      }
    : undefined;
  const result = await controlledSwitch({
    release: values.release,
    legacy: values.legacy,
    database: values.database,
    rehearsal: values.rehearsal,
    production: values.production,
    injectFailure: values['inject-new-start-failure'],
    expected,
  });
  console.log(JSON.stringify(result));
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
module.exports = {
  controlledSwitch,
  processIdentity,
  sameIdentity,
  unusedPort,
  waitReady,
  stopOwned,
  loadProductionEnvironment,
};
