'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
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
        (p) => p.name?.getText(source) === 'onReorder',
      ).initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(source);
  const items = ['a', 'b', 'c'].map((id, order) => ({ id, name: id, order }));
  const events = [];
  let cache = { items },
    readResolve;
  const scope = {
    Map,
    queryUtils: {
      feed: {
        groups: {
          cancel: async () => events.push(['cancel']),
          setData: (_, update) => {
            cache = update(cache);
          },
        },
      },
    },
    reorderFolders: {
      mutateAsync: async (input) => {
        events.push(['save', input]);
        if (fail) throw Error('SQLite 一致性备份超时，本次未写入');
        return { ids: input.ids };
      },
    },
    folders: {
      refetch: () =>
        new Promise((resolve) => {
          events.push(['read']);
          readResolve = resolve;
        }),
    },
    toast: { warning: (message) => events.push(['warning', message]) },
  };
  const code = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: 9 },
  }).outputText;
  const reorder = vm.runInNewContext(code, scope);
  return {
    reorder,
    scope,
    events,
    items,
    cache: () => cache,
    finishRead: (result) => readResolve(result),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
test('saved folder order completes before a hung reread; refresh errors never roll back or reject a committed sort', async () => {
  const f = fixture();
  let finished = false;
  const saving = f.reorder(['c', 'b', 'a'], ['a', 'b', 'c']).then(() => {
    finished = true;
  });
  await settle();
  assert.equal(finished, true);
  assert.deepEqual(
    f.cache().items.map((item) => item.id),
    ['c', 'b', 'a'],
  );
  f.finishRead({ error: Error('Synthetic group reread failed') });
  await saving;
  await settle();
  assert.deepEqual(
    f.cache().items.map((item) => item.id),
    ['c', 'b', 'a'],
  );
  assert.match(
    f.events.find((event) => event[0] === 'warning')[1],
    /排序已保存/,
  );
  assert.equal(f.events.filter((event) => event[0] === 'save').length, 1);
});
test('rejected folder sort keeps source order and error without waiting on a second read', async () => {
  const f = fixture({ fail: true });
  let rejected;
  void f.reorder(['c', 'b', 'a'], ['a', 'b', 'c']).catch((error) => {
    rejected = error;
  });
  await settle();
  assert.equal(rejected?.message, 'SQLite 一致性备份超时，本次未写入');
  assert.deepEqual(
    f.cache().items.map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    f.events.map((event) => event[0]),
    ['cancel', 'save'],
  );
});
test('installed QueryObserver ignores a late old folder order after a second saved reorder', async () => {
  const { QueryClient, QueryObserver } = require(
    require.resolve('@tanstack/react-query', {
      paths: [path.resolve('apps/web')],
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
  });
  const key = ['feed.groups'];
  const f = fixture();
  const reads = [];
  client.setQueryData(key, { items: f.items });
  const observer = new QueryObserver(client, {
    queryKey: key,
    enabled: false,
    queryFn: () => new Promise((resolve) => reads.push(resolve)),
  });
  let visible = f.items;
  const unsubscribe = observer.subscribe((result) => {
    if (result.data) visible = result.data.items;
  });
  f.scope.queryUtils = {
    feed: {
      groups: {
        cancel: () => client.cancelQueries(key),
        setData: (_, update) => client.setQueryData(key, update),
      },
    },
  };
  f.scope.folders = { refetch: () => observer.refetch() };
  const snapshot = (ids) => ({
    items: ids.map((id, order) => ({ id, name: id, order })),
  });
  try {
    await f.reorder(['c', 'b', 'a'], ['a', 'b', 'c']);
    await settle();
    await f.reorder(['b', 'a', 'c'], ['c', 'b', 'a']);
    await settle();
    reads[1](snapshot(['b', 'a', 'c']));
    await settle();
    reads[0](snapshot(['c', 'b', 'a']));
    await settle();
    assert.deepEqual(
      client.getQueryData(key).items.map((item) => item.id),
      ['b', 'a', 'c'],
    );
    assert.deepEqual(
      visible.map((item) => item.id),
      ['b', 'a', 'c'],
    );
  } finally {
    unsubscribe();
    client.clear();
  }
});
