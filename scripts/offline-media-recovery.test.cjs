// Synthetic fixtures only. Run: node --test scripts/offline-media-recovery.test.cjs
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../apps/server/node_modules/typescript');

// Refuse all outbound traffic; this harness invokes the real background tick.
const rejectNetwork = () => {
  throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN');
};
global.fetch = rejectNetwork;
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = rejectNetwork;
  transport.get = rejectNetwork;
}
require('node:net').connect = rejectNetwork;
require('node:tls').connect = rejectNetwork;

const sourceRoot = path.resolve(__dirname, '../apps/server/src');
require.extensions['.ts'] = (mod, filename) => {
  assert.ok(
    filename.startsWith(sourceRoot + path.sep),
    'unexpected runtime source',
  );
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  mod._compile(compiled.outputText, filename);
};
const {
  CacheSyncEngine,
} = require('../apps/server/src/feeds/cache-sync-engine.ts');
const {
  cacheSyncState,
} = require('../apps/server/src/feeds/cache-sync-state.ts');
const daytime = Date.parse('2026-10-11T08:00:00Z');
const ids = ['MP_WXS_1234567890', 'MP_WXS_2345678901'];
const fixture = (id) => ({
  articles: [
    {
      id: `WX_${id.slice(7)}_9_1`,
      mpId: id,
      title: 'synthetic fixture',
      url: `https://mp.weixin.qq.com/s?__biz=fixture&mid=9&idx=1`,
      publishTime: 1791684000,
      picUrl: '',
      contentHtml: '<div class="rich_media_content"><p>fixture</p></div>',
    },
  ],
  coverage: 'recent-window',
  upstreamCount: 1,
  bodyMissing: 0,
  imageBlocked: 0,
});
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function setup({ count = 1, sync, mediaEnabled } = {}) {
  let now = daytime;
  let paused = false;
  const calls = [];
  const reads = [];
  const deps = {
    now: () => now,
    mediaEnabled,
    inspectLocalMedia: async () => ({ mediaReady: true }),
    list: async () =>
      ids.slice(0, count).map((feedId) => ({
        feedId,
        name: feedId,
        feedUrl: `/feed/${feedId.slice(7)}.json`,
        checkTime: null,
        nextUpdateTime: null,
        paused,
      })),
    localFeeds: async () =>
      ids.slice(0, count).map((id) => ({ id, mpName: id })),
    read: async (row) => {
      reads.push(row.feedId);
      return fixture(row.feedId);
    },
    sync: async (id, page, listOnly) => {
      calls.push({ id, page, listOnly });
      return sync
        ? sync(id, page, listOnly)
        : { bodyMissing: 0, imageBlocked: 0, localMediaPendingArticleCount: 0 };
    },
  };
  const engine = new CacheSyncEngine(deps);
  return {
    engine,
    deps,
    calls,
    reads,
    time: (value) => {
      now = value;
    },
    pause: (value) => {
      paused = value;
    },
    tick: async () => {
      await engine.tick();
      await drain();
    },
  };
}
beforeEach(() => {
  cacheSyncState.signal = 'metadata';
  cacheSyncState.feeds = [];
  global.fetch = rejectNetwork;
});

test('background ticks do not repeat successful media while cache stays unchanged', async () => {
  const f = setup();
  await f.tick();
  for (let i = 1; i <= 3; i++) {
    f.time(daytime + i * 60000);
    await f.tick();
  }
  assert.equal(f.calls.filter((row) => !row.listOnly).length, 1);
  f.engine.close();
});

