'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function fixture({ fail = false } = {}) {
  const source = ts.createSourceFile(
    'feeds.tsx',
    fs.readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8'),
    99,
    true,
    ts.ScriptKind.TSX,
  );
  let callback;
  function visit(node) {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(source) === 'ManagementFolders'
    )
      callback = node.attributes.properties.find(
        (p) => p.name?.getText(source) === 'onMove',
      ).initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(source);
  const items = [
    { id: 'a', groupId: null },
    { id: 'b', groupId: 'old' },
  ];
  const events = [];
  let visible = items,
    cache = { items },
    readResolve;
  const context = {
    Error,
    Set,
    movedIntoFolder: { current: false },
    draggedItem: 0,
    dragSnapshot: { current: items },
    setDraggedItem() {},
    setOrderedFeeds: (rows) => {
      visible = rows;
    },
    setSelectedIds: (ids) => events.push(['selection', ids]),
    queryUtils: {
      feed: {
        list: {
          cancel: async () => events.push(['cancel']),
          setData: (_, update) => {
            cache = update(cache);
          },
        },
      },
    },
    moveFeeds: {
      mutateAsync: async (input) => {
        events.push(['save', input]);
        if (fail)
          throw Error(
            typeof fail === 'string' ? fail : 'Synthetic mutation rejected',
          );
        return {
          ids: [...new Set(input.ids)],
          groupId: input.groupId,
          moved: new Set(input.ids).size,
        };
      },
    },
    refetchFeedList: () =>
      new Promise((resolve) => {
        events.push(['read']);
        readResolve = resolve;
      }),
    toast: { warning: (m) => events.push(['warning', m]) },
  };
  const code = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: 9 },
  }).outputText;
  const move = vm.runInNewContext(code, context);
  return {
    move,
    events,
    visible: () => visible,
    cache: () => cache,
    finishRead: (value) => readResolve(value),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
test('acknowledged folder drop releases the mutation before a stalled list refresh and publishes saved membership', async () => {
  const f = fixture();
  let completed = false;
  const operation = f.move(['a', 'a', 'b'], 'new').then(() => {
    completed = true;
  });
  await settle();
  assert.equal(
    completed,
    true,
    'a saved move must not hold every folder control behind an unrelated list read',
  );
  assert.deepEqual(
    f.visible().map((row) => row.groupId),
    ['new', 'new'],
  );
  assert.deepEqual(
    f.cache().items.map((row) => row.groupId),
    ['new', 'new'],
  );
  f.finishRead({ error: Error('Synthetic refresh failed') });
  await operation;
  await settle();
  assert(f.events.some((event) => event[0] === 'warning'));
  assert.equal(f.events.filter((event) => event[0] === 'save').length, 1);
  assert.deepEqual(
    f.visible().map((row) => row.groupId),
    ['new', 'new'],
    'refresh failure cannot undo an acknowledged commit',
  );
  assert.deepEqual(
    f.cache().items.map((row) => row.groupId),
    ['new', 'new'],
  );
});
test('rejected move preserves membership and selection, restores the drag snapshot, and does not reread or replay', async () => {
  const f = fixture({ fail: true });
  await assert.rejects(f.move(['a'], 'new'), /Synthetic mutation rejected/);
  assert.deepEqual(
    f.visible().map((row) => row.groupId),
    [null, 'old'],
  );
  assert.deepEqual(
    f.cache().items.map((row) => row.groupId),
    [null, 'old'],
  );
  assert(!f.events.some((event) => ['selection', 'read'].includes(event[0])));
});
test('explicit SQLite backup timeout never publishes a destination or clears the retained selection', async () => {
  const message = 'SQLite 一致性备份超时，本次未写入';
  const f = fixture({ fail: message });
  await assert.rejects(
    f.move(['a', 'b'], 'new'),
    (error) => error.message === message,
  );
  assert.deepEqual(
    f.visible().map((row) => row.groupId),
    [null, 'old'],
  );
  assert.deepEqual(
    f.cache().items.map((row) => row.groupId),
    [null, 'old'],
  );
  assert.deepEqual(
    f.events.map((event) => event[0]),
    ['cancel', 'save'],
  );
});
