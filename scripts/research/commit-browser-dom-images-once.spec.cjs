'use strict';

// Synthetic-only SQLite/image fixtures. Tests never touch the real private
// cache, production database or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');
const {
  TARGET_ARTICLE_ID,
  TARGET_MP_ID,
  sha256,
  collectBrowserDomImages,
} = require('./collect-browser-dom-images-once.cjs');
const {
  runImageCopyRehearsal,
} = require('./replay-browser-dom-images-copy.cjs');
const {
  readSnapshot,
  runOneArticleImport,
} = require('./commit-browser-dom-images-once.cjs');

const ROOT = path.resolve(__dirname, '../..');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const imageUrl = 'https://mmbiz.qpic.cn/synthetic-verified-image';
const biz = Buffer.from('3895431412').toString('base64');
const articleUrl = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=2247493594&idx=1&sn=abcdef1234567890`;
const publishTime = 1790749883;
const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">Synthetic import</h1><div id="js_content"><p>Synthetic body</p><img data-src="${imageUrl}#one"><img src="${imageUrl}#two"></div><script>var biz="${biz}";var mid="2247493594";var idx="1";var sn="abcdef1234567890";var ct=${publishTime};</script>`;
const domSha = sha256(html);
const candidate = {
  id: TARGET_ARTICLE_ID,
  mpId: TARGET_MP_ID,
  url: articleUrl,
  title: 'Synthetic import',
  indexTimestamp: publishTime - 1,
  discovery: {
    source: 'owner-web-search',
    capturedAt: '2026-09-30T10:05:09.244Z',
    page: 1,
  },
};

let originalRequest;
test.before(() => {
  originalRequest = https.request;
  https.request = () => {
    throw new Error('LIVE_HTTP_FORBIDDEN');
  };
});
test.after(() => {
  https.request = originalRequest;
});

