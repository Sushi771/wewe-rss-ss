// Windows 本机受控切换。恢复授权不足时停止；绝不在不确定库上自动重启旧应用。
const fs = require('./lib.cjs').hostEffects.fs;
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('./lib.cjs').hostEffects.processes;
const { once } = require('node:events');
const { parseArgs, promisify } = require('node:util');
const { validateRoles, expectedPending } = require('./switch-contract.cjs');
const { recoverSwitchFailure } = require('./switch-recovery.cjs');
const {
  verifyRelease,
  writeJson,
  fileHash,
  cleanEnvironment,
  run,
} = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const schemaGate = require('./switch-prewrite.cjs');
// Shared by the real CLI migration location and the synthetic-only harness.
// No process/activation operation belongs to this phase.
async function performMigrationPhase(
  request,
  migrate,
  beforeFinalRevalidation,
) {
  let attempted = false,
    outcome = 'not_attempted',
    schemaBefore,
    schemaAfter,
    taskDocumentPreflight;
  try {
    schemaBefore = schemaGate.inspectSwitchDatabase({
      ...request,
      stage: 'before-migration',
    });
    const documents = require('./task-document-preflight.cjs');
    taskDocumentPreflight = documents.assertTaskDocumentsForMigration(
      request.database,
    );
    if (beforeFinalRevalidation) await beforeFinalRevalidation(schemaBefore);
    documents.assertTaskDocumentPreflightUnchanged(
      request.database,
      taskDocumentPreflight,
    );
    schemaBefore = schemaGate.assertSwitchDatabaseUnchanged(
      { ...request, stage: 'before-migration' },
      schemaBefore,
    );
    // The last synchronous revalidation covers schema, receipts, task bytes and
    // DB/WAL/journal identities. It does not replace all-writer quiescence.
    attempted = true;
    const result = await migrate();
    outcome = 'verification_failed';
    schemaAfter = schemaGate.inspectSwitchDatabase({
      ...request,
      stage: 'after-migration',
    });
    schemaGate.assertSwitchTransition(schemaBefore, schemaAfter);
    outcome = 'confirmed';
    return {
      migrationAttempted: true,
      migrationOutcome: outcome,
      schemaBefore,
      schemaAfter,
      taskDocumentPreflight,
      result,
    };
  } catch (error) {
    error.migrationAttempted = attempted;
    error.migrationOutcome =
      attempted && outcome === 'not_attempted' ? 'unknown' : outcome;
    error.databaseRestored = false;
    error.manualRecoveryRequired = true;
    error.schemaPrewrite = {
      schemaBefore: schemaBefore || null,
      schemaAfter: schemaAfter || null,
      taskDocumentPreflight: taskDocumentPreflight || null,
    };
    throw error;
  }
}
function createSyntheticSwitchMigrationHarness(request) {
  const scope = request.scope;
  const binding = Object.freeze({
    database: request.database,
    operationId: request.operationId,
    roles: JSON.parse(JSON.stringify(request.roles)),
  });
  schemaGate.assertSyntheticPrewriteScope(scope, binding.database);
  return async function run(effects) {
    schemaGate.assertSyntheticPrewriteScope(scope, binding.database);
    if (
      !effects ||
      typeof effects.migrate !== 'function' ||
      (effects.activate !== undefined &&
        typeof effects.activate !== 'function') ||
      (effects.beforeFinalRevalidation !== undefined &&
        typeof effects.beforeFinalRevalidation !== 'function')
    )
      throw Error('SWITCH_SYNTHETIC_EFFECTS_INVALID');
    const phase = await performMigrationPhase(
      binding,
      effects.migrate,
      effects.beforeFinalRevalidation,
    );
    schemaGate.assertSwitchDatabaseUnchanged(
      { ...binding, stage: 'after-migration' },
      phase.schemaAfter,
    );
    if (effects.activate) {
      try {
        await effects.activate(phase.schemaAfter);
      } catch (error) {
        error.migrationAttempted = true;
        error.activationAttempted = true;
        error.activationOutcome = 'unknown';
        error.databaseRestored = false;
        error.manualRecoveryRequired = true;
        throw error;
      }
    }
    return {
      ...phase,
      activationAttempted: Boolean(effects.activate),
      activationOutcome: effects.activate ? 'confirmed' : 'not_attempted',
      syntheticFixtureOnly: true,
    };
  };
}
function verifiedSwitchRoles(release, rollback, rehearsal) {
  const container = path.dirname(release);
  assert.equal(
    path.dirname(rollback),
    container,
    'RELEASE_ROLE_CONTAINER_CHANGED',
  );
  const pointer = path.join(container, 'active.json');
  let currentRoot = rollback;
  if (fs.existsSync(pointer)) {
    const s = fs.lstatSync(pointer);
    assert(
      s.isFile() && !s.isSymbolicLink() && s.size < 65536,
      'RELEASE_CURRENT_POINTER_INVALID',
    );
    const active = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    assert(
      active.format === 1 &&
        /^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(active.id || ''),
      'RELEASE_CURRENT_POINTER_INVALID',
    );
    currentRoot = fs.realpathSync(path.join(container, active.id));
    assert.equal(
      path.dirname(currentRoot),
      container,
      'RELEASE_ROLE_CONTAINER_CHANGED',
    );
  } else assert.equal(rehearsal, true, 'RELEASE_CURRENT_POINTER_REQUIRED');
  const roles = {};
  for (const [name, folder] of Object.entries({
    current: currentRoot,
    candidate: release,
    rollback,
  })) {
    const manifestSha256 = fileHash(path.join(folder, 'release.json'));
    const manifest = verifyRelease(folder);
    assert.equal(
      fileHash(path.join(folder, 'release.json')),
      manifestSha256,
      'RELEASE_ROLE_CHANGED_DURING_VERIFICATION',
    );
    assert.equal(
      manifest.id,
      path.basename(folder),
      'RELEASE_ROLE_PATH_INVALID',
    );
    roles[name] = { folder, manifest, manifestSha256 };
  }
  validateRoles(roles);
  return roles;
}

