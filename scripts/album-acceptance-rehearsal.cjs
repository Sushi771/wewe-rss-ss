// Replays a PRIVATE cassette of real official responses through the built provider.
// Source SQLite is opened read-only; every write/export occurs under private-data.
// This is persistence/export acceptance, never proof of current online acquisition.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { parseArgs } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const TARGET = 'MP_WXS_3895431412';
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const options =
  require.main === module
    ? parseArgs({
        options: {
          database: { type: 'string' },
          manifest: { type: 'string' },
          'runtime-root': { type: 'string' },
          worker: { type: 'string' },
          copy: { type: 'string' },
          output: { type: 'string' },
          'baseline-only': { type: 'boolean' },
          'expect-blocked': { type: 'boolean' },
          'self-test': { type: 'boolean' },
          live: { type: 'boolean' },
        },
      }).values
    : { 'runtime-root': process.env.ALBUM_QA_RUNTIME_ROOT };
const runtime = fs.realpathSync(
  options['runtime-root'] || path.resolve(__dirname, '..'),
);
const server = path.join(runtime, 'apps/server');
const serverRequire = createRequire(path.join(server, 'package.json'));
const built = path.join(server, 'dist/apps/server/src');
const privateRoot = path.join(runtime, 'private-data', 'album-loop-qa');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function checkPrivate(p) {
  assert(
    inside(privateRoot, path.resolve(p)),
    'REHEARSAL_WRITE_OUTSIDE_PRIVATE_ROOT',
  );
}
function run(exe, args, extra = {}) {
  const result = spawnSync(exe, args, {
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...extra,
  });
  if (result.error || result.status !== 0)
    throw new Error('CHILD_FAILED_CHECK_PRIVATE_LOG');
  return result.stdout;
}
function snapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    return Object.fromEntries(
      ['accounts', 'feeds', 'articles'].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
function summary(s) {
  return Object.fromEntries(
    Object.entries(s).map(([table, rows]) => [
      table,
      { count: rows.length, digest: hash(JSON.stringify(rows)) },
    ]),
  );
}
function preservation(before, after, strict = false, provenTimes = {}) {
  assert.deepEqual(after.accounts, before.accounts, 'ACCOUNT_CHANGED');
  let correctedUnverifiedListTimes = 0;
  const articles = new Map(after.articles.map((r) => [r.id, r]));
  for (const old of before.articles) {
    const row = articles.get(old.id);
    assert(row, 'OLD_ARTICLE_ID_LOST');
    for (const key of Object.keys(old)) {
      if (key === 'updated_at') continue;
      const proven = provenTimes[old.id];
      if (
        !strict &&
        key === 'publish_time' &&
        row[key] !== old[key] &&
        /^WX_\d{5,15}_\d+_[1-9]\d*$/.test(old.id) &&
        !old.content_html &&
        !old.verified_source_url &&
        row.content_html &&
        row.verified_source_url &&
        proven &&
        old[key] === proven.albumCreateTime &&
        row[key] === proven.ct &&
        Math.abs(proven.ct - old[key]) <= 60
      ) {
        correctedUnverifiedListTimes++;
        continue;
      }
      if (
        !strict &&
        key === 'last_body_status' &&
        !old.content_html &&
        row.content_html
      )
        continue;
      // Only empty cache/identity fields may be filled on the first import.
      if (
        !strict &&
        [
          'source_url',
          'verified_source_url',
          'content_html',
          'last_body_status',
          'last_body_retry',
          'pic_url',
        ].includes(key) &&
        !old[key]
      )
        continue;
      assert.deepEqual(row[key], old[key], `OLD_ARTICLE_FIELD_CHANGED:${key}`);
    }
  }
  assert.equal(after.feeds.length, before.feeds.length, 'FEED_COUNT_CHANGED');
  for (const old of before.feeds) {
    const row = after.feeds.find((r) => r.id === old.id);
    assert(row, 'OLD_FEED_LOST');
    for (const key of Object.keys(old)) {
      if (
        old.id === TARGET &&
        [
          'public_album_ids',
          'collection_channel',
          'local_directory',
          'sync_time',
          'update_time',
          'has_history',
          'last_collection_result',
          'updated_at',
        ].includes(key)
      )
        continue;
      assert.deepEqual(row[key], old[key], `OLD_FEED_FIELD_CHANGED:${key}`);
    }
  }
  if (strict)
    assert.equal(
      after.articles.length,
      before.articles.length,
      'REPEAT_CREATED_ARTICLES',
    );
  return {
    oldArticleIds: before.articles.length,
    lost: 0,
    protectedChanges: 0,
    correctedUnverifiedListTimes,
  };
}
function verifiedTimesFromCassette(manifestPath) {
  const manifest = json(manifestPath),
    root = path.dirname(manifestPath);
  const { canonicalArticleUrl } = require(
    path.join(built, 'collection/collection-format'),
  );
  const { articleIdentity, articlePublishTime } = require(
    path.join(built, 'collection/article-page'),
  );
  const listed = new Map(),
    proven = {};
  for (const entry of manifest.responses.filter((r) => r.kind === 'json')) {
    const bytes = fs.readFileSync(path.resolve(root, entry.file));
    assert.equal(hash(bytes), entry.sha256);
    for (const item of JSON.parse(bytes.toString('utf8')).getalbum_resp
      ?.article_list || [])
      listed.set(canonicalArticleUrl(item.url).id, item);
  }
  for (const entry of manifest.responses.filter((r) => r.kind === 'html')) {
    const bytes = fs.readFileSync(path.resolve(root, entry.file));
    assert.equal(hash(bytes), entry.sha256);
    const identity = articleIdentity(bytes.toString('utf8'));
    const ct = articlePublishTime(bytes.toString('utf8'));
    const item = listed.get(identity.id);
    assert(item && ct && identity.mpId === TARGET);
    assert.equal(identity.url, canonicalArticleUrl(item.url).url);
    proven[identity.id] = { ct, albumCreateTime: Number(item.create_time) };
  }
  return proven;
}
function cassette(manifestPath) {
  const manifest = json(manifestPath);
  assert.equal(manifest.mpId, TARGET, 'CASSETTE_TARGET_MISMATCH');
  assert(
    manifest.capturedAt &&
      Array.isArray(manifest.albumIds) &&
      manifest.albumIds.length,
  );
  assert(
    Array.isArray(manifest.responses) && manifest.responses.length,
    'CASSETTE_EMPTY',
  );
  const root = path.dirname(fs.realpathSync(manifestPath));
  const entries = manifest.responses.map((r) => {
    assert(
      typeof r.url === 'string' && ['json', 'html', 'image'].includes(r.kind),
    );
    const file = fs.realpathSync(path.resolve(root, r.file));
    assert(inside(root, file), 'CASSETTE_FILE_OUTSIDE_MANIFEST_DIRECTORY');
    const bytes = fs.readFileSync(file);
    assert.equal(hash(bytes), r.sha256, 'CASSETTE_HASH_MISMATCH');
    return { ...r, bytes };
  });
  // Every request must match an exact saved official URL and (album) cursor.
  const axios = serverRequire('axios');
  let axiosCalls = 0,
    imageCalls = 0,
    blockedCalls = 0;
  const find = (raw, params, kind) => {
    const url = new URL(raw);
    for (const [key, value] of Object.entries(params || {}))
      url.searchParams.set(key, String(value));
    url.searchParams.sort();
    return entries.find((r) => {
      if (!kind.includes(r.kind)) return false;
      const expected = new URL(r.url);
      expected.searchParams.sort();
      return expected.href === url.href;
    });
  };
  axios.get = async (url, config = {}) => {
    const entry = find(url, config.params, ['json', 'html']);
    if (!entry) {
      blockedCalls++;
      throw new Error('CASSETTE_REQUEST_NOT_CAPTURED');
    }
    axiosCalls++;
    return {
      status: 200,
      data:
        entry.kind === 'json'
          ? JSON.parse(entry.bytes.toString('utf8'))
          : entry.bytes.toString('utf8'),
    };
  };
  global.fetch = async (raw) => {
    const entry = find(String(raw), {}, ['image']);
    if (!entry) {
      blockedCalls++;
      throw new Error('CASSETTE_IMAGE_NOT_CAPTURED');
    }
    imageCalls++;
    return new Response(entry.bytes, {
      status: 200,
      headers: {
        'content-type': entry.contentType,
        'content-length': String(entry.bytes.length),
      },
    });
  };
  // Defense in depth: a changed network adapter must not escape replay isolation.
  for (const name of ['node:http', 'node:https']) {
    const module = require(name);
    for (const operation of ['request', 'get'])
      module[operation] = () => {
        blockedCalls++;
        throw new Error('REPLAY_NETWORK_DISABLED');
      };
  }
  const { canonicalArticleUrl } = require(
    path.join(built, 'collection/collection-format'),
  );
  const identities = new Set();
  for (const entry of entries.filter((r) => r.kind === 'json')) {
    const page = JSON.parse(entry.bytes.toString('utf8'));
    for (const article of page.getalbum_resp?.article_list || []) {
      const identity = canonicalArticleUrl(article.url);
      assert.equal(identity.mpId, TARGET);
      identities.add(identity.id);
    }
  }
  assert(identities.size >= 5, 'LESS_THAN_FIVE_REAL_IDENTITIES');
  return {
    manifest,
    identities,
    counts: () => ({ axiosCalls, imageCalls, blockedCalls }),
  };
}
function app(prisma, vault) {
  const { CollectionService } = require(
    path.join(built, 'collection/collection.service'),
  );
  const { TrpcService } = require(path.join(built, 'trpc/trpc.service'));
  const { TrpcRouter } = require(path.join(built, 'trpc/trpc.router'));
  const config = {
    get: (key) =>
      ({
        platform: { url: '' },
        feed: { updateDelayTime: 0, obsidianPath: vault },
        database: { type: 'sqlite' },
      })[key],
  };
  const collection = new CollectionService(prisma);
  const trpc = new TrpcService(prisma, config, {}, collection);
  const router = new TrpcRouter(trpc, prisma, config, {}, collection);
  return {
    collection,
    trpc,
    router,
    config,
    caller: router.appRouter.createCaller({ errorMsg: null, isLocal: true }),
  };
}
async function worker() {
  checkPrivate(options.copy);
  checkPrivate(options.output);
  process.env.DATABASE_URL = `file:${options.copy.replace(/\\/g, '/')}`;
  delete process.env.PRIVATE_ONLINE_MODE;
  const liveRequests = [];
  if (options.live && options.worker === 'first') {
    const folder = path.join(path.dirname(options.output), 'live-inputs');
    fs.mkdirSync(folder);
    const saveLive = (url, kind, bytes, status, contentType) => {
      const sha256 = hash(bytes),
        file = `${sha256}.${kind === 'image' ? 'bin' : kind}`;
      fs.writeFileSync(path.join(folder, file), bytes);
      liveRequests.push({ url, kind, file, sha256, status, contentType });
      write(path.join(folder, 'manifest.json'), {
        mpId: TARGET,
        albumIds: json(options.manifest).albumIds,
        capturedAt: new Date().toISOString(),
        responses: liveRequests,
      });
    };
    const axios = serverRequire('axios'),
      originalGet = axios.get;
    axios.get = async (url, config = {}) => {
      const response = await originalGet(url, config);
      const full = new URL(url);
      for (const [k, v] of Object.entries(config.params || {}))
        full.searchParams.set(k, String(v));
      const isHtml = typeof response.data === 'string';
      saveLive(
        full.toString(),
        isHtml ? 'html' : 'json',
        Buffer.from(isHtml ? response.data : JSON.stringify(response.data)),
        response.status,
      );
      return response;
    };
    const originalFetch = global.fetch;
    global.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const bytes = Buffer.from(await response.clone().arrayBuffer());
      saveLive(
        String(args[0]),
        'image',
        bytes,
        response.status,
        response.headers.get('content-type'),
      );
      return response;
    };
  }
  const replay =
    options.live && options.worker === 'first'
      ? {
          manifest: json(options.manifest),
          counts: () => ({
            mode: 'actual online provider',
            requests: liveRequests.length,
            statuses: liveRequests.map((r) => r.status),
            originals: liveRequests.filter((r) => r.kind === 'html').length,
            images: liveRequests.filter((r) => r.kind === 'image').length,
          }),
        }
      : cassette(options.manifest);
  const { PrismaClient } = serverRequire('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  try {
    const { trpc, router, caller, config } = app(
      prisma,
      path.join(path.dirname(options.copy), 'vault'),
    );
    if (options.worker !== 'export') {
      const result =
        options.worker === 'first'
          ? await trpc.collectPublicAlbums({
              mpId: TARGET,
              albumIds: replay.manifest.albumIds,
            })
          : await trpc.refreshMpArticlesAndUpdateFeed(
              TARGET,
              1,
              options.worker === 'scheduled' ? 'scheduled' : 'local-manual',
            );
      assert.equal(result.source, 'public-album');
      assert.equal(result.coverage, 'selected-albums');
      assert.equal(result.complete, false);
      if (options.worker !== 'first')
        assert.equal(result.created, 0, 'REPEAT_NOT_ZERO_CREATED');
      write(options.output, {
        source: result.source,
        coverage: result.coverage,
        articles: result.articles,
        created: result.created,
        updated: result.updated,
        pages: result.pages,
        bodyFetch: result.bodyFetch,
        bodyCache: result.bodyCache,
        correctedPublishTimes: result.correctedPublishTimes,
        network: replay.counts(),
        capturedAt: replay.manifest.capturedAt,
        ...(options.live ? { observedAt: new Date().toISOString() } : {}),
        boundary: options.live
          ? 'actual online provider on isolated SQLite; no production write'
          : 'offline real-response replay; no live subscription proof',
      });
      return;
    }
    const articles = await prisma.article.findMany({ where: { mpId: TARGET } });
    const { canonicalArticleUrl } = require(
      path.join(built, 'collection/collection-format'),
    );
    assert(
      articles.every((row) =>
        replay.identities.has(
          canonicalArticleUrl(row.sourceUrl || row.verifiedSourceUrl).id,
        ),
      ),
      'EXPORT_SCOPE_OUTSIDE_ALBUM',
    );
    const { load } = serverRequire('cheerio');
    const { decodeInlineImage } = require(
      path.join(built, 'collection/image-fetch'),
    );
    let markdownBodies = 0,
      obsidianComplete = 0,
      verifiedAttachments = 0,
      verifiedAttachmentFiles = 0;
    const failures = [];
    for (const row of articles) {
      if (!row.contentHtml) {
        failures.push('body_missing');
        continue;
      }
      const browser = await caller.article.exportMarkdown(row.id);
      assert(browser.markdown.length > 30);
      markdownBodies++;
      // Expected bytes come from the persisted data URI, not the export itself.
      const images = load(row.contentHtml)('img[src]').toArray();
      const $ = load(row.contentHtml);
      const inlineHashes = images
        .map((n) => $(n).attr('src'))
        .filter((src) => src.startsWith('data:'))
        .map((src) => hash(decodeInlineImage(src).bytes));
      const normalizedUrl = (raw) => {
        const u = new URL(raw);
        u.searchParams.sort();
        return u.href;
      };
      const sourceHashes = $('img')
        .toArray()
        .map((n) => {
          const src = $(n).attr('src') || '';
          if (src.startsWith('data:'))
            return hash(decodeInlineImage(src).bytes);
          const remote = $(n).attr('data-src') || src;
          const entry = replay.manifest.responses.find(
            (r) =>
              r.kind === 'image' &&
              normalizedUrl(r.url) === normalizedUrl(remote),
          );
          return entry?.sha256;
        });
      try {
        const saved = await caller.article.saveToObsidian(row.id);
        const markdown = fs.readFileSync(saved.path, 'utf8');
        const refs = [
          ...new Set(
            markdown.match(
              /attachments\/image_[a-f0-9]+\.(?:png|jpe?g|gif|webp)/g,
            ) || [],
          ),
        ];
        const hashes = refs.map((ref) =>
          hash(fs.readFileSync(path.join(path.dirname(saved.path), ref))),
        );
        for (const digest of inlineHashes)
          assert(hashes.includes(digest), 'ATTACHMENT_BYTES_CHANGED');
        for (const digest of sourceHashes)
          assert(
            digest && hashes.includes(digest),
            'REMOTE_ATTACHMENT_BYTES_CHANGED',
          );
        verifiedAttachments += inlineHashes.length;
        verifiedAttachmentFiles += refs.length;
        obsidianComplete++;
      } catch {
        failures.push('obsidian_incomplete');
      }
    }
    const { FeedsService } = require(path.join(built, 'feeds/feeds.service'));
    const rss = await new FeedsService(prisma, trpc, config).handleGenerateFeed(
      {
        id: TARGET,
        type: 'rss',
        limit: 5000,
        page: 1,
        mode: 'fulltext',
      },
    );
    fs.writeFileSync(
      path.join(path.dirname(options.output), 'album.rss'),
      rss.content,
    );
    const rssItems = load(rss.content, { xmlMode: true })('item').length;
    assert.equal(rssItems, articles.length, 'RSS_ARTICLE_COUNT_CHANGED');
    const folder = path.join(path.dirname(options.output), 'offline');
    const staged = await router.buildOfflineFeedDirectory(TARGET, folder);
    const { OfflineExportController } = require(
      path.join(built, 'offline-export.controller'),
    );
    const zip = path.join(path.dirname(options.output), 'album.zip');
    const response = fs.createWriteStream(zip, { flags: 'wx' });
    response.headersSent = false;
    response.setHeader = () => {};
    response.status = (code) => {
      throw new Error(`ZIP_HTTP_ERROR:${code}`);
    };
    await new OfflineExportController(router).feedZip(TARGET, response);
    const zipResult = JSON.parse(
      run(process.env.SQLITE_BACKUP_PYTHON || 'python', [
        path.join(__dirname, 'album-acceptance-zip.py'),
        zip,
        folder,
      ]),
    );
    write(options.output, {
      scope: 'selected official album only; separate narrowed copy',
      articles: articles.length,
      rssItems,
      markdownBodies,
      obsidianComplete,
      verifiedInlineAttachments: verifiedAttachments,
      verifiedAttachmentFiles,
      offlineComplete: staged.complete,
      offlineIncomplete: staged.incomplete.length,
      zip: zipResult,
      failures,
      network: replay.counts(),
      capturedAt: replay.manifest.capturedAt,
    });
  } finally {
    await prisma.$disconnect();
  }
}
async function parent() {
  if (!options.database)
    throw new Error(
      'USE --database <absolute source SQLite> --manifest <private cassette> --runtime-root <built repo>',
    );
  const source = fs.realpathSync(options.database);
  const before = snapshot(source);
  const root = path.join(privateRoot, crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  checkPrivate(root);
  const baseline = summary(before);
  write(path.join(root, 'baseline-summary.json'), baseline);
  const backup = JSON.parse(
    run(process.env.SQLITE_BACKUP_PYTHON || 'python', [
      path.join(server, 'scripts/backup-sqlite.py'),
      '--database',
      source,
      '--backup-root',
      path.join(root, 'backups'),
    ]),
  );
  assert.equal(backup.integrityCheck, 'ok');
  assert.equal(hash(fs.readFileSync(backup.backup)), backup.sha256);
  assert.deepEqual(snapshot(backup.backup), before, 'BACKUP_BASELINE_MISMATCH');
  const copy = path.join(root, 'rehearsal.db');
  fs.copyFileSync(backup.backup, copy, fs.constants.COPYFILE_EXCL);
  if (options['baseline-only']) {
    assert.deepEqual(snapshot(source), before, 'PRODUCTION_CHANGED');
    const report = {
      phase: 'read-only baseline and consistent backup',
      baseline,
      productionUnchanged: true,
      integrity: 'ok',
      reportDirectory: root,
    };
    write(path.join(root, 'result.json'), report);
    console.log(JSON.stringify(report));
    return;
  }
  assert(options.manifest, 'PRIVATE_CASSETTE_REQUIRED');
  const env = {
    ...process.env,
    DATABASE_URL: `file:${copy.replace(/\\/g, '/')}`,
  };
  run(
    process.execPath,
    [
      serverRequire.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      path.join(server, 'prisma/schema.prisma'),
    ],
    { cwd: server, env },
  );
  const migrated = snapshot(copy);
  const provenTimes = verifiedTimesFromCassette(
    fs.realpathSync(options.manifest),
  );
  // Migration must preserve all pre-existing columns before any provider input.
  preservation(before, migrated);
  const stages = [];
  let previous = migrated;
  for (const stage of ['first', 'repeat', 'scheduled']) {
    const output = path.join(root, `${stage}.json`);
    const result = spawnSync(
      process.execPath,
      [
        __filename,
        '--worker',
        stage,
        '--copy',
        copy,
        '--output',
        output,
        '--manifest',
        fs.realpathSync(options.manifest),
        '--runtime-root',
        runtime,
        ...(options.live && stage === 'first' ? ['--live'] : []),
      ],
      {
        cwd: server,
        env,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(root, `${stage}.log`),
      `${result.stdout || ''}\n${result.stderr || ''}`,
    );
    if (stage === 'first' && result.status !== 0 && options['expect-blocked']) {
      const after = snapshot(copy);
      preservation(migrated, after, true);
      assert.deepEqual(
        after.articles,
        migrated.articles,
        'FAILED_BATCH_ARTICLES_CHANGED',
      );
      const oldFeed = migrated.feeds.find((f) => f.id === TARGET);
      const newFeed = after.feeds.find((f) => f.id === TARGET);
      for (const key of [
        'public_album_ids',
        'collection_channel',
        'local_directory',
        'has_history',
      ])
        assert.deepEqual(
          newFeed[key],
          oldFeed[key],
          'FAILED_BATCH_BINDING_CHANGED',
        );
      assert.equal(JSON.parse(newFeed.last_collection_result).status, 'failed');
      assert.deepEqual(snapshot(source), before, 'PRODUCTION_CHANGED');
      const report = {
        boundary:
          'offline real-response replay with incomplete/challenged inputs; not a live request',
        accepted: false,
        blockedBatch: true,
        articleWrites: 0,
        bindingWrites: 0,
        baseline,
        productionUnchanged: true,
        reportDirectory: root,
        outstanding: [
          'successful full-album body input',
          'repeat zero-created',
          'HTTP service restart/manual update',
          'album exports',
          'natural increment',
        ],
      };
      write(path.join(root, 'result.json'), report);
      console.log(JSON.stringify(report));
      return;
    }
    assert.equal(result.status, 0, `STAGE_FAILED:${stage}:CHECK_PRIVATE_LOG`);
    const current = snapshot(copy);
    const protectedFields = preservation(
      stage === 'first' ? migrated : previous,
      current,
      stage !== 'first',
      provenTimes,
    );
    stages.push({ stage, ...json(output), protection: protectedFields });
    previous = current;
  }
  // Narrow only a second export copy. Never delete rows from the source or rehearsal.
  const exportBackup = JSON.parse(
    run(process.env.SQLITE_BACKUP_PYTHON || 'python', [
      path.join(server, 'scripts/backup-sqlite.py'),
      '--database',
      copy,
      '--backup-root',
      path.join(root, 'export-backups'),
    ]),
  );
  const scoped = path.join(root, 'export-scope.db');
  fs.copyFileSync(exportBackup.backup, scoped, fs.constants.COPYFILE_EXCL);
  const replay = cassette(options.manifest);
  const { canonicalArticleUrl } = require(
    path.join(built, 'collection/collection-format'),
  );
  const scopedDb = new DatabaseSync(scoped);
  try {
    for (const row of scopedDb
      .prepare(
        'SELECT id,source_url,verified_source_url FROM articles WHERE mp_id=?',
      )
      .all(TARGET)) {
      let included = false;
      try {
        included = replay.identities.has(
          canonicalArticleUrl(row.source_url || row.verified_source_url).id,
        );
      } catch {
        /* legacy outside album */
      }
      if (!included)
        scopedDb.prepare('DELETE FROM articles WHERE id=?').run(row.id);
    }
  } finally {
    scopedDb.close();
  }
  const output = path.join(root, 'exports.json');
  const exported = spawnSync(
    process.execPath,
    [
      __filename,
      '--worker',
      'export',
      '--copy',
      scoped,
      '--output',
      output,
      '--manifest',
      fs.realpathSync(options.manifest),
      '--runtime-root',
      runtime,
    ],
    {
      cwd: server,
      env,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(root, 'exports.log'),
    `${exported.stdout || ''}\n${exported.stderr || ''}`,
  );
  assert.equal(exported.status, 0, 'EXPORT_FAILED:CHECK_PRIVATE_LOG');
  assert.deepEqual(snapshot(source), before, 'PRODUCTION_CHANGED');
  preservation(migrated, snapshot(copy), false, provenTimes);
  const report = {
    boundary: options.live
      ? 'first actual online provider update on isolated SQLite; repeats/exports replay saved inputs; no natural new publication proof'
      : 'real saved responses replayed offline; not natural new publication proof',
    restart:
      'separate Node process persistence only; HTTP service restart remains unverified',
    baseline,
    stages,
    exports: json(output),
    productionUnchanged: true,
    reportDirectory: root,
  };
  write(path.join(root, 'result.json'), report);
  console.log(JSON.stringify(report));
}
function selfTest() {
  const before = {
    accounts: [{ id: 'account', token: 'private synthetic' }],
    feeds: [{ id: TARGET, collection_channel: null, mp_name: 'target' }],
    articles: [
      {
        id: 'legacy',
        mp_id: TARGET,
        publish_time: 123,
        content_html: '<p>cached</p>',
        pic_url: 'old',
        read_count: 0,
        like_count: 4,
        metrics: '{"read":{"value":0}}',
        source_url: null,
        verified_source_url: null,
        created_at: 100,
        updated_at: 100,
      },
    ],
  };
  const cloned = () => structuredClone(before);
  preservation(before, cloned(), true);
  let cases = 0;
  for (const [field, value] of [
    ['id', 'new'],
    ['publish_time', 124],
    ['content_html', null],
    ['pic_url', ''],
    ['read_count', null],
    ['like_count', 0],
    ['metrics', '{}'],
    ['created_at', 101],
  ]) {
    const changed = cloned();
    changed.articles[0][field] = value;
    assert.throws(() => preservation(before, changed));
    cases++;
  }
  const filled = cloned();
  filled.articles[0].verified_source_url = 'proven';
  preservation(before, filled);
  assert.throws(() => preservation(before, filled, true));
  cases++;
  const account = cloned();
  account.accounts[0].token = 'changed';
  assert.throws(() => preservation(before, account));
  cases++;
  const dup = cloned();
  dup.articles.push({ ...dup.articles[0], id: 'duplicate' });
  assert.throws(() => preservation(before, dup, true));
  cases++;
  const unverified = cloned();
  Object.assign(unverified.articles[0], {
    id: 'WX_3895431412_2247499999_1',
    content_html: null,
    verified_source_url: null,
    publish_time: 1790000000,
  });
  const corrected = structuredClone(unverified);
  Object.assign(corrected.articles[0], {
    content_html: '<p>actual</p>',
    verified_source_url: 'proven',
    publish_time: 1790000039,
  });
  const proof = {
    WX_3895431412_2247499999_1: { ct: 1790000039, albumCreateTime: 1790000000 },
  };
  assert.equal(
    preservation(unverified, corrected, false, proof)
      .correctedUnverifiedListTimes,
    1,
  );
  assert.throws(() => preservation(unverified, corrected, true, proof));
  cases++;
  const wrongCt = structuredClone(corrected);
  wrongCt.articles[0].publish_time++;
  assert.throws(() => preservation(unverified, wrongCt, false, proof));
  cases++;
  const trusted = structuredClone(unverified);
  trusted.articles[0].verified_source_url = 'old-proof';
  assert.throws(() => preservation(trusted, corrected, false, proof));
  cases++;
  const cached = structuredClone(unverified);
  cached.articles[0].content_html = '<p>old</p>';
  assert.throws(() => preservation(cached, corrected, false, proof));
  cases++;
  console.log(
    JSON.stringify({
      selfTest: 'protection assertions only',
      negativeCases: cases,
      passed: true,
    }),
  );
}
module.exports = {
  cassette,
  snapshot,
  preservation,
  summary,
  inside,
  verifiedTimesFromCassette,
};
if (require.main === module)
  Promise.resolve()
    .then(() =>
      options['self-test'] ? selfTest() : options.worker ? worker() : parent(),
    )
    .catch((error) => {
      if (options.output)
        write(options.output + '.failure.json', {
          name: error.name,
          message: error.message,
          stack: error.stack,
        });
      // Deliberately suppress upstream errors/URLs and raw records from stdout.
      console.error(
        error instanceof assert.AssertionError
          ? error.message
          : 'REHEARSAL_FAILED_CHECK_PRIVATE_LOG',
      );
      process.exitCode = 1;
    });
