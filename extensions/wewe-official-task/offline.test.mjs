import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runTask, localEndpoint } from './task-client.mjs';

const taskId = '12345678-1234-1234-1234-123456789012';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const fixture = () => ({
  pageUrl: 'https://weread.qq.com/web/mp/reader/fixture',
  html: 'synthetic only',
  images: [{ index: 0, inline: 'data:image/png;base64,' + png }],
});
const projection = {
  bookId: 'MP_WXS_1234567890',
  current: { reviewId: 'synthetic' },
  bodyFingerprint: 'a'.repeat(64),
};
function harness({
  source = 'https://weread.qq.com/web/mp/reader/fixture',
  permission = true,
  mediaPermission = false,
  remote,
  changed = false,
  changedAfterMedia = false,
  manual = false,
  manualChanged = false,
} = {}) {
  const calls = [];
  let projections = 0;
  let captures = 0;
  const chrome = {
    permissions: {
      contains: async ({ origins }) =>
        origins[0].startsWith('http:') ? permission : mediaPermission,
    },
    tabs: {
      query: async () => [{ id: 4, windowId: 2, url: source }],
      get: async () => ({ id: 4, windowId: 2, url: source }),
    },
    scripting: {
      executeScript: async (options) => {
        calls.push({ kind: 'script', world: options.world });
        if (options.world === 'MAIN') {
          if (manual) throw new Error('NO_VUE_FOR_CONFIRMED_DOM');
          projections++;
          return [
            {
              frameId: 0,
              result:
                (changed && projections > 1) ||
                (changedAfterMedia && projections > 2)
                  ? { ...projection, bodyFingerprint: 'b'.repeat(64) }
                  : projection,
            },
          ];
        }
        const observation = fixture();
        captures++;
        if (manual) {
          assert.equal(options.args[0].confirmedImageCount, 1);
          observation.omittedEmptyImageNodes = 2;
          observation.assetFingerprint = (
            manualChanged && captures > 1 ? 'b' : 'a'
          ).repeat(64);
        }
        if (remote)
          observation.images = [{ index: 0, source: remote, inline: null }];
        return [{ frameId: 0, result: observation }];
      },
    },
  };
  const fetch = async (url, options) => {
    calls.push({ kind: 'http', url, options });
    if (url.startsWith('https:'))
      return new Response(Buffer.from(png, 'base64'), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    return new Response(
      JSON.stringify(
        url.endsWith('claim')
          ? {
              nonce: 'n'.repeat(43),
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              ...(manual
                ? {
                    contentMode: 'confirmed-dom',
                    confirmedImageCount: 1,
                    disclosure: {
                      title: 'Synthetic article',
                      publisher: 'Synthetic publisher',
                      originalUrl:
                        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcd',
                      publishTime: 1700000000,
                      imageCount: 1,
                      destination: '/tmp/fixture-notes',
                    },
                  }
                : {}),
            }
          : { accepted: true },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return {
    calls,
    chrome,
    fetch,
    base: 'http://127.0.0.1:4000/',
    key: 'k'.repeat(43),
    taskId,
  };
}
test('manifest grants only click-scoped reads; host permissions remain optional', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('./manifest.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.deepEqual(manifest.optional_host_permissions, [
    'http://127.0.0.1/*',
    'https://mmbiz.qpic.cn/*',
  ]);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions, undefined);
});
test('one clicked task claims before reads and returns actual inline bytes', async () => {
  const h = harness();
  assert.deepEqual(await runTask(h), { accepted: true });
  assert.equal(h.calls[0].url, 'http://127.0.0.1:4000/browser-task/claim');
  assert.deepEqual(
    h.calls.filter((c) => c.kind === 'script').map((c) => c.world),
    ['MAIN', 'ISOLATED', 'MAIN', 'MAIN'],
  );
  const final = h.calls.at(-1);
  assert.ok(final.url.endsWith('complete'));
  assert.equal(
    JSON.parse(final.options.body).observation.images[0].inline,
    'data:image/png;base64,' + png,
  );
  assert.ok(
    h.calls
      .filter((c) => c.kind === 'http')
      .every(
        (c) =>
          c.options.credentials === 'omit' && c.options.redirect === 'error',
      ),
  );
});

test('server-bound manual DOM task avoids Vue and rechecks body/assets before returning only bound original bytes', async () => {
  const h = harness({
    manual: true,
    mediaPermission: true,
    remote: 'https://mmbiz.qpic.cn/synthetic.png',
  });
  assert.deepEqual(await runTask(h), { accepted: true });
  assert.deepEqual(
    h.calls.filter((call) => call.kind === 'script').map((call) => call.world),
    ['ISOLATED', 'ISOLATED'],
  );
  const observation = JSON.parse(h.calls.at(-1).options.body).observation;
  assert.equal(observation.omittedEmptyImageNodes, 2);
  assert.equal(observation.images.length, 1);
  assert.equal(Object.hasOwn(observation, 'projection'), false);
  assert.equal(Object.hasOwn(observation, 'assetFingerprint'), false);
  assert.equal(
    h.calls.filter((call) => call.url?.startsWith('https:')).length,
    1,
  );
  const changed = harness({ manual: true, manualChanged: true });
  await assert.rejects(runTask(changed), /ARTICLE_CHANGED/);
  assert(!changed.calls.some((call) => call.url?.endsWith('complete')));
});
test('remote bytes use only optional exact observed CDN and preserve bytes', async () => {
  const h = harness({
    mediaPermission: true,
    remote: 'https://mmbiz.qpic.cn/synthetic.png',
  });
  await runTask(h);
  assert.equal(
    JSON.parse(h.calls.at(-1).options.body).observation.images[0].inline,
    'data:image/png;base64,' + png,
  );
});
test('no permission means zero communication or page reads', async () => {
  const h = harness({ permission: false });
  await assert.rejects(runTask(h), /LOOPBACK_PERMISSION_PENDING/);
  assert.equal(h.calls.length, 0);
});
test('wrong official origin stops before task claim', async () => {
  const h = harness({
    source: 'https://weread.qq.com.evil.invalid/web/mp/reader/fixture',
  });
  await assert.rejects(runTask(h), /SOURCE_TAB/);
  assert.equal(h.calls.length, 0);
});
test('ordinary book reader and non-target paths stop before any task/page request', async () => {
  for (const path of [
    '/web/reader/fixture',
    '/web/mp/reader/',
    '/web/mp/reader/fixture/extra',
    '/web/mp/other/fixture',
  ]) {
    const h = harness({ source: 'https://weread.qq.com' + path });
    await assert.rejects(runTask(h), /SOURCE_TAB/);
    assert.equal(h.calls.length, 0);
  }
});
test('article changing within same tab cancels with no completion', async () => {
  const h = harness({ changed: true });
  await assert.rejects(runTask(h), /ARTICLE_CHANGED/);
  assert.ok(h.calls.at(-1).url.endsWith('cancel'));
  assert.equal(h.calls.filter((c) => c.url?.endsWith('complete')).length, 0);
});
test('chapter changing during media retrieval cancels before completion', async () => {
  const h = harness({
    mediaPermission: true,
    remote: 'https://mmbiz.qpic.cn/synthetic.png',
    changedAfterMedia: true,
  });
  await assert.rejects(runTask(h), /ARTICLE_CHANGED/);
  assert.ok(h.calls.at(-1).url.endsWith('cancel'));
  assert.equal(h.calls.filter((c) => c.url?.endsWith('complete')).length, 0);
});
test('ungranted media origin fails instead of partial save', async () => {
  const h = harness({ remote: 'https://mmbiz.qpic.cn/synthetic.png' });
  await assert.rejects(runTask(h), /MEDIA_PERMISSION_PENDING/);
  assert.equal(h.calls.filter((c) => c.url?.startsWith('https:')).length, 0);
});
test('internal/non-CDN media denied even with optional permission', async () => {
  for (const remote of [
    'http://127.0.0.1:4000/private',
    'https://mmbiz.qpic.cn.evil.invalid/x',
    'https://user@mmbiz.qpic.cn/x',
  ]) {
    const h = harness({ remote, mediaPermission: true });
    await assert.rejects(runTask(h), /IMAGE_SOURCE/);
    assert.equal(h.calls.filter((c) => c.url?.startsWith('https:')).length, 0);
  }
});
test('precise loopback endpoint cannot redirect communication to another origin', () => {
  for (const url of [
    'http://localhost:4000/',
    'https://127.0.0.1:4000/',
    'http://127.0.0.1:4000/task',
    'http://127.0.0.1:4000/?token=x',
    'http://user@127.0.0.1:4000/',
  ])
    assert.throws(() => localEndpoint(url));
});
