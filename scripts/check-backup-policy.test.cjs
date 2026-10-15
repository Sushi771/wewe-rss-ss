const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectSource, violations } = require('./check-backup-policy.cjs');
const rule = (scope, maxCalls = 1, gate = 'createVerifiedSqliteBackup') => ({
  file: 'writer.ts',
  scope,
  gate,
  maxCalls,
  rationale: 'Explicit reviewed fixture boundary',
});
const inspect = (source) => inspectSource(source, 'writer.ts');

test('removing a required high-risk gate fails rather than silently weakening deletion', () => {
  assert.match(
    violations(inspect('async function remove(){}'), {
      boundaries: [rule('remove')],
    }).join(),
    /Required protected boundary is missing/,
  );
});
test('unknown generic write wrappers fail closed', () => {
  const found = inspect(
    "import {createVerifiedSqliteBackup} from './sqlite-backup'; async function save(){await createVerifiedSqliteBackup();}",
  );
  assert.match(violations(found, { boundaries: [] }).join(), /Unregistered/);
});
test('ordinary calls have a zero budget even inside nested callbacks', () => {
  const found = inspect(
    'class Service { async recordCollectionResult(){ return runner(async()=>{await createVerifiedSqliteBackup()}) } }',
  );
  assert.match(
    violations(found, {
      boundaries: [rule('Service.recordCollectionResult', 0)],
    }).join(),
    /exceeds 0/,
  );
});
test('renaming the imported backup does not bypass registration', () => {
  const found = inspect(
    "import {createVerifiedSqliteBackup as protect} from './sqlite-backup'; async function remove(){await protect();}",
  );
  assert.equal(found.calls[0].gate, 'createVerifiedSqliteBackup');
  assert.deepEqual(violations(found, { boundaries: [rule('remove')] }), []);
});
test('passing backup capability or an alias to another writer is rejected', () => {
  const found = inspect(
    "import {createVerifiedSqliteBackup as protect} from './sqlite-backup'; const again=protect; register(protect);",
  );
  assert.equal(found.references.length, 2);
  assert.equal(violations(found, { boundaries: [] }).length, 2);
});
test('namespace backup calls and repeated protection are counted', () => {
  const found = inspect(
    'async function remove(){await b.createVerifiedSqliteBackup();await b.createVerifiedSqliteBackup();}',
  );
  assert.equal(found.calls.length, 2);
  assert.match(
    violations(found, { boundaries: [rule('remove')] }).join(),
    /exceeds 1/,
  );
});
test('using a protected-delete wrapper in an ordinary writer needs explicit review too', () => {
  const found = inspect(
    "import {protectedDelete as erase} from './protected-delete'; async function edit(){await erase(db,options);}",
  );
  assert.equal(found.calls[0].gate, 'protectedDelete');
  assert.match(violations(found, { boundaries: [] }).join(), /Unregistered/);
});
test('route property names distinguish protected existing deletion entrypoints', () => {
  const found = inspect(
    'class Router { articleRouter=router({delete: mutation(async()=>protectedArticleDelete(db,id))}); }',
  );
  assert.equal(found.calls[0].scope, 'Router.articleRouter.delete');
  assert.deepEqual(
    violations(found, {
      boundaries: [
        rule('Router.articleRouter.delete', 1, 'protectedArticleDelete'),
      ],
    }),
    [],
  );
});
test('comments, strings and imports alone do not request a snapshot', () => {
  assert.deepEqual(
    inspect(
      "import {createVerifiedSqliteBackup} from './sqlite-backup'; // createVerifiedSqliteBackup()\nconst text='createVerifiedSqliteBackup()';",
    ),
    { calls: [], references: [] },
  );
});

test('wildcard, duplicate, missing rationale and unlimited rules are invalid', () => {
  const valid = rule('remove');
  assert.match(
    violations(inspect(''), { boundaries: [valid, valid] }).join(),
    /Duplicate/,
  );
  for (const invalid of [
    { ...valid, maxCalls: Infinity },
    { ...valid, maxCalls: 2 },
    { ...valid, rationale: '' },
    { ...valid, gate: '*' },
  ])
    assert.match(
      violations(inspect(''), { boundaries: [invalid] }).join(),
      /Invalid/,
    );
});

test('computed namespace calls and namespace aliases cannot hide protection', () => {
  assert.equal(
    inspect("const indirect=backup['createVerifiedSqliteBackup'];").references
      .length,
    1,
  );
  assert.equal(
    inspect(
      "async function remove(){await backup['createVerifiedSqliteBackup']();}",
    ).calls.length,
    1,
  );
  assert.equal(
    inspect('const indirect=backup.createVerifiedSqliteBackup;').references
      .length,
    1,
  );
});
