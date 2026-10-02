#!/usr/bin/env node
'use strict';
// Offline browser-assisted update slice.
// Strictly offline: NO Tencent/network requests, NO CDP/browser launch, NO production DB writes.
// Inserts single genuine article from owner-confirmed browser DOM into an isolated SQLite COPY,
// then repeats update idempotently and verifies all old rows/fields remain unchanged.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync, backup } = require('node:sqlite');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const server = path.join(root, 'apps/server');
const built = path.join(server, 'dist/apps/server/src');
const local = createRequire(path.join(server, 'package.json'));
const privateDataDir = path.join(
  root,
  'private-data/single-account-update-20260930',
);
const productionDb = path.join(server, 'data/wewe-rss.db');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function networkGuard() {
  let blocked = 0;
  const fail = () => {
    blocked++;
    throw new Error('NETWORK_ACCESS_FORBIDDEN_IN_OFFLINE_SLICE');
  };
  for (const mod of ['node:http', 'node:https']) {
    for (const op of ['get', 'request']) {
      require(mod)[op] = fail;
    }
  }
  global.fetch = fail;
  try {
    const axios = local('axios');
    axios.get = axios.post = axios.request = fail;
  } catch {}
  return () => blocked;
}

function getRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON;');
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

function assertOldRowsUnchanged(before, after) {
  assert.deepEqual(after.feeds, before.feeds, 'FEEDS_TABLE_MODIFIED');
  assert.deepEqual(after.accounts, before.accounts, 'ACCOUNTS_TABLE_MODIFIED');
  const afterArticleMap = new Map(after.articles.map((a) => [a.id, a]));
  for (const beforeArticle of before.articles) {
    const matched = afterArticleMap.get(beforeArticle.id);
    assert(matched, `OLD_ARTICLE_MISSING: ${beforeArticle.id}`);
    assert.deepEqual(
      matched,
      beforeArticle,
      `OLD_ARTICLE_MODIFIED: ${beforeArticle.id}`,
    );
  }
}

