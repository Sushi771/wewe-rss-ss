#!/usr/bin/env node
'use strict';

// One explicit, offline production insert for WX_3895431412_2247493594_1.
// Usage (after a fresh successful copy-only replay):
// node scripts/research/commit-browser-dom-images-once.cjs \
//   --trial-dir <absolute private-data/.../image-replay-trial-...> \
//   --expected-source-sha256 <Get-FileHash apps/server/data/wewe-rss.db SHA256> \
//   --execute
// The source digest is an operator-supplied, exact preflight gate. This script
// also compares every logical SQLite table with the named rehearsal copy and
// a new consistent backup; the main-file hash alone does not cover WAL data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const {
  loadVerifiedImageManifest,
} = require('./replay-browser-dom-images-copy.cjs');
const {
  TARGET_ARTICLE_ID,
  TARGET_MP_ID,
} = require('./collect-browser-dom-images-once.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PRIVATE_BASE = path.join(
  ROOT,
  'private-data/single-account-update-20260930',
);
const PRODUCTION_DB = path.join(ROOT, 'apps/server/data/wewe-rss.db');
const HEX_SHA = /^[a-f0-9]{64}$/;
const EXPECTED_TABLES = ['_prisma_migrations', 'accounts', 'articles', 'feeds'];
// The additive XHS migration is optional for older, unmigrated databases.
// Both known layouts are snapshotted in full; unexpected tables still stop.
const EXPECTED_XHS_TABLES = [...EXPECTED_TABLES, 'xhs_creators', 'xhs_notes'];
const MAX_REHEARSAL_AGE_MS = 2 * 60 * 60 * 1000;

function fail(code) {
  throw new Error(code);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function regularFile(file, code) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(code);
  }
  if (!stat.isFile()) fail(code);
  return stat;
}

function readJson(file, code) {
  regularFile(file, code);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(code);
  }
}

function samePath(left, right) {
  return (
    fs.realpathSync(left).toLowerCase() === fs.realpathSync(right).toLowerCase()
  );
}

function assertPrivateTrialDir(trialDir, sourceDb, testMode) {
  if (!path.isAbsolute(trialDir)) fail('TRIAL_DIR_MUST_BE_ABSOLUTE');
  const real = fs.realpathSync(trialDir);
  if (!testMode) {
    const privateRoot = fs.realpathSync(PRIVATE_BASE);
    if (
      !real.toLowerCase().startsWith((privateRoot + path.sep).toLowerCase()) ||
      !/^image-replay-trial-[^\\/]+$/.test(path.basename(real))
    )
      fail('TRIAL_DIR_OUTSIDE_PRIVATE_BASE');
  }
  if (samePath(real, path.dirname(sourceDb))) fail('TRIAL_DIR_IS_SOURCE_DIR');
  for (const name of [
    'result.json',
    'trial.db',
    'trial.db.browser-dom-replay.json',
  ]) {
    regularFile(path.join(real, name), 'TRIAL_FILE_INVALID');
  }
  return real;
}

