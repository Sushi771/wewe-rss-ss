#!/usr/bin/env node
'use strict';
// Real persisted search responses + previously captured originals/images.
// No production update route is enabled and every write is to an isolated copy.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { snapshot } = require('./probe-recent-account-discovery.cjs');
const root = path.resolve(__dirname, '../..'),
  server = path.join(root, 'apps/server'),
  built = path.join(server, 'dist/apps/server/src');
const local = createRequire(path.join(server, 'package.json'));
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) =>
  fs.writeFileSync(f, JSON.stringify(v, null, 2), { flag: 'wx' });
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    return Object.fromEntries(
      ['feeds', 'articles', 'accounts'].map((t) => [
        t,
        db.prepare(`SELECT * FROM ${t} ORDER BY id`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
function sameOld(before, after) {
  assert.deepEqual(after.feeds, before.feeds);
  assert.deepEqual(after.accounts, before.accounts);
  const map = new Map(after.articles.map((a) => [a.id, a]));
  for (const article of before.articles)
    assert.deepEqual(map.get(article.id), article);
}
function networkGuard() {
  let blocked = 0;
  const fail = () => {
    blocked++;
    throw Error('SEARCH_REPLAY_NETWORK_DISABLED');
  };
  for (const n of ['node:http', 'node:https'])
    for (const op of ['get', 'request']) require(n)[op] = fail;
  global.fetch = fail;
  local('axios').get = local('axios').post = fail;
  return () => blocked;
}
function inputs() {
  const { searchArticleCandidates } = require(
    path.join(built, 'collection/article-candidate'),
  );
  const config = json(
    path.join(
      root,
      'private-data/owner-web-search-20260930/source-config.json',
    ),
  );
  const pages = [1, 2].map((n) =>
    json(
      path.join(root, `private-data/owner-web-search-20260930/page-${n}.json`),
    ),
  );
  const candidates = pages.flatMap((p) =>
    searchArticleCandidates(p.items, config, {
      source: 'owner-web-search',
      capturedAt: p.capturedAt,
      page: p.pageNumber,
    }),
  );
  assert.equal(new Set(candidates.map((c) => c.id)).size, 26);
  const cutoff = Date.parse(pages[0].capturedAt) / 1000 - 7 * 86400;
  const selected = candidates
    .filter((c) => c.indexTimestamp >= cutoff)
    .sort((a, b) => b.indexTimestamp - a.indexTimestamp);
  assert.equal(selected.length, 5);
  // Cache lookup is strictly downstream of the independent saved response.
  const cacheRoot = path.join(root, 'private-data/user-recent-articles');
  const records = fs
    .readdirSync(cacheRoot)
    .filter((n) => /^[a-f0-9]{20}$/.test(n))
    .map((n) => {
      const dir = path.join(cacheRoot, n);
      return {
        dir,
        result: json(path.join(dir, 'result.json')),
        attempt: json(path.join(dir, 'attempt.json')),
      };
    });
  return {
    candidates,
    selected,
    mpId: selected[0].mpId,
    resolveCache: async (c) => {
      const matches = records.filter((r) => r.result.id === c.id);
      if (!matches.length) return null;
      assert.equal(matches.length, 1);
      const r = matches[0],
        imageDir = path.join(
          cacheRoot,
          'body-image-acceptance',
          path.basename(r.dir),
        );
      let images = [];
      if (fs.existsSync(path.join(imageDir, 'image.json'))) {
        const image = json(path.join(imageDir, 'image.json'));
        assert.equal(image.status, 200);
        images = [
          {
            url: image.url,
            sha256: image.sha256,
            capturedAt: image.capturedAt,
            source: 'official-image-response',
            bytes: fs.readFileSync(path.join(imageDir, 'image.bytes')),
          },
        ];
      }
      assert.equal(r.result.status, 200);
      return {
        html: fs.readFileSync(path.join(r.dir, 'original.html'), 'utf8'),
        images,
        evidence: {
          source: 'official-public-original',
          requestedUrl: r.attempt.url,
          capturedAt: r.result.observedAt,
          sha256: r.result.originalSha256,
          transport: 'verified-cache',
        },
      };
    },
  };
}
async function worker(stage, dir, copy) {
  assert(
    path.resolve(dir).startsWith(path.join(root, 'private-data') + path.sep),
  );
  assert.equal(path.dirname(copy), dir);
  process.env.DATABASE_URL = `file:${copy.replace(/\\/g, '/')}`;
  process.env.DISABLE_SCHEDULED_UPDATES = '1';
  delete process.env.PRIVATE_ONLINE_MODE;
  const blocked = networkGuard();
  const input = inputs();
  const { prepareSearchReplay } = require(
    path.join(built, 'collection/search-replay'),
  );
  const replay = await prepareSearchReplay(
    input.selected,
    input.mpId,
    input.resolveCache,
  );
  assert.equal(replay.verified.length, 2);
  assert.equal(replay.unverified.length, 3);
  const { PrismaClient } = local('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  try {
    const { CollectionService } = require(
      path.join(built, 'collection/collection.service'),
    );
    const collection = new CollectionService(prisma);
    const result = await collection.replayVerifiedSearch(input.mpId, replay);
    assert.equal(result.created, stage === 'first' ? 2 : 0);
    assert.equal(result.updated, 0);
    const articles = await prisma.article.findMany({
      where: { id: { in: replay.verified.map((v) => v.article.id) } },
    });
    for (const verified of replay.verified) {
      const saved = articles.find((a) => a.id === verified.article.id);
      assert(saved);
      assert.equal(saved.publishTime, verified.article.publishTime);
      assert.equal(saved.contentHtml, verified.article.contentHtml);
    }
    write(path.join(dir, stage + '.json'), {
      ...result,
      selected: input.selected.map((c) => ({
        id: c.id,
        indexTimestamp: c.indexTimestamp,
      })),
      verified: replay.verified.map((v) => ({
        id: v.article.id,
        publishTime: v.article.publishTime,
        discovery: v.discovery,
        original: v.original,
        images: v.images,
      })),
      unverified: replay.unverified,
      blockedNetwork: blocked(),
    });
  } finally {
    await prisma.$disconnect();
  }
}
async function exportsWorker(dir, copy) {
  process.env.DATABASE_URL = `file:${copy.replace(/\\/g, '/')}`;
  delete process.env.PRIVATE_ONLINE_MODE;
  const blocked = networkGuard(),
    input = inputs();
  const { PrismaClient } = local('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  const { CollectionService } = require(
    path.join(built, 'collection/collection.service'),
  );
  const { TrpcService } = require(path.join(built, 'trpc/trpc.service'));
  const { TrpcRouter } = require(path.join(built, 'trpc/trpc.router'));
  const vault = path.join(dir, 'obsidian');
  const config = {
    get: (k) =>
      ({
        platform: { url: '' },
        feed: {
          updateDelayTime: 0,
          obsidianPath: vault,
          originUrl: 'http://127.0.0.1:4000',
          mode: 'fulltext',
        },
        database: { type: 'sqlite' },
      })[k],
  };
  const collection = new CollectionService(prisma),
    trpc = new TrpcService(prisma, config, {}, collection),
    router = new TrpcRouter(trpc, prisma, config, {}, collection);
  const caller = router.appRouter.createCaller({
    errorMsg: null,
    isLocal: true,
  });
  try {
    const articles = await prisma.article.findMany({
      where: { mpId: input.mpId },
    });
    assert.equal(articles.length, 2);
    let imageHash;
    for (const article of articles) {
      const markdown = await caller.article.exportMarkdown(article.id);
      assert(markdown.markdown.length > 100);
      const saved = await caller.article.saveToObsidian(article.id);
      assert(saved.success);
      const text = fs.readFileSync(saved.path, 'utf8');
      for (const ref of text.match(
        /attachments\/image_[a-f0-9]+\.(?:png|jpeg|gif|webp)/g,
      ) || []) {
        imageHash = hash(
          fs.readFileSync(path.join(path.dirname(saved.path), ref)),
        );
      }
    }
    const { FeedsService } = require(path.join(built, 'feeds/feeds.service'));
    const rss = await new FeedsService(prisma, trpc, config).handleGenerateFeed(
      { id: input.mpId, type: 'rss', limit: 20, page: 1, mode: 'fulltext' },
    );
    fs.writeFileSync(path.join(dir, 'search-replay.rss'), rss.content);
    assert.equal(
      local('cheerio').load(rss.content, { xmlMode: true })('item').length,
      2,
    );
    const folder = path.join(dir, 'offline');
    const staged = await router.buildOfflineFeedDirectory(input.mpId, folder);
    assert(staged.complete);
    const { OfflineExportController } = require(
      path.join(built, 'offline-export.controller'),
    );
    const zip = path.join(dir, 'search-replay.zip');
    const res = fs.createWriteStream(zip, { flags: 'wx' });
    res.headersSent = false;
    res.setHeader = () => {};
    res.status = (code) => {
      throw Error('ZIP_HTTP_' + code);
    };
    await new OfflineExportController(router).feedZip(input.mpId, res);
    const checked = JSON.parse(
      run('python', [
        path.join(root, 'scripts/album-acceptance-zip.py'),
        zip,
        folder,
      ]),
    );
    const expected = json(
      path.join(
        root,
        'private-data/user-recent-articles/body-image-acceptance/e327de2ad1eb292750d7/image.json',
      ),
    ).sha256;
    assert.equal(imageHash, expected);
    write(path.join(dir, 'exports.json'), {
      scope: 'two verified cache articles on narrowed export copy',
      rssItems: 2,
      markdown: 2,
      obsidian: 2,
      imageBytesVerified: true,
      zip: checked,
      blockedNetwork: blocked(),
    });
    assert.equal(blocked(), 0);
  } finally {
    await prisma.$disconnect();
  }
}
async function parent() {
  const source = path.join(server, 'data/wewe-rss.db'),
    before = snapshot(source),
    old = rows(source);
  const dir = path.join(
    root,
    'private-data/single-account-update-20260930',
    'replay-' + crypto.randomUUID(),
  );
  fs.mkdirSync(dir);
  const backup = JSON.parse(
    run('python', [
      path.join(server, 'scripts/backup-sqlite.py'),
      '--database',
      source,
      '--backup-root',
      path.join(dir, 'backups'),
    ]),
  );
  const backupFile = backup.backup;
  if (!backupFile) throw Error('BACKUP_REPORT_PATH_REQUIRED');
  const copy = path.join(dir, 'replay.db');
  fs.copyFileSync(backupFile, copy);
  assert.equal(hash(fs.readFileSync(copy)), hash(fs.readFileSync(backupFile)));
  write(copy + '.search-replay.json', {
    mode: 'real-response-replay',
    sourceDatabase: source,
  });
  let afterFirst;
  for (const stage of ['first', 'restart']) {
    const output = run(
      process.execPath,
      [__filename, '--worker', stage, dir, copy],
      { cwd: server },
    );
    fs.writeFileSync(path.join(dir, stage + '.log'), output);
    const current = rows(copy);
    sameOld(old, current);
    assert.equal(current.articles.length, 1449);
    if (afterFirst) assert.deepEqual(current, afterFirst);
    else afterFirst = current;
  }
  const exportCopy = path.join(dir, 'export-only.db');
  const exportBackup = JSON.parse(
    run('python', [
      path.join(server, 'scripts/backup-sqlite.py'),
      '--database',
      copy,
      '--backup-root',
      path.join(dir, 'export-backup'),
    ]),
  );
  fs.copyFileSync(exportBackup.backup, exportCopy);
  const only = json(path.join(dir, 'first.json')).verified.map((v) => v.id);
  const db = new DatabaseSync(exportCopy);
  try {
    db.prepare('DELETE FROM articles WHERE id NOT IN (?,?)').run(...only);
    db.prepare('DELETE FROM feeds WHERE id <> ?').run(inputs().mpId);
  } finally {
    db.close();
  }
  fs.writeFileSync(
    path.join(dir, 'exports.log'),
    run(process.execPath, [__filename, '--exports', dir, exportCopy], {
      cwd: server,
    }),
  );
  assert.deepEqual(rows(copy), afterFirst);
  assert.deepEqual(snapshot(source), before);
  const summary = {
    discovery: 'persisted real response replay',
    candidateCount: 26,
    selected: 5,
    verifiedOriginals: 2,
    unverifiedOriginals: 3,
    first: json(path.join(dir, 'first.json')).created,
    afterRestartCreated: json(path.join(dir, 'restart.json')).created,
    exports: json(path.join(dir, 'exports.json')),
    allOldColumnsPreserved: true,
    productionUnchanged: true,
    productionSourceEnabled: false,
    backup,
    copy,
    dir,
  };
  write(path.join(dir, 'result.json'), summary);
  console.log(JSON.stringify(summary));
}
const a = process.argv.slice(2);
(a[0] === '--worker'
  ? worker(a[1], a[2], a[3])
  : a[0] === '--exports'
    ? exportsWorker(a[1], a[2])
    : a.length === 0
      ? parent()
      : Promise.reject(Error('usage_gate'))
).catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