function processIdentity(action, pid, port, expected) {
  require('./lib.cjs').hostEffects.assertRuntime();
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

function portOwnersAsync(port) {
  // Only this read-only action overlaps database preparation. Identity/Stop
  // keep their existing complete contract and the original PS fallback.
  if (
    process.platform !== 'win32' ||
    process.env.LOCAL_RELEASE_FORCE_POWERSHELL === '1'
  )
    return Promise.resolve(processIdentity('Port', undefined, port));
  const tool = require('./identity-tool.cjs').identityTool();
  if (!tool) return Promise.resolve(processIdentity('Port', undefined, port));
  // Fallback or helper-integrity failures throw before preparation is invoked.
  return promisify(execFile)(tool, ['Port', '0', String(port), '', '', ''], {
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: cleanEnvironment(),
  }).then(({ stdout }) => JSON.parse(stdout));
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
async function waitReady(
  port,
  child,
  seconds = 900,
  retryMs = 300,
  rssItems = 20,
) {
  assert([1, 20].includes(rssItems), 'Unsupported RSS readiness contract');
  const base = `http://127.0.0.1:${port}`;
  const rssUrl =
    base + `/feeds/MP_WXS_3895431412.rss?limit=${rssItems}&mode=summary`;
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
          ((await result.text()).match(/<item>/g) || []).length === rssItems
        )
          return;
      }
    } catch (error) {
      if (error instanceof PrivateReadinessError) throw error;
      /* 等待校验、数据库连接和 HTTP 监听 */
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  throw new Error(`服务 ${port} 启动或 RSS 冒烟超时`);
}