function makeSourceDb(file, { groups = true } = {}) {
  const db = new DatabaseSync(file);
  try {
    const migrations = path.join(ROOT, 'apps/server/prisma/migrations');
    for (const name of fs.readdirSync(migrations).sort()) {
      if (!groups && name === '20261009063000_add_management_groups') continue;
      const sqlFile = path.join(migrations, name, 'migration.sql');
      if (fs.existsSync(sqlFile)) db.exec(fs.readFileSync(sqlFile, 'utf8'));
    }
    db.exec(
      'CREATE TABLE "_prisma_migrations" (id TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
    );
    db.prepare(
      'INSERT INTO "_prisma_migrations" (id, checksum) VALUES (?, ?)',
    ).run('synthetic-migration', 'synthetic-checksum');
    db.prepare('INSERT INTO accounts (id, token, name) VALUES (?, ?, ?)').run(
      'synthetic-account',
      'synthetic-token',
      'Fixture',
    );
    db.prepare(
      'INSERT INTO feeds (id, mp_name, mp_cover, mp_intro, update_time, sync_time) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(TARGET_MP_ID, 'Synthetic feed', '', '', 1700000000, 1700000000);
    db.prepare(
      'INSERT INTO articles (id, mp_id, title, pic_url, publish_time, content_html, last_body_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'WX_synthetic_old',
      TARGET_MP_ID,
      'Old untouched article',
      '',
      1700000000,
      '<p>Old body stays intact</p>',
      'available',
    );
    db.prepare(
      'INSERT INTO xhs_creators (id, profile_url, display_name) VALUES (?, ?, ?)',
    ).run(
      'synthetic-creator',
      'https://www.xiaohongshu.com/synthetic-profile',
      'Synthetic creator',
    );
    db.prepare(
      'INSERT INTO xhs_notes (id, creator_id, title, publish_time, status, content_html) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'synthetic-note',
      'synthetic-creator',
      'Synthetic cached note',
      1700000000,
      'available',
      '<p>Unchanged XHS body</p>',
    );
    if (groups) {
      db.prepare(
        'INSERT INTO management_groups(id,name,platform) VALUES(?,?,?)',
      ).run('synthetic-wechat-folder', 'Synthetic Wechat', 'wechat');
      db.prepare(
        'INSERT INTO management_groups(id,name,platform) VALUES(?,?,?)',
      ).run('synthetic-xhs-folder', 'Synthetic XHS', 'xiaohongshu');
      db.exec(
        "UPDATE feeds SET group_id='synthetic-wechat-folder'; UPDATE xhs_creators SET group_id='synthetic-xhs-folder'",
      );
    }
  } finally {
    db.close();
  }
}

async function withRehearsal(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-image-import-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'official-browser-dom.html'), html);
    fs.writeFileSync(
      path.join(dir, 'official-browser-observation.json'),
      JSON.stringify({
        kind: 'owner-confirmed-browser-dom',
        id: TARGET_ARTICLE_ID,
        observedAt: '2026-09-30T11:53:14.269Z',
        publishTimeFromBrowserDOM: publishTime,
        sha256: domSha,
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'official-original-selection.json'),
      JSON.stringify({ candidate, rawUrl: articleUrl }),
    );
    await collectBrowserDomImages({
      baseDir: dir,
      execute: true,
      testExpectedHash: domSha,
      fetchImage: async () => ({
        bytes: png,
        sha256: sha256(png),
        mimeType: 'image/png',
        size: png.length,
      }),
      paceMs: 0,
    });
    const sourceDb = path.join(dir, 'source.db');
    makeSourceDb(sourceDb);
    await runImageCopyRehearsal({
      baseDir: dir,
      sourceDb,
      testExpectedHash: domSha,
    });
    const trialDir = path.join(
      dir,
      fs
        .readdirSync(dir)
        .find((name) => name.startsWith('image-replay-trial-')),
    );
    const options = {
      baseDir: dir,
      sourceDb,
      trialDir,
      testExpectedHash: domSha,
      expectedSourceSha256: sha256(fs.readFileSync(sourceDb)),
    };
    await fn(options);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('commits exactly one inlined article after a named fresh copy rehearsal and preserves all old tables', async () => {
  await withRehearsal(async (options) => {
    const before = readSnapshot(options.sourceDb);
    assert.equal(before.tables.management_groups.rows.length, 2);
    assert.equal(
      before.tables.feeds.rows[0].group_id,
      'synthetic-wechat-folder',
    );
    assert.equal(before.tables.xhs_creators.rows.length, 1);
    assert.equal(
      before.tables.xhs_notes.rows[0].content_html,
      '<p>Unchanged XHS body</p>',
    );
    const result = await runOneArticleImport(options);
    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.imageOccurrences, 2);
    assert.equal(result.uniqueImages, 1);
    assert.equal(result.complete, false);
    const oldAfter = readSnapshot(options.sourceDb, true);
    assert.deepEqual(oldAfter, before);
    const db = new DatabaseSync(options.sourceDb, { readOnly: true });
    try {
      const inserted = db
        .prepare('SELECT * FROM articles WHERE id=?')
        .get(TARGET_ARTICLE_ID);
      assert.equal(inserted.publish_time, publishTime);
      assert.equal(inserted.last_body_status, 'available');
      assert.equal(inserted.source_url, articleUrl);
      assert.equal(
        (inserted.content_html.match(/data:image\/png;base64,/g) || []).length,
        2,
      );
      assert.equal(
        db.prepare('SELECT sync_time FROM feeds WHERE id=?').get(TARGET_MP_ID)
          .sync_time,
        1700000000,
      );
    } finally {
      db.close();
    }
    const backupDir = fs
      .readdirSync(options.baseDir)
      .find((name) => name.startsWith('image-production-import-'));
    assert(backupDir);
    assert.deepEqual(
      readSnapshot(path.join(options.baseDir, backupDir, 'before.db')),
      before,
    );
    await assert.rejects(
      runOneArticleImport({
        ...options,
        expectedSourceSha256: sha256(fs.readFileSync(options.sourceDb)),
      }),
      /SOURCE_DRIFTED_SINCE_REHEARSAL|SOURCE_IDENTITY_PREFLIGHT_FAILED/,
    );
  });
});

test('snapshots the legacy schema and rejects unknown or incomplete additive tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-image-schema-test-'));
  const file = path.join(dir, 'source.db');
  let db;
  try {
    makeSourceDb(file, { groups: false });
    assert.equal(Object.keys(readSnapshot(file).tables).length, 6);
    db = new DatabaseSync(file);
    db.exec('DROP TABLE xhs_notes; DROP TABLE xhs_creators');
    assert.deepEqual(Object.keys(readSnapshot(file).tables), [
      '_prisma_migrations',
      'accounts',
      'articles',
      'feeds',
    ]);
    db.exec('CREATE TABLE unknown_table (id TEXT)');
    assert.throws(() => readSnapshot(file), /SQLITE_SCHEMA_UNEXPECTED/);
    db.exec('DROP TABLE unknown_table; CREATE TABLE xhs_creators (id TEXT)');
    assert.throws(() => readSnapshot(file), /SQLITE_SCHEMA_UNEXPECTED/);
    db.exec('DROP TABLE xhs_creators; CREATE TABLE management_groups(id TEXT)');
    assert.throws(() => readSnapshot(file), /SQLITE_SCHEMA_UNEXPECTED/);
  } finally {
    if (db) db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects XHS cache drift since rehearsal without importing the article', async () => {
  await withRehearsal(async (options) => {
    const db = new DatabaseSync(options.sourceDb);
    try {
      db.prepare('UPDATE xhs_notes SET content_html=? WHERE id=?').run(
        '<p>Changed cached note</p>',
        'synthetic-note',
      );
    } finally {
      db.close();
    }
    options.expectedSourceSha256 = sha256(fs.readFileSync(options.sourceDb));
    const before = readSnapshot(options.sourceDb);
    await assert.rejects(
      runOneArticleImport(options),
      /SOURCE_DRIFTED_SINCE_REHEARSAL/,
    );
    assert.deepEqual(readSnapshot(options.sourceDb), before);
  });
});

