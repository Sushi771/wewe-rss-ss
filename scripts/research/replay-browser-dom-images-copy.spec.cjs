'use strict';

// All databases and cached images here are synthetic; no HTTP requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');
const { createRequire } = require('node:module');
const {
  TARGET_ARTICLE_ID,
  TARGET_MP_ID,
  sha256,
  collectBrowserDomImages,
} = require('./collect-browser-dom-images-once.cjs');
const {
  loadVerifiedImageManifest,
  runImageCopyRehearsal,
} = require('./replay-browser-dom-images-copy.cjs');

const ROOT = path.resolve(__dirname, '../..');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const imageUrl = 'https://mmbiz.qpic.cn/synthetic-verified-image';
const biz = Buffer.from('3895431412').toString('base64');
const articleUrl = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=2247493594&idx=1&sn=abcdef1234567890`;
const title = 'Synthetic browser DOM image rehearsal';
const publishTime = 1790749883;
const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">${title}</h1><div id="js_content"><p>Synthetic body</p><img data-src="${imageUrl}#one"><img src="${imageUrl}#two"></div><script>var biz="${biz}";var mid="2247493594";var idx="1";var sn="abcdef1234567890";var ct=${publishTime};</script>`;
const domSha = sha256(html);
const candidate = {
  id: TARGET_ARTICLE_ID,
  mpId: TARGET_MP_ID,
  url: articleUrl,
  title,
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

async function withCache(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-image-copy-test-'));
  const oldRoot = process.env.WEWE_TEST_OUTPUT_ROOT;
  process.env.WEWE_TEST_OUTPUT_ROOT = path.join(dir, 'managed');
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
    return await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.WEWE_TEST_OUTPUT_ROOT;
    else process.env.WEWE_TEST_OUTPUT_ROOT = oldRoot;
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function manifestPaths(dir) {
  const base = path.join(dir, 'image-cache');
  return {
    manifest: path.join(base, 'manifest.json'),
    marker: path.join(base, 'image-collector-marker.json'),
    imageDir: path.join(base, 'images'),
  };
}

function resign(dir, edit) {
  const files = manifestPaths(dir);
  const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(files.marker, 'utf8'));
  edit(manifest, marker);
  const { manifestSha256: _old, ...unsigned } = manifest;
  manifest.manifestSha256 = sha256(JSON.stringify(unsigned));
  marker.manifestSha256 = manifest.manifestSha256;
  fs.writeFileSync(files.manifest, JSON.stringify(manifest));
  fs.writeFileSync(files.marker, JSON.stringify(marker));
}

function makeSourceDb(file) {
  const db = new DatabaseSync(file);
  try {
    const migrations = path.join(ROOT, 'apps/server/prisma/migrations');
    for (const name of fs.readdirSync(migrations).sort()) {
      const sqlFile = path.join(migrations, name, 'migration.sql');
      if (fs.existsSync(sqlFile)) db.exec(fs.readFileSync(sqlFile, 'utf8'));
    }
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
  } finally {
    db.close();
  }
}

test('loads a completed synthetic manifest, verifies bytes and inlines both occurrences', async () => {
  await withCache(async (dir) => {
    const loaded = loadVerifiedImageManifest({
      baseDir: dir,
      testExpectedHash: domSha,
    });
    assert.deepEqual(loaded.counts, { occurrences: 2, unique: 1 });
    assert.equal(loaded.replay.unarchivedImages, 0);
    assert.equal(loaded.replay.imagesComplete, true);
    assert.equal(loaded.replay.page.articles[0].publishTime, publishTime);
    assert.equal(
      (
        loaded.replay.page.articles[0].contentHtml.match(
          /data:image\/png;base64,/g,
        ) || []
      ).length,
      2,
    );
  });
});

test('rejects incomplete marker and wrong manifest checksum', async () => {
  await withCache(async (dir) => {
    const files = manifestPaths(dir);
    const marker = JSON.parse(fs.readFileSync(files.marker, 'utf8'));
    marker.status = 'stopped';
    fs.writeFileSync(files.marker, JSON.stringify(marker));
    assert.throws(
      () =>
        loadVerifiedImageManifest({ baseDir: dir, testExpectedHash: domSha }),
      /IMAGE_MANIFEST_MISMATCH/,
    );
    marker.status = 'completed';
    fs.writeFileSync(files.marker, JSON.stringify(marker));
    const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
    manifest.images[0].size++;
    fs.writeFileSync(files.manifest, JSON.stringify(manifest));
    assert.throws(
      () =>
        loadVerifiedImageManifest({ baseDir: dir, testExpectedHash: domSha }),
      /IMAGE_MANIFEST_HASH_MISMATCH/,
    );
  });
});

test('rejects altered DOM occurrence sequence even when the manifest is re-signed', async () => {
  await withCache(async (dir) => {
    resign(dir, (manifest) => {
      manifest.occurrences.reverse();
    });
    assert.throws(
      () =>
        loadVerifiedImageManifest({ baseDir: dir, testExpectedHash: domSha }),
      /IMAGE_OCCURRENCE_MISMATCH/,
    );
  });
});

test('rejects image paths, byte hash changes, and invalid image containers', async () => {
  await withCache(async (dir) => {
    resign(dir, (manifest) => {
      manifest.images[0].path = '../outside.png';
    });
    assert.throws(
      () =>
        loadVerifiedImageManifest({ baseDir: dir, testExpectedHash: domSha }),
      /IMAGE_RECORD_MISMATCH/,
    );
  });
  await withCache(async (dir) => {
    const files = manifestPaths(dir);
    const image = fs.readdirSync(files.imageDir)[0];
    fs.writeFileSync(path.join(files.imageDir, image), Buffer.from('bad'));
    assert.throws(
      () =>
        loadVerifiedImageManifest({ baseDir: dir, testExpectedHash: domSha }),
      /IMAGE_BYTES_INVALID/,
    );
  });
  await withCache(async (dir) => {
    const files = manifestPaths(dir);
    const image = fs.readdirSync(files.imageDir)[0];
    const bytes = Buffer.from('not-a-real-png');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const next = digest + '.png';
    fs.writeFileSync(path.join(files.imageDir, next), bytes);
    fs.rmSync(path.join(files.imageDir, image));
    resign(dir, (manifest) => {
      manifest.images[0].sha256 = digest;
      manifest.images[0].size = bytes.length;
      manifest.images[0].fileName = next;
      manifest.images[0].path = `images/${next}`;
      for (const occurrence of manifest.occurrences) {
        occurrence.sha256 = digest;
        occurrence.fileName = next;
      }
    });
    assert.throws(
      () =>
        loadVerifiedImageManifest({ baseDir: dir, testExpectedHash: domSha }),
      /IMAGE_BYTES_INVALID/,
    );
  });
});

test('explicit test-only retention supports the synthetic import fixture; old rows and source stay unchanged', async () => {
  await withCache(async (dir) => {
    const sourceDb = path.join(dir, 'source.db');
    makeSourceDb(sourceDb);
    const beforeHash = sha256(fs.readFileSync(sourceDb));
    const result = await runImageCopyRehearsal({
      baseDir: dir,
      sourceDb,
      testExpectedHash: domSha,
      keepTestDatabases: true,
    });
    assert.equal(result.success, true);
    assert.equal(result.firstPass.created, 1);
    assert.equal(result.secondPass.updated, 0);
    assert.equal(result.networkRequests, 0);
    assert.equal(sha256(fs.readFileSync(sourceDb)), beforeHash);
    const copyDb = path.join(result.audit, 'trial.db');
    const db = new DatabaseSync(copyDb, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT content_html FROM articles WHERE id=?')
        .get(TARGET_ARTICLE_ID);
      assert.equal(
        (row.content_html.match(/data:image\/png;base64,/g) || []).length,
        2,
      );
      assert.equal(
        db
          .prepare('SELECT content_html FROM articles WHERE id=?')
          .get('WX_synthetic_old').content_html,
        '<p>Old body stays intact</p>',
      );
      assert.equal(
        db.prepare('SELECT sync_time FROM feeds WHERE id=?').get(TARGET_MP_ID)
          .sync_time,
        1700000000,
      );
    } finally {
      db.close();
    }
  });
});

test('default rehearsal uses a tiny synthetic source and reclaims databases after confirmed disconnect', async () => {
  await withCache(async (dir) => {
    const result = await runImageCopyRehearsal({
      baseDir: dir,
      testExpectedHash: domSha,
    });
    assert.equal(result.syntheticDatabase, true);
    assert.equal(result.firstPass.created, 1);
    assert.equal(result.oldRowsUnchanged, true);
    assert.equal(result.networkRequests, 0);
    const summary = JSON.parse(
      fs.readFileSync(path.join(result.audit, 'space-summary.json')),
    );
    assert.equal(summary.retained, false);
    assert.equal(summary.usage.databases, 0);
    assert(summary.removedSyntheticFiles >= 2);
    assert(
      !fs.existsSync(path.join(path.dirname(result.audit), '.test-run.lock')),
    );
    assert(fs.existsSync(path.join(result.audit, 'result.json')));
  });
});

test('failure after copying a fixture reclaims only owned databases and preserves input and unrelated files', async () => {
  await withCache(async (dir) => {
    const sourceDb = path.join(dir, 'source.db');
    makeSourceDb(sourceDb);
    const db = new DatabaseSync(sourceDb);
    try {
      db.prepare('UPDATE articles SET id=? WHERE id=?').run(
        TARGET_ARTICLE_ID,
        'WX_synthetic_old',
      );
    } finally {
      db.close();
    }
    const before = fs.readFileSync(sourceDb);
    const unrelated = path.join(dir, 'unrelated.db');
    fs.writeFileSync(unrelated, 'existing unapproved file');
    await assert.rejects(
      runImageCopyRehearsal({
        baseDir: dir,
        sourceDb,
        testExpectedHash: domSha,
      }),
      /TARGET_ALREADY_IN_SOURCE_DATABASE/,
    );
    const managed = path.join(dir, 'managed');
    const audit = path.join(
      managed,
      fs.readdirSync(managed).find((name) => name.startsWith('run-')),
    );
    const summary = JSON.parse(
      fs.readFileSync(path.join(audit, 'space-summary.json')),
    );
    assert.equal(summary.usage.databases, 0);
    assert.equal(summary.failure, 'TARGET_ALREADY_IN_SOURCE_DATABASE');
    assert.equal(summary.retained, false);
    assert(!fs.existsSync(path.join(managed, '.test-run.lock')));
    assert.deepEqual(fs.readFileSync(sourceDb), before);
    assert.equal(
      fs.readFileSync(unrelated, 'utf8'),
      'existing unapproved file',
    );
  });
});

test('image replay preserves its database and lease when disconnect is unconfirmed', async () => {
  await withCache(async (dir) => {
    const local = createRequire(path.join(ROOT, 'apps/server/package.json'));
    const client = local('@prisma/client'),
      Original = client.PrismaClient;
    client.PrismaClient = class extends Original {
      async $disconnect() {
        await super.$disconnect();
        throw Error('INJECTED_DISCONNECT_UNCONFIRMED');
      }
    };
    const originalFetch = global.fetch,
      originalDatabase = process.env.DATABASE_URL;
    try {
      await assert.rejects(
        runImageCopyRehearsal({ baseDir: dir, testExpectedHash: domSha }),
        /INJECTED_DISCONNECT_UNCONFIRMED/,
      );
      const managed = path.join(dir, 'managed');
      const audit = path.join(
        managed,
        fs.readdirSync(managed).find((name) => name.startsWith('run-')),
      );
      assert(fs.existsSync(path.join(audit, 'trial.db')));
      assert(fs.existsSync(path.join(managed, '.test-run.lock')));
      assert(!fs.existsSync(path.join(audit, 'space-summary.json')));
      assert.equal(global.fetch, originalFetch);
      assert.equal(process.env.DATABASE_URL, originalDatabase);
    } finally {
      client.PrismaClient = Original;
    }
  });
});
