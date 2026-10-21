const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { splitSqliteStatements } = require('./sqlite-statements.cjs');
test('migration splitter preserves trigger blocks, comments and quoted semicolons', () => {
  const rows = splitSqliteStatements(
    `-- semi; comment\nCREATE TABLE x(id TEXT);CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO x VALUES ('a;b');UPDATE x SET id=CASE WHEN id='a;b' THEN 'c;d' ELSE id END;END;SELECT 'tail;';`,
  );
  assert.equal(rows.length, 3);
  assert.match(rows[1], /INSERT INTO x/);
  assert.match(rows[1], /UPDATE x/);
  assert.match(rows[2], /tail;/);
});
