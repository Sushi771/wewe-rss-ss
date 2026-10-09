const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const Module = require('node:module');
const { isIP } = require('node:net');
const {
  verifyReleaseAsync,
  fileHash,
  readJson,
  inside,
  cleanEnvironment,
  run,
} = require('./lib.cjs');

// Mirror the Provider constructor's private URL/token boundary without loading
// the application or making requests during the runtime's scheduling decision.
function validWechat2RssConfig(settings) {
  if (
    typeof settings.wechat2RssToken !== 'string' ||
    !settings.wechat2RssToken ||
    settings.wechat2RssToken.length > 512
  )
    return false;
  try {
    const url = new URL(settings.wechat2RssBaseUrl);
    const host = url.hostname;
    const parts = host.split('.').map(Number);
    const privateHost =
      ['localhost', 'wechat2rss', '127.0.0.1', '[::1]'].includes(host) ||
      (isIP(host) === 4 &&
        (parts[0] === 10 ||
          parts[0] === 127 ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)));
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      privateHost &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}

// Scheduling is an explicit opt-in. Each source uses its own configuration and
// binding; no source requires a different provider's key.
function scheduledUpdatesEnabled(manifest, settings) {
  if (
    manifest.schemaCompatibility !== 'current' ||
    manifest.desktopHelperIncluded !== false ||
    settings.enabled !== '1'
  )
    return false;
  if (settings.mp2RssFeedKey?.trim()) return true;
  if (settings.wechat2RssEnabled === '1' && validWechat2RssConfig(settings)) {
    const allowed = new Set(
      (settings.wechat2RssFeedIds || '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^MP_WXS_\d{5,15}$/.test(id)),
    );
    if (
      (settings.wechat2RssFeeds || []).some(
        (feed) =>
          feed.status === 1 &&
          /^MP_WXS_\d{5,15}$/.test(feed.id) &&
          (feed.collectionChannel === 'wechat2rss' ||
            (feed.collectionChannel == null &&
              !feed.publicAlbumIds &&
              allowed.has(feed.id))),
      )
    )
      return true;
  }
  if (
    settings.ownerSearchConfigFile &&
    (settings.ownerSearchFeeds || []).some(
      (feed) =>
        feed.status === 1 &&
        feed.collectionChannel === 'owner-web-search' &&
        /^MP_WXS_\d{5,15}$/.test(feed.id),
    )
  )
    return true;
  return (settings.publicAlbumFeeds || []).some((feed) => {
    if (
      feed.status !== 1 ||
      feed.collectionChannel !== 'public-album' ||
      !/^MP_WXS_\d{5,15}$/.test(feed.id)
    )
      return false;
    try {
      const ids = JSON.parse(feed.publicAlbumIds);
      return (
        Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= 10 &&
        ids.every((id) => typeof id === 'string' && /^\d{10,30}$/.test(id))
      );
    } catch {
      return false;
    }
  });
}

function guardModulePath(release, resolved) {
  // Native realpath retains the canonical path boundary check without a JS
  // ancestor walk repeated for every dependency in the immutable package.
  if (
    !Module.isBuiltin(resolved) &&
    !inside(release, fs.realpathSync.native(resolved))
  )
    throw new Error('Runtime dependency escaped the fixed release');
}

function guardNativePath(release, manifest, file) {
  const canonical = fs.realpathSync.native(file);
  const relative = path.relative(release, canonical).replace(/\\/g, '/');
  if (
    !inside(release, canonical) ||
    !relative.endsWith('.node') ||
    !manifest.files[relative] ||
    fileHash(canonical) !== manifest.files[relative]
  )
    throw new Error('Native runtime dependency escaped or changed');
}

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
  const manifest = await verifyReleaseAsync(release, {
    reuseVerified:
      command === 'start' && process.env.LOCAL_RELEASE_REUSE_VERIFIED === '1',
  });
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
  const compact = manifest.executionLayout === 'compact-cjs-v1';
  if (manifest.executionLayout && !compact)
    throw new Error('Unknown release execution layout');
  const entry = compact
    ? path.join(server, 'main.cjs')
    : path.join(server, 'dist/apps/server/src/main.js');
  const resolveModule = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    const resolved =
      compact && request === 'hbs'
        ? path.join(server, 'hbs.cjs')
        : resolveModule.call(this, request, ...args);
    guardModulePath(release, resolved);
    return resolved;
  };
  const dlopen = process.dlopen;
  process.dlopen = function (module, file, ...args) {
    guardNativePath(release, manifest, file);
    return dlopen.call(this, module, file, ...args);
  };
  const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
  const inspected =
    command === 'start' &&
    manifest.startupPreparation === 'node-pinned-backup-v1'
      ? require('./startup-sqlite.cjs').inspectDatabase(
          database,
          path.join(server, 'prisma/migrations'),
          { schemaOnly: true },
        )
      : JSON.parse(
          run(python, [
            path.join(release, 'inspect-sqlite.py'),
            '--database',
            database,
            '--migrations',
            legacy
              ? path.join(release, 'known-migrations')
              : path.join(server, 'prisma/migrations'),
            ...(!legacy ? ['--require-current'] : []),
            ...(command === 'start' && !legacy ? ['--schema-only'] : []),
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
  const clientPath = require.resolve('@prisma/client', { paths: [server] });
  const { PrismaClient, Prisma } = require(clientPath);
  if (Prisma.prismaVersion.client !== manifest.prisma.clientVersion)
    throw new Error('运行时 Client 版本不一致');
  const client = new PrismaClient();
  let counts;
  let publicAlbumFeeds = [];
  let ownerSearchFeeds = [];
  let wechat2RssFeeds = [];
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
      publicAlbumFeeds = await client.feed.findMany({
        where: { status: 1, collectionChannel: 'public-album' },
        select: {
          id: true,
          status: true,
          collectionChannel: true,
          publicAlbumIds: true,
        },
      });
      ownerSearchFeeds = await client.feed.findMany({
        where: { status: 1, collectionChannel: 'owner-web-search' },
        select: { id: true, status: true, collectionChannel: true },
      });
      if (
        command === 'start' &&
        values.production &&
        process.env.ENABLE_SCHEDULED_UPDATES === '1' &&
        process.env.WECHAT2RSS_ENABLED === '1' &&
        validWechat2RssConfig({
          wechat2RssBaseUrl: process.env.WECHAT2RSS_BASE_URL,
          wechat2RssToken: process.env.WECHAT2RSS_TOKEN,
        })
      ) {
        wechat2RssFeeds = await client.feed.findMany({
          where: {
            status: 1,
            OR: [
              { collectionChannel: 'wechat2rss' },
              { collectionChannel: null },
            ],
          },
          select: {
            id: true,
            status: true,
            collectionChannel: true,
            publicAlbumIds: true,
          },
        });
      }
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
  // Legacy rollback bundles still carry the shared pause marker. Current
  // backend-only bundles never read it or start the desktop helper.
  if (manifest.desktopHelperIncluded === true) {
    if (!values['pause-file'] || !path.isAbsolute(values['pause-file']))
      throw new Error('旧产物启动必须指定共享暂停文件的绝对路径');
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
  }
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
    const scheduled = scheduledUpdatesEnabled(manifest, {
      enabled: process.env.ENABLE_SCHEDULED_UPDATES,
      mp2RssFeedKey: process.env.MP2RSS_FEED_KEY,
      publicAlbumFeeds,
      ownerSearchFeeds,
      ownerSearchConfigFile: process.env.OWNER_SEARCH_CONFIG_FILE,
      wechat2RssEnabled: process.env.WECHAT2RSS_ENABLED,
      wechat2RssBaseUrl: process.env.WECHAT2RSS_BASE_URL,
      wechat2RssToken: process.env.WECHAT2RSS_TOKEN,
      wechat2RssFeedIds: process.env.WECHAT2RSS_FEED_IDS,
      wechat2RssFeeds,
    });
    Object.assign(process.env, {
      HOST: '127.0.0.1',
      PORT: '4000',
      DISABLE_SCHEDULED_UPDATES: scheduled ? '0' : '1',
      WECHAT_DESKTOP_ALLOW_SCHEDULED: '0',
      WECHAT_DESKTOP_MP_IDS: '',
      ...(legacy ? { CRON_EXPRESSION: '0 0 1 1 *' } : {}),
    });
    require(entry);
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
    AUTH_CODE:
      process.env.PRIVATE_ONLINE_MODE === '1'
        ? process.env.AUTH_CODE || ''
        : '',
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
  require(entry);
}

if (require.main === module)
  runtime().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = {
  runtime,
  scheduledUpdatesEnabled,
  guardModulePath,
  guardNativePath,
};