async function stopOwned(child, identity) {
  require('./lib.cjs').hostEffects.assertRuntime();
  require('./lib.cjs').hostEffects.assertWritable();
  if (!child) return;
  if (identity) {
    if (identity.pid !== child.pid)
      throw Error('OWNED_PROCESS_IDENTITY_CHANGED');
    if (child.exitCode !== null || typeof child.signalCode === 'string')
      return { ...identity, stopped: true };
    try {
      return processIdentity('OwnedStop', child.pid, identity.port, identity);
    } catch (error) {
      await new Promise(setImmediate);
      if (child.exitCode !== null || typeof child.signalCode === 'string')
        return { ...identity, stopped: true };
      throw error;
    }
  }
  if (child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

function observeProjectWriters(roots, port) {
  if (
    !Array.isArray(roots) ||
    !roots.length ||
    roots.length > 16 ||
    roots.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
  )
    throw Error('LEGACY_MAINTENANCE_PROJECT_ROOTS_UNPROVEN');
  const started = performance.now(),
    active = new Map();
  let queries = 0;
  for (const pid of new Set(roots)) {
    const fact = processIdentity('Tree', pid, port);
    queries++;
    if (
      fact.complete !== true ||
      !Array.isArray(fact.active) ||
      !Array.isArray(fact.portOwners)
    )
      throw Error('LEGACY_MAINTENANCE_PROJECT_WRITER_UNPROVEN');
    for (const row of fact.active) active.set(row.pid, row);
    for (const row of fact.portOwners)
      active.set(Number(row.OwningProcess), {
        pid: Number(row.OwningProcess),
        listener: true,
      });
  }
  return {
    complete: true,
    active: [...active.values()],
    queries,
    durationMs: performance.now() - started,
  };
}

function loadProductionEnvironment() {
  require('./lib.cjs').hostEffects.assertRuntime();
  require('./lib.cjs').hostEffects.assertWritable();
  const server = path.join(root, 'apps/server');
  // Node 内置 envFile 只填充缺失值；本机 .env.local 优先，文件内容不写入审计。
  for (const file of ['.env.local', '.env']) {
    const target = path.join(server, file);
    if (fs.existsSync(target)) process.loadEnvFile(target);
  }
  // 保持现有配置语义：当前实例允许 AUTH_CODE 为空；不在切换时更改鉴权策略。
}

async function controlledSwitch(options) {
  require('./release-scope.cjs').assertWritableSession(['switch']);
  // Existing scope grants compatible-app recovery only, never database restore.
  // No CLI flag or fixture receipt can turn this into production authorization.
  if (options.production) {
    const error = new Error('RELEASE_SWITCH_ALL_WRITERS_RECOVERY_UNPROVEN');
    error.code = error.message;
    error.manualRecoveryRequired = true;
    error.migrationAttempted = false;
    error.databaseRestored = false;
    throw error;
  }
  if (!options.production) return controlledSwitchInner(options);
  return require('./release-scope.cjs').within(
    {
      kind: 'switch',
      root: path.dirname(fs.realpathSync(options.release)),
      reserveBytes: 256 * 1024 ** 2,
      transition: true,
    },
    (lease) => {
      lease.authorizePackage(options.release);
      lease.authorizePackage(options.legacy);
      return controlledSwitchInner(options);
    },
  );
}
async function controlledSwitchInner(options) {
  if (process.platform !== 'win32') throw new Error('只支持 Windows 本机切换');
  const rehearsal = options.rehearsal === true;
  if (!rehearsal && !options.production)
    throw new Error('必须显式选择 --production 或 --rehearsal');
  if (rehearsal && options.production) throw new Error('切换模式不能同时启用');
  if (options.injectFailure && !rehearsal)
    throw new Error('故障注入只允许隔离演练');
  const release = fs.realpathSync(options.release);
  const legacy = fs.realpathSync(options.legacy);
  let source = rehearsal ? null : fs.realpathSync(options.database);
  const roles = verifiedSwitchRoles(release, legacy, rehearsal);
  const current = roles.candidate.manifest;
  const old = roles.rollback.manifest;
  if (!rehearsal) {
    assert.equal(
      source,
      fs.realpathSync(path.join(root, 'apps/server/data/wewe-rss.db')),
    );
    if (process.env.SQLITE_BACKUP_KIND === 'test')
      throw new Error(
        'Production control refuses inherited test backup policy',
      );
    loadProductionEnvironment();
  }
  const pauseFile = path.join(root, 'tools/wechat-desktop-collector/.paused');
  const helperRequired = Object.values(roles).some(
    (r) => r.manifest.desktopHelperIncluded,
  );
  if (helperRequired)
    assert.equal(
      fs.readFileSync(pauseFile, 'utf8').trim(),
      'USER_PAUSED',
      '用户暂停状态不符',
    );
  const pauseHash = helperRequired ? fileHash(pauseFile) : null;
  const artifacts = rehearsal
    ? require('./test-artifacts.cjs').begin({
        outputRoot: options.outputRoot,
        source: options.database,
        realCopy: options.realCopy,
        // A blocked or failed recovery leaves its snapshot and uncertain DB
        // available for review. Cleanup is a separate, explicitly owned action.
        keep: true,
        legacy: false,
        migrations: path.join(roles.current.folder, 'server/prisma/migrations'),
      })
    : null;
  if (artifacts) source = artifacts.database;
  const audit =
    artifacts?.audit ||
    path.join(
      options.outputRoot ||
        process.env.WEWE_PRODUCTION_AUDIT_ROOT ||
        path.join(root, 'output/playwright/local-release-audit'),
      `controlled-switch-${Date.now()}-${process.pid}`,
    );
  if (!artifacts) {
    const lease = require('./release-scope.cjs').session();
    lease?.registerOutput(audit);
    fs.mkdirSync(audit, { recursive: true });
    lease?.createdOutput(audit);
  }
  let artifactError;
  try {
    const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
    const env = cleanEnvironment({
      NODE_ENV: 'production',
      SQLITE_BACKUP_KIND: rehearsal ? 'test' : 'production',
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
            rehearsal
              ? path.join(audit, name)
              : require('./space-budget.cjs').productionRoot(source),
          ],
          { env },
        ),
      );
      assert.equal(result.integrityCheck, 'ok');
      assert.equal(fileHash(result.backup), result.sha256);
      return result;
    };
    const schemaOperationId = require('node:crypto').randomUUID();
    let sourceSchemaPreflight;
    try {
      sourceSchemaPreflight = schemaGate.inspectSwitchDatabase({
        database: source,
        roles,
        operationId: schemaOperationId,
        stage: 'before-migration',
      });
    } catch (error) {
      error.migrationAttempted = false;
      error.databaseRestored = false;
      error.oldApplicationRestarted = false;
      throw error;
    }
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
            JSON.stringify(after.tables) ===
            JSON.stringify(sourceBefore.tables),
          feeds: after.tables.feeds.rows,
          articles: after.tables.articles.rows,
        };
      } catch (error) {
        return { unchanged: null, error: error.message };
      }
    };
    const pending = expectedPending(roles, sourceBefore);
    let database = source;
    let port = 4000;
    let oldChild = null;
    if (rehearsal) {
      const copy = backup(source, 'source-backup');
      database = path.join(audit, 'rehearsal.db');
      fs.copyFileSync(copy.backup, database, fs.constants.COPYFILE_EXCL);
      artifacts?.checkpoint();
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
      ];
      if (helperRequired) args.push('--pause-file', pauseFile);
      if (rehearsal)
        args.push(
          '--rehearsal',
          '--obsidian-root',
          path.join(audit, `${label}-vault`),
          '--guard-report',
          path.join(audit, `${label}-guard.json`),
        );
      else args.push('--production');
      const scopeLease = require('./release-scope.cjs').session();
      if (scopeLease) scopeLease.check(true);
      const child = spawn(path.join(bundle, 'runtime/node.exe'), args, {
        cwd: audit,
        env: {
          ...env,
          LOCAL_RELEASE_CONTROLLED_START: manifest.id,
          ...(require('./release-scope.cjs').session()
            ? { LOCAL_RELEASE_REUSE_VERIFIED: '0' }
            : {}),
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
    let stopAttempted = false;
    let stopOutcome = 'not_attempted';
    let migrationAttempted = false;
    let migrationSchemaPhase = null;
    let migrated = false;
    let finalBackup;
    let taskDocumentPreflight;
    let newChild;
    let newChildStopError;
    try {
      stopAttempted = true;
      stopOutcome = 'unknown';
      const stoppedIdentity = processIdentity(
        'Stop',
        identity.pid,
        port,
        identity,
      );
      assert.equal(stoppedIdentity.stopped, true);
      stopped = true;
      stopOutcome = 'confirmed';
      // 停止后再取一致性备份，捕捉预检与停止之间可能发生的写入。
      finalBackup = backup(database, 'after-stop');
      const finalBaseline = path.join(audit, 'final-baseline.json');
      const finalBefore = inspection(database, ['--output', finalBaseline]);
      assert.deepEqual(expectedPending(roles, finalBefore), pending);
      inspection(finalBackup.backup, ['--baseline', finalBaseline]);
      const node = path.join(release, 'runtime/node.exe');
      const server = path.join(release, 'server');
      const migrateEnv = {
        ...env,
        DATABASE_URL: 'file:' + database.replace(/\\/g, '/'),
      };
      migrationSchemaPhase = await performMigrationPhase(
        { database, roles, operationId: schemaOperationId },
        () => {
          const output = run(
            node,
            [
              path.join(server, 'node_modules/prisma/build/index.js'),
              'migrate',
              'deploy',
              '--schema',
              path.join(server, 'prisma/schema.prisma'),
            ],
            { cwd: server, env: migrateEnv },
          );
          fs.writeFileSync(path.join(audit, 'migrate.log'), output);
          return output;
        },
      );
      migrationAttempted = migrationSchemaPhase.migrationAttempted;
      taskDocumentPreflight = migrationSchemaPhase.taskDocumentPreflight;
      inspection(database, [
        '--baseline',
        finalBaseline,
        '--require-current',
        '--output',
        path.join(audit, 'after-migration.json'),
      ]);
      migrated = true;
      if (options.injectFailure) throw new Error('INJECTED_NEW_START_FAILURE');
      schemaGate.assertSwitchDatabaseUnchanged(
        {
          database,
          roles,
          operationId: schemaOperationId,
          stage: 'after-migration',
        },
        migrationSchemaPhase.schemaAfter,
      );
      newChild = start(release, 'new');
      await waitReady(port, newChild);
      const newIdentity = processIdentity('Snapshot', newChild.pid, port);
      assert.equal(newIdentity.pid, newChild.pid);
      if (helperRequired) assert.equal(fileHash(pauseFile), pauseHash);
      const summary = {
        passed: true,
        mode: rehearsal ? 'rehearsal' : 'production',
        audit,
        database,
        finalBackup: finalBackup.backup,
        migrated,
        migrationAttempted,
        migrationSchemaPhase,
        sourceSchemaPreflight,
        taskDocumentPreflight,
        oldStopped: true,
        stopAttempted,
        stopOutcome,
        newIdentity,
        rollbackUsed: false,
        sourceObservation: rehearsal ? sourceObservation() : null,
      };
      writeJson(path.join(audit, 'summary.json'), summary);
      if (!rehearsal) newChild.unref();
      return summary;
    } catch (error) {
      migrationAttempted =
        migrationAttempted || error.migrationAttempted === true;
      if (!taskDocumentPreflight && error.schemaPrewrite?.taskDocumentPreflight)
        taskDocumentPreflight = error.schemaPrewrite.taskDocumentPreflight;
      try {
        await stopOwned(newChild);
      } catch (stopError) {
        newChildStopError = stopError.message;
      }
      // The production/rehearsal adapters intentionally grant no restoration.
      // The same recovery state machine is exercised separately with an explicit
      // synthetic-fixture lease; never call start(legacy) on this uncertain DB.
      const recovery = await recoverSwitchFailure({
        mode: rehearsal ? 'rehearsal' : 'production',
        database,
        migrationAttempted,
        migrated,
      });
      const summary = {
        passed: false,
        mode: rehearsal ? 'rehearsal' : 'production',
        audit,
        database,
        migrationAttempted,
        migrated,
        taskDocumentPreflight,
        migrationSchemaPhase:
          migrationSchemaPhase || error.schemaPrewrite || null,
        sourceSchemaPreflight,
        migrationOutcome:
          error.migrationOutcome ||
          migrationSchemaPhase?.migrationOutcome ||
          'not_attempted',
        oldStopped: stopped ? true : stopAttempted ? null : false,
        stopAttempted,
        stopOutcome,
        rollbackUsed: false,
        databaseRestored: false,
        manualRecoveryRequired: true,
        oldApplicationRestarted: false,
        restartAttempted: recovery.restartAttempted,
        restartOutcome: recovery.restartOutcome,
        failure: error.message,
        failureCode: error.code || null,
        ...(error.manualReviewRequired
          ? { manualReviewRequired: true, diagnostics: error.diagnostics }
          : {}),
        newChildStopError,
        protectedSnapshot: finalBackup || null,
        recovery,
        sourceObservation: rehearsal ? sourceObservation() : null,
      };
      if (helperRequired) assert.equal(fileHash(pauseFile), pauseHash);
      writeJson(path.join(audit, 'summary.json'), summary);
      error.manualRecoveryRequired = true;
      error.migrationAttempted = migrationAttempted;
      error.databaseRestored = false;
      error.recovery = recovery;
      throw error;
    } finally {
      if (rehearsal) {
        for (const child of [oldChild, newChild]) {
          // An attempted identity-bound stop or uncertain child stop is not
          // repeated blindly during cleanup. Leave the audit for manual review.
          if (
            (child === oldChild && stopAttempted) ||
            (child === newChild && newChildStopError)
          )
            continue;
          await stopOwned(child);
        }
      }
    }
  } catch (error) {
    artifactError = error;
    throw error;
  } finally {
    artifacts?.finish(artifactError);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      'output-root': { type: 'string' },
      'real-copy': { type: 'boolean', default: false },
      'keep-test-databases': { type: 'boolean', default: false },
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
  if (
    !values.release ||
    !values.legacy ||
    (values.production && !values.database)
  )
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
    outputRoot: values['output-root'],
    realCopy: values['real-copy'],
    keepTestDatabases: values['keep-test-databases'],
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
  portOwnersAsync,
  sameIdentity,
  unusedPort,
  waitReady,
  stopOwned,
  observeProjectWriters,
  loadProductionEnvironment,
  verifiedSwitchRoles,
  recoverSwitchFailure,
  createSyntheticSwitchMigrationHarness,
};
