#!/usr/bin/env node
'use strict';
// Explicit one-time import of a real cached original after the SQLite-copy
// rehearsal. No Tencent requests, feed-success timestamp, or source switch.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { inputs } = require('./replay-owner-search-cache.cjs');

const root = path.resolve(__dirname, '../..');
const server = path.join(root, 'apps/server');
const source = path.join(server, 'data/wewe-rss.db');
const built = path.join(server, 'dist/apps/server/src');
const local = createRequire(path.join(server, 'package.json'));
const expectedNewId = 'WX_3895431412_2247493551_1';
const expectedExistingId = 'WX_3895431412_2247493556_1';

function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    return Object.fromEntries(
      ['feeds', 'articles', 'accounts'].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}

function guardNetwork() {
  let blocked = 0;
  const fail = () => {
    blocked++;
    throw Error('BACKFILL_NETWORK_DISABLED');
  };
  for (const moduleName of ['node:http', 'node:https'])
    for (const operation of ['get', 'request'])
      require(moduleName)[operation] = fail;
  global.fetch = fail;
  local('axios').get = local('axios').post = fail;
  return () => blocked;
}

function sameOld(before, after) {
  assert.deepEqual(after.feeds, before.feeds);
  assert.deepEqual(after.accounts, before.accounts);
  const current = new Map(
    after.articles.map((article) => [article.id, article]),
  );
  for (const old of before.articles) assert.deepEqual(current.get(old.id), old);
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    args[0] !== '--rehearsal' ||
    !path.isAbsolute(args[1]) ||
    args[2] !== '--execute'
  )
    throw Error('usage: --rehearsal <absolute private result.json> --execute');
  const privateRoot = path.join(root, 'private-data') + path.sep;
  if (!path.resolve(args[1]).startsWith(privateRoot))
    throw Error('BACKFILL_REHEARSAL_MUST_BE_PRIVATE');
  const rehearsal = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  assert.equal(rehearsal.discovery, 'persisted real response replay');
  assert.equal(rehearsal.first, 1);
  assert.equal(rehearsal.afterRestartCreated, 0);
  assert.equal(rehearsal.allOldColumnsPreserved, true);
  assert.equal(rehearsal.productionUnchanged, true);
  assert.equal(rehearsal.backup.source, source);
  assert.equal(rehearsal.verifiedOriginals, 2);
  assert.equal(rehearsal.unverifiedOriginals, 3);

  const before = rows(source);
  assert(!before.articles.some((article) => article.id === expectedNewId));
  assert(before.articles.some((article) => article.id === expectedExistingId));
  const runDir = fs.mkdtempSync(
    path.join(root, 'private-data/single-account-update-20260930/backfill-'),
  );
  const backup = JSON.parse(
    execFileSync(
      'python',
      [
        path.join(server, 'scripts/backup-sqlite.py'),
        '--database',
        source,
        '--backup-root',
        path.join(runDir, 'backups'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    ),
  );
  assert.equal(backup.integrityCheck, 'ok');
  assert.equal(backup.articles, before.articles.length);
  assert.equal(backup.sha256, rehearsal.backup.sha256);
  // The existing replay adapter proves hashes, original identity and every
  // locally cached image before yielding a page. It has no network fallback.
  const blocked = guardNetwork();
  const input = inputs();
  assert.equal(input.mpId, 'MP_WXS_3895431412');
  process.env.DATABASE_URL = `file:${source.replace(/\\/g, '/')}`;
  process.env.DISABLE_SCHEDULED_UPDATES = '1';
  delete process.env.PRIVATE_ONLINE_MODE;
  const { prepareSearchReplay } = require(
    path.join(built, 'collection/search-replay'),
  );
  const replay = await prepareSearchReplay(
    input.selected,
    input.mpId,
    input.resolveCache,
  );
  assert.deepEqual(
    replay.verified.map((entry) => entry.article.id).sort(),
    [expectedExistingId, expectedNewId].sort(),
  );
  assert.equal(replay.unverified.length, 3);
  const { PrismaClient } = local('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  let result;
  try {
    const { CollectionService } = require(
      path.join(built, 'collection/collection.service'),
    );
    result = await new CollectionService(prisma).importVerifiedSearchBackfill(
      input.mpId,
      replay,
    );
  } finally {
    await prisma.$disconnect();
  }
  assert.deepEqual(
    { created: result.created, updated: result.updated },
    { created: 1, updated: 0 },
  );
  const after = rows(source);
  sameOld(before, after);
  assert.equal(after.articles.length, before.articles.length + 1);
  assert(after.articles.some((article) => article.id === expectedNewId));
  assert.equal(blocked(), 0);
  const summary = {
    mode: result.mode,
    created: result.created,
    updated: result.updated,
    oldRowsUnchanged: true,
    beforeArticles: before.articles.length,
    afterArticles: after.articles.length,
    feedSyncUnchanged: true,
    coverage: result.coverage,
    complete: false,
    networkRequests: blocked(),
    rehearsal: args[1],
    backup,
  };
  fs.writeFileSync(
    path.join(runDir, 'result.json'),
    JSON.stringify(summary, null, 2),
    {
      flag: 'wx',
    },
  );
  console.log(
    JSON.stringify({
      mode: summary.mode,
      created: summary.created,
      updated: summary.updated,
      beforeArticles: summary.beforeArticles,
      afterArticles: summary.afterArticles,
      oldRowsUnchanged: true,
      complete: false,
      networkRequests: 0,
    }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
