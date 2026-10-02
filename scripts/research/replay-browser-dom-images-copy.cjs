#!/usr/bin/env node
'use strict';

// Offline, copy-only rehearsal for one owner-confirmed article and its
// completed private image cache. This file has no live collection path.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { createRequire } = require('node:module');
const {
  TARGET_ARTICLE_ID,
  TARGET_MP_ID,
  EXPECTED_DOM_SHA256,
  MAX_IMAGE_BYTES,
  validateDomEvidence,
  extractAllowedImageUrls,
  validateImageSignature,
} = require('./collect-browser-dom-images-once.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'apps/server');
const BUILT = path.join(SERVER, 'dist/apps/server/src');
const localRequire = createRequire(path.join(SERVER, 'package.json'));
const PRIVATE_BASE = path.join(
  ROOT,
  'private-data/single-account-update-20260930',
);
const PRODUCTION_DB = path.join(SERVER, 'data/wewe-rss.db');
const HEX_SHA = /^[a-f0-9]{64}$/;
const IMAGE_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

function fail(code) {
  throw new Error(code);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys)
  );
}

function readRegularFile(file, maxBytes, code) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(code);
  }
  if (!stat.isFile() || stat.size > maxBytes) fail(code);
  try {
    return fs.readFileSync(file);
  } catch {
    fail(code);
  }
}

function readJson(file, maxBytes, code) {
  try {
    return JSON.parse(readRegularFile(file, maxBytes, code).toString('utf8'));
  } catch {
    fail(code);
  }
}

function builtModule(name) {
  const file = path.join(BUILT, `collection/${name}.js`);
  if (!fs.existsSync(file)) fail('SERVER_BUILD_REQUIRED');
  try {
    return require(file);
  } catch {
    fail('SERVER_BUILD_MODULE_FAILED');
  }
}

function permittedTestHash(value) {
  if (value === undefined) return undefined;
  if (!process.env.NODE_TEST_CONTEXT || !HEX_SHA.test(value))
    fail('TEST_EVIDENCE_OVERRIDE_FORBIDDEN');
  return value;
}