test('REGRESSION: unchanged cache must recheck a deleted local media file', async () => {
  const dir = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'wewe-offline-missing-'),
  );
  const image = path.join(dir, 'synthetic.png');
  let attempts = 0;
  const f = setup({
    sync: async (_id, _page, listOnly) => {
      if (!listOnly) {
        attempts++;
        fs.writeFileSync(image, png);
      }
      return {
        bodyMissing: 0,
        imageBlocked: 0,
        localMediaPendingArticleCount: 0,
      };
    },
  });
  f.deps.inspectLocalMedia = async () => ({ mediaReady: fs.existsSync(image) });
  await f.tick();
  fs.unlinkSync(image); // Only this test-created file is deleted; upstream is unchanged.
  f.time(daytime + 60000);
  await f.tick();
  assert.equal(
    attempts,
    2,
    'background reconciliation skipped unchanged upstream cache',
  );
  assert.equal(fs.existsSync(image), true);
  f.engine.close();
});

test('background media retries failure after backoff without another list import', async () => {
  let attempts = 0;
  const f = setup({
    sync: async (_id, _page, listOnly) => {
      if (!listOnly && ++attempts === 1)
        throw new Error('synthetic transient failure');
      return {
        bodyMissing: 0,
        imageBlocked: 0,
        localMediaPendingArticleCount: 0,
      };
    },
  });
  await f.tick();
  assert.equal(cacheSyncState.feeds[0].state, 'media-pending');
  f.time(daytime + 59999);
  await f.tick();
  assert.equal(attempts, 1);
  f.time(daytime + 60000);
  await f.tick();
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter((row) => row.listOnly).length, 1);
  f.engine.close();
});

test('restart rediscovers pending media and daytime permits recovery', async () => {
  const f = setup({ sync: async () => ({ bodyMissing: 0, imageBlocked: 1 }) });
  await f.tick();
  assert.equal(cacheSyncState.feeds[0].state, 'media-pending');
  f.engine.close();
  const restarted = new CacheSyncEngine(f.deps);
  f.calls.length = 0;
  await restarted.tick();
  await drain();
  assert.equal(f.calls.filter((row) => !row.listOnly).length, 1);
  restarted.close();
});

test('00:00 to 06:00 Shanghai blocks body/media, resumes at 06:00', async () => {
  const f = setup();
  for (const timestamp of ['2026-10-11T16:00:00Z', '2026-10-11T21:59:59Z']) {
    f.time(Date.parse(timestamp));
    await f.tick();
    assert.equal(f.reads.length, 0);
    assert.equal(f.calls.length, 0);
  }
  f.time(Date.parse('2026-10-11T22:00:00Z'));
  await f.tick();
  assert.equal(f.calls.filter((row) => !row.listOnly).length, 1);
  f.engine.close();
});

test('a failed feed does not starve another feed media lane', async () => {
  const f = setup({
    count: 2,
    sync: async (id, _page, listOnly) => {
      if (!listOnly && id === ids[0])
        throw new Error('synthetic article failure');
      return {
        bodyMissing: 0,
        imageBlocked: 0,
        localMediaPendingArticleCount: 0,
      };
    },
  });
  await f.tick();
  f.time(daytime + 1000);
  await f.tick();
  assert.ok(f.calls.some((row) => row.id === ids[1] && !row.listOnly));
  f.engine.close();
});

test('operational pause retains media until enabled', async () => {
  let enabled = false;
  const f = setup({ mediaEnabled: () => enabled });
  await f.tick();
  assert.equal(f.calls.length, 1);
  enabled = true;
  await f.tick();
  assert.equal(f.calls.filter((row) => !row.listOnly).length, 1);
  f.engine.close();
});

test('upstream pause blocks pending media and retains it for unpause', async () => {
  let enabled = false;
  const f = setup({ mediaEnabled: () => enabled });
  await f.tick();
  f.pause(true);
  enabled = true;
  f.time(daytime + 5000);
  await f.tick();
  assert.equal(f.calls.length, 1);
  f.pause(false);
  f.time(daytime + 10000);
  await f.tick();
  assert.equal(f.calls.filter((row) => !row.listOnly).length, 1);
  f.engine.close();
});

