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

const namespaceImport = "import * as snapshots from './sqlite-backup'; ";
for (const [name, body] of [
  ['literal namespace key', "await snapshots['createVerifiedSqliteBackup']();"],
  [
    'constant namespace key',
    "const key='createVerifiedSqliteBackup'; await snapshots[key]();",
  ],
  [
    'template namespace key',
    'await snapshots[`createVerifiedSqliteBackup`]();',
  ],
  [
    'extracted computed function',
    "const key='createVerifiedSqliteBackup'; const take=snapshots[key]; await take();",
  ],
])
  test(`independent ordinary-write regression: ${name} is refused`, () => {
    const found = inspect(namespaceImport + `async function save(){${body}}`);
    assert.notDeepEqual(
      violations(found, { boundaries: [rule('save', 0)] }),
      [],
    );
  });

for (const body of [
  'const key=choose(); await snapshots[key]();',
  "const key='createVerifiedSqliteBackup'; await snapshots[`${key}`]();",
  "const key='createVerifiedSqliteBackup'; await snapshots?.[key]?.();",
  'const key=choose(); await (snapshots as any)[key]();',
  'const key=choose(); const {[key]: take}=snapshots; await take();',
  'const {createVerifiedSqliteBackup: take}=snapshots; await take();',
  'const take=snapshots.createVerifiedSqliteBackup; await take();',
  'const second=snapshots; await second[choose()]();',
  'await Reflect.get(snapshots, choose())();',
  'await snapshots.createVerifiedSqliteBackup.call(null);',
  'register(snapshots);',
])
  test(`unresolved/extracted namespace capability needs explicit review: ${body}`, () => {
    const found = inspect(namespaceImport + `async function remove(){${body}}`);
    assert.match(
      violations(found, { boundaries: [rule('remove')] }).join(),
      /Unreviewed backup alias\/reference/,
    );
  });

for (const declaration of [
  "import snapshots = require('./sqlite-backup');",
  "const snapshots=require('./sqlite-backup');",
  "const snapshots=await import('./sqlite-backup');",
  "const snapshots=(await import('./sqlite-backup')) as any;",
  "const snapshots=require('.\\\\sqlite-backup');",
  "const snapshots=await import('./sqlite-backup.js?review=1');",
])
  test(`module loading cannot hide dynamic calls: ${declaration}`, () => {
    assert.match(
      violations(
        inspect(
          declaration +
            ' async function save(){const key=choose();return snapshots[key]();}',
        ),
        { boundaries: [] },
      ).join(),
      /Unreviewed/,
    );
  });

for (const body of [
  "await require('./sqlite-backup')[choose()]();",
  "await (await import('./sqlite-backup'))[choose()]();",
  "const key=choose(); const {[key]: take}=require('./sqlite-backup'); await take();",
  "register(require('./sqlite-backup'));",
])
  test(`inline module capability cannot escape review: ${body}`, () => {
    assert.match(
      violations(inspect(`async function save(){${body}}`), {
        boundaries: [],
      }).join(),
      /Unreviewed/,
    );
  });

test('backup capability re-export requires review rather than creating an invisible barrel', () => {
  assert.match(
    violations(inspect("export * from './sqlite-backup';"), {
      boundaries: [],
    }).join(),
    /Unreviewed/,
  );
});

for (const member of [
  '.createVerifiedSqliteBackup',
  "['createVerifiedSqliteBackup']",
  '[`createVerifiedSqliteBackup`]',
])
  test(`a directly registered static namespace gate still passes: ${member}`, () => {
    const found = inspect(
      namespaceImport + `async function remove(){await snapshots${member}();}`,
    );
    assert.equal(found.calls.length, 1);
    assert.deepEqual(violations(found, { boundaries: [rule('remove')] }), []);
  });

test('unrelated dynamic namespaces, type-only imports and unused imports do not fail', () => {
  for (const source of [
    namespaceImport,
    "import type * as snapshots from './sqlite-backup'; type Snapshot = typeof snapshots;",
    "import * as ordinary from './ordinary-values'; ordinary[choose()]();",
    "const ordinary=require('./ordinary-values'); ordinary[choose()]();",
  ])
    assert.deepEqual(violations(inspect(source), { boundaries: [] }), []);
});