/** Verify the complete collector output against the fixed DOM before loading bytes. */
function loadVerifiedImageManifest(options = {}) {
  const baseDir = options.baseDir || PRIVATE_BASE;
  const testExpectedHash = permittedTestHash(options.testExpectedHash);
  const html = readRegularFile(
    path.join(baseDir, 'official-browser-dom.html'),
    10 * 1024 * 1024,
    'DOM_FILE_INVALID',
  ).toString('utf8');
  const observation = readJson(
    path.join(baseDir, 'official-browser-observation.json'),
    64 * 1024,
    'OBSERVATION_INVALID',
  );
  const selection = readJson(
    path.join(baseDir, 'official-original-selection.json'),
    64 * 1024,
    'SELECTION_INVALID',
  );
  // Collector verification fixes the article id, MP id, page identity and DOM
  // hash. The test override is unavailable through the CLI.
  const dom = validateDomEvidence({
    domHtml: html,
    observation,
    selection,
    testExpectedHash,
  });
  if (
    dom.articleId !== TARGET_ARTICLE_ID ||
    dom.mpId !== TARGET_MP_ID ||
    selection.candidate?.id !== TARGET_ARTICLE_ID ||
    selection.candidate?.mpId !== TARGET_MP_ID
  )
    fail('ARTICLE_IDENTITY_MISMATCH');

  const expected = extractAllowedImageUrls(html);
  const cacheDir = path.join(baseDir, 'image-cache');
  const manifest = readJson(
    path.join(cacheDir, 'manifest.json'),
    2 * 1024 * 1024,
    'IMAGE_MANIFEST_INVALID',
  );
  const marker = readJson(
    path.join(cacheDir, 'image-collector-marker.json'),
    64 * 1024,
    'IMAGE_MARKER_INVALID',
  );
  const manifestKeys = [
    'articleId',
    'domSha256',
    'completedAt',
    'totalOccurrences',
    'uniqueCount',
    'images',
    'occurrences',
    'manifestSha256',
  ];
  const markerKeys = [
    'status',
    'startedAt',
    'completedAt',
    'articleId',
    'domSha256',
    'totalOccurrences',
    'uniqueCount',
    'manifestSha256',
  ];
  if (
    !exactKeys(manifest, manifestKeys) ||
    !exactKeys(marker, markerKeys) ||
    marker.status !== 'completed' ||
    manifest.articleId !== dom.articleId ||
    marker.articleId !== dom.articleId ||
    manifest.domSha256 !== dom.domSha256 ||
    marker.domSha256 !== dom.domSha256 ||
    !Number.isFinite(Date.parse(manifest.completedAt)) ||
    marker.completedAt !== manifest.completedAt ||
    !Number.isFinite(Date.parse(marker.startedAt)) ||
    manifest.totalOccurrences !== expected.totalOccurrences ||
    marker.totalOccurrences !== expected.totalOccurrences ||
    manifest.uniqueCount !== expected.uniqueCount ||
    marker.uniqueCount !== expected.uniqueCount ||
    !Array.isArray(manifest.images) ||
    !Array.isArray(manifest.occurrences) ||
    manifest.images.length !== expected.uniqueCount ||
    manifest.occurrences.length !== expected.totalOccurrences ||
    !HEX_SHA.test(manifest.manifestSha256) ||
    marker.manifestSha256 !== manifest.manifestSha256
  )
    fail('IMAGE_MANIFEST_MISMATCH');

  const unsigned = Object.fromEntries(
    manifestKeys.slice(0, -1).map((key) => [key, manifest[key]]),
  );
  if (sha256(JSON.stringify(unsigned)) !== manifest.manifestSha256)
    fail('IMAGE_MANIFEST_HASH_MISMATCH');

  const imageDir = path.join(cacheDir, 'images');
  if (!fs.lstatSync(imageDir).isDirectory()) fail('IMAGE_DIRECTORY_INVALID');
  const cachedImages = [];
  for (const [index, image] of manifest.images.entries()) {
    if (
      !exactKeys(image, [
        'url',
        'sha256',
        'mimeType',
        'size',
        'fileName',
        'path',
      ]) ||
      image.url !== expected.uniqueUrls[index] ||
      !HEX_SHA.test(image.sha256) ||
      !IMAGE_MIME.has(image.mimeType) ||
      !Number.isSafeInteger(image.size) ||
      image.size <= 0 ||
      image.size > MAX_IMAGE_BYTES ||
      image.fileName !== image.sha256 + IMAGE_MIME.get(image.mimeType) ||
      image.path !== `images/${image.fileName}`
    )
      fail('IMAGE_RECORD_MISMATCH');
    const bytes = readRegularFile(
      path.join(imageDir, image.fileName),
      MAX_IMAGE_BYTES,
      'IMAGE_FILE_INVALID',
    );
    if (
      bytes.length !== image.size ||
      sha256(bytes) !== image.sha256 ||
      !validateImageSignature(bytes, image.mimeType)
    )
      fail('IMAGE_BYTES_INVALID');
    cachedImages.push({
      url: image.url,
      sha256: image.sha256,
      mimeType: image.mimeType,
      bytes,
    });
  }
  const byUrl = new Map(manifest.images.map((item) => [item.url, item]));
  for (const [index, item] of manifest.occurrences.entries()) {
    const source = expected.occurrences[index];
    const image = byUrl.get(source.requestUrl);
    if (
      !exactKeys(item, [
        'index',
        'rawUrl',
        'requestUrl',
        'sha256',
        'fileName',
      ]) ||
      item.index !== source.index ||
      item.rawUrl !== source.rawUrl ||
      item.requestUrl !== source.requestUrl ||
      !image ||
      item.sha256 !== image.sha256 ||
      item.fileName !== image.fileName
    )
      fail('IMAGE_OCCURRENCE_MISMATCH');
  }

  const candidate = selection.candidate;
  const evidence = {
    source: 'owner-confirmed-browser-dom',
    observationKind: 'owner-confirmed-browser-dom',
    capturedAt: observation.observedAt,
    sha256: observation.sha256,
    rawUrl: selection.rawUrl,
  };
  const { prepareBrowserDomWithImagesReplay } = builtModule(
    'browser-dom-adapter',
  );
  const replay = prepareBrowserDomWithImagesReplay(
    candidate,
    html,
    evidence,
    cachedImages,
    { verifiedAt: manifest.completedAt },
  );
  if (
    replay.page.articles.length !== 1 ||
    replay.page.articles[0].id !== TARGET_ARTICLE_ID ||
    replay.page.articles[0].mpId !== TARGET_MP_ID ||
    replay.verified.article.publishTime !==
      observation.publishTimeFromBrowserDOM ||
    replay.verified.imageProvenance.inlinedImagesCount !==
      expected.totalOccurrences ||
    replay.verified.imageProvenance.distinctImagesCount !==
      expected.uniqueCount ||
    replay.unarchivedImages !== 0 ||
    replay.imagesComplete !== true ||
    replay.networkRequests !== 0
  )
    fail('IMAGE_REPLAY_MISMATCH');
  return {
    replay,
    counts: {
      occurrences: expected.totalOccurrences,
      unique: expected.uniqueCount,
    },
    manifestSha256: manifest.manifestSha256,
  };
}

