'use strict';
// Execute the actual sidebar's drag handlers with isolated local subscription rows.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function fixture({ fail = false } = {}) {
  const source = fs.readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8');
  const handlers = source.slice(
    source.indexOf('  const handleDragStart ='),
    source.indexOf('  const [currentMpId,'),
  );
  const items = [
    { id: 'a', groupId: 'g', order: 0 },
    { id: 'other', groupId: 'other', order: 7 },
    { id: 'b', groupId: 'g', order: 3 },
  ];
  const calls = [],
    context = {
      orderedFeeds: items,
      draggedItem: null,
      folderOperation: { current: false },
      movedIntoFolder: { current: false },
      dragSnapshot: { current: items },
      dragOrder: { current: items },
      acceptedFeedDrop: { current: false },
      setDraggedItem: (i) => {
        context.draggedItem = i;
      },
      setOrderedFeeds: (rows) => {
        context.orderedFeeds = rows;
      },
      setFolderBusy: (busy) => calls.push(['busy', busy]),
      queryUtils: {
        feed: { list: { cancel: async () => calls.push(['cancel']) } },
      },
      updateOrder: async (input) => {
        calls.push(['save', input]);
        if (fail) throw Error('offline failure');
      },
      refetchFeedList: async () => calls.push(['read']),
      toast: {
        success: (m) => calls.push(['success', m]),
        error: (m) => calls.push(['error', m]),
      },
    };
  vm.createContext(context);
  vm.runInContext(
    ts.transpileModule(
      `${handlers}\nglobalThis.handlers={handleDragStart,handleDragEnter,handleDragEnd};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
    ).outputText,
    context,
  );
  const event = {
    preventDefault() {
      calls.push(['prevent']);
    },
    dataTransfer: { setData() {} },
  };
  return {
    context,
    calls,
    start: (i) => context.handlers.handleDragStart(event, i),
    enter: (i) => context.handlers.handleDragEnter(event, i),
    end: () => context.handlers.handleDragEnd(),
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
test('cancelled drag restores snapshot and never saves; crossing other groups does not reorder them', async () => {
  const f = fixture();
  f.start(0);
  f.enter(1);
  assert.deepEqual(plain(f.context.orderedFeeds.map((f) => f.id)), [
    'a',
    'other',
    'b',
  ]);
  f.enter(2);
  assert.deepEqual(plain(f.context.orderedFeeds.map((f) => f.id)), [
    'b',
    'other',
    'a',
  ]);
  await f.end();
  assert.deepEqual(plain(f.context.orderedFeeds.map((f) => f.id)), [
    'a',
    'other',
    'b',
  ]);
  assert(!f.calls.some((c) => c[0] === 'save'));
});
test('accepted drop saves only own group with stale-order checks and synchronously blocks duplicate starts', async () => {
  const f = fixture();
  f.start(0);
  f.enter(2);
  f.context.acceptedFeedDrop.current = true;
  const saving = f.end();
  f.start(2);
  assert(f.calls.some((c) => c[0] === 'prevent'));
  await saving;
  const saves = f.calls.filter((c) => c[0] === 'save');
  assert.equal(saves.length, 1);
  assert.deepEqual(plain(saves[0][1]), [
    { id: 'b', order: 0, expectedOrder: 3, expectedGroupId: 'g' },
    { id: 'a', order: 1, expectedOrder: 0, expectedGroupId: 'g' },
  ]);
  assert(
    f.calls.findIndex((c) => c[0] === 'cancel') <
      f.calls.findIndex((c) => c[0] === 'save'),
  );
  assert.equal(f.context.folderOperation.current, false);
});
test('failed save restores source order and rereads; folder drop does not issue a second sorting request', async () => {
  const f = fixture({ fail: true });
  f.start(0);
  f.enter(2);
  f.context.acceptedFeedDrop.current = true;
  await f.end();
  assert.deepEqual(plain(f.context.orderedFeeds.map((f) => f.id)), [
    'a',
    'other',
    'b',
  ]);
  assert(f.calls.some((c) => c[0] === 'error'));
  assert(f.calls.some((c) => c[0] === 'read'));
  const moved = fixture();
  moved.start(0);
  moved.enter(2);
  moved.context.movedIntoFolder.current = true;
  await moved.end();
  assert(!moved.calls.some((c) => c[0] === 'save'));
});
