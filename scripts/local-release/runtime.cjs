const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const Module = require('node:module');
const {
  verifyRelease,
  fileHash,
  readJson,
  inside,
  cleanEnvironment,
  run,
} = require('./lib.cjs');

async function runtime() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      database: { type: 'string' },
      port: { type: 'string' },
      'obsidian-root': { type: 'string' },
      'guard-report': { type: 'string' },
      'pause-file': { type: 'string' },
      rehearsal: { type: 'boolean', default: false },
      production: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (!['verify', 'probe', 'start'].includes(command))
    throw new Error(
      '用法: runtime.cjs verify|probe|start [--database 绝对路径]',
    );
  const release = __dirname;
  const manifest = verifyRelease(release);
  const legacy = manifest.schemaCompatibility === 'legacy-additive';
  if (!legacy && manifest.schemaCompatibility !== 'current')
    throw new Error('未知应用 schema 兼容模式');
  if (fileHash(process.execPath) !== manifest.files['runtime/node.exe'])
    throw new Error('必须使用产物内固定版本的 Node');
  if (command === 'verify') {
    console.log(JSON.stringify({ id: manifest.id, integrity: 'ok' }));
    return;
  }
  if (!values.database || !path.isAbsolute(values.database))
    throw new Error('必须明确指定已有数据库的绝对路径');
  const database = fs.realpathSync(values.database);
  if (!fs.statSync(database).isFile()) throw new Error('数据库不是文件');
  const server = path.join(release, 'server');
  const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
  const inspected = JSON.parse(
    run(python, [
      path.join(release, 'inspect-sqlite.py'),
      '--database',
      database,
      '--migrations',
      legacy
        ? path.join(release, 'known-migrations')
        : path.join(server, 'prisma/migrations'),
      ...(!legacy ? ['--require-current'] : []),
    ]),
  );
  const env = cleanEnvironment({
    DATABASE_URL: 'file:' + database.replace(/\\/g, '/'),
    NODE_ENV: 'production',
    DATABASE_TYPE: 'sqlite',
  });
  for (const key of Object.keys(process.env))
    if (/^(NODE_OPTIONS|NODE_PATH|PRISMA_.*|DATABASE_URL)$/i.test(key))
      delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(server);
  const resolveModule = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    const resolved = resolveModule.call(this, request, ...args);
    if (
      !Module.isBuiltin(resolved) &&
      !inside(release, fs.realpathSync(resolved))
    )
      throw new Error('运行依赖逃逸到产物目录之外');
    return resolved;
  };
  const clientPath = require.resolve('@prisma/client', { paths: [server] });
  const { PrismaClient, Prisma } = require(clientPath);
  if (Prisma.prismaVersion.client !== manifest.prisma.clientVersion)
    throw new Error('运行时 Client 版本不一致');
  const client = new PrismaClient();
  let counts;
  try {
    // raw 查询用于暴露曾出现过的 5.22 engine / 5.10 client 协议不兼容。
    const [{ version }] = await client.$queryRawUnsafe(
      'SELECT sqlite_version() AS version',
    );
    counts = {
      feeds: await client.feed.count(),
      articles: await client.article.count(),
      sqlite: version,
    };
    if (legacy) {
      // 固定旧 schema 的 Client 必须能在迁移前后读同一份副本，供进程回滚。
      await client.article.findFirst({ select: { id: true } });
      await client.feed.findFirst({ select: { id: true } });
    } else {
      await client.article.findFirst({
        select: {
          lastBodyStatus: true,
          verifiedSourceUrl: true,
          lastBodyRetry: true,
        },
      });
      await client.feed.findFirst({ select: { collectionChannel: true } });
    }
  } finally {
    await client.$disconnect();
  }
  console.log(
    JSON.stringify({
      event: 'runtime-verified',
      id: manifest.id,
      prisma: Prisma.prismaVersion,
      clientPath,
      engineSha256: manifest.prisma.engineSha256,
      counts,
      schemaCompatibility: manifest.schemaCompatibility,
      pending: inspected.pending,
    }),
  );
  if (command === 'probe') return;
  // helper 与应用同版；暂停文件必须位于版本目录之外，供将来的切换/回滚共用。
  if (manifest.desktopHelperIncluded !== true)
    throw new Error('产物缺少固定版本的桌面 helper');
  if (!values['pause-file'] || !path.isAbsolute(values['pause-file']))
    throw new Error('启动必须指定共享暂停文件的绝对路径');
  const pauseFile = path.resolve(values['pause-file']);
  const pauseParent = fs.realpathSync(path.dirname(pauseFile));
  if (
    path.basename(pauseFile) !== '.paused' ||
    pauseParent === release ||
    inside(release, pauseParent) ||
    (fs.existsSync(pauseFile) && inside(release, fs.realpathSync(pauseFile)))
  )
    throw new Error('暂停文件必须在产物外并命名为 .paused');
  process.env.WECHAT_DESKTOP_PAUSE_FILE = pauseFile;
  if (values.rehearsal === values.production)
    throw new Error('启动须且只能选择 --rehearsal 或 --production');
  if (values.production) {
    if (
      Number(values.port) !== 4000 ||
      values['guard-report'] ||
      values['obsidian-root']
    )
      throw new Error('生产模式固定 4000 端口，禁止演练参数');
    if (process.env.LOCAL_RELEASE_CONTROLLED_START !== manifest.id)
      throw new Error('生产模式必须由受控切换器启动');
    Object.assign(process.env, {
      HOST: '0.0.0.0',
      PORT: '4000',
      DISABLE_SCHEDULED_UPDATES: '1',
      WECHAT_DESKTOP_ALLOW_SCHEDULED: '0',
      WECHAT_DESKTOP_MP_IDS: '',
      ...(legacy ? { CRON_EXPRESSION: '0 0 1 1 *' } : {}),
    });
    require(path.join(server, 'dist/apps/server/src/main.js'));
    return;
  }
  if (!values['obsidian-root'] || !values['guard-report'])
    throw new Error('演练启动须指定隔离导出目录与网络审计文件');
  if (
    !path.isAbsolute(values['obsidian-root']) ||
    !path.isAbsolute(values['guard-report'])
  )
    throw new Error('演练输出须为绝对路径');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4000)
    throw new Error('须使用 4000 之外的明确演练端口');
  const marker = readJson(database + '.rehearsal.json');
  if (
    marker.releaseId !== manifest.id ||
    fs.realpathSync(marker.database) !== database
  )
    throw new Error('数据库不是此版本的隔离演练副本');
  Object.assign(process.env, {
    HOST: '127.0.0.1',
    PORT: String(port),
    AUTH_CODE: '',
    FEED_MODE: '',
    SERVER_ORIGIN_URL: `http://127.0.0.1:${port}`,
    OBSIDIAN_PATH: values['obsidian-root'],
    DISABLE_SCHEDULED_UPDATES: '1',
    WECHAT_DESKTOP_ALLOW_SCHEDULED: '0',
    WECHAT_DESKTOP_MP_IDS: '',
    PLATFORM_URL: 'http://127.0.0.1:1',
    ...(legacy ? { CRON_EXPRESSION: '0 0 1 1 *' } : {}),
    REHEARSAL_GUARD_REPORT: values['guard-report'],
  });
  require('./offline-guard.cjs');
  require(path.join(server, 'dist/apps/server/src/main.js'));
}

if (require.main === module)
  runtime().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { runtime };
