'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', {
    paths: [path.join(__dirname, '../apps/web')],
  }),
);
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        path.join(__dirname, '../apps/web/src/utils', name + '.ts'),
        'utf8',
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      module,
      exports: module.exports,
      require: (value) => load(value.replace('./', '')),
      Date,
      Intl,
      URLSearchParams,
    },
  );
  return (cache[name] = module.exports);
}
const state = load('feed-browse-state');
const plain = (x) => JSON.parse(JSON.stringify(x));
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};
test('relative shortcut survives reload and Shanghai midnight; manual dates stay fixed', () => {
  const storage = memory(),
    filters = state.emptyBrowseFilters();
  filters.articleDates = {
    mode: 'day',
    start: '2026-10-10',
    end: '',
    shortcut: 'today',
  };
  filters.search = 'alpha';
  filters.articleSort = 'likeCount';
  filters.articleDirection = 'asc';
  filters.folderFilter = 'group-a';
  state.saveBrowseFilters(storage, filters, new Date('2026-10-10T15:59:59Z'));
  const restored = state.readBrowseFilters(
    storage,
    new Date('2026-10-10T16:00:01Z'),
  );
  assert.equal(restored.articleDates.start, '2026-10-11');
  assert.equal(restored.articleDates.shortcut, 'today');
  assert.equal(restored.search, 'alpha');
  assert.equal(restored.articleSort, 'likeCount');
  filters.articleDates = { mode: 'day', start: '2026-10-10', end: '' };
  state.saveBrowseFilters(storage, filters, new Date('2026-10-10T15:59:59Z'));
  assert.equal(
    state.readBrowseFilters(storage, new Date('2026-10-10T16:00:01Z'))
      .articleDates.start,
    '2026-10-10',
  );
});
test('explicit URL query defaults absent fields; source URL cannot inherit cached group', () => {
  const storage = memory(),
    filters = state.emptyBrowseFilters();
  filters.search = 'old-hidden-keyword';
  filters.folderFilter = 'old-group';
  filters.articleDirection = 'asc';
  state.saveBrowseFilters(storage, filters);
  const explicit = state.initialBrowseFilters(
    storage,
    'source-b',
    '?search=new&group=wrong&dateStart=2026-10-01&direction=desc',
  );
  assert.equal(explicit.search, 'new');
  assert.equal(explicit.folderFilter, 'all');
  assert.equal(explicit.articleDates.start, '2026-10-01');
  assert.equal(explicit.articleDirection, 'desc');
  assert.equal(
    state.initialBrowseFilters(storage, undefined, '?direction=asc').search,
    '',
  );
  assert.equal(
    state.initialBrowseFilters(storage, 'source-b', '').folderFilter,
    'all',
  );
});
test('malformed, old version, expired, impossible dates and blocked storage use defaults', () => {
  for (const value of [
    'bad-json',
    JSON.stringify({ version: 99 }),
    JSON.stringify({
      version: 1,
      at: Date.now() - 31 * 86400000,
      filters: state.emptyBrowseFilters(),
    }),
  ]) {
    const storage = memory();
    storage.setItem(state.FILTER_STORAGE_KEY, value);
    assert.deepEqual(
      plain(state.readBrowseFilters(storage)),
      plain(state.emptyBrowseFilters()),
    );
  }
  const storage = memory(),
    filters = state.emptyBrowseFilters();
  filters.articleDates.start = '2026-02-30';
  state.saveBrowseFilters(storage, filters);
  assert.equal(storage.getItem(state.FILTER_STORAGE_KEY), null);
  const denied = {
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('full');
    },
    removeItem() {
      throw Error('denied');
    },
  };
  assert.deepEqual(
    plain(state.readBrowseFilters(denied)),
    plain(state.emptyBrowseFilters()),
  );
  assert.doesNotThrow(() =>
    state.saveBrowseFilters(denied, state.emptyBrowseFilters()),
  );
  assert.doesNotThrow(() => state.forgetBrowsePositions(denied));
});
test('position history bounds pages and views, ignores damaged data, clear removes it', () => {
  const storage = memory();
  for (let i = 0; i < 12; i++)
    state.saveBrowsePosition(storage, 'view-' + i, {
      pages: 30,
      top: 200,
      anchor: 'article-20',
      offset: -8,
    });
  const entries = JSON.parse(
    storage.getItem(state.POSITION_STORAGE_KEY),
  ).entries;
  assert.equal(Object.keys(entries).length, 8);
  assert(Object.values(entries).every((value) => value.pages === 10));
  state.forgetBrowsePositions(storage);
  assert.equal(storage.getItem(state.POSITION_STORAGE_KEY), null);
  storage.setItem(
    state.POSITION_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      entries: { bad: { at: Date.now(), pages: -1, top: -1 } },
    }),
  );
  assert.equal(state.readBrowsePosition(storage, 'bad'), undefined);
});