function validateRehearsal(trialDir, sourceDb, manifest, now, testMode) {
  const real = assertPrivateTrialDir(trialDir, sourceDb, testMode);
  const resultFile = path.join(real, 'result.json');
  const trialFile = path.join(real, 'trial.db');
  const result = readJson(resultFile, 'TRIAL_RESULT_INVALID');
  const marker = readJson(
    trialFile + '.browser-dom-replay.json',
    'TRIAL_MARKER_INVALID',
  );
  const resultTime = regularFile(resultFile, 'TRIAL_RESULT_INVALID').mtimeMs;
  const trialTime = regularFile(trialFile, 'TRIAL_DATABASE_INVALID').mtimeMs;
  if (
    resultTime > now + 2 * 60 * 1000 ||
    trialTime > now + 2 * 60 * 1000 ||
    now - resultTime > MAX_REHEARSAL_AGE_MS ||
    now - trialTime > MAX_REHEARSAL_AGE_MS ||
    trialTime > resultTime + 2 * 60 * 1000
  )
    fail('TRIAL_NOT_RECENT');
  if (
    result.success !== true ||
    result.offline !== true ||
    result.copyOnly !== true ||
    result.articleId !== TARGET_ARTICLE_ID ||
    result.manifestSha256 !== manifest.manifestSha256 ||
    result.imageOccurrences !== manifest.counts.occurrences ||
    result.uniqueImages !== manifest.counts.unique ||
    result.firstPass?.created !== 1 ||
    result.firstPass?.updated !== 0 ||
    result.secondPass?.created !== 0 ||
    result.secondPass?.updated !== 0 ||
    result.oldRowsUnchanged !== true ||
    result.sourceDatabaseUnchanged !== true ||
    result.networkRequests !== 0 ||
    result.integrityCheck !== 'ok' ||
    marker.mode !== 'owner-confirmed-browser-dom' ||
    !samePath(marker.sourceDatabase, sourceDb)
  )
    fail('TRIAL_RESULT_MISMATCH');
  return { trialFile, resultFile };
}

function encodeRows(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        Buffer.isBuffer(value) ? ['blob', sha256(value)] : value,
      ]),
    ),
  );
}

function snapshot(db, omitTarget = false) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
    fail('SQLITE_INTEGRITY_FAILED');
  if (db.prepare('PRAGMA foreign_key_check').all().length)
    fail('SQLITE_FOREIGN_KEYS_FAILED');
  const definitions = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const tableNames = JSON.stringify(definitions.map((row) => row.name));
  if (
    tableNames !== JSON.stringify(EXPECTED_TABLES) &&
    tableNames !== JSON.stringify(EXPECTED_XHS_TABLES)
  )
    fail('SQLITE_SCHEMA_UNEXPECTED');
  const tables = {};
  for (const { name, sql } of definitions) {
    const safe = `"${name.replaceAll('"', '""')}"`;
    const rows = db.prepare(`SELECT * FROM ${safe} ORDER BY rowid`).all();
    tables[name] = {
      sql,
      rows: encodeRows(
        name === 'articles' && omitTarget
          ? rows.filter((row) => row.id !== TARGET_ARTICLE_ID)
          : rows,
      ),
    };
  }
  return { tables, digest: sha256(JSON.stringify(tables)) };
}

function readSnapshot(file, omitTarget = false) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const value = snapshot(db, omitTarget);
    db.exec('COMMIT');
    return value;
  } finally {
    db.close();
  }
}

function assertBaselineEqual(left, right, code) {
  if (left.digest !== right.digest) fail(code);
  assert.deepEqual(left.tables, right.tables, code);
}

function assertVerifiedArticle(row, article) {
  if (
    !row ||
    row.id !== TARGET_ARTICLE_ID ||
    row.mp_id !== TARGET_MP_ID ||
    row.title !== article.title ||
    row.publish_time !== article.publishTime ||
    row.source_url !== article.url ||
    row.verified_source_url !== article.url ||
    row.content_html !== article.contentHtml ||
    row.pic_url !== article.picUrl ||
    row.last_body_status !== 'available'
  )
    fail('TARGET_ROW_MISMATCH');
}

function installNetworkGuard() {
  const http = require('node:http');
  const https = require('node:https');
  const original = {
    httpGet: http.get,
    httpRequest: http.request,
    httpsGet: https.get,
    httpsRequest: https.request,
    fetch: global.fetch,
  };
  let blocked = 0;
  const deny = () => {
    blocked++;
    fail('NETWORK_FORBIDDEN_IN_PRODUCTION_IMPORT');
  };
  http.get = http.request = https.get = https.request = deny;
  global.fetch = deny;
  return {
    count: () => blocked,
    restore: () => {
      http.get = original.httpGet;
      http.request = original.httpRequest;
      https.get = original.httpsGet;
      https.request = original.httpsRequest;
      global.fetch = original.fetch;
    },
  };
}