async function main() {
  const blockedRequests = networkGuard();

  // 1. Read input evidence from gitignored private-data
  const selectionFile = path.join(
    privateDataDir,
    'official-original-selection.json',
  );
  const observationFile = path.join(
    privateDataDir,
    'official-browser-observation.json',
  );
  const domHtmlFile = path.join(privateDataDir, 'official-browser-dom.html');

  if (
    !fs.existsSync(selectionFile) ||
    !fs.existsSync(observationFile) ||
    !fs.existsSync(domHtmlFile)
  ) {
    throw new Error('REQUIRED_BROWSER_DOM_EVIDENCE_FILES_NOT_FOUND');
  }

  const selection = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));
  const observation = JSON.parse(fs.readFileSync(observationFile, 'utf8'));
  const html = fs.readFileSync(domHtmlFile, 'utf8');

  // Verify DOM hash and identity before doing any database operations
  const computedHtmlHash = sha256(html);
  if (computedHtmlHash !== observation.sha256) {
    throw new Error('BROWSER_DOM_HASH_MISMATCH');
  }
  if (observation.id !== selection.candidate.id) {
    throw new Error('BROWSER_DOM_CANDIDATE_ID_MISMATCH');
  }
  if (observation.kind !== 'owner-confirmed-browser-dom') {
    throw new Error('INVALID_OBSERVATION_KIND');
  }

  const candidate = selection.candidate;
  const evidence = {
    source: 'owner-confirmed-browser-dom',
    observationKind: 'owner-confirmed-browser-dom',
    capturedAt: observation.observedAt,
    sha256: observation.sha256,
    rawUrl: selection.rawUrl,
  };

  // 2. Protect production database
  assert(fs.existsSync(productionDb), 'PRODUCTION_DB_MISSING');
  const productionHashBefore = sha256(fs.readFileSync(productionDb));

  // 3. Create isolated trial directory and SQLite COPY inside private-data
  const trialDir = fs.mkdtempSync(
    path.join(privateDataDir, 'browser-update-trial-'),
  );
  const copyDb = path.join(trialDir, 'trial.db');

  const srcDb = new DatabaseSync(productionDb, { readOnly: true });
  try {
    await backup(srcDb, copyDb);
  } finally {
    srcDb.close();
  }

  // Create isolated replay marker
  fs.writeFileSync(
    copyDb + '.browser-dom-replay.json',
    JSON.stringify({
      mode: 'owner-confirmed-browser-dom',
      sourceDatabase: productionDb,
    }),
  );

  // Capture baseline rows in SQLite copy
  const beforeRows = getRows(copyDb);
  assert(
    !beforeRows.articles.some((a) => a.id === candidate.id),
    'TARGET_ARTICLE_ALREADY_EXISTS_IN_BASELINE',
  );

  // 4. Execute Pass 1 through CollectionService
  process.env.DATABASE_URL = `file:${copyDb.replace(/\\/g, '/')}`;
  process.env.DISABLE_SCHEDULED_UPDATES = '1';
  delete process.env.PRIVATE_ONLINE_MODE;

  const { prepareBrowserDomReplay } = require(
    path.join(built, 'collection/browser-dom-adapter'),
  );
  const replay = prepareBrowserDomReplay(candidate, html, evidence);

  const { PrismaClient } = local('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  try {
    const { CollectionService } = require(
      path.join(built, 'collection/collection.service'),
    );
    const collection = new CollectionService(prisma);

    const firstResult = await collection.replayBrowserDomUpdate(
      candidate.mpId,
      replay,
    );
    assert.equal(firstResult.created, 1, 'FIRST_PASS_MUST_CREATE_ONE_ARTICLE');
    assert.equal(firstResult.updated, 0, 'FIRST_PASS_MUST_NOT_UPDATE');
    assert.equal(
      firstResult.articles,
      1,
      'FIRST_PASS_ARTICLE_COUNT_MUST_BE_ONE',
    );

    const inserted = await prisma.article.findUnique({
      where: { id: candidate.id },
    });
    assert(inserted, 'INSERTED_ARTICLE_NOT_FOUND');
    assert.equal(
      inserted.publishTime,
      observation.publishTimeFromBrowserDOM,
      'PUBLISH_TIME_MUST_MATCH_DOM_EXACTLY',
    );
    assert.equal(inserted.title, candidate.title, 'TITLE_MUST_MATCH');
    assert.equal(inserted.sourceUrl, candidate.url, 'SOURCE_URL_MUST_MATCH');
    assert(
      inserted.contentHtml && inserted.contentHtml.length > 1000,
      'CONTENT_HTML_INVALID',
    );
    assert.equal(
      inserted.lastBodyStatus,
      'available',
      'LAST_BODY_STATUS_MUST_BE_AVAILABLE',
    );

    // Verify all old rows/fields unchanged after first pass
    const rowsAfterFirst = getRows(copyDb);
    assertOldRowsUnchanged(beforeRows, rowsAfterFirst);

    // 5. Execute Pass 2: Repeat update idempotently
    const secondResult = await collection.replayBrowserDomUpdate(
      candidate.mpId,
      replay,
    );
    assert.equal(
      secondResult.created,
      0,
      'SECOND_PASS_MUST_BE_IDEMPOTENT_ZERO_CREATED',
    );
    assert.equal(
      secondResult.updated,
      0,
      'SECOND_PASS_MUST_BE_IDEMPOTENT_ZERO_UPDATED',
    );

    // Verify all rows in copy DB are strictly identical to after first pass
    const rowsAfterSecond = getRows(copyDb);
    assert.deepEqual(
      rowsAfterSecond,
      rowsAfterFirst,
      'SECOND_PASS_MODIFIED_ROWS',
    );

    // 6. Verify production database was never written to
    const productionHashAfter = sha256(fs.readFileSync(productionDb));
    assert.equal(
      productionHashAfter,
      productionHashBefore,
      'PRODUCTION_DATABASE_WAS_MODIFIED',
    );

    // 7. Write private result file in gitignored trial directory
    const privateResult = {
      trialDir,
      mode: 'owner-confirmed-browser-dom',
      executedAt: new Date().toISOString(),
      firstPass: firstResult,
      secondPass: secondResult,
      article: {
        id: inserted.id,
        title: inserted.title,
        publishTime: inserted.publishTime,
        contentLength: inserted.contentHtml ? inserted.contentHtml.length : 0,
        status: inserted.lastBodyStatus,
        unarchivedImages: replay.unarchivedImages,
      },
      baselineArticleCount: beforeRows.articles.length,
      finalArticleCount: rowsAfterSecond.articles.length,
      oldRowsUnchanged: true,
      productionDatabaseUnchanged: true,
      blockedNetworkRequests: blockedRequests(),
    };
    fs.writeFileSync(
      path.join(trialDir, 'result.json'),
      JSON.stringify(privateResult, null, 2),
    );

    // 8. Public log: boolean, count and status only
    console.log(
      JSON.stringify({
        success: true,
        offline: true,
        mode: 'owner-confirmed-browser-dom',
        blockedNetworkRequests: blockedRequests(),
        firstPass: {
          created: firstResult.created,
          updated: firstResult.updated,
        },
        secondPass: {
          created: secondResult.created,
          updated: secondResult.updated,
        },
        articleId: inserted.id,
        articlePublishTime: inserted.publishTime,
        unarchivedImages: replay.unarchivedImages,
        offlineImagesReady: replay.unarchivedImages === 0,
        oldRowsUnchanged: true,
        productionDatabaseUnchanged: true,
        integrityCheck: 'ok',
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exitCode = 1;
});