test('REGRESSION: missing completion counts must not report synced-cache', async () => {
  const f = setup({ sync: async () => ({}) });
  await f.tick();
  assert.equal(
    cacheSyncState.feeds[0].state,
    'media-pending',
    'absence of evidence is not ready',
  );
  f.engine.close();
});

const {
  archiveProviderImages,
  supplementSavedBodyImages,
} = require('../apps/server/src/collection/archive-provider-images.ts');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const inline = `data:image/png;base64,${png.toString('base64')}`;
const imageA = 'https://mmbiz.qpic.cn/synthetic-a';
const imageB = 'https://mmbiz.qpic.cn/synthetic-b';
function imagePage(html) {
  const value = fixture(ids[0]);
  value.articles[0].contentHtml = html;
  return value;
}
const successImage = () =>
  new Response(png, { headers: { 'Content-Type': 'image/png' } });

test('already cached inline image never downloads its stale data-src', async () => {
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return successImage();
  };
  const page = await archiveProviderImages(
    imagePage(
      `<div class="rich_media_content"><p>fixture</p><img src="${inline}" data-src="${imageA}"></div>`,
    ),
  );
  assert.equal(requests, 0);
  assert.ok(page.articles[0].contentHtml.includes(inline));
});

test('REGRESSION: retry reads preserved data-src after the first archive failure', async () => {
  global.fetch = async () => {
    throw new Error('synthetic offline');
  };
  const first = await archiveProviderImages(
    imagePage(
      `<div class="rich_media_content"><p>saved fixture</p><img src="${imageA}"></div>`,
    ),
    { preserveTextOnImageFailure: true },
  );
  assert.ok(first.articles[0].contentHtml.includes(`data-src="${imageA}"`));
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return successImage();
  };
  // Input counter is a current upstream diagnostic, not a historical retry count.
  const retried = await archiveProviderImages(
    { ...first, imageBlocked: 0 },
    { preserveTextOnImageFailure: true },
  );
  assert.equal(requests, 1, 'data-src-only pending image was never requested');
  assert.ok(retried.articles[0].contentHtml.includes(inline));
  assert.equal(retried.imageBlocked, 0);
});

test('REGRESSION: repeating a pending source must not increment the pending count', async () => {
  global.fetch = async () => {
    throw new Error('synthetic offline');
  };
  const input = imagePage(
    `<div class="rich_media_content" data-wewe-image-pending="1" data-wewe-image-retryable="true"><p>fixture</p><img src="${imageA}" data-src="${imageA}"></div>`,
  );
  const retried = await archiveProviderImages(input, {
    preserveTextOnImageFailure: true,
  });
  const { load } = require('../apps/server/node_modules/cheerio');
  assert.equal(
    load(retried.articles[0].contentHtml)('.rich_media_content').attr(
      'data-wewe-image-pending',
    ),
    '1',
  );
  assert.ok(retried.articles[0].contentHtml.includes(`data-src="${imageA}"`));
});

test('REGRESSION: a partial archive supplements successful bytes without losing saved edits', async () => {
  global.fetch = async (url) => {
    if (String(url) === imageB) throw new Error('synthetic offline');
    return successImage();
  };
  const upstream = imagePage(
    `<div class="rich_media_content"><p>upstream fixture</p><img src="${imageA}"><img src="${imageB}"></div>`,
  );
  const partial = await archiveProviderImages(upstream, {
    preserveTextOnImageFailure: true,
  });
  const saved = `<div class="rich_media_content" style="color:red"><p>synthetic edited note</p><img alt="kept" src="${imageA}"><img src="${imageB}"></div>`;
  const supplemented = supplementSavedBodyImages(saved, partial.articles[0]);
  assert.ok(
    supplemented,
    'successful image provenance was discarded on partial failure',
  );
  assert.ok(supplemented.includes(inline));
  assert.ok(supplemented.includes('synthetic edited note'));
  assert.ok(supplemented.includes('color:red'));
  assert.ok(
    supplemented.includes(`data-src="${imageB}"`) ||
      supplemented.includes(`src="${imageB}"`),
  );
});

