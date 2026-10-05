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
