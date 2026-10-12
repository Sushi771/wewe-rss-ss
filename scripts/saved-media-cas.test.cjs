const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { saveMediaCas } = require('./saved-media-cas.cjs');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE articles (id TEXT PRIMARY KEY, mp_id TEXT,
    updated_at INTEGER, content_html TEXT, source_url TEXT,
    verified_source_url TEXT, last_body_status TEXT, title TEXT, notes TEXT);
    INSERT INTO articles VALUES ('a','m',NULL,'old',NULL,NULL,NULL,'title','note');
    CREATE TABLE feeds (id TEXT); INSERT INTO feeds VALUES ('m');`);
  return db;
}
test('large saved body commits after slow preparation without an interactive deadline', async () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT * FROM articles').get();
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const body = '<p>note</p>' + 'x'.repeat(12_000_000);
    assert.equal(saveMediaCas(db, before, body, 'available'), 1);
    const after = db.prepare('SELECT * FROM articles').get();
    assert.equal(after.content_html, body);
    assert.equal(after.last_body_status, 'available');
    assert.equal(after.notes, before.notes);
    assert.equal(after.title, before.title);
    assert.equal(db.prepare('SELECT count(*) AS n FROM feeds').get().n, 1);
    assert.equal(saveMediaCas(db, after, body, 'available'), 0);
    assert.throws(
      () => saveMediaCas(db, before, body, 'available'),
      /CAS_CONFLICT/,
    );
  } finally {
    db.close();
  }
});
for (const key of [
  'id',
  'mp_id',
  'updated_at',
  'content_html',
  'source_url',
  'verified_source_url',
  'last_body_status',
]) {
  test(`concurrent ${key} change refuses stale overwrite`, () => {
    const db = fixture();
    try {
      const before = db.prepare('SELECT * FROM articles').get();
      db.prepare(`UPDATE articles SET ${key} = ?`).run(
        key === 'updated_at' ? 2 : 'edited',
      );
      const edited = db.prepare('SELECT * FROM articles').get();
      assert.throws(
        () => saveMediaCas(db, before, 'new', 'available'),
        /CAS_CONFLICT/,
      );
      assert.deepEqual(db.prepare('SELECT * FROM articles').get(), edited);
    } finally {
      db.close();
    }
  });
}
test('SQLite failure rolls back every changed field in the atomic statement', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT * FROM articles').get();
    db.exec(
      "CREATE TRIGGER fail BEFORE UPDATE ON articles BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    );
    assert.throws(
      () => saveMediaCas(db, before, 'new', 'available'),
      /injected failure/,
    );
    assert.deepEqual(db.prepare('SELECT * FROM articles').get(), before);
  } finally {
    db.close();
  }
});