function validateReplay(loaded) {
  const replay = loaded.replay;
  const article = replay.page?.articles?.[0];
  if (
    replay.page?.articles?.length !== 1 ||
    article?.id !== TARGET_ARTICLE_ID ||
    article.mpId !== TARGET_MP_ID ||
    !Number.isSafeInteger(article.publishTime) ||
    article.publishTime <= 0 ||
    !article.title ||
    !article.url ||
    !article.contentHtml ||
    replay.page.coverage !== 'search-results' ||
    replay.page.bodyMissing !== 0 ||
    replay.page.imageBlocked !== 0 ||
    replay.discovery !== 'owner-confirmed-browser-dom' ||
    replay.provenance !== 'owner-confirmed-browser-dom-verified-image-cache' ||
    replay.imagesComplete !== true ||
    replay.unarchivedImages !== 0 ||
    replay.networkRequests !== 0 ||
    replay.complete !== false
  )
    fail('VERIFIED_REPLAY_INVALID');
  return article;
}

async function runOneArticleImport(options) {
  const testMode = Boolean(process.env.NODE_TEST_CONTEXT);
  if (
    !testMode &&
    (options.sourceDb ||
      options.baseDir ||
      options.testExpectedHash ||
      options.now)
  )
    fail('TEST_OVERRIDE_FORBIDDEN');
  const sourceDb = fs.realpathSync(options.sourceDb || PRODUCTION_DB);
  if (!testMode && !samePath(sourceDb, PRODUCTION_DB))
    fail('PRODUCTION_DATABASE_REQUIRED');
  if (!HEX_SHA.test(options.expectedSourceSha256))
    fail('EXPECTED_SOURCE_SHA256_INVALID');
  const guard = installNetworkGuard();
  let db;
  let inTransaction = false;
  try {
    const loaded = loadVerifiedImageManifest({
      ...(testMode && options.baseDir ? { baseDir: options.baseDir } : {}),
      ...(testMode && options.testExpectedHash
        ? { testExpectedHash: options.testExpectedHash }
        : {}),
    });
    const article = validateReplay(loaded);
    const { trialFile } = validateRehearsal(
      options.trialDir,
      sourceDb,
      loaded,
      options.now || Date.now(),
      testMode,
    );
    const sourceHash = sha256(fs.readFileSync(sourceDb));
    if (sourceHash !== options.expectedSourceSha256)
      fail('SOURCE_FILE_DIGEST_MISMATCH');
    const before = readSnapshot(sourceDb);
    const trial = readSnapshot(trialFile);
    const rehearsalRow = trial.tables.articles.rows.find(
      (row) => row.id === TARGET_ARTICLE_ID,
    );
    assertVerifiedArticle(rehearsalRow, article);
    if (
      trial.tables.articles.rows.filter((row) => row.id === TARGET_ARTICLE_ID)
        .length !== 1 ||
      before.tables.articles.rows.some((row) => row.id === TARGET_ARTICLE_ID) ||
      !before.tables.feeds.rows.some((row) => row.id === TARGET_MP_ID)
    )
      fail('SOURCE_IDENTITY_PREFLIGHT_FAILED');
    const rehearsalOld = readSnapshot(trialFile, true);
    assertBaselineEqual(before, rehearsalOld, 'SOURCE_DRIFTED_SINCE_REHEARSAL');

    const runDir = fs.mkdtempSync(
      path.join(
        testMode && options.baseDir ? options.baseDir : PRIVATE_BASE,
        'image-production-import-',
      ),
    );
    const backupFile = path.join(runDir, 'before.db');
    const backupSource = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      await backup(backupSource, backupFile);
    } finally {
      backupSource.close();
    }
    const backupSnapshot = readSnapshot(backupFile);
    assertBaselineEqual(before, backupSnapshot, 'BACKUP_SOURCE_MISMATCH');
    if (sha256(fs.readFileSync(sourceDb)) !== sourceHash)
      fail('SOURCE_FILE_CHANGED_DURING_BACKUP');

    db = new DatabaseSync(sourceDb);
    db.exec(
      'PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE',
    );
    inTransaction = true;
    const lockedBefore = snapshot(db);
    assertBaselineEqual(before, lockedBefore, 'SOURCE_CHANGED_BEFORE_WRITE');
    if (guard.count() !== 0) fail('NETWORK_ATTEMPT_DETECTED');
    const collision = db
      .prepare(
        'SELECT id FROM articles WHERE source_url=? OR verified_source_url=? OR (mp_id=? AND title=? AND source_url IS NULL AND verified_source_url IS NULL) LIMIT 1',
      )
      .get(article.url, article.url, TARGET_MP_ID, article.title);
    if (collision) fail('ARTICLE_IDENTITY_COLLISION');
    const inserted = db
      .prepare(
        'INSERT INTO articles (id, mp_id, title, pic_url, publish_time, source_url, verified_source_url, content_html, last_body_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        article.id,
        TARGET_MP_ID,
        article.title,
        article.picUrl,
        article.publishTime,
        article.url,
        article.url,
        article.contentHtml,
        'available',
      );
    if (inserted.changes !== 1) fail('INSERT_COUNT_INVALID');
    const after = snapshot(db);
    assertVerifiedArticle(
      after.tables.articles.rows.find((row) => row.id === TARGET_ARTICLE_ID),
      article,
    );
    if (
      after.tables.articles.rows.length !==
      before.tables.articles.rows.length + 1
    )
      fail('ARTICLE_COUNT_INVALID');
    const oldAfter = snapshot(db, true);
    assertBaselineEqual(before, oldAfter, 'OLD_ROWS_CHANGED');
    if (guard.count() !== 0) fail('NETWORK_ATTEMPT_DETECTED');
    db.exec('COMMIT');
    inTransaction = false;
    const result = {
      success: true,
      mode: 'one-verified-browser-dom-image-article',
      committedAtUtc: new Date().toISOString(),
      articleId: TARGET_ARTICLE_ID,
      created: 1,
      updated: 0,
      beforeArticles: before.tables.articles.rows.length,
      afterArticles: after.tables.articles.rows.length,
      imageOccurrences: loaded.counts.occurrences,
      uniqueImages: loaded.counts.unique,
      manifestSha256: loaded.manifestSha256,
      sourceFileSha256Before: sourceHash,
      sourceTablesSha256Before: before.digest,
      sourceTablesSha256After: after.digest,
      sourceDatabase: sourceDb,
      trialDirectory: options.trialDir,
      backupFile,
      backupSha256: sha256(fs.readFileSync(backupFile)),
      oldRowsUnchanged: true,
      feedSyncUnchanged: true,
      networkRequests: 0,
      complete: false,
      productionSubscriptionRestored: false,
    };
    fs.writeFileSync(
      path.join(runDir, 'result.json'),
      JSON.stringify(result, null, 2),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    return result;
  } finally {
    if (inTransaction && db) db.exec('ROLLBACK');
    if (db) db.close();
    guard.restore();
  }
}

async function main(args = process.argv.slice(2), logger = console) {
  if (
    args.length !== 5 ||
    args[0] !== '--trial-dir' ||
    args[2] !== '--expected-source-sha256' ||
    args[4] !== '--execute'
  )
    fail('CLI_ARGUMENTS_INVALID');
  const result = await runOneArticleImport({
    trialDir: args[1],
    expectedSourceSha256: args[3].toLowerCase(),
  });
  logger.log(
    JSON.stringify({
      success: result.success,
      articleId: result.articleId,
      created: result.created,
      updated: result.updated,
      oldRowsUnchanged: result.oldRowsUnchanged,
      networkRequests: result.networkRequests,
      complete: false,
    }),
  );
}

if (require.main === module) {
  main().catch((error) => {
    // Never print paths, article text, source URLs or underlying exception data.
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'ONE_ARTICLE_IMPORT_FAILED';
    console.error(JSON.stringify({ success: false, error: code }));
    process.exitCode = 1;
  });
}

module.exports = {
  snapshot,
  readSnapshot,
  validateRehearsal,
  runOneArticleImport,
  main,
};
