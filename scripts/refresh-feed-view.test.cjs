const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve('apps/web/package.json'));
const code = req('typescript').transpileModule(
  fs.readFileSync('apps/web/src/utils/refresh-feed-view.ts', 'utf8'),
  { compilerOptions: { module: 1, target: 9 } },
).outputText;
const exportsObject = {};
vm.runInNewContext(code, { exports: exportsObject });
const { refreshFeedViews } = exportsObject;
function savedSubscriptionsFixture({
  listFailure = false,
  articleFailure = false,
} = {}) {
  const ts = req('typescript');
  const source = ts.createSourceFile(
    'feeds.tsx',
    fs.readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callback;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'refreshSavedSubscriptions'
    )
      callback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert(callback);
  const events = [],
    saved = [{ id: 'MP_WXS_1234567890', mpName: '' }];
  const code = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: 9 },
  }).outputText;
  const fn = vm.runInNewContext(code, {
    queryUtils: {
      feed: { list: { cancel: async () => events.push('cancel') } },
      article: {
        list: {
          reset: async () => {
            events.push('article');
            if (articleFailure) throw Error('synthetic article read failure');
          },
        },
        summary: { invalidate: async () => events.push('summary') },
      },
    },
    refetchFeedList: async () => {
      events.push('feed');
      if (listFailure) throw Error('synthetic feed read failure');
      return { data: { items: saved } };
    },
    setOrderedFeeds: (items) => {
      assert.equal(items, saved);
      events.push('visible');
    },
    setFolderFilter: (fn) => {
      assert.equal(fn('fixture-group'), 'all');
      events.push('reveal');
    },
    folderFilter: 'fixture-group',
  });
  return { fn, events };
}
test('actual saved-subscription callback reveals the acknowledged list before secondary article failures', async () => {
  const { fn, events } = savedSubscriptionsFixture({ articleFailure: true });
  await fn(true);
  assert.deepEqual(events, [
    'cancel',
    'feed',
    'visible',
    'reveal',
    'article',
    'summary',
  ]);
});
test('actual saved-subscription callback keeps a primary list failure visible instead of claiming it was loaded', async () => {
  const { fn, events } = savedSubscriptionsFixture({ listFailure: true });
  await assert.rejects(fn(true), /synthetic feed read failure/);
  assert.deepEqual(events, ['cancel', 'feed']);
});
test('starts all existing cache operations before awaiting any and reports a failure without skipping the others', async () => {
  const started = [],
    finish = [];
  const pending = refreshFeedViews(
    ...['feed', 'article', 'summary'].map((name) => () => {
      started.push(name);
      return new Promise((resolve, reject) => finish.push({ resolve, reject }));
    }),
  );
  assert.deepEqual(started, ['feed', 'article', 'summary']);
  finish[0].reject(Error('synthetic local query error'));
  finish[1].resolve();
  finish[2].resolve();
  await assert.rejects(pending, /synthetic local query error/);
});
test('installed tRPC link uses one batch per existing authenticated client, without sharing account requests', async () => {
  const { createTRPCUntypedClient, httpBatchLink } = req('@trpc/client');
  const requests = [];
  const client = (authorization) =>
    createTRPCUntypedClient({
      links: [
        httpBatchLink({
          url: 'http://127.0.0.1:65530/trpc',
          headers: () => ({ authorization }),
          fetch: async (url, init) => {
            const names = new URL(url).pathname.split('/').at(-1).split(',');
            requests.push({
              authorization: new Headers(init.headers).get('authorization'),
              names,
            });
            return new Response(
              JSON.stringify(
                names.map(() => ({ result: { data: { fixture: true } } })),
              ),
              { headers: { 'content-type': 'application/json' } },
            );
          },
        }),
      ],
    });
  const a = client('synthetic-a'),
    b = client('synthetic-b');
  const refresh = (c) =>
    refreshFeedViews(
      () => c.query('feed.list', {}),
      () => c.query('article.list', { mpId: 'synthetic-publisher' }),
      () => c.query('article.summary', { mpId: 'synthetic-publisher' }),
    );
  await Promise.all([refresh(a), refresh(b)]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => r.authorization).sort(), [
    'synthetic-a',
    'synthetic-b',
  ]);
  for (const r of requests)
    assert.deepEqual(r.names, ['feed.list', 'article.list', 'article.summary']);
});
