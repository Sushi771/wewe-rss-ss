import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  createLocalSitesGateway,
  createSitesClient,
  createSitesWorker,
  parseSitesCommand,
  sitesDownloadBlob,
  createWechatCacheProjector,
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
test('invalid operations and extra URLs, paths, credentials and owner IDs are rejected', () => {
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

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const bodyCommand = {
  action: 'body',
  platform: 'xiaohongshu',
  authorId: 'creator-1',
  itemId: 'XHS_synthetic-note',
};
const refreshCommand = {
  action: 'refresh',
  platform: 'xiaohongshu',
  authorId: 'creator-1',
  operationId: 'synthetic-operation',
  confirmed: true,
};
function cacheFixture(options = {}) {
  const { caller, calls } = fixture();
  const cached = {
    title: '合成 <script>标题</script>',
    publishTime: 1700000000,
    text: '完整合成正文\n<img src="https://private.invalid">',
    images: [png],
  };
  const track = (name, value) => async (input) => {
    calls.push([name, input]);
    return value;
  };
  caller.xiaohongshu.body = track('xiaohongshu.body', cached);
  caller.xiaohongshu.capability = track('xiaohongshu.capability', {
    sourceConfigured: true,
    canRefresh: true,
  });
  caller.xiaohongshu.list = track('xiaohongshu.list', {
    items: [{ id: 'creator-1', enabled: true, displayName: '合成博主' }],
  });
  caller.xiaohongshu.refresh = track('xiaohongshu.refresh', {
    status: 'complete',
    added: 1,
    message: 'private receipt',
  });
  caller.article.byId = track('article.byId', {
    id: 'old-short-id',
    mpId: 'MP_WXS_12345',
    title: cached.title,
    publishTime: cached.publishTime,
    contentHtml: '<div id="js_content">cached synthetic body</div>',
    lastBodyStatus: 'available',
    sourceUrl: 'private',
  });
  caller.feed.byId = track('feed.byId', {
    id: 'MP_WXS_12345',
    collectionRoute: { channel: 'wechat2rss' },
  });
  caller.feed.addCapability = track('feed.addCapability', {
    source: 'wechat2rss',
    available: true,
  });
  caller.feed.refreshArticles = track('feed.refreshArticles', [
    {
      source: 'wechat2rss',
      status: 'pending',
      complete: false,
      accepted: true,
      created: 0,
      message: 'private',
    },
  ]);
  const settings = {
    authorize: owner,
    caller,
    projectWechatCachedBody: async () => ({
      text: cached.text,
      images: cached.images,
    }),
    refreshAccess: async () => ({
      sourceAvailable: true,
      accountAvailable: true,
      manualAccessConfirmed: true,
      budgetApproved: true,
    }),
    ...options,
  };
  return { caller, calls, cached, gateway: createLocalSitesGateway(settings) };
}
const clientFor = (gateway) =>
  createSitesClient(async (_, options) =>
    createSitesWorker({
      authorize: owner,
      transport: { send: (c) => gateway.execute(c) },
    }).fetch(req(JSON.parse(options.body))),
  );

test('new commands require explicit IDs and confirmation and still reject paths, URLs, budgets and tRPC selectors', () => {
  assert.deepEqual(parseSitesCommand(bodyCommand), bodyCommand);
  assert.deepEqual(parseSitesCommand(refreshCommand), refreshCommand);
  for (const command of [
    { ...refreshCommand, confirmed: false },
    { ...refreshCommand, operationId: '' },
    { ...bodyCommand, itemId: '' },
    { ...bodyCommand, limit: 1 },
    { ...refreshCommand, method: 'account.list' },
    { ...refreshCommand, budgetApproved: true },
    { ...refreshCommand, accountToken: 'private' },
    { ...bodyCommand, url: 'https://private.invalid' },
    { ...bodyCommand, directory: '../vault' },
    {
      action: 'refresh',
      platform: 'wechat',
      authorId: 'f',
      operationId: 'o',
      confirmed: true,
    },
  ])
    assert.throws(() => parseSitesCommand(command), { code: 'BAD_REQUEST' });
});
test('XHS cached body travels through the actual contract chain with ordered actual PNG bytes and no private fields', async () => {
  const { gateway, calls, cached } = cacheFixture();
  cached.images = [png, png];
  const result = await clientFor(gateway)(bodyCommand);
  assert.deepEqual(result.images, [png, png]);
  assert.equal(result.text, cached.text);
  assert.deepEqual(calls, [
    [
      'xiaohongshu.body',
      { creatorId: 'creator-1', noteId: 'XHS_synthetic-note' },
    ],
  ]);
  assert.equal(result.itemId, bodyCommand.itemId);
  assert.equal('sourceUrl' in result, false);
});
test('cached-only browser download is self-contained escaped HTML with a real Blob, never a PC path or remote export call', async () => {
  const { gateway, calls } = cacheFixture();
  const download = await clientFor(gateway)({
    ...bodyCommand,
    action: 'download',
  });
  const result = sitesDownloadBlob(download);
  assert.equal(result.filename, '缓存图文.html');
  assert.equal(result.blob.type, 'text/html');
  const html = await result.blob.text();
  assert.match(html, /&lt;script&gt;标题&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=/);
  assert.match(html, /default-src &#39;none&#39;/);
  assert.ok(html.includes(png));
  assert.doesNotMatch(
    html,
    /<script>|src="https?:|Obsidian|markdownPath|file:\/\//,
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['xiaohongshu.body'],
  );
});
test('remote images, MIME mismatches, truncated/fake bytes, sparse media and empty cached bodies fail without fallback', async () => {
  const { gateway, cached, calls } = cacheFixture();
  for (const images of [
    ['https://private.invalid/image.png'],
    [png.replace('image/png', 'image/jpeg')],
    ['data:image/png;base64,SGVsbG8='],
    [png.slice(0, -4)],
    Array(1),
  ]) {
    cached.images = images;
    await rejects(gateway.execute(bodyCommand), 'CACHE_UNAVAILABLE');
  }
  cached.images = [];
  cached.text = '';
  await rejects(gateway.execute(bodyCommand), 'CACHE_UNAVAILABLE');
  assert.ok(calls.every((c) => c[0] === 'xiaohongshu.body'));
});
test('text-only cached body works, but oversized text, media count and aggregate bytes are refused without truncation', async () => {
  const { gateway, cached } = cacheFixture();
  cached.images = [];
  assert.equal((await gateway.execute(bodyCommand)).text, cached.text);
  cached.text = 'x'.repeat(250001);
  await rejects(gateway.execute(bodyCommand), 'CACHE_UNAVAILABLE');
  cached.text = '合成正文';
  cached.images = Array(61).fill(png);
  await rejects(gateway.execute(bodyCommand), 'CACHE_UNAVAILABLE');
  const image = Buffer.alloc(850000);
  const bytes = Buffer.from(png.split(',')[1], 'base64');
  bytes.copy(image, 0, 0, 16);
  bytes.copy(image, image.length - 12, bytes.length - 12);
  cached.images = Array(5).fill(
    'data:image/png;base64,' + image.toString('base64'),
  );
  await rejects(gateway.execute(bodyCommand), 'CACHE_UNAVAILABLE');
});
test('Wechat body uses original cache lookup and server projector only, rejects foreign parent and unavailable cache', async () => {
  const { gateway, calls, caller } = cacheFixture();
  const command = {
    ...bodyCommand,
    platform: 'wechat',
    authorId: 'MP_WXS_12345',
    itemId: 'old-short-id',
  };
  assert.deepEqual((await gateway.execute(command)).images, [png]);
  assert.deepEqual(calls, [['article.byId', 'old-short-id']]);
  await rejects(
    gateway.execute({ ...command, authorId: 'wrong' }),
    'NOT_FOUND',
  );
  caller.article.byId = async () => ({
    id: command.itemId,
    mpId: command.authorId,
    contentHtml: '',
  });
  await rejects(gateway.execute(command), 'CACHE_UNAVAILABLE');
  const missing = cacheFixture({ projectWechatCachedBody: undefined });
  await rejects(missing.gateway.execute(command), 'CACHE_ADAPTER_UNCONFIGURED');
});
test('Wechat projector validates before parsing, refuses missing dependencies and extracts text/media using the supplied original parser', () => {
  assert.throws(() => createWechatCacheProjector()('cached'), {
    code: 'CACHE_ADAPTER_UNCONFIGURED',
  });
  let parsed = false;
  assert.throws(
    () =>
      createWechatCacheProjector({
        verifiedDownloadBody: () => {
          throw new Error('invalid');
        },
        load: () => {
          parsed = true;
        },
      })('remote body'),
    { code: 'CACHE_UNAVAILABLE' },
  );
  assert.equal(parsed, false);
  const body = {
    length: 1,
    find: (selector) =>
      selector === 'img'
        ? { toArray: () => ['synthetic-image-node'] }
        : { replaceWith: () => {}, append: () => {} },
    text: () => '合成正文\n',
  };
  const project = createWechatCacheProjector({
    verifiedDownloadBody: (html) => {
      assert.equal(html, 'cached-html');
      return 'validated-html';
    },
    load: (html) => {
      assert.equal(html, 'validated-html');
      return (node) => (node === '#js_content' ? body : { attr: () => png });
    },
  });
  assert.deepEqual(project('cached-html'), {
    text: '合成正文\n',
    images: [png],
  });
});
test('body, download, refresh and status remain closed with missing identity or missing PC transport', async () => {
  for (const command of [
    bodyCommand,
    { ...bodyCommand, action: 'download' },
    refreshCommand,
    {
      action: 'status',
      platform: 'xiaohongshu',
      authorId: 'creator-1',
      operationId: 'synthetic-operation',
    },
  ]) {
    assert.equal((await worker.fetch(req(command))).status, 503);
    assert.equal(
      (await createSitesWorker({ authorize: owner }).fetch(req(command)))
        .status,
      503,
    );
    await rejects(
      createLocalSitesGateway().execute(command),
      'IDENTITY_UNCONFIGURED',
    );
  }
});
test('refresh needs a server-only policy adapter and returns source/account/policy unavailable without submission', async () => {
  for (const [options, expected] of [
    [{ refreshAccess: undefined }, 'REFRESH_UNCONFIGURED'],
    [
      { refreshAccess: async () => ({ sourceAvailable: false }) },
      'SOURCE_UNAVAILABLE',
    ],
    [
      { refreshAccess: async () => ({ accountAvailable: false }) },
      'ACCOUNT_UNAVAILABLE',
    ],
    [
      {
        refreshAccess: async () => ({
          sourceAvailable: true,
          accountAvailable: true,
        }),
      },
      'POLICY_UNCONFIRMED',
    ],
  ]) {
    const { gateway, calls } = cacheFixture(options);
    const result = await gateway.execute(refreshCommand);
    assert.equal(result.state, 'blocked');
    assert.equal(result.code, expected);
    assert.ok(calls.every((c) => !c[0].endsWith('.refresh')));
  }
});
test('unconfigured or paused XHS source blocks refresh and does not call policy or source', async () => {
  let policyCalls = 0;
  const { gateway, caller, calls } = cacheFixture({
    refreshAccess: async () => {
      policyCalls++;
    },
  });
  caller.xiaohongshu.capability = async () => ({ sourceConfigured: false });
  assert.equal(
    (await gateway.execute(refreshCommand)).code,
    'SOURCE_UNAVAILABLE',
  );
  caller.xiaohongshu.capability = async () => ({ sourceConfigured: true });
  caller.xiaohongshu.list = async () => ({
    items: [{ id: 'creator-1', enabled: false }],
  });
  assert.equal(
    (await gateway.execute({ ...refreshCommand, operationId: 'paused' })).code,
    'SOURCE_UNAVAILABLE',
  );
  assert.equal(policyCalls, 0);
  assert.ok(calls.every((c) => c[0] !== 'xiaohongshu.refresh'));
});
test('paid WX refresh follows existing saved binding and projects pending as pending; native never falls back or rebinds', async () => {
  const { gateway, caller, calls } = cacheFixture();
  const command = {
    ...refreshCommand,
    platform: 'wechat',
    authorId: 'MP_WXS_12345',
    source: 'wechat2rss',
  };
  const result = await gateway.execute(command);
  assert.equal(result.state, 'pending');
  assert.equal(result.code, 'UPSTREAM_PENDING');
  assert.deepEqual(calls.at(-1), [
    'feed.refreshArticles',
    { mpId: 'MP_WXS_12345' },
  ]);
  caller.feed.addCapability = async () => ({
    source: 'native',
    available: true,
  });
  const blocked = await gateway.execute({
    ...command,
    source: 'native',
    operationId: 'native',
  });
  assert.equal(blocked.code, 'SOURCE_MISMATCH');
  assert.equal(calls.filter((c) => c[0] === 'feed.refreshArticles').length, 1);
});
test('same operation is never replayed and cannot be rebound to another author/source', async () => {
  const { gateway, calls } = cacheFixture();
  const result = await gateway.execute(refreshCommand);
  assert.equal(result.state, 'complete');
  assert.equal(result.added, 1);
  assert.deepEqual(await gateway.execute(refreshCommand), result);
  await rejects(
    gateway.execute({ ...refreshCommand, authorId: 'different' }),
    'CONFLICT',
  );
  assert.equal(calls.filter((c) => c[0] === 'xiaohongshu.refresh').length, 1);
});
test('known original source-unavailable and failed receipts stay explicit and cannot become completed', async () => {
  const { gateway, caller } = cacheFixture();
  caller.xiaohongshu.refresh = async () => ({
    status: 'failed',
    added: 0,
    message: 'private',
  });
  assert.equal((await gateway.execute(refreshCommand)).state, 'failed');
  const command = {
    ...refreshCommand,
    platform: 'wechat',
    authorId: 'MP_WXS_12345',
    source: 'wechat2rss',
  };
  for (const [source, state, code] of [
    ['unavailable', 'blocked', 'SOURCE_UNAVAILABLE'],
    ['error', 'failed', 'UPDATE_FAILED'],
  ]) {
    caller.feed.refreshArticles = async () => [
      { source, status: state, complete: false, message: 'private' },
    ];
    const result = await gateway.execute({ ...command, operationId: source });
    assert.equal(result.state, state);
    assert.equal(result.code, code);
  }
});
test('in-flight author rejects a different operation, same operation/status queries are read-only and lock releases after completion', async () => {
  const { gateway, caller, calls } = cacheFixture();
  let finish;
  caller.xiaohongshu.refresh = async () => {
    calls.push(['source-call']);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = gateway.execute(refreshCommand);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const statusCommand = {
    action: 'status',
    platform: 'xiaohongshu',
    authorId: 'creator-1',
    operationId: refreshCommand.operationId,
  };
  assert.equal((await gateway.execute(statusCommand)).state, 'running');
  assert.equal((await gateway.execute(refreshCommand)).state, 'running');
  await rejects(
    gateway.execute({ ...refreshCommand, operationId: 'another' }),
    'CONFLICT',
  );
  await rejects(
    gateway.execute({ ...statusCommand, authorId: 'other' }),
    'NOT_FOUND',
  );
  finish({ status: 'partial', added: 1 });
  await pending;
  assert.equal((await gateway.execute(statusCommand)).state, 'partial');
  assert.equal(calls.filter((c) => c[0] === 'source-call').length, 1);
});
test('service failure retains an unknown fixed-code receipt, releases guard and never retries the same operation', async () => {
  const { gateway, caller } = cacheFixture();
  let count = 0;
  caller.xiaohongshu.refresh = async () => {
    count++;
    throw new Error('private URL/key/path');
  };
  const result = await gateway.execute(refreshCommand);
  assert.equal(result.state, 'unknown');
  assert.equal(result.code, 'RESULT_UNKNOWN');
  assert.deepEqual(await gateway.execute(refreshCommand), result);
  assert.equal(count, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|URL|key|path/);
  const later = await gateway.execute({
    ...refreshCommand,
    operationId: 'explicit-new-operation',
  });
  assert.equal(later.state, 'unknown');
  assert.equal(count, 2);
});
test('bounded receipt storage rejects more operations instead of evicting uncertain IDs for replay', async () => {
  const { gateway } = cacheFixture({ refreshAccess: undefined });
  for (let i = 0; i < 128; i++)
    await gateway.execute({ ...refreshCommand, operationId: 'fixture-' + i });
  await rejects(
    gateway.execute({ ...refreshCommand, operationId: 'overflow' }),
    'OPERATION_LIMIT',
  );
  assert.equal(
    (await gateway.execute({ ...refreshCommand, operationId: 'fixture-0' }))
      .code,
    'REFRESH_UNCONFIGURED',
  );
});
test('refresh transport timeout reports unknown without replay; later status resolves the original local receipt', async () => {
  const { gateway, caller } = cacheFixture();
  let finish,
    count = 0;
  caller.xiaohongshu.refresh = async () => {
    count++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const site = createSitesWorker({
    authorize: owner,
    transport: { send: (c) => gateway.execute(c) },
  });
  const reply = await site.fetch(req(refreshCommand));
  assert.deepEqual(await reply.json(), { ok: false, code: 'RESULT_UNKNOWN' });
  assert.equal(count, 1);
  const statusCommand = {
    action: 'status',
    platform: 'xiaohongshu',
    authorId: 'creator-1',
    operationId: refreshCommand.operationId,
  };
  assert.equal(
    (await (await site.fetch(req(statusCommand))).json()).data.state,
    'running',
  );
  finish({ status: 'complete', added: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await (await site.fetch(req(statusCommand))).json()).data.state,
    'complete',
  );
  assert.equal(count, 1);
});