test('exact source conflict refuses supplementation rather than matching title', async () => {
  global.fetch = async () => successImage();
  const complete = await archiveProviderImages(
    imagePage(
      `<div class="rich_media_content"><p>fixture</p><img src="${imageA}"></div>`,
    ),
  );
  assert.throws(
    () =>
      supplementSavedBodyImages(
        `<div class="rich_media_content"><p>fixture</p><img src="${imageB}"></div>`,
        complete.articles[0],
      ),
    /SAVED_BODY_IMAGE_SOURCE_CONFLICT/,
  );
});

test('successful supplementation preserves local text, style and existing inline media', async () => {
  global.fetch = async () => successImage();
  const complete = await archiveProviderImages(
    imagePage(
      `<div class="rich_media_content"><p>upstream</p><img src="${imageA}"></div>`,
    ),
  );
  const saved = `<div class="rich_media_content" style="color:red"><p>synthetic personal note</p><img alt="existing" src="${inline}"><img alt="saved" src="${imageA}"></div>`;
  const result = supplementSavedBodyImages(saved, complete.articles[0]);
  assert.ok(result.includes('synthetic personal note'));
  assert.ok(result.includes('color:red'));
  assert.ok(result.includes('alt="existing"'));
  assert.ok(result.includes('alt="saved"'));
  assert.equal((result.match(/data:image\/png;base64,/g) || []).length, 2);
});

test('background lane remains pending when local media gaps survive upstream success', async () => {
  const f = setup({
    sync: async () => ({
      bodyMissing: 0,
      imageBlocked: 0,
      localMediaPendingArticleCount: 1,
    }),
  });
  await f.tick();
  assert.equal(cacheSyncState.feeds[0].state, 'media-pending');
  f.time(daytime + 60000);
  await f.tick();
  assert.equal(f.calls.filter((row) => !row.listOnly).length, 2);
  f.engine.close();
});

test('CDN authentication/risk rejection stops all subsequent image requests', async () => {
  for (const status of [401, 403, 429]) {
    let requests = 0;
    global.fetch = async () => {
      requests++;
      return new Response(null, { status });
    };
    const result = await archiveProviderImages(
      imagePage(
        `<div class="rich_media_content"><p>fixture</p><img src="${imageA}"><img src="${imageB}"></div>`,
      ),
      { preserveTextOnImageFailure: true },
    );
    assert.equal(requests, 1, `must stop after status ${status}`);
    assert.equal(result.mediaRequestBlocked, true);
    assert.ok(result.articles[0].contentHtml.includes(imageB));
  }
});

test('background global media block preserves other jobs, list lane still runs', async () => {
  const f = setup({
    count: 2,
    sync: async (_id, _page, listOnly) => ({
      bodyMissing: 0,
      imageBlocked: listOnly ? 0 : 1,
      mediaRequestBlocked: !listOnly,
    }),
  });
  let stopped = false;
  f.deps.onMediaBlocked = async () => {
    stopped = true;
  };
  f.deps.mediaStopped = () => stopped;
  await f.tick();
  f.time(daytime + 60000);
  await f.tick();
  assert.equal(f.calls.filter((row) => !row.listOnly).length, 1);
  assert.equal(stopped, true);
  assert.equal(
    f.reads.length,
    4,
    'list/cache discovery survives global media stop',
  );
  assert.ok(cacheSyncState.feeds.every((row) => row.state === 'media-pending'));
  f.engine.close();
});

