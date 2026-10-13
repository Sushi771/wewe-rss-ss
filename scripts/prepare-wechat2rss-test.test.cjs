const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { prepareWechat2RssTest } = require('./prepare-wechat2rss-test.cjs');
const id = 'MP_WXS_1234567890';
function cleanup(root) {
  const target = fs.realpathSync(root);
  assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('wewe-wechat-test-'));
  fs.rmSync(target, { recursive: true, force: true });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-wechat-test-'));
  const source = path.join(root, 'source.db');
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE feeds(id TEXT PRIMARY KEY, mp_name TEXT, collection_channel TEXT, status INTEGER, public_album_ids TEXT, updated_at TEXT);
    CREATE TABLE articles(id TEXT PRIMARY KEY, mp_id TEXT REFERENCES feeds(id), body TEXT, image BLOB);
    INSERT INTO feeds VALUES('${id}','synthetic publisher','owner-weread-latest',1,'["synthetic-old-album"]','old-time');
    INSERT INTO feeds VALUES('MP_WXS_1111111111','other','public-album',1,'["keep"]','old-time');
    INSERT INTO articles VALUES('old','${id}','whole cached body',X'010203');`);
  db.close();
  return {
    root,
    source,
    settings: {
      source,
      feedId: id,
      expectedName: 'synthetic publisher',
      expectedChannel: 'owner-weread-latest',
    },
  };
}
const digest = (p) =>
  createHash('sha256').update(fs.readFileSync(p)).digest('hex');
test('consistent SQLite copy binds only the explicitly matched old feed and preserves all content', async () => {
  const f = fixture(),
    before = digest(f.source);
  try {
    const result = await prepareWechat2RssTest(f.settings, f.root);
    assert.equal(digest(f.source), before);
    assert.equal(result.requests, 0);
    assert.equal(result.enablesCollection, false);
    const source = new DatabaseSync(f.source, { readOnly: true }),
      copy = new DatabaseSync(result.database, { readOnly: true });
    try {
      assert.deepEqual(
        copy.prepare('SELECT * FROM articles').all(),
        source.prepare('SELECT * FROM articles').all(),
      );
      const expected = source.prepare('SELECT * FROM feeds ORDER BY id').all();
      expected.find((row) => row.id === id).collection_channel = 'wechat2rss';
      assert.deepEqual(
        copy.prepare('SELECT * FROM feeds ORDER BY id').all(),
        expected,
      );
    } finally {
      source.close();
      copy.close();
    }
  } finally {
    cleanup(f.root);
  }
});
for (const [name, override, code] of [
  [
    'stale channel',
    { expectedChannel: 'unbound' },
    'WECHAT2RSS_TEST_BINDING_CONFLICT',
  ],
  [
    'wrong identity',
    { expectedName: 'different publisher' },
    'WECHAT2RSS_TEST_IDENTITY_MISMATCH',
  ],
  [
    'missing feed',
    { feedId: 'MP_WXS_2222222222' },
    'WECHAT2RSS_TEST_IDENTITY_MISMATCH',
  ],
  [
    'invalid channel',
    { expectedChannel: 'auto' },
    'WECHAT2RSS_TEST_ARGUMENT_INVALID',
  ],
])
  test(`refuses ${name} without touching original data`, async () => {
    const f = fixture(),
      before = digest(f.source);
    try {
      await assert.rejects(
        prepareWechat2RssTest({ ...f.settings, ...override }, f.root),
        new RegExp(code),
      );
      assert.equal(digest(f.source), before);
    } finally {
      cleanup(f.root);
    }
  });
test('refuses unreviewed feed triggers instead of preserving hidden side effects', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.source);
  db.exec(
    "CREATE TRIGGER hidden AFTER UPDATE ON feeds BEGIN UPDATE articles SET body='lost'; END",
  );
  db.close();
  try {
    await assert.rejects(
      prepareWechat2RssTest(f.settings, f.root),
      /WECHAT2RSS_TEST_SCHEMA_UNVERIFIED/,
    );
  } finally {
    cleanup(f.root);
  }
});
test('a live WAL source is copied consistently without checkpointing or writing it', async () => {
  const f = fixture();
  const writer = new DatabaseSync(f.source);
  writer.exec(
    "PRAGMA journal_mode=WAL; INSERT INTO articles VALUES('wal','MP_WXS_1234567890','committed WAL body',X'0405')",
  );
  const before = digest(f.source);
  try {
    const result = await prepareWechat2RssTest(f.settings, f.root);
    const copy = new DatabaseSync(result.database, { readOnly: true });
    try {
      assert.equal(
        copy.prepare("SELECT body FROM articles WHERE id='wal'").get().body,
        'committed WAL body',
      );
    } finally {
      copy.close();
    }
    assert.equal(digest(f.source), before);
  } finally {
    writer.close();
    cleanup(f.root);
  }
});
