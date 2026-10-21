import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker, { createPrivateReaderWorker } from '../worker.mjs';
import {
  createReaderController,
  createReaderRequest,
} from '../reader-model.mjs';
import { mountReader } from '../view.mjs';
import {
  fixture,
  image,
  authorId,
  itemId,
  NodeElement,
  documentFixture,
} from './fixtures.mjs';

const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw Error('REAL_NETWORK_FORBIDDEN');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
});
const request = (command, extra = {}) =>
  new Request('https://reader.invalid/api/subscriptions', {
    method: 'POST',
    headers: {
      origin: 'https://reader.invalid',
      'content-type': 'application/json',
      ...extra,
    },
    body: JSON.stringify(command),
  });
const authors = { action: 'authors', platform: 'wechat' };
test('pre-aborted read performs no fetch', async () => {
  let calls = 0;
  const abort = new AbortController();
  abort.abort();
  const read = createReaderRequest({
    fetchImpl: async () => {
      calls++;
    },
  });
  await assert.rejects(read(authors, { signal: abort.signal }), {
    code: 'CANCELLED',
  });
  assert.equal(calls, 0);
});

test('missing cache and malformed replies remain distinct from an empty subscription list', async () => {
  const empty = createReaderController({
    request: async () => ({ items: [], nextCursor: null }),
  });
  await empty.loadAuthors();
  assert.equal(empty.getState().status, 'empty');
  assert.deepEqual(empty.getState().authors, []);
  for (const [code, expected] of [
    ['CACHE_UNAVAILABLE', 'cache-missing'],
    ['BAD_RESPONSE', 'failed'],
  ]) {
    const controller = createReaderController({
      request: async () => {
        throw Object.assign(Error(code), { code });
      },
    });
    await controller.loadAuthors();
    assert.equal(controller.getState().status, expected);
    assert.equal(controller.getState().body, null);
  }
});
async function openBody(controller, platform = 'wechat') {
  await controller.loadAuthors(platform);
  await controller.openAuthor(authorId);
  await controller.openItem(itemId);
}

test('default Worker refuses claimed owner/service headers and environment flags without invoking a connection', async () => {
  const response = await worker.fetch(
    request(authors, {
      'oai-authenticated-user-id': 'claimed-owner',
      'oai-sites-authorization': 'Bearer NOT_A_VISITOR',
      'x-is-owner': 'true',
    }),
    { IS_OWNER: true, SITES_OWNER_ID: 'claimed-owner' },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: 'IDENTITY_UNCONFIGURED',
  });
  const page = await worker.fetch(new Request('https://reader.invalid/'));
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.match(
    page.headers.get('content-security-policy'),
    /connect-src 'self'/,
  );
  assert.doesNotMatch(
    await page.text(),
    /Synthetic owner article|PRIVATE_TOKEN|isOwner:true/,
  );
});

for (const [viewer, code, state] of [
  [null, 'UNAUTHORIZED', 'sign-in'],
  ['other', 'FORBIDDEN', 'forbidden'],
]) {
  test(`verified identity seam distinguishes ${state} and never reads the PC`, async () => {
    const f = fixture({ viewer });
    const controller = createReaderController({
      request: createReaderRequest({ fetchImpl: f.fetchImpl }),
    });
    await controller.loadAuthors();
    assert.equal(controller.getState().status, state);
    assert.equal(f.calls.length, 0);
    const result = await f.worker.fetch(request(authors));
    assert.equal((await result.json()).code, code);
  });
}

test('local connection authorization is independent of the Worker visitor decision', async () => {
  const f = fixture({ viewer: 'owner', localViewer: 'other' });
  const result = await f.worker.fetch(request(authors));
  assert.equal(result.status, 403);
  assert.equal(f.calls.length, 0);
});

test('real contract client → Worker → local contract → synthetic caller reads and downloads cached bytes only', async () => {
  const f = fixture();
  const controller = createReaderController({
    request: createReaderRequest({ fetchImpl: f.fetchImpl }),
  });
  await openBody(controller);
  const state = controller.getState();
  assert.equal(state.body.title, 'Synthetic owner article');
  assert.deepEqual(state.body.images, [image]);
  assert.doesNotMatch(
    JSON.stringify(state),
    /PRIVATE_TOKEN|contentHtml|profileUrl/,
  );
  const download = await controller.download();
  assert.equal(download.filename, '缓存图文.html');
  assert.equal(download.blob.type, 'text/html');
  const html = await download.blob.text();
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert(html.includes(image));
  assert.match(html, /default-src &#39;none&#39;/);
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['feed.list', 'article.list', 'article.byId', 'article.byId'],
  );
  for (const { endpoint, options } of f.requests) {
    assert.equal(endpoint, '/api/subscriptions');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
  }
});

test('XHS cache follows the unchanged creator scope without invented pagination', async () => {
  const f = fixture();
  const controller = createReaderController({
    request: createReaderRequest({ fetchImpl: f.fetchImpl }),
  });
  await openBody(controller, 'xiaohongshu');
  assert.equal(controller.getState().nextItems, null);
  assert.equal(controller.getState().body.title, 'Synthetic XHS note');
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['xhs.list', 'xhs.notes', 'xhs.body'],
  );
  assert.deepEqual(f.calls[1][1], { creatorId: authorId });
});

