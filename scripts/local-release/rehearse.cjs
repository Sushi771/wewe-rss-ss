// 对源库只读备份；迁移、运行、导出、回滚全部发生在新建的本机忽略目录。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const {
  readJson,
  fileHash,
  writeJson,
  inside,
  verifyRelease,
  cleanEnvironment,
  run,
  walk,
} = require('./lib.cjs');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function rehearse() {
  const { values } = parseArgs({
    options: { release: { type: 'string' }, source: { type: 'string' } },
  });
  if (!values.release || !values.source)
    throw new Error(
      '用法: node scripts/local-release/rehearse.cjs --release 产物目录 --source 源SQLite',
    );
  const root = path.resolve(__dirname, '../..');
  const release = fs.realpathSync(values.release);
  const source = fs.realpathSync(values.source);
  const manifest = verifyRelease(release);
  const audit = path.join(
    root,
    'output/playwright/local-release-audit',
    `${manifest.id}-${Date.now()}`,
  );
  fs.mkdirSync(audit, { recursive: true });
  const node = path.join(release, 'runtime/node.exe');
  const server = path.join(release, 'server');
  const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
  const env = cleanEnvironment({
    NODE_ENV: 'production',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  });
  const inspect = (database, options = []) =>
    JSON.parse(
      run(
        python,
        [
          path.join(release, 'inspect-sqlite.py'),
          '--database',
          database,
          '--migrations',
          path.join(server, 'prisma/migrations'),
          ...options,
        ],
        { env },
      ),
    );
  const pauseFile = path.join(root, 'tools/wechat-desktop-collector/.paused');
  const pauseHash = fs.existsSync(pauseFile) ? fileHash(pauseFile) : null;
  const productionBefore = path.join(audit, 'production-before.json');
  const sourceBefore = inspect(source, ['--output', productionBefore]);
  const backup = JSON.parse(
    run(
      python,
      [
        path.join(server, 'scripts/backup-sqlite.py'),
        '--database',
        source,
        '--backup-root',
        path.join(audit, 'backups'),
      ],
      { env },
    ),
  );
  assert.equal(backup.integrityCheck, 'ok');
  assert.equal(fileHash(backup.backup), backup.sha256);
  const database = path.join(audit, 'rehearsal.db');
  assert(inside(audit, database));
  assert.notEqual(database.toLowerCase(), source.toLowerCase());
  fs.copyFileSync(backup.backup, database, fs.constants.COPYFILE_EXCL);
  const baseline = path.join(audit, 'copy-before.json');
  const before = inspect(database, ['--output', baseline]);
  assert.deepEqual(
    before.tables,
    sourceBefore.tables,
    '源库在备份期间变化；保留副本，重新取基线后再演练',
  );
  assert.deepEqual(before.pending, [
    '20260927110000_collection_channel',
    '20260928020000_article_body_status',
    '20260928030000_article_body_retry',
  ]);
  const runtime = (command, db = database) =>
    run(node, [path.join(release, 'runtime.cjs'), command, '--database', db], {
      cwd: audit,
      env,
    });
  assert.throws(
    () => runtime('probe'),
    /尚未迁移/,
    '旧 schema 必须在加载应用之前拒绝',
  );
  const migrateEnv = {
    ...env,
    DATABASE_URL: 'file:' + database.replace(/\\/g, '/'),
  };
  const cli = path.join(server, 'node_modules/prisma/build/index.js');
  const migrate = () =>
    run(
      node,
      [
        cli,
        'migrate',
        'deploy',
        '--schema',
        path.join(server, 'prisma/schema.prisma'),
      ],
      { cwd: server, env: migrateEnv },
    );
  fs.writeFileSync(path.join(audit, 'migrate.log'), migrate());
  const migrated = inspect(database, [
    '--baseline',
    baseline,
    '--require-current',
    '--output',
    path.join(audit, 'copy-migrated.json'),
  ]);
  assert.equal(migrated.applied.length - before.applied.length, 3);
  const migratedBaseline = path.join(audit, 'migrated-baseline.json');
  inspect(database, ['--output', migratedBaseline]);
  fs.writeFileSync(path.join(audit, 'migrate-repeat.log'), migrate());
  inspect(database, ['--baseline', migratedBaseline, '--require-current']);
  fs.writeFileSync(path.join(audit, 'runtime-probe.jsonl'), runtime('probe'));
  writeJson(database + '.rehearsal.json', { releaseId: manifest.id, database });
  const localRequire = createRequire(path.join(server, 'package.json'));
  const { PrismaClient } = localRequire('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: migrateEnv.DATABASE_URL } },
  });
  let cached, textOnly;
  try {
    cached = await prisma.article.findFirstOrThrow({
      where: { mpId: 'MP_WXS_3895431412', contentHtml: { not: null } },
      select: { id: true, contentHtml: true },
    });
    textOnly = (
      await prisma.article.findMany({
        where: { contentHtml: { not: null } },
        select: { id: true, contentHtml: true },
      })
    ).find(
      (article) =>
        !/<img\b/i.test(article.contentHtml) &&
        /js_content|rich_media_content/.test(article.contentHtml),
    );
    assert(textOnly, '需要一篇已有无外链图片的正文来执行无网络 Obsidian 冒烟');
  } finally {
    await prisma.$disconnect();
  }
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const guardReport = path.join(audit, 'guard.json');
  const vault = path.join(audit, 'vault');
  const log = fs.openSync(path.join(audit, 'server.log'), 'wx');
  const child = spawn(
    node,
    [
      path.join(release, 'runtime.cjs'),
      'start',
      '--database',
      database,
      '--port',
      String(port),
      '--pause-file',
      pauseFile,
      '--rehearsal',
      '--obsidian-root',
      vault,
      '--guard-report',
      guardReport,
    ],
    {
      cwd: audit,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', log, log],
    },
  );
  const closed = once(child, 'close');
  let result;
  try {
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error('隔离服务提前退出；查看 server.log');
      try {
        const response = await fetch(base + '/', {
          signal: AbortSignal.timeout(1000),
        });
        ready = response.ok;
      } catch {
        /* 等待启动 */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(ready, '隔离服务启动超时');
    async function trpc(route, input, mutation = false) {
      // 与前端 httpBatchLink 一致：mutation 使用对象批次，避免 Express 拒绝根 JSON 字符串。
      const response = await fetch(
        `${base}/trpc/${route}${mutation ? '?batch=1' : '?input=' + encodeURIComponent(JSON.stringify(input))}`,
        mutation
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // 与前端 httpBatchLink 相同：Express 默认 JSON parser 不接收顶层字符串。
              body: JSON.stringify({ 0: input }),
              signal: AbortSignal.timeout(15000),
            }
          : { signal: AbortSignal.timeout(10000) },
      );
      assert.equal(response.status, 200, `TRPC ${route} 失败`);
      const raw = await response.json();
      const payload = mutation ? raw[0] : raw;
      assert(!payload.error, `TRPC ${route} 返回错误`);
      return payload.result.data;
    }
    const dash = await fetch(base + '/dash');
    assert.equal(dash.status, 200);
    const html = await dash.text();
    const asset = html.match(/(?:src|href)="(\/dash\/assets\/[^"?#]+\.js)"/)[1];
    const assetResponse = await fetch(base + asset);
    assert.equal(assetResponse.status, 200);
    assert((await assetResponse.text()).length > 1000);
    const feeds = await trpc('feed.list', {});
    assert.equal(feeds.items.length, before.tables.feeds.rows);
    for (const mpId of ['MP_WXS_3895431412', 'MP_WXS_3922744618']) {
      const feed = await trpc('feed.byId', mpId);
      assert(feed.collectionRoute);
      const list = await trpc('article.list', { mpId, limit: 20 });
      assert.equal(list.items.length, 20);
      assert(
        list.items.every(
          (article) =>
            !Object.hasOwn(article, 'contentHtml') &&
            typeof article.bodyCached === 'boolean',
        ),
      );
      const rss = await fetch(
        `${base}/feeds/${mpId}.rss?limit=20&mode=summary`,
      );
      assert.equal(rss.status, 200);
      assert.equal(((await rss.text()).match(/<item>/g) || []).length, 20);
    }
    const article = await trpc('article.byId', cached.id);
    assert.equal(article.contentHtml, cached.contentHtml);
    assert.equal(article.verifiedSourceUrl, null);
    assert.equal(article.lastBodyRetry, null);
    const markdown = await trpc('article.exportMarkdown', cached.id, true);
    assert(markdown.markdown.length > 50);
    const saved = await trpc('article.saveToObsidian', textOnly.id, true);
    assert(
      saved.success &&
        inside(vault, saved.path) &&
        fs.statSync(saved.path).size > 50,
    );
    const guard = readJson(guardReport);
    assert.deepEqual(guard, {
      installed: true,
      blockedNetwork: 0,
      blockedChildren: 0,
    });
    assert(
      !fs
        .readFileSync(path.join(audit, 'server.log'), 'utf8')
        .includes('Called handleUpdateFeedsCron'),
    );
    let markdownFiles = 0;
    walk(vault, (file, kind) => {
      if (kind === 'file' && file.endsWith('.md')) markdownFiles++;
    });
    result = {
      dashboard: true,
      staticAsset: true,
      feeds: feeds.items.length,
      targetLists: 2,
      targetRss: 2,
      cachedBodyExact: true,
      markdownExport: true,
      obsidianExport: true,
      markdownFiles,
      guard,
    };
  } finally {
    if (child.exitCode === null) child.kill(); // 只结束本脚本创建的已知子进程。
    await closed;
    fs.closeSync(log);
  }
  inspect(database, [
    '--baseline',
    baseline,
    '--require-current',
    '--output',
    path.join(audit, 'copy-after-smoke.json'),
  ]);
  inspect(database, ['--baseline', migratedBaseline, '--require-current']);
  // 回滚演练恢复到一个新路径，绝不覆盖源库或销毁演练后的状态。
  assert.equal(fileHash(backup.backup), backup.sha256);
  const rollback = path.join(audit, 'rollback.db');
  fs.copyFileSync(backup.backup, rollback, fs.constants.COPYFILE_EXCL);
  const restored = inspect(rollback, [
    '--baseline',
    baseline,
    '--output',
    path.join(audit, 'rollback.json'),
  ]);
  assert.deepEqual(restored.pending, before.pending);
  assert.throws(() => runtime('probe', rollback), /尚未迁移/);
  inspect(source, [
    '--baseline',
    productionBefore,
    '--output',
    path.join(audit, 'production-after.json'),
  ]);
  assert.equal(
    fs.existsSync(pauseFile) ? fileHash(pauseFile) : null,
    pauseHash,
  );
  verifyRelease(release);
  const summary = {
    passed: true,
    release,
    audit,
    sourceReadOnly: true,
    feeds: before.tables.feeds.rows,
    articles: before.tables.articles.rows,
    migrationsApplied: 3,
    repeatedMigrationNoChange: true,
    oldColumnsExactlyPreserved: true,
    newColumnsNull: true,
    rejectsOldSchema: true,
    runtimeContainedInRelease: true,
    databaseRollbackVerified: true,
    pauseUnchanged: true,
    processStopped: true,
    ...result,
  };
  writeJson(path.join(audit, 'summary.json'), summary);
  console.log(JSON.stringify(summary));
  return summary;
}

if (require.main === module)
  rehearse().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { rehearse };