test('CDN safety latch survives restart without automatically clearing', async () => {
  const {
    MediaSafetyStop,
  } = require('../apps/server/src/feeds/media-safety-stop.ts');
  const dir = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'wewe-offline-safety-'),
  );
  const db = path.join(dir, 'synthetic.sqlite');
  fs.writeFileSync(db, 'synthetic placeholder; no user data');
  const stop = new MediaSafetyStop();
  await stop.initialize(`file:${db}`);
  assert.equal(stop.blocked, false);
  await stop.stop();
  const restarted = new MediaSafetyStop();
  await restarted.initialize(`file:${db}`);
  assert.equal(restarted.blocked, true);
  await restarted.stop();
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(dir, '.wechat2rss-media-blocked.json'), 'utf8'),
    ).code,
    'IMAGE_REQUEST_BLOCKED',
  );
  // Intentionally retain the synthetic evidence in Temp; never delete user paths.
});

test('saved-body cache reuse requests only the genuinely missing exact source', async () => {
  const {
    savedBodyMediaInput,
  } = require('../apps/server/src/collection/archive-provider-images.ts');
  const saved = `<div class="rich_media_content"><p>synthetic edited note</p><img src="${inline}" data-src="${imageA}"><img data-src="${imageB}"></div>`;
  const input = imagePage(
    `<div class="rich_media_content"><p>upstream changed text</p><img src="${imageA}"><img src="${imageB}"></div>`,
  );
  const reused = savedBodyMediaInput(saved, input.articles[0]);
  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    return successImage();
  };
  const result = await archiveProviderImages(
    { ...input, articles: [reused] },
    { preserveTextOnImageFailure: true },
  );
  assert.deepEqual(requests, [imageB]);
  assert.ok(result.articles[0].contentHtml.includes('synthetic edited note'));
  assert.equal(
    (result.articles[0].contentHtml.match(/data:image\/png;base64,/g) || [])
      .length,
    2,
  );
});

test('REGRESSION: superseding snapshot cannot discard an in-flight CDN global block', async () => {
  let finish;
  let attempts = 0;
  let stopped = false;
  const f = setup({
    sync: async (_id, _page, listOnly) => {
      if (!listOnly && ++attempts === 1)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return {
        bodyMissing: 0,
        imageBlocked: 0,
        localMediaPendingArticleCount: 0,
      };
    },
  });
  f.deps.onMediaBlocked = async () => {
    stopped = true;
  };
  f.deps.mediaStopped = () => stopped;
  await f.tick();
  f.deps.read = async () => {
    const fresh = fixture(ids[0]);
    fresh.articles[0].contentHtml += '<p>synthetic new snapshot</p>';
    return fresh;
  };
  f.time(daytime + 1000);
  f.engine.signal({ [ids[0]]: 'synthetic-next-snapshot' });
  await f.tick();
  finish({ bodyMissing: 0, imageBlocked: 1, mediaRequestBlocked: true });
  await drain();
  assert.equal(
    stopped,
    true,
    'superseded job ignored security result before saving global stop',
  );
  await f.tick();
  assert.equal(attempts, 1);
  f.engine.close();
});

test('a one-call explicit archive permit does not lift the automatic night window', async () => {
  const f = setup();
  f.time(Date.parse('2026-10-11T16:30:00Z')); // Shanghai 00:30.
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return successImage();
  };
  const input = imagePage(
    `<div class="rich_media_content"><p>synthetic explicit repair</p><img src="${imageA}"></div>`,
  );
  await archiveProviderImages(input, {
    preserveTextOnImageFailure: true,
    canFetchImage: () => false,
  });
  assert.equal(requests, 0, 'ordinary archive must honor its night fence');
  // This explicit caller-scoped permit represents an already-authorized one-off.
  // It does not modify process.env, the clock, or the automatic scheduler.
  await archiveProviderImages(input, {
    preserveTextOnImageFailure: true,
    canFetchImage: () => true,
  });
  assert.equal(requests, 1);
  await f.tick();
  assert.equal(f.reads.length, 0);
  assert.equal(
    f.calls.length,
    0,
    'automatic background remains paused at night',
  );
  await archiveProviderImages(input, {
    preserveTextOnImageFailure: true,
    canFetchImage: () => false,
  });
  assert.equal(requests, 1, 'next ordinary invocation must still block');
  f.engine.close();
});
