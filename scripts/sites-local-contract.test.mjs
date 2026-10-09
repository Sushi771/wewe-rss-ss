import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  createLocalSitesGateway,
  createSitesClient,
  createSitesWorker,
  parseSitesCommand,
} from './sites-local-contract.mjs';

const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw new Error('REAL_NETWORK_FORBIDDEN');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
});
const owner = async () => ({ isOwner: true }); // Synthetic server proof only.
const command = { action: 'capability', platform: 'xiaohongshu' };
const req = (body = command, options = {}) =>
  new Request('https://fixture.invalid/api/subscriptions', {
    method: 'POST',
    headers: {
      origin: 'https://fixture.invalid',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...options,
  });
function fixture() {
  const calls = [];
  const track = (name, value) => async (input) => {
    calls.push([name, input]);
    return value;
  };
  const caller = {
    feed: {
      addCapability: track('feed.addCapability', {
        available: false,
        source: 'wechat2rss',
        message: 'secret',
        sources: [],
      }),
      list: track('feed.list', {
        items: [
          {
            id: 'MP_WXS_12345',
            mpName: '合成公众号',
            token: 'secret',
            raw: 'private',
          },
        ],
        nextCursor: 'next-db-id',
      }),
    },
    article: {
      list: track('article.list', {
        items: [
          {
            id: 'old-short-id',
            mpId: 'MP_WXS_12345',
            title: '合成正文',
            publishTime: 1700000000,
            contentHtml: 'secret',
            sourceUrl: 'https://private.invalid/?token=secret',
            bodyRetry: 'private',
          },
        ],
      }),
    },
    xiaohongshu: {
      capability: track('xiaohongshu.capability', {
        sourceConfigured: false,
        canRefresh: false,
        message: 'private',
      }),
      list: track('xiaohongshu.list', {
        items: [
          {
            id: 'creator-1',
            displayName: '合成博主',
            profileUrl: 'private',
            externalAuthorId: 'private',
            lastMessage: 'private',
          },
        ],
      }),
      // Actual existing notes route selects these fields, without creatorId.
      notes: track('xiaohongshu.notes', {
        items: [
          {
            id: 'XHS_synthetic-note',
            title: '合成笔记',
            publishTime: 1700000000,
            status: 'complete',
          },
        ],
      }),
    },
  };
  return {
    caller,
    calls,
    gateway: createLocalSitesGateway({ authorize: owner, caller }),
  };
}
const rejects = (promise, code) => assert.rejects(promise, { code });

test('default Worker and local gateway reject unconfigured identity, including forged headers', async () => {
  const response = await worker.fetch(
    req(command, {
      headers: {
        origin: 'https://fixture.invalid',
        'content-type': 'application/json',
        'oai-authenticated-user-id': 'pretend-owner',
        authorization: 'pretend-secret',
        'OAI-Sites-Authorization': 'Bearer pretend-service',
      },
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: 'IDENTITY_UNCONFIGURED',
  });
  await rejects(
    createLocalSitesGateway().execute(command, { isOwner: true }),
    'IDENTITY_UNCONFIGURED',
  );
});
test('missing visitor and non-owner fail before transport or local routes', async () => {
  for (const [identity, code, status] of [
    [null, 'UNAUTHORIZED', 401],
    [{ isOwner: false }, 'FORBIDDEN', 403],
  ]) {
    let touched = false;
    const site = createSitesWorker({
      authorize: async () => identity,
      transport: {
        send: () => {
          touched = true;
        },
      },
    });
    const reply = await site.fetch(req());
    assert.equal(reply.status, status);
    assert.equal((await reply.json()).code, code);
    await rejects(
      createLocalSitesGateway({
        authorize: async () => identity,
        caller: {},
      }).execute(command),
      code,
    );
    assert.equal(touched, false);
  }
});
test('only three read operations are accepted; arbitrary URLs, paths, source credentials and owner IDs are rejected', () => {
  for (const action of [
    'refresh',
    'add',
    'delete',
    'retryBody',
    'export',
    'file',
    'settings',
    'account.list',
    'shell',
  ])
    assert.throws(() => parseSitesCommand({ action, platform: 'wechat' }), {
      code: 'BAD_REQUEST',
    });
  for (const key of [
    'url',
    'path',
    'directory',
    'html',
    'token',
    'ownerId',
    'isLocal',
  ])
    assert.throws(() => parseSitesCommand({ ...command, [key]: 'synthetic' }), {
      code: 'BAD_REQUEST',
    });
  for (const raw of [
    null,
    [],
    { ...command, platform: 'other' },
    { action: 'items', platform: 'wechat' },
    { action: 'authors', platform: 'wechat', limit: 51 },
    { action: 'authors', platform: 'wechat', limit: 1.5 },
    { action: 'authors', platform: 'xiaohongshu', cursor: 'invented' },
    { ...command, source: 'native' },
  ])
    assert.throws(() => parseSitesCommand(raw), { code: 'BAD_REQUEST' });
});
test('PC offline or missing transport returns a safe unavailable receipt once without fallback', async () => {
  const absent = await createSitesWorker({ authorize: owner }).fetch(req());
  assert.equal(absent.status, 503);
  let count = 0;
  const reply = await createSitesWorker({
    authorize: owner,
    transport: {
      send: () => {
        count++;
        throw new Error('private-address / local-path / token');
      },
    },
  }).fetch(req());
  assert.deepEqual(await reply.json(), { ok: false, code: 'PC_UNAVAILABLE' });
  assert.equal(count, 1);
  await rejects(
    createLocalSitesGateway({ authorize: owner }).execute(command),
    'PC_UNAVAILABLE',
  );
});
test('local authorization is checked independently and remains forbidden through the Worker', async () => {
  const { caller, calls } = fixture();
  const gateway = createLocalSitesGateway({
    authorize: async () => ({ isOwner: false }),
    caller,
  });
  const site = createSitesWorker({
    authorize: owner,
    transport: { send: (c) => gateway.execute(c) },
  });
  const reply = await site.fetch(req());
  assert.equal(reply.status, 403);
  assert.deepEqual(await reply.json(), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(calls, []);
});
test('raw local service and verifier exceptions are replaced with fixed safe errors', async () => {
  const { gateway, caller } = fixture();
  caller.xiaohongshu.capability = async () => {
    throw new Error('private-address token local-path');
  };
  await rejects(gateway.execute(command), 'PC_UNAVAILABLE');
  const broken = createLocalSitesGateway({
    authorize: async () => {
      throw new Error('private-owner');
    },
    caller,
  });
  await rejects(broken.execute(command), 'PC_UNAVAILABLE');
});
test('unconfigured source remains false; native/paid selection and legacy omitted default are passed unchanged', async () => {
  const { gateway, calls, caller } = fixture();
  assert.deepEqual(await gateway.execute(command), {
    action: 'capability',
    platform: 'xiaohongshu',
    sourceConfigured: false,
    canRefresh: false,
  });
  for (const source of [undefined, 'wechat2rss', 'native']) {
    caller.feed.addCapability = async (input) => {
      calls.push(['feed.addCapability', input]);
      return { available: false, source: input?.source ?? 'wechat2rss' };
    };
    const result = await gateway.execute({
      action: 'capability',
      platform: 'wechat',
      ...(source ? { source } : {}),
    });
    assert.equal(result.sourceConfigured, false);
    assert.equal(result.canRefresh, false);
    assert.deepEqual(calls.at(-1)[1], source ? { source } : undefined);
  }
});
test('explicit source mismatches and malformed capabilities cannot silently switch or report refresh enabled', async () => {
  const { gateway, caller } = fixture();
  await rejects(
    gateway.execute({
      action: 'capability',
      platform: 'wechat',
      source: 'native',
    }),
    'INVALID_RESPONSE',
  );
  caller.xiaohongshu.capability = async () => ({ sourceConfigured: 'yes' });
  await rejects(gateway.execute(command), 'INVALID_RESPONSE');
});
test('author metadata uses existing list routes, cursor and limit; sensitive fields are dropped', async () => {
  const { gateway, calls } = fixture();
  const wx = await gateway.execute({
    action: 'authors',
    platform: 'wechat',
    cursor: 'old-db-id',
    limit: 2,
  });
  assert.deepEqual(calls.at(-1), [
    'feed.list',
    { limit: 2, cursor: 'old-db-id' },
  ]);
  assert.deepEqual(wx.items, [{ id: 'MP_WXS_12345', name: '合成公众号' }]);
  assert.equal(wx.nextCursor, 'next-db-id');
  const xhs = await gateway.execute({
    action: 'authors',
    platform: 'xiaohongshu',
  });
  assert.deepEqual(xhs.items, [{ id: 'creator-1', name: '合成博主' }]);
  assert.equal('nextCursor' in xhs, false);
  assert.doesNotMatch(
    JSON.stringify([wx, xhs]),
    /secret|private|externalAuthorId|profileUrl|lastMessage/,
  );
});
test('cached item metadata uses existing author-scoped queries, keeps old IDs and never returns body/media URLs', async () => {
  const { gateway, calls } = fixture();
  const wx = await gateway.execute({
    action: 'items',
    platform: 'wechat',
    authorId: 'MP_WXS_12345',
  });
  assert.deepEqual(calls.at(-1), [
    'article.list',
    { mpId: 'MP_WXS_12345', limit: 20 },
  ]);
  assert.equal(wx.items[0].id, 'old-short-id');
  const xhs = await gateway.execute({
    action: 'items',
    platform: 'xiaohongshu',
    authorId: 'creator-1',
  });
  assert.deepEqual(calls.at(-1), [
    'xiaohongshu.notes',
    { creatorId: 'creator-1' },
  ]);
  assert.equal(xhs.items[0].authorId, 'creator-1');
  assert.doesNotMatch(
    JSON.stringify([wx, xhs]),
    /contentHtml|sourceUrl|secret|bodyRetry/,
  );
});
test('bounded XHS result reports truncation without fabricating pagination or completeness', async () => {
  const { gateway, caller } = fixture();
  caller.xiaohongshu.list = async () => ({
    items: Array.from({ length: 60 }, (_, i) => ({
      id: 'creator-' + i,
      displayName: '合成',
    })),
  });
  const result = await gateway.execute({
    action: 'authors',
    platform: 'xiaohongshu',
    limit: 2,
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
  assert.equal('nextCursor' in result, false);
});
test('cross-author, oversized or malformed metadata fails closed', async () => {
  const { gateway, caller } = fixture();
  caller.article.list = async () => ({
    items: [{ id: 'a', mpId: 'other', title: '合成', publishTime: 1 }],
  });
  await rejects(
    gateway.execute({
      action: 'items',
      platform: 'wechat',
      authorId: 'expected',
    }),
    'INVALID_RESPONSE',
  );
  caller.xiaohongshu.list = async () => ({
    items: [{ id: 'a', displayName: 'x'.repeat(501) }],
  });
  await rejects(
    gateway.execute({ action: 'authors', platform: 'xiaohongshu' }),
    'INVALID_RESPONSE',
  );
});
test('Worker checks same-origin JSON, endpoint, request size and unknown fields before sending anything', async () => {
  let count = 0;
  const site = createSitesWorker({
    authorize: owner,
    transport: {
      send: () => {
        count++;
      },
    },
  });
  for (const request of [
    req(command, {
      headers: {
        origin: 'https://other.invalid',
        'content-type': 'application/json',
      },
    }),
    req(command, { headers: { 'content-type': 'application/json' } }),
    req(command, {
      headers: {
        origin: 'https://fixture.invalid',
        'content-type': 'text/plain',
      },
    }),
    req({ ...command, extra: 'x'.repeat(4097) }),
    req({ ...command, token: 'private' }),
    new Request('https://fixture.invalid/api/subscriptions?url=private', {
      method: 'POST',
    }),
    new Request('https://fixture.invalid/trpc/account.list'),
  ]) {
    const reply = await site.fetch(request);
    assert.ok([400, 404].includes(reply.status));
  }
  assert.equal(count, 0);
});
test('Worker rejects results for a different action/platform and strips extra response fields', async () => {
  const { gateway } = fixture();
  const correct = await gateway.execute(command);
  const wrong = createSitesWorker({
    authorize: owner,
    transport: { send: async () => ({ ...correct, platform: 'wechat' }) },
  });
  assert.equal((await wrong.fetch(req())).status, 502);
  const site = createSitesWorker({
    authorize: owner,
    transport: { send: async () => ({ ...correct, token: 'private' }) },
  });
  assert.doesNotMatch(await (await site.fetch(req())).text(), /private|token/);
});
test('browser helper calls only same-origin endpoint with no backend or service authorization', async () => {
  const { gateway } = fixture();
  const site = createSitesWorker({
    authorize: owner,
    transport: { send: (c) => gateway.execute(c) },
  });
  const calls = [];
  const client = createSitesClient(async (url, options) => {
    calls.push([url, options]);
    return site.fetch(req(JSON.parse(options.body)));
  });
  assert.equal((await client(command)).sourceConfigured, false);
  assert.equal(calls[0][0], '/api/subscriptions');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].mode, 'same-origin');
  assert.equal(calls[0][1].redirect, 'error');
  assert.deepEqual(calls[0][1].headers, { 'Content-Type': 'application/json' });
});
test('browser receives only safe errors and never retries PC offline or anonymous access', async () => {
  for (const code of ['PC_UNAVAILABLE', 'UNAUTHORIZED']) {
    let count = 0;
    const client = createSitesClient(async () => {
      count++;
      return Response.json(
        { ok: false, code, token: 'private' },
        { status: 503 },
      );
    });
    await rejects(client(command), code);
    assert.equal(count, 1);
  }
  await rejects(
    createSitesClient(async () => {
      throw new Error('private-address');
    })(command),
    'PC_UNAVAILABLE',
  );
});
test('hung transport is bounded and receives an abort signal without a retry', async () => {
  let count = 0,
    signal;
  const site = createSitesWorker({
    authorize: owner,
    transport: {
      send: (_, options) => {
        count++;
        signal = options.signal;
        return new Promise(() => {});
      },
    },
  });
  const result = await site.fetch(req());
  assert.equal(result.status, 503);
  assert.equal(signal.aborted, true);
  assert.equal(count, 1);
});

test('sparse local metadata rows fail instead of serializing missing items as null', async () => {
  const { gateway, caller } = fixture();
  caller.xiaohongshu.list = async () => ({ items: Array(1) });
  await rejects(
    gateway.execute({ action: 'authors', platform: 'xiaohongshu' }),
    'INVALID_RESPONSE',
  );
});

test('oversized transport results retain truncation even when the sender claims false', async () => {
  const site = createSitesWorker({
    authorize: owner,
    transport: {
      send: async () => ({
        action: 'authors',
        platform: 'xiaohongshu',
        items: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
        truncated: false,
      }),
    },
  });
  const reply = await site.fetch(
    req({ action: 'authors', platform: 'xiaohongshu', limit: 1 }),
  );
  const result = await reply.json();
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.truncated, true);
});
