#!/usr/bin/env node
'use strict';
// Saved official samples only. No browser, Tencent requests, production writes or source rebinding.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { DatabaseSync, backup } = require('node:sqlite');
const root = path.resolve(__dirname, '../..');
const server = path.join(root, 'apps/server');
const local = createRequire(path.join(server, 'package.json'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function privateFile(file) {
  const privateRoot = fs.realpathSync(path.join(root, 'private-data'));
  const resolved = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(privateRoot, resolved);
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'INPUT_MUST_BE_PRIVATE',
  );
  return resolved;
}

function sample(record) {
  const bytes = fs.readFileSync(privateFile(record.file));
  assert.equal(hash(bytes), record.sha256, 'SAVED_SAMPLE_HASH_MISMATCH');
  return bytes;
}

function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN;');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
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

async function main() {
  assert(
    process.argv.length === 4 && process.argv[2] === '--manifest',
    'USE_--manifest_PRIVATE_FILE',
  );
  const manifest = JSON.parse(
    fs.readFileSync(privateFile(process.argv[3]), 'utf8'),
  );
  const built = path.join(server, 'dist/apps/server/src');
  const { prepareWereadDirectoryReplay } = require(
    path.join(built, 'collection/weread-directory'),
  );
  const replay = prepareWereadDirectoryReplay(
    manifest.pages.map((page) =>
      JSON.parse(
        sample(page)
          .toString('utf8')
          .replace(/^\uFEFF/, ''),
      ),
    ),
    { mpId: manifest.mpId, name: manifest.name },
    manifest.bodies.map((body) => ({
      reviewId: body.reviewId,
      html: sample(body).toString('utf8'),
      sha256: body.sha256,
      capturedAt: body.capturedAt,
      images: (body.images || []).map((image) => ({
        url: image.url,
        inline: `data:${image.mimeType};base64,${sample(image).toString('base64')}`,
        sha256: image.sha256,
      })),
    })),
    10,
  );
  console.log(
    JSON.stringify(await replayDirectoryFixture(manifest.mpId, replay)),
  );
}

async function replayDirectoryFixture(mpId, replay) {
  const built = path.join(server, 'dist/apps/server/src');
  let blockedRequests = 0;
  const fail = () => {
    blockedRequests++;
    throw new Error('NETWORK_FORBIDDEN_IN_DIRECTORY_REPLAY');
  };
  const saved = [];
  for (const [object, keys] of [
    [require('node:http'), ['get', 'request']],
    [require('node:https'), ['get', 'request']],
    [local('axios'), ['get', 'post', 'request']],
    [global, ['fetch']],
  ]) {
    for (const key of keys) {
      saved.push([object, key, object[key]]);
      object[key] = fail;
    }
  }
  let artifacts;
  try {
    artifacts = require('../local-release/test-artifacts.cjs').begin({
      migrations: path.join(server, 'prisma/migrations'),
    });
    const { audit: trial, database: source } = artifacts;
    const copy = path.join(trial, 'copy.db');
    const oldDatabase = process.env.DATABASE_URL;
    const oldScheduled = process.env.DISABLE_SCHEDULED_UPDATES;
    let prisma,
      artifactError,
      writerClosed = true;
    try {
      const before = rows(source);
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(db, copy);
      } finally {
        db.close();
      }
      artifacts.checkpoint();
      assert.deepEqual(rows(copy), before, 'COPY_BASELINE_MISMATCH');
      fs.writeFileSync(
        copy + '.weread-directory-replay.json',
        JSON.stringify({
          mode: 'saved-weread-directory',
          syntheticDatabase: true,
          sourceDatabase: source,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      process.env.DATABASE_URL = `file:${copy.replace(/\\/g, '/')}`;
      process.env.DISABLE_SCHEDULED_UPDATES = '1';
      const { PrismaClient } = local('@prisma/client');
      const { CollectionService } = require(
        path.join(built, 'collection/collection.service'),
      );
      prisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      writerClosed = false;
      let first, second;
      try {
        first = await new CollectionService(prisma).replayWereadDirectory(
          mpId,
          replay,
        );
        const afterFirst = rows(copy);
        assert.deepEqual(afterFirst.feeds, before.feeds, 'FEEDS_CHANGED');
        assert.deepEqual(
          afterFirst.accounts,
          before.accounts,
          'ACCOUNTS_CHANGED',
        );
        const byId = new Map(afterFirst.articles.map((row) => [row.id, row]));
        for (const row of before.articles)
          assert.deepEqual(byId.get(row.id), row, 'OLD_ARTICLE_CHANGED');
        second = await new CollectionService(prisma).replayWereadDirectory(
          mpId,
          replay,
        );
        assert.equal(second.created, 0);
        assert.equal(second.updated, 0);
        assert.deepEqual(rows(copy), afterFirst, 'REPEAT_CHANGED_COPY');
        assert.deepEqual(rows(source), before, 'SYNTHETIC_SOURCE_CHANGED');
        assert.equal(blockedRequests, 0);
      } finally {
        await prisma.$disconnect();
        writerClosed = true;
      }
      const report = {
        mode: 'saved-weread-directory',
        groupCounts: replay.groupCounts,
        directoryArticles: replay.page.upstreamCount,
        latestSelected: replay.selected.length,
        bodyVerified: replay.verified.length,
        missingLatestBodies: replay.unverified.length,
        latestWindowReady: replay.latestWindowReady,
        first,
        second,
        sourceCounts: Object.fromEntries(
          Object.entries(before).map(([table, data]) => [table, data.length]),
        ),
        oldRowsUnchanged: true,
        syntheticDatabase: true,
        networkRequests: blockedRequests,
        liveSubscriptionVerified: false,
        audit: trial,
      };
      fs.writeFileSync(
        path.join(trial, 'result.json'),
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      return report;
    } catch (error) {
      artifactError = error;
      throw error;
    } finally {
      // Disconnect was awaited above before either success or ordinary failure
      // reaches finish. If disconnect failed, retain the owned run for review.
      if (oldDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldDatabase;
      if (oldScheduled === undefined)
        delete process.env.DISABLE_SCHEDULED_UPDATES;
      else process.env.DISABLE_SCHEDULED_UPDATES = oldScheduled;
      if (writerClosed) artifacts.finish(artifactError);
    }
  } finally {
    for (const [object, key, value] of saved) object[key] = value;
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { replayDirectoryFixture };
