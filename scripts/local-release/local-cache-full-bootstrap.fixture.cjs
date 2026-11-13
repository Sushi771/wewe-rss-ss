// Synthetic source bootstrap only. No production paths, builds, or gate overrides.
(async () => {
  const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict'),
    cp = require('node:child_process'),
    crypto = require('node:crypto');
  const w = path.resolve(__dirname, '../..'),
    server = path.join(w, 'apps/server');

  const osEnvironment = new Set([
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'COMSPEC',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
  ]);
  for (const key of Object.keys(process.env))
    if (!osEnvironment.has(key.toUpperCase())) delete process.env[key];
  process.chdir(server);
  process.env.TS_NODE_PROJECT = path.join(server, 'tsconfig.json');
  require(path.join(server, 'node_modules/ts-node/register/transpile-only'));
  require(path.join(server, 'node_modules/tsconfig-paths/register'));
  const reuse = process.argv[2] === '--reuse-root';
  assert.ok(process.argv.length === (reuse ? 4 : 2));
  if (reuse) assert.ok(!fs.lstatSync(process.argv[3]).isSymbolicLink());
  const root = reuse
    ? fs.realpathSync.native(process.argv[3])
    : fs.mkdtempSync(
        path.join(
          fs.realpathSync.native(require('node:os').tmpdir()),
          'wewe-full-bootstrap-',
        ),
      );
  assert.equal(
    path.dirname(root).toLowerCase(),
    fs.realpathSync.native(require('node:os').tmpdir()).toLowerCase(),
  );
  assert.ok(path.basename(root).startsWith('wewe-full-bootstrap-'));
  // Only the preceding owned test run may supply reuse-root. This is not a
  // general database-import or arbitrary-directory maintenance interface.
  if (reuse) {
    let entries = 0;
    const visit = (directory) => {
      assert.ok(!fs.lstatSync(directory).isSymbolicLink());
      const real = fs.realpathSync.native(directory);
      assert.ok(real === root || real.startsWith(root + path.sep));
      for (const name of fs.readdirSync(directory)) {
        assert.ok(++entries <= 1000);
        const file = path.join(directory, name),
          st = fs.lstatSync(file);
        assert.ok(!st.isSymbolicLink());
        if (st.isDirectory()) visit(file);
        else assert.ok(st.isFile() && st.nlink === 1);
      }
    };
    visit(root);
  }
  const marker = path.join(root, 'synthetic-fixture.json');
  const markerValue = {
    format: 1,
    fixtureSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(__filename))
      .digest('hex'),
  };
  if (reuse)
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), markerValue);
  else fs.writeFileSync(marker, JSON.stringify(markerValue), { flag: 'wx' });
  const db = path.join(root, 'application.sqlite'),
    cache = path.join(root, 'synthetic-upstream.sqlite');
  if (!reuse) fs.writeFileSync(db, '', { flag: 'wx' });
  else {
    assert.ok(!fs.lstatSync(db).isSymbolicLink());
    assert.ok(!fs.lstatSync(cache).isSymbolicLink());
  }
  const fixtureServer = path.join(root, 'server');
  fs.mkdirSync(path.join(fixtureServer, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(server, 'scripts/watch-wechat2rss-cache.py'),
    path.join(fixtureServer, 'scripts/watch-wechat2rss-cache.py'),
  );
  for (const name of fs
    .readdirSync(path.join(server, 'scripts'))
    .filter((name) => name.endsWith('.py') && !name.startsWith('test_')))
    fs.copyFileSync(
      path.join(server, 'scripts', name),
      path.join(fixtureServer, 'scripts', name),
    );
  fs.mkdirSync(path.join(fixtureServer, 'prisma'), { recursive: true });
  fs.copyFileSync(
    path.join(server, 'prisma/schema.prisma'),
    path.join(fixtureServer, 'prisma/schema.prisma'),
  );
  fs.copyFileSync(
    path.join(server, 'package.json'),
    path.join(fixtureServer, 'package.json'),
  );
  require(path.join(w, 'scripts/local-release/project-writer-gate.cjs'));
  process.chdir(fixtureServer);
  Object.assign(process.env, {
    NODE_ENV: 'production',
    PORT: '0',
    HOST: '127.0.0.1',
    SQLITE_BACKUP_KIND: 'test',
    SQLITE_TEST_BACKUP_ROOT: path.join(root, 'backups'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    DATABASE_TYPE: 'sqlite',
    OBSIDIAN_PATH: path.join(root, 'exports'),
    CRON_EXPRESSION: '0 0 1 1 *',
    DATABASE_URL: 'file:' + db.replace(/\\/g, '/'),
    WECHAT2RSS_ENABLED: '1',
    WECHAT2RSS_CACHE_SYNC: '1',
    WECHAT2RSS_LOCAL_CACHE_SYNC: '1',
    WECHAT2RSS_CACHE_DB: cache,
    SQLITE_BACKUP_PYTHON: 'python',
    SQLITE_PERIODIC_SNAPSHOT_ENABLED: '1',
  });
  for (const key of [
    'WECHAT2RSS_BASE_URL',
    'WECHAT2RSS_TOKEN',
    'WECHAT2RSS_RECOVERY_HOLD',
    'WEWE_ACCEPTANCE_MODE',
    'REHEARSAL_GUARD_REPORT',
  ])
    delete process.env[key];
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
  const { DatabaseSync } = require('node:sqlite');
  if (!reuse) {
    const upstream = new DatabaseSync(cache);
    upstream.exec(
      'CREATE TABLE rsses(biz_id INTEGER,name TEXT); CREATE TABLE articles(id INTEGER PRIMARY KEY,biz_id INTEGER,o_id TEXT,url TEXT,title TEXT,created TEXT,fulltext INTEGER,content TEXT,pic_url TEXT)',
    );
    for (const [biz, name, encoded] of [
      [1234567890, '合成一号', 'MTIzNDU2Nzg5MA=='],
      [3234567890, '合成二号', 'MzIzNDU2Nzg5MA=='],
    ]) {
      upstream.prepare('INSERT INTO rsses VALUES(?,?)').run(biz, name);
      for (const mid of biz === 1234567890 ? [991, 993] : [992])
        upstream
          .prepare(
            'INSERT INTO articles(biz_id,o_id,url,title,created,fulltext,content,pic_url) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            biz,
            String(mid),
            `https://mp.weixin.qq.com/s?__biz=${encoded}&mid=${mid}&idx=1`,
            name + '最新文章',
            '2026-11-12 10:00:00+08:00',
            1,
            '<div class="rich_media_content"><p>真实缓存正文一😱</p><img src="data:image/png;base64,' +
              png +
              '"><img src="https://mmbiz.qpic.cn/synthetic-only.png"></div>',
            '',
          );
    }
    upstream.close();
  }
  await require(
    path.join(w, 'scripts/local-release/writer-self.fixture.test.cjs'),
  ).prepareWriterSelf();
  const counts = {
    http: 0,
    provider: 0,
    media: 0,
    backup: 0,
    childReads: 0,
    childWatchers: 0,
    childSnapshots: 0,
    blockedChildren: 0,
  };
  global.fetch = () => {
    counts.http++;
    throw Error('HTTP_FORBIDDEN');
  };
  for (const mod of ['node:http', 'node:https'])
    for (const name of ['request', 'get'])
      require(mod)[name] = () => {
        counts.http++;
        throw Error('HTTP_FORBIDDEN');
      };
  for (const name of ['connect', 'createConnection'])
    require('node:net')[name] = () => {
      counts.http++;
      throw Error('NETWORK_FORBIDDEN');
    };
  require('node:net').Socket.prototype.connect = () => {
    counts.http++;
    throw Error('NETWORK_FORBIDDEN');
  };
  const spawn = cp.spawn;
  function allow(executable, args) {
    try {
      assert.ok(/(?:^|[\\/])python(?:3|\.exe)?$/i.test(executable));
      assert.ok(Array.isArray(args));
      const at = args.indexOf('--database');
      assert.ok([cache, db].includes(args[at + 1]));
      const script = args.find((x) => /\.py$/.test(x));
      assert.ok(script);
      const base = path.basename(script);
      assert.ok(
        ['watch-wechat2rss-cache.py', 'sqlite-snapshot-guard.py'].includes(
          base,
        ),
      );
      assert.equal(
        fs.realpathSync(script),
        fs.realpathSync(path.join(fixtureServer, 'scripts', base)),
      );
      assert.deepEqual(
        args,
        base === 'watch-wechat2rss-cache.py'
          ? [
              '-u',
              path.join(fixtureServer, 'scripts', base),
              '--database',
              cache,
              '--event-hints',
            ]
          : [
              path.join(fixtureServer, 'scripts', base),
              '--database',
              db,
              '--backup-root',
              path.join(root, 'backups'),
              '--interval-seconds',
              '900',
              '--max-age-seconds',
              '900',
            ],
      );
      if (base === 'watch-wechat2rss-cache.py') counts.childWatchers++;
      else counts.childSnapshots++;
    } catch (error) {
      counts.blockedChildren++;
      throw error;
    }
  }
  cp.spawn = function (exe, args, options) {
    allow(exe, args);
    assert.deepEqual(
      { ...options, env: undefined },
      {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: undefined,
      },
    );
    return spawn.call(this, exe, args, options);
  };
  cp.execFile =
    cp.execFileSync =
    cp.spawnSync =
    cp.exec =
    cp.execSync =
    cp.fork =
      () => {
        counts.blockedChildren++;
        throw Error('UNAPPROVED_CHILD_FORBIDDEN');
      };
  require(
    path.join(server, 'src/collection/provider-registry'),
  ).wechat2RssProvider = () => {
    counts.provider++;
    throw Error('PROVIDER_FORBIDDEN');
  };
  require(
    path.join(server, 'src/feeds/automatic-media-queue'),
  ).AutomaticMediaQueue = class {
    constructor() {
      counts.media++;
      throw Error('MEDIA_WORKER_FORBIDDEN');
    }
  };
  require(path.join(server, 'src/feeds/media-safety-stop')).mediaSafetyStop =
    async () => {
      counts.media++;
      throw Error('MEDIA_STATE_FORBIDDEN');
    };
  require(path.join(server, 'src/collection/image-fetch')).fetchAllowedImage =
    async () => {
      counts.media++;
      throw Error('MEDIA_FETCH_FORBIDDEN');
    };
  require(
    path.join(server, 'src/collection/sqlite-backup'),
  ).createVerifiedSqliteBackup = async () => {
    counts.backup++;
    throw Error('ORDINARY_BACKUP_FORBIDDEN');
  };
  const { PrismaClient } = require(
    path.join(server, 'node_modules/@prisma/client'),
  );
  const { withFixtureMigrationConnection } = require(
    path.join(server, 'test/fixture-migration-connection'),
  );
  const { splitSqliteStatements } = require(
    path.join(w, 'scripts/sqlite-statements.cjs'),
  );
  const { CacheSyncService } = require(
    path.join(server, 'src/feeds/cache-sync.service'),
  );
  const { cacheSyncState } = require(
    path.join(server, 'src/feeds/cache-sync-state'),
  );
  const { canonicalArticleUrl } = require(
    path.join(server, 'src/collection/collection-format'),
  );
  const sha = (file) =>
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    beforeCache = sha(cache);
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  let app;
  const childExits = [];
  const guardedSpawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = guardedSpawn(...args);
    childExits.push(new Promise((resolve) => child.once('close', resolve)));
    return child;
  };
  const { NestFactory } = require(
    path.join(server, 'node_modules/@nestjs/core'),
  );
  const originalCreate = NestFactory.create.bind(NestFactory);
  NestFactory.create = async (...args) => {
    app = await originalCreate(...args);
    return app;
  };
  const { PrismaService } = require(
    path.join(server, 'src/prisma/prisma.service'),
  );
  async function stop() {
    if (app) {
      const current = app;
      app = undefined;
      await current.close();
      await current.get(PrismaService).$disconnect();
    }
    await Promise.all(childExits);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const archived = canonicalArticleUrl(
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=990&idx=1',
  );
  let round = 0;
  async function checkpoint(phase) {
    if (!process.send) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        process.removeListener('message', reply);
        reject(Error('SUPERVISOR_TIMEOUT'));
      }, 180000);
      const reply = (message) => {
        clearTimeout(timer);
        message?.continue === true
          ? resolve()
          : reject(Error('SUPERVISOR_REFUSED'));
      };
      process.once('message', reply);
      process.send({
        phase,
        round,
        pid: process.pid,
        root,
        cache,
        script: path.join(fixtureServer, 'scripts/watch-wechat2rss-cache.py'),
        snapshotScript: path.join(
          fixtureServer,
          'scripts/sqlite-snapshot-guard.py',
        ),
        database: db,
        backupRoot: path.join(root, 'backups'),
        port: app?.getHttpServer().address().port,
      });
    });
  }
  async function startAndWait() {
    round++;

    require(path.join(server, 'src/main.ts'));
    const until = performance.now() + 20000;
    while (performance.now() < until) {
      const rows = await prisma.article.findMany();
      if (
        app?.getHttpServer().listening &&
        counts.childSnapshots >= round &&
        (
          await require(
            path.join(server, 'src/collection/sqlite-snapshot-guard'),
          ).queryFastInsertSnapshotGuard()
        ).verified &&
        rows.length === 4 &&
        counts.childWatchers >= round &&
        rows.filter((r) => r.id !== archived.id).every((r) => r.contentHtml)
      ) {
        await checkpoint('ready');
        return;
      }
      await sleep(100);
    }
    throw Error('LOCAL_IMPORT_TIMEOUT ' + JSON.stringify(cacheSyncState));
  }
  await (async () => {
    try {
      if (!reuse)
        await withFixtureMigrationConnection(
          process.env.DATABASE_URL,
          async (tx) => {
            const dir = path.join(server, 'prisma/migrations');
            for (const name of fs.readdirSync(dir).sort()) {
              const f = path.join(dir, name, 'migration.sql');
              if (fs.existsSync(f))
                for (const sql of splitSqliteStatements(
                  fs.readFileSync(f, 'utf8'),
                )
                  .map((x) => x.trim())
                  .filter(Boolean))
                  await tx.$executeRawUnsafe(sql);
            }
          },
        );
      for (const [id, name] of [
        ['MP_WXS_1234567890', '合成一号'],
        ['MP_WXS_3234567890', '合成二号'],
      ])
        if (!reuse)
          await prisma.feed.create({
            data: {
              id,
              mpName: name,
              mpIntro: '',
              mpCover: '',
              status: 1,
              collectionChannel: 'wechat2rss',
              updateTime: 0,
            },
          });
      if (!reuse)
        await prisma.article.create({
          data: {
            id: archived.id,
            mpId: archived.mpId,
            title: '滚动缓存外的旧文章',
            publishTime: 1760000000,
            picUrl: '',
            sourceUrl: archived.url,
            verifiedSourceUrl: archived.url,
            contentHtml:
              '<p>用户原有正文</p><img src="data:image/png;base64,' +
              png +
              '">',
            metrics: '{"note":"keep"}',
          },
        });
      const original = await prisma.article.findUnique({
        where: { id: archived.id },
      });
      const overlap = canonicalArticleUrl(
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=991&idx=1',
      );
      if (!reuse)
        await prisma.article.create({
          data: {
            id: overlap.id,
            mpId: overlap.mpId,
            title: '用户编辑旧标题',
            publishTime: 1760000000,
            picUrl: '',
            sourceUrl: overlap.url,
            verifiedSourceUrl: overlap.url,
            contentHtml:
              '<div class="rich_media_content"><p>本地编辑旧正文</p><img src="data:image/png;base64,' +
              png +
              '"></div>',
            metrics: '{"note":"preserve-overlap"}',
          },
        });
      const originalOverlap = await prisma.article.findUnique({
        where: { id: overlap.id },
      });

      if (!reuse)
        await prisma.$executeRawUnsafe(
          "UPDATE Wechat2RssSourceGate SET state='pending',token='synthetic-unknown',status=NULL WHERE id=1",
        );
      if (!reuse)
        await prisma.$executeRawUnsafe(
          'INSERT INTO refresh_submission_claims(id,mp_id,state,reserved_at,previous_at,updated_at_ms) VALUES(?,?,?,?,?,?)',
          'e'.repeat(64),
          archived.mpId,
          'unknown',
          1794448800,
          0,
          1794448800000,
        );
      const gates = await prisma.$queryRawUnsafe(
          'SELECT * FROM Wechat2RssSourceGate',
        ),
        claims = await prisma.$queryRawUnsafe(
          'SELECT * FROM refresh_submission_claims',
        );

      await startAndWait();
      await stop();
      await checkpoint('stopped');
      await sleep(500);
      const first = await prisma.article.findMany({ orderBy: { id: 'asc' } });
      assert.deepEqual(
        first.find((r) => r.id === archived.id),
        original,
      );
      assert.deepEqual(
        first.find((r) => r.id === overlap.id),
        originalOverlap,
      );
      const fresh = first.find((r) => r.title === '合成一号最新文章');
      assert.ok(fresh.contentHtml.includes('真实缓存正文一😱'));
      assert.ok(!fresh.contentHtml.includes('data:image/png;base64,'));
      assert.ok(original.contentHtml.includes('data:image/png;base64,'));
      assert.ok(
        fresh.contentHtml.includes('https://mmbiz.qpic.cn/synthetic-only.png'),
      );
      assert.equal(fresh.publishTime, 1794448800);
      const baseline = path.join(root, 'articles-first.json');
      if (reuse)
        assert.equal(JSON.stringify(first), fs.readFileSync(baseline, 'utf8'));
      else fs.writeFileSync(baseline, JSON.stringify(first), { flag: 'wx' });
      assert.deepEqual(
        await prisma.article.findMany({ orderBy: { id: 'asc' } }),
        first,
      );
      assert.deepEqual(
        await prisma.$queryRawUnsafe('SELECT * FROM Wechat2RssSourceGate'),
        gates,
      );
      assert.deepEqual(
        await prisma.$queryRawUnsafe('SELECT * FROM refresh_submission_claims'),
        claims,
      );
      assert.equal(sha(cache), beforeCache);
      assert.equal(cacheSyncState.mediaPause, 'local-cache-only');
      for (const k of [
        'http',
        'provider',
        'media',
        'backup',
        'blockedChildren',
      ])
        assert.equal(counts[k], 0);
      assert.equal(counts.childReads, 0);
      assert.equal(counts.childWatchers, 1);
      assert.equal(counts.childSnapshots, 1);
      const report = {
        ok: true,
        layout:
          'real source main.ts listen(0), one real main bootstrap per OS process; wrapper reuses only its own synthetic database; not installed-runtime or formal publication proof',
        sourceHashes: Object.fromEntries(
          [
            'collection/local-cache-reader.ts',
            'feeds/cache-sync.service.ts',
            'app.module.ts',
            'main.ts',
            'collection/sqlite-snapshot-guard.ts',
          ].map((name) => [name, sha(path.join(server, 'src', name))]),
        ),
        fixtureRoot: root,
        sourceCache: 'synthetic only; no production database or cache',
        startupFlag: 'WECHAT2RSS_LOCAL_CACHE_SYNC=1',
        providerConfigAbsent: true,
        realWriterGate: true,
        periodicSnapshotEnabled: true,
        fullMainEntrypoint: true,
        sameProcessMainBootstraps: 1,
        reusedSyntheticDatabase: reuse,
        installedStartupGate: false,
        formalReleasePublication: false,
        articles: 4,
        newArticles: reuse ? 0 : 2,
        overlappingEditedArticleUnchanged: true,
        sourceCacheBytesUnchanged: true,
        archivedRowUnchanged: true,
        storedInlineImageBytesPreserved: true,
        untrustedUpstreamDataImagesRejected: true,
        supportedRemoteImageLinkPreservedWithoutDownload: true,
        gatePendingAndUnknownClaimUnchanged: true,
        restartReplayIdentical: reuse,
        counts,
      };
      fs.writeFileSync(
        path.join(root, reuse ? 'REPORT.replay.json' : 'REPORT.json'),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
    } finally {
      await stop();
      await prisma.$disconnect();
    }
  })();
})()
  .finally(() => {
    if (process.connected) process.disconnect();
  })
  .catch((e) => {
    console.error(e.stack || e);
    process.exitCode = 1;
  });
