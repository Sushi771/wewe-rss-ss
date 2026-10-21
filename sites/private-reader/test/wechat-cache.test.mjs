import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createLocalSitesGateway,
  createWechatCacheProjector,
} from '../../../scripts/sites-local-contract.mjs';
import { createPrivateReaderWorker } from '../worker.mjs';
import {
  createReaderController,
  createReaderRequest,
} from '../reader-model.mjs';
import { image, png, authorId, itemId } from './fixtures.mjs';

const requireServer = createRequire(
  new URL('../../../apps/server/package.json', import.meta.url),
);
const requireWeb = createRequire(
  new URL('../../../apps/web/package.json', import.meta.url),
);
const esbuild = createRequire(requireWeb.resolve('vite'))('esbuild');
// Compile only the new pure server boundary and existing policies in memory.
// No Nest bootstrap, Prisma, listener, files, credentials or live connection.
const compiled = await esbuild.build({
  entryPoints: [
    fileURLToPath(
      new URL(
        '../../../apps/server/src/sites-wechat-cache.ts',
        import.meta.url,
      ),
    ),
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
  logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  requireServer,
  module,
  module.exports,
);
const { verifySitesWechatCachedBody } = module.exports;
const { load } = requireServer('cheerio');
const projector = createWechatCacheProjector({
  verifiedDownloadBody: verifySitesWechatCachedBody,
  load,
});
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw Error('REAL_NETWORK_FORBIDDEN');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
});

function chain(html, { parent = authorId, status = 'available' } = {}) {
  const calls = [];
  const caller = {
    feed: {
      list: async () => ({
        items: [{ id: authorId, mpName: 'Synthetic Wechat' }],
        nextCursor: null,
      }),
    },
    article: {
      list: async () => ({
        items: [
          {
            id: itemId,
            mpId: authorId,
            title: 'Cached only',
            publishTime: 1700000000,
          },
        ],
        nextCursor: null,
      }),
      byId: async (id) => {
        calls.push(id);
        return {
          id,
          mpId: parent,
          title: 'Cached only',
          publishTime: 1700000000,
          lastBodyStatus: status,
          contentHtml: html,
        };
      },
      exportMarkdown: () => {
        throw Error('EXPORT_FORBIDDEN');
      },
      retryBody: () => {
        throw Error('RETRY_FORBIDDEN');
      },
    },
  };
  // Synthetic authorization only; the default Worker still has no real binding.
  const gateway = createLocalSitesGateway({
    authorize: async () => ({ isOwner: true }),
    caller,
    projectWechatCachedBody: projector,
  });
  const worker = createPrivateReaderWorker({
    authorize: async () => ({ isOwner: true }),
    transport: { send: (command) => gateway.execute(command, {}) },
  });
  const read = createReaderRequest({
    fetchImpl: (_endpoint, options) =>
      worker.fetch(
        new Request('https://reader.invalid/api/subscriptions', {
          ...options,
          headers: { ...options.headers, origin: 'https://reader.invalid' },
        }),
      ),
  });
  return { read, calls };
}

test('real main cache validator + parser + unchanged contract delivers cached text and actual image bytes through the reader', async () => {
  const html = `<div class="rich_media_content" onclick="bad()"><p>First &amp; last</p><img src="${image}"><script>PRIVATE_SCRIPT</script><a href="https://private.invalid">label</a></div>`;
  const { read, calls } = chain(html);
  const controller = createReaderController({ request: read });
  await controller.loadAuthors();
  await controller.openAuthor(authorId);
  await controller.openItem(itemId);
  assert.equal(controller.getState().status, 'ready');
  assert.match(controller.getState().body.text, /First & last/);
  assert.deepEqual(controller.getState().body.images, [image]);
  const download = await controller.download();
  const body = await download.blob.text();
  assert(body.includes(image));
  assert.doesNotMatch(body, /PRIVATE_SCRIPT|private.invalid|onclick/);
  assert.deepEqual(calls, [itemId, itemId]);
  assert.equal(html.includes('onclick'), true); // The supplied cache string is unchanged.
});

for (const [name, html, options, code] of [
  [
    'foreign author',
    '<div id="js_content">text</div>',
    { parent: 'other' },
    'NOT_FOUND',
  ],
  [
    'unavailable receipt',
    '<div id="js_content">text</div>',
    { status: 'unavailable' },
    'CACHE_UNAVAILABLE',
  ],
  [
    'remote media',
    '<div id="js_content"><img src="https://mmbiz.qpic.cn/a.png"></div>',
    {},
    'CACHE_UNAVAILABLE',
  ],
  [
    'pending media',
    '<div id="js_content" data-wewe-image-pending="1">text</div>',
    {},
    'CACHE_UNAVAILABLE',
  ],
  [
    'fake bytes',
    '<div id="js_content"><img src="data:image/png;base64,YQ=="></div>',
    {},
    'CACHE_UNAVAILABLE',
  ],
]) {
  test(`real cached chain refuses ${name} without export, retry or network fallback`, async () => {
    const { read, calls } = chain(html, options);
    await assert.rejects(
      read({ action: 'body', platform: 'wechat', authorId, itemId }),
      { code },
    );
    assert.deepEqual(calls, [itemId]);
  });
}

test('unchanged Sites response limits remain stricter than the local validator, with no truncation or media fetching', async () => {
  const longText = `<div id="js_content">${'x'.repeat(250001)}</div>`;
  assert(verifySitesWechatCachedBody(longText));
  await assert.rejects(
    chain(longText).read({
      action: 'download',
      platform: 'wechat',
      authorId,
      itemId,
    }),
    { code: 'CACHE_UNAVAILABLE' },
  );
  // The existing container checker deliberately is not a full image decoder.
  // Synthetic PNG-shaped bytes exercise the separate contract's 1 MiB limit.
  const bytes = Buffer.from(png, 'base64');
  const large = Buffer.concat([
    bytes.subarray(0, -12),
    Buffer.alloc(1048577),
    bytes.subarray(-12),
  ]);
  const html = `<div id="js_content"><img src="data:image/png;base64,${large.toString('base64')}"></div>`;
  assert(verifySitesWechatCachedBody(html));
  await assert.rejects(
    chain(html).read({ action: 'body', platform: 'wechat', authorId, itemId }),
    { code: 'CACHE_UNAVAILABLE' },
  );
});