test('snapshots actual SQLite video BLOBs as typed bounded hashes and detects byte drift', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-image-blob-test-'));
  const file = path.join(dir, 'source.db');
  let db;
  try {
    makeSourceDb(file);
    db = new DatabaseSync(file);
    db.exec('ALTER TABLE xhs_notes ADD COLUMN video_bytes BLOB');
    const bytes = Buffer.from([0, 255, 17, 0, 128]);
    db.prepare('UPDATE xhs_notes SET video_bytes=? WHERE id=?').run(
      bytes,
      'synthetic-note',
    );
    const before = readSnapshot(file);
    assert.deepEqual(before.tables.xhs_notes.rows[0].video_bytes, [
      'blob',
      bytes.length,
      sha256(bytes),
    ]);
    db.prepare('UPDATE xhs_notes SET video_bytes=? WHERE id=?').run(
      Buffer.from([0, 254, 17, 0, 128]),
      'synthetic-note',
    );
    assert.notEqual(readSnapshot(file).digest, before.digest);
  } finally {
    if (db) db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects local folder drift since rehearsal without importing the article', async () => {
  await withRehearsal(async (options) => {
    const db = new DatabaseSync(options.sourceDb);
    try {
      db.prepare('UPDATE management_groups SET name=? WHERE id=?').run(
        'Changed folder',
        'synthetic-xhs-folder',
      );
    } finally {
      db.close();
    }
    options.expectedSourceSha256 = sha256(fs.readFileSync(options.sourceDb));
    const before = readSnapshot(options.sourceDb);
    await assert.rejects(
      runOneArticleImport(options),
      /SOURCE_DRIFTED_SINCE_REHEARSAL/,
    );
    assert.deepEqual(readSnapshot(options.sourceDb), before);
  });
});

test('rejects wrong source digest, stale rehearsal, and failed result without writing', async () => {
  await withRehearsal(async (options) => {
    const before = readSnapshot(options.sourceDb);
    await assert.rejects(
      runOneArticleImport({ ...options, expectedSourceSha256: '0'.repeat(64) }),
      /SOURCE_FILE_DIGEST_MISMATCH/,
    );
    await assert.rejects(
      runOneArticleImport({ ...options, now: Date.now() + 3 * 60 * 60 * 1000 }),
      /TRIAL_NOT_RECENT/,
    );
    const resultFile = path.join(options.trialDir, 'result.json');
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    result.oldRowsUnchanged = false;
    fs.writeFileSync(resultFile, JSON.stringify(result));
    await assert.rejects(runOneArticleImport(options), /TRIAL_RESULT_MISMATCH/);
    assert.deepEqual(readSnapshot(options.sourceDb), before);
  });
});

test('rejects source drift from the named rehearsal and a damaged private image cache', async () => {
  await withRehearsal(async (options) => {
    const db = new DatabaseSync(options.sourceDb);
    try {
      db.prepare('UPDATE feeds SET sync_time=? WHERE id=?').run(
        1700000001,
        TARGET_MP_ID,
      );
    } finally {
      db.close();
    }
    options.expectedSourceSha256 = sha256(fs.readFileSync(options.sourceDb));
    await assert.rejects(
      runOneArticleImport(options),
      /SOURCE_DRIFTED_SINCE_REHEARSAL/,
    );
    const imageDir = path.join(options.baseDir, 'image-cache/images');
    fs.writeFileSync(
      path.join(imageDir, fs.readdirSync(imageDir)[0]),
      'broken',
    );
    await assert.rejects(runOneArticleImport(options), /IMAGE_BYTES_INVALID/);
    const after = readSnapshot(options.sourceDb);
    assert.equal(
      after.tables.articles.rows.some((row) => row.id === TARGET_ARTICLE_ID),
      false,
    );
  });
});