function installNetworkGuard() {
  const http = require('node:http');
  const https = require('node:https');
  const old = {
    httpGet: http.get,
    httpRequest: http.request,
    httpsGet: https.get,
    httpsRequest: https.request,
    fetch: global.fetch,
  };
  let blocked = 0;
  const deny = () => {
    blocked++;
    fail('NETWORK_FORBIDDEN_IN_IMAGE_COPY_REHEARSAL');
  };
  http.get = http.request = https.get = https.request = deny;
  global.fetch = deny;
  return {
    count: () => blocked,
    restore: () => {
      http.get = old.httpGet;
      http.request = old.httpRequest;
      https.get = old.httpsGet;
      https.request = old.httpsRequest;
      global.fetch = old.fetch;
    },
  };
}

function snapshotTables(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
      fail('SQLITE_INTEGRITY_FAILED');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      fail('SQLITE_FOREIGN_KEYS_FAILED');
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    return Object.fromEntries(
      names.map((name) => [
        name,
        db
          .prepare(
            `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
          )
          .all(),
      ]),
    );
  } finally {
    db.close();
  }
}

function assertOldRowsUnchanged(before, after) {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const [table, rows] of Object.entries(before)) {
    if (table !== 'articles') {
      assert.deepEqual(after[table], rows, `${table.toUpperCase()}_MODIFIED`);
      continue;
    }
    const current = new Map(after.articles.map((row) => [row.id, row]));
    for (const row of rows) {
      assert.deepEqual(current.get(row.id), row, 'OLD_ARTICLE_MODIFIED');
    }
  }
}

/** The CLI never accepts a database path; tests can inject a synthetic one. */
async function runImageCopyRehearsal(options = {}) {
  if (options.sourceDb && !process.env.NODE_TEST_CONTEXT)
    fail('TEST_DATABASE_OVERRIDE_FORBIDDEN');
  const guard = installNetworkGuard();
  const oldEnv = {
    database: process.env.DATABASE_URL,
    scheduled: process.env.DISABLE_SCHEDULED_UPDATES,
    privateMode: process.env.PRIVATE_ONLINE_MODE,
  };
  let prisma;
  try {
    // Every image and every source occurrence is verified before SQLite opens.
    const loaded = loadVerifiedImageManifest(options);
    const sourceDb = fs.realpathSync(options.sourceDb || PRODUCTION_DB);
    const sourceHash = sha256(fs.readFileSync(sourceDb));
    // A main-file hash alone misses committed SQLite WAL changes. Compare
    // every logical source row as well before claiming the source is intact.
    const sourceBefore = snapshotTables(sourceDb);
    const baseDir = fs.realpathSync(options.baseDir || PRIVATE_BASE);
    const trialDir = fs.mkdtempSync(path.join(baseDir, 'image-replay-trial-'));
    const copyDb = path.join(trialDir, 'trial.db');
    const source = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      await backup(source, copyDb);
    } finally {
      source.close();
    }
    if (fs.realpathSync(copyDb).toLowerCase() === sourceDb.toLowerCase())
      fail('COPY_IS_SOURCE_DATABASE');
    fs.writeFileSync(
      copyDb + '.browser-dom-replay.json',
      JSON.stringify({
        mode: 'owner-confirmed-browser-dom',
        sourceDatabase: sourceDb,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const before = snapshotTables(copyDb);
    if (before.articles.some((row) => row.id === TARGET_ARTICLE_ID))
      fail('TARGET_ALREADY_IN_SOURCE_DATABASE');
    process.env.DATABASE_URL = `file:${copyDb.replace(/\\/g, '/')}`;
    process.env.DISABLE_SCHEDULED_UPDATES = '1';
    delete process.env.PRIVATE_ONLINE_MODE;
    const { PrismaClient } = localRequire('@prisma/client');
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    const { CollectionService } = builtModule('collection.service');
    const collection = new CollectionService(prisma);
    const first = await collection.replayBrowserDomUpdate(
      TARGET_MP_ID,
      loaded.replay,
    );
    assert.equal(first.created, 1, 'FIRST_PASS_CREATE_COUNT_INVALID');
    assert.equal(first.updated, 0, 'FIRST_PASS_UPDATE_COUNT_INVALID');
    assert.equal(first.unarchivedImages, 0, 'FIRST_PASS_IMAGES_INCOMPLETE');
    const afterFirst = snapshotTables(copyDb);
    assertOldRowsUnchanged(before, afterFirst);
    assert.equal(
      afterFirst.articles.length,
      before.articles.length + 1,
      'ARTICLE_COUNT_INVALID',
    );
    const inserted = afterFirst.articles.find(
      (row) => row.id === TARGET_ARTICLE_ID,
    );
    assert(inserted, 'INSERTED_ARTICLE_MISSING');
    assert.equal(
      inserted.content_html,
      loaded.replay.page.articles[0].contentHtml,
      'INLINE_CONTENT_CHANGED',
    );
    const expectedArticle = loaded.replay.page.articles[0];
    assert.equal(inserted.mp_id, expectedArticle.mpId, 'ARTICLE_MP_CHANGED');
    assert.equal(
      inserted.title,
      expectedArticle.title,
      'ARTICLE_TITLE_CHANGED',
    );
    assert.equal(
      inserted.publish_time,
      expectedArticle.publishTime,
      'ARTICLE_PUBLISH_TIME_CHANGED',
    );
    assert.equal(
      inserted.source_url,
      expectedArticle.url,
      'ARTICLE_SOURCE_URL_CHANGED',
    );
    assert.equal(
      inserted.verified_source_url,
      expectedArticle.url,
      'ARTICLE_VERIFIED_URL_CHANGED',
    );
    assert.equal(
      inserted.pic_url,
      expectedArticle.picUrl,
      'ARTICLE_PIC_CHANGED',
    );
    assert.equal(inserted.last_body_status, 'available');
    const second = await collection.replayBrowserDomUpdate(
      TARGET_MP_ID,
      loaded.replay,
    );
    assert.equal(second.created, 0, 'SECOND_PASS_CREATED_ARTICLE');
    assert.equal(second.updated, 0, 'SECOND_PASS_UPDATED_ARTICLE');
    const afterSecond = snapshotTables(copyDb);
    assert.deepEqual(afterSecond, afterFirst, 'SECOND_PASS_MODIFIED_ROWS');
    if (sha256(fs.readFileSync(sourceDb)) !== sourceHash)
      fail('SOURCE_DATABASE_CHANGED_DURING_REHEARSAL');
    assert.deepEqual(
      snapshotTables(sourceDb),
      sourceBefore,
      'SOURCE_DATABASE_LOGICAL_CHANGE',
    );
    if (guard.count() !== 0) fail('NETWORK_ATTEMPT_DETECTED');
    const result = {
      success: true,
      offline: true,
      copyOnly: true,
      articleId: TARGET_ARTICLE_ID,
      imageOccurrences: loaded.counts.occurrences,
      uniqueImages: loaded.counts.unique,
      manifestSha256: loaded.manifestSha256,
      firstPass: { created: first.created, updated: first.updated },
      secondPass: { created: second.created, updated: second.updated },
      oldRowsUnchanged: true,
      sourceDatabaseUnchanged: true,
      networkRequests: guard.count(),
      integrityCheck: 'ok',
    };
    fs.writeFileSync(
      path.join(trialDir, 'result.json'),
      JSON.stringify(result, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    return result;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (oldEnv.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldEnv.database;
    if (oldEnv.scheduled === undefined)
      delete process.env.DISABLE_SCHEDULED_UPDATES;
    else process.env.DISABLE_SCHEDULED_UPDATES = oldEnv.scheduled;
    if (oldEnv.privateMode === undefined)
      delete process.env.PRIVATE_ONLINE_MODE;
    else process.env.PRIVATE_ONLINE_MODE = oldEnv.privateMode;
    guard.restore();
  }
}

async function main(args = process.argv.slice(2), logger = console) {
  if (args.length) fail('CLI_ARGUMENTS_INVALID');
  const result = await runImageCopyRehearsal();
  logger.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    // Private paths and URLs may appear in lower-level exceptions. Never print
    // their message; the code is enough to identify the failed gate.
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'IMAGE_COPY_REHEARSAL_FAILED';
    console.error(JSON.stringify({ success: false, error: code }));
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_DOM_SHA256,
  loadVerifiedImageManifest,
  runImageCopyRehearsal,
  main,
};