test('read-only Worker rejects refresh/status and arbitrary gateway fields before transport', async () => {
  let calls = 0;
  const readOnly = createPrivateReaderWorker({
    authorize: async () => ({ isOwner: true }),
    transport: {
      send: async () => {
        calls++;
      },
    },
  });
  for (const command of [
    {
      action: 'refresh',
      platform: 'wechat',
      source: 'wechat2rss',
      authorId,
      operationId: 'operation',
      confirmed: true,
    },
    {
      action: 'status',
      platform: 'wechat',
      authorId,
      operationId: 'operation',
    },
    { ...authors, gatewayUrl: 'https://not-allowed.invalid' },
    {
      action: 'download',
      platform: 'wechat',
      authorId,
      itemId,
      path: 'C:/private',
    },
  ]) {
    const response = await readOnly.fetch(request(command));
    assert.notEqual(response.status, 200);
  }
  assert.equal(calls, 0);
});

test('offline is an error, not an empty success, and has no implicit retry', async () => {
  const f = fixture({ offline: true });
  const controller = createReaderController({
    request: createReaderRequest({ fetchImpl: f.fetchImpl }),
  });
  await controller.loadAuthors();
  assert.equal(controller.getState().status, 'offline');
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.length, 0);
});

test('browser deadline aborts exactly one attempt and reports timeout', async () => {
  let attempts = 0;
  let observedSignal;
  const controller = createReaderController({
    request: createReaderRequest({
      timeoutMs: 5,
      fetchImpl: (_, options) => {
        attempts++;
        observedSignal = options.signal;
        return new Promise(() => {});
      },
    }),
  });
  await controller.loadAuthors();
  assert.equal(controller.getState().status, 'timeout');
  assert.equal(attempts, 1);
  assert.equal(observedSignal.aborted, true);
});

test('expired/non-owner session removes already displayed body, images and metadata before download', async () => {
  const f = fixture();
  const controller = createReaderController({
    request: createReaderRequest({ fetchImpl: f.fetchImpl }),
  });
  await openBody(controller);
  f.setViewer('other');
  assert.equal(await controller.download(), null);
  assert.equal(controller.getState().status, 'forbidden');
  assert.equal(controller.getState().body, null);
  assert.deepEqual(controller.getState().authors, []);
  assert.deepEqual(controller.getState().items, []);
});

test('page cursor is bound to the selected platform and the old page is replaced', async () => {
  const f = fixture();
  f.caller.feed.list = async (input) => {
    f.calls.push(['feed.list', input]);
    return input.cursor
      ? { items: [{ id: 'second', mpName: 'Second page' }], nextCursor: null }
      : { items: [{ id: authorId, mpName: 'First page' }], nextCursor: 'next' };
  };
  const controller = createReaderController({
    request: createReaderRequest({ fetchImpl: f.fetchImpl }),
  });
  await controller.loadAuthors();
  await controller.nextAuthors();
  assert.deepEqual(controller.getState().authors, [
    { id: 'second', name: 'Second page' },
  ]);
  assert.deepEqual(f.calls[1][1], { limit: 20, cursor: 'next' });
});

test('late responses cannot overwrite a newer platform selection and superseded reads are aborted', async () => {
  const pending = [];
  const controller = createReaderController({
    request: (command, { signal }) =>
      new Promise((resolve) => pending.push({ command, signal, resolve })),
  });
  const old = controller.loadAuthors('wechat');
  const current = controller.loadAuthors('xiaohongshu');
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({
    items: [{ id: 'new', name: 'New selection' }],
    truncated: false,
  });
  await current;
  pending[0].resolve({
    items: [{ id: 'old', name: 'Late private result' }],
    truncated: false,
  });
  await old;
  assert.equal(controller.getState().platform, 'xiaohongshu');
  assert.equal(controller.getState().authors[0].id, 'new');
});

test('actual view uses text nodes, keeps device download explicit and renders access states', async () => {
  const f = fixture();
  const document = documentFixture();
  const root = new NodeElement('main');
  const downloads = [];
  let view;
  const controller = createReaderController({
    request: createReaderRequest({ fetchImpl: f.fetchImpl }),
    onState: (state) => view?.render(state),
  });
  view = mountReader({
    document,
    root,
    controller,
    saveDownload: (value) => downloads.push(value),
  });
  await openBody(controller);
  assert(root.textContent.includes('<script>not executable</script>'));
  assert.equal(root.find((node) => node.tagName === 'script').length, 0);
  assert.deepEqual(
    root.find((node) => node.tagName === 'img').map((node) => node.src),
    [image],
  );
  assert.equal(downloads.length, 0);
  await root
    .find(
      (node) =>
        node.tagName === 'button' && node.textContent === '下载到当前设备',
    )[0]
    .click();
  assert.equal(downloads.length, 1);
  f.setViewer(null);
  await controller.loadAuthors();
  assert(root.textContent.includes('请使用本人账号登录'));
  const signIn = root.find((node) => node.tagName === 'a')[0];
  assert.equal(signIn.href, '/signin-with-chatgpt');
  assert.equal(signIn.target, '_top');
  assert.equal(root.find((node) => node.tagName === 'img').length, 0);
});
