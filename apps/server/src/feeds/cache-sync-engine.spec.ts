import {
  CacheSyncEngine,
  cachePageFingerprint,
  cacheSyncDaytime,
} from './cache-sync-engine';
import {
  cacheRevision,
  cacheDataChanged,
  cacheSyncState,
} from './cache-sync-state';
import { ProviderPage } from '../collection/subscription-provider';
import { Wechat2RssResponseError } from '../collection/providers/wechat2rss-response';
import { cacheSyncStatus } from './cache-sync-state';
const start = Date.parse('2026-10-11T08:00:00Z');
const ids = ['MP_WXS_1234567890', 'MP_WXS_2345678901'];
const metadata = (feedId = ids[0]) => ({
  feedId,
  name: feedId,
  feedUrl: `/feed/${feedId.slice(7)}.json`,
  checkTime: null,
  nextUpdateTime: null,
  paused: false,
});
const page = (body: string | null = null, index = 1): ProviderPage => ({
  articles: [
    {
      id: `WX_1234567890_9_${index}`,
      mpId: ids[0],
      url: `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=9&idx=${index}`,
      title: 'fixture',
      publishTime: 1791684000,
      contentHtml: body,
      picUrl: '',
    },
  ],
  bodyMissing: body ? 0 : 1,
  imageBlocked: 0,
  coverage: 'recent-window',
  upstreamCount: 1,
});
function setup(count = 1, mediaEnabled?: () => boolean, syncText?: jest.Mock) {
  let now = start;
  const list = jest
    .fn()
    .mockResolvedValue(ids.slice(0, count).map((id) => metadata(id)));
  const localFeeds = jest
    .fn()
    .mockResolvedValue(ids.slice(0, count).map((id) => ({ id, mpName: id })));
  const read = jest.fn().mockResolvedValue(page());
  const sync = jest.fn().mockResolvedValue({
    created: 0,
    updated: 0,
    bodyMissing: 1,
    imageBlocked: 0,
    localMediaPendingArticleCount: 0,
  });
  const engine = new CacheSyncEngine({
    now: () => now,
    list,
    localFeeds,
    read,
    sync,
    mediaEnabled,
    syncText,
  });
  cacheSyncState.signal = 'metadata';
  return {
    engine,
    list,
    localFeeds,
    read,
    sync,
    time: (offset: number) => {
      now = start + offset;
    },
  };
}
const drainMedia = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function reconciledFixture() {
  let mediaEnabled = true;
  const syncText = jest.fn().mockResolvedValue({ mediaReady: true });
  const inspect = jest.fn().mockResolvedValue({ mediaReady: false });
  const f = setup(1, () => mediaEnabled, syncText);
  (f.engine as any).deps.inspectLocalMedia = inspect;
  f.read.mockResolvedValue(page('<p>unchanged provider text</p>'));
  f.sync.mockResolvedValue({
    bodyMissing: 0,
    imageBlocked: 0,
    localMediaPendingArticleCount: 0,
  });
  await f.engine.tick();
  await drainMedia();
  expect(cacheSyncState.feeds[0].state).toBe('synced-cache');
  f.sync.mockClear();
  syncText.mockClear();
  f.time(60000);
  return {
    ...f,
    syncText,
    inspect,
    pauseMedia: () => {
      mediaEnabled = false;
    },
  };
}
describe('fresh unchanged-page text reconciliation', () => {
  it('uses one current text result for a healthy page without ingesting the list or archiving media', async () => {
    const f = await reconciledFixture();
    const revision = cacheRevision();
    await f.engine.tick();
    await drainMedia();
    expect(f.syncText).toHaveBeenCalledTimes(1);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.sync).not.toHaveBeenCalled();
    expect(cacheSyncState.feeds[0].state).toBe('synced-cache');
    expect(cacheRevision()).toEqual(revision);
    f.engine.close();
  });
  it.each([
    ['local media changed', { mediaReady: false }],
    ['body remains missing', { mediaReady: false, bodyMissing: 1 }],
    ['readiness omitted', {}],
    ['result unavailable', undefined],
  ])(
    'keeps %s pending using this tick rather than the previous complete result',
    async (_name, result) => {
      const f = await reconciledFixture();
      f.pauseMedia();
      f.syncText.mockResolvedValue(result);
      await f.engine.tick();
      expect(f.syncText).toHaveBeenCalledTimes(1);
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.sync).not.toHaveBeenCalled();
      expect(cacheSyncState.feeds[0].state).toBe('media-pending');
      f.engine.close();
    },
  );
  it('retains failure and retries fresh text reconciliation before declaring readiness', async () => {
    const f = await reconciledFixture();
    f.syncText.mockRejectedValueOnce(Error('OFFLINE_TEXT_FAILURE'));
    await f.engine.tick();
    expect(cacheSyncState.feeds[0].state).toBe('unavailable');
    expect(f.sync).not.toHaveBeenCalled();
    f.time(69000);
    await f.engine.tick();
    expect(f.syncText).toHaveBeenCalledTimes(1);
    f.time(70000);
    await f.engine.tick();
    expect(f.syncText).toHaveBeenCalledTimes(2);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(cacheSyncState.feeds[0].state).toBe('synced-cache');
    f.engine.close();
  });
  it('continues full list/text reconciliation when the provider body or media changes', async () => {
    const f = await reconciledFixture();
    f.pauseMedia();
    f.read.mockResolvedValue(
      page('<p>new body</p><img src="https://fixture.invalid/image">'),
    );
    await f.engine.tick();
    expect(f.sync.mock.calls.map((args) => args[2])).toEqual([true]);
    expect(f.syncText).toHaveBeenCalledTimes(1);
    expect(cacheSyncState.feeds[0].state).toBe('media-pending');
    f.engine.close();
  });
});
describe('existing-cache synchronization', () => {
  it('retains safe read-limit diagnostics, continues peers, and clears the error after recovery', async () => {
    const f = setup(
      2,
      () => false,
      jest.fn().mockResolvedValue({ mediaReady: true }),
    );
    f.read.mockRejectedValueOnce(
      new Wechat2RssResponseError('WECHAT2RSS_RESPONSE_TOO_LARGE', {
        responseBytes: 16777217,
        responseLimitBytes: 16777216,
      }),
    );
    await f.engine.tick();
    expect(cacheSyncState.feeds[0]).toMatchObject({
      state: 'unavailable',
      failure: {
        failureReason: 'CACHE_RESPONSE_TOO_LARGE',
        failurePoint: 'cache-read',
        failureCode: 'WECHAT2RSS_RESPONSE_TOO_LARGE',
        responseBytes: 16777217,
        responseLimitBytes: 16777216,
      },
    });
    expect(cacheSyncState.feeds[1].state).not.toBe('unavailable');
    const snapshot = cacheSyncStatus();
    snapshot.feeds[0].failure!.responseBytes = 0;
    expect(cacheSyncState.feeds[0].failure!.responseBytes).toBe(16777217);
    f.time(10000);
    await f.engine.tick();
    expect(cacheSyncState.feeds[0].state).toBe('media-pending');
    expect(cacheSyncState.feeds[0].failure).toBeUndefined();
    f.engine.close();
  });
  it('distinguishes metadata/read/import failure stages without raw messages or secrets', async () => {
    const f = setup(1, () => false);
    f.list.mockRejectedValueOnce(
      new Wechat2RssResponseError('WECHAT2RSS_HTTP_STATUS', {
        httpStatus: 503,
      }),
    );
    await f.engine.tick();
    expect(cacheSyncStatus().metadataFailure).toMatchObject({
      failureReason: 'CACHE_HTTP_STATUS',
      failurePoint: 'metadata-read',
      httpStatus: 503,
    });
    f.time(10000);
    f.sync.mockRejectedValueOnce(Error('private SQL synthetic-secret'));
    await f.engine.tick();
    expect(cacheSyncState.metadataFailure).toBeUndefined();
    expect(cacheSyncState.feeds[0].failure).toMatchObject({
      failurePoint: 'cache-import',
      failureReason: 'CACHE_UNKNOWN_ERROR',
    });
    expect(JSON.stringify(cacheSyncStatus())).not.toContain('synthetic-secret');
    f.engine.close();
  });
  it('saves text while CDN media is disabled, without invoking the media lane', async () => {
    const syncText = jest.fn().mockResolvedValue({ bodyMissing: 0 });
    const f = setup(1, () => false, syncText);
    f.read.mockResolvedValue(page('<p>cached text</p>'));
    await f.engine.tick();
    expect(syncText).toHaveBeenCalledWith(
      ids[0],
      expect.objectContaining({ bodyMissing: 0 }),
    );
    expect(f.sync.mock.calls.every((call) => call[2] === true)).toBe(true);
    f.engine.close();
  });
  it('pauses media without losing list imports or the pending media snapshot', async () => {
    let enabled = false;
    const f = setup(1, () => enabled);
    f.read.mockResolvedValue(page('<p>cached body</p>'));
    f.sync.mockResolvedValue({
      created: 1,
      updated: 0,
      bodyMissing: 0,
      imageBlocked: 0,
      localMediaPendingArticleCount: 0,
    });
    await f.engine.tick();
    expect(f.sync.mock.calls.map((args) => args[2])).toEqual([true]);
    expect(cacheSyncState.feeds[0].state).toBe('media-pending');
    f.time(5000);
    await f.engine.tick();
    expect(f.sync).toHaveBeenCalledTimes(1);
    enabled = true;
    await f.engine.tick();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.sync.mock.calls.map((args) => args[2])).toEqual([true, false]);
    expect(cacheSyncState.feeds[0].state).toBe('synced-cache');
    f.engine.close();
  });
  it('drains a committed signal received while the current worker is busy', async () => {
    const f = setup();
    let finish!: () => void;
    f.sync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ created: 1, bodyMissing: 1 });
        }),
    );
    const tick = f.engine.tick();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    f.read.mockResolvedValue(page(null, 2));
    f.engine.signal({ [ids[0]]: 'committed-next-snapshot' });
    await f.engine.tick();
    finish();
    await tick;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.sync.mock.calls.filter((args) => args[2])).toHaveLength(2);
    f.engine.close();
  });
  it('rechecks after check_time changes; delayed cache landing is not ignored', async () => {
    const f = setup();
    await f.engine.tick();
    f.list.mockResolvedValue([
      { ...metadata(), checkTime: '2026-10-11T08:00:05.000Z' },
    ]);
    f.time(5000);
    await f.engine.tick(); // Old nonempty cache.
    f.read.mockResolvedValue(page('<p>late fulltext</p>', 2));
    f.time(10000);
    await f.engine.tick();
    expect(f.sync.mock.calls.filter((args) => args[2])).toHaveLength(2);
    expect(
      f.sync.mock.calls.find((args) => args[1].articles[0].id.endsWith('_2')),
    ).toBeDefined();
  });
  it('body and media fills change fingerprint without changing publication/check times', () => {
    expect(cachePageFingerprint(page(null))).not.toBe(
      cachePageFingerprint(page('<p>body</p>')),
    );
    expect(cachePageFingerprint(page('<img>'))).not.toBe(
      cachePageFingerprint(page('<img src="https://mmbiz.qpic.cn/image">')),
    );
  });
  it('SQLite signal wakes an existing cache immediately and reads only changed feed', async () => {
    const f = setup(2);
    await f.engine.tick();
    f.time(1000);
    f.engine.signal({ [ids[0]]: 'a'.repeat(64) });
    f.read.mockClear();
    await f.engine.tick();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(1);
  });
  it('unchanged metadata/cache does not call list ingestion or advance revision', async () => {
    const f = setup();
    await f.engine.tick();
    f.sync.mockClear();
    const previous = cacheRevision();
    for (let tick = 1; tick <= 59; tick++) {
      f.time(tick * 1000);
      await f.engine.tick();
    }
    expect(f.list).toHaveBeenCalledTimes(12);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.sync).not.toHaveBeenCalled();
    expect(cacheRevision()).toEqual(previous);
  });
  it('prevents overlapping ticks and backs off unreachable upstream', async () => {
    const f = setup();
    let release!: (rows: ReturnType<typeof metadata>[]) => void;
    f.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.engine.tick();
    await f.engine.tick();
    expect(f.list).toHaveBeenCalledTimes(1);
    release([metadata()]);
    await pending;
    f.list.mockRejectedValue(Error('private-upstream-error'));
    f.time(5000);
    await f.engine.tick();
    for (let i = 6; i < 15; i++) {
      f.time(i * 1000);
      await f.engine.tick();
    }
    expect(f.list).toHaveBeenCalledTimes(2);
    f.time(15000);
    f.list.mockResolvedValue([metadata()]);
    await f.engine.tick();
    expect(f.list).toHaveBeenCalledTimes(3);
  });
  it('blocks body cache reads and media from 00 to 06 Shanghai; resumes after restart/day', async () => {
    const f = setup();
    f.time(-8 * 3600000); // 00:00 UTC = 08:00 Shanghai -- use explicit boundary below.
    expect(cacheSyncDaytime(Date.parse('2026-10-11T15:59:59Z'))).toBe(true);
    expect(cacheSyncDaytime(Date.parse('2026-10-11T16:00:00Z'))).toBe(false);
    expect(cacheSyncDaytime(Date.parse('2026-10-11T21:59:59Z'))).toBe(false);
    expect(cacheSyncDaytime(Date.parse('2026-10-11T22:00:00Z'))).toBe(true);
    f.time(8 * 3600000);
    await f.engine.tick(); // Shanghai 00:00.
    expect(f.read).not.toHaveBeenCalled();
    expect(f.sync).not.toHaveBeenCalled();
    f.time(14 * 3600000);
    await f.engine.tick(); // Shanghai 06:00.
    expect(f.read).toHaveBeenCalledTimes(1);
    f.engine.close();
    await f.engine.tick();
    expect(f.read).toHaveBeenCalledTimes(1);
    const restarted = setup();
    await restarted.engine.tick();
    expect(restarted.read).toHaveBeenCalledTimes(1);
  });
  it('paused feeds cannot submit, unpause or download via the cache engine', async () => {
    const f = setup();
    f.list.mockResolvedValue([{ ...metadata(), paused: true }]);
    await f.engine.tick();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.sync).not.toHaveBeenCalled();
    expect(cacheSyncState.feeds[0].state).toBe('paused');
  });
  it('slow media does not hold discovery/list processing', async () => {
    const f = setup();
    let finish!: () => void;
    f.sync.mockImplementation(async (_id, _page, listOnly) =>
      listOnly
        ? { created: 1 }
        : new Promise((resolve) => {
            finish = () => resolve({ bodyMissing: 0 });
          }),
    );
    await f.engine.tick();
    f.time(1000);
    f.engine.signal({ [ids[0]]: 'b'.repeat(64) });
    f.read.mockResolvedValue(page('<p>second</p>', 2));
    await f.engine.tick();
    expect(f.sync.mock.calls.filter((args) => args[2])).toHaveLength(2);
    finish();
    await Promise.resolve();
    await Promise.resolve();
  });
  it('revision queries are pure; only positive committed changes notify', () => {
    const before = cacheRevision();
    cacheDataChanged(0);
    cacheDataChanged(-1);
    expect(cacheRevision()).toEqual(before);
    cacheDataChanged(1);
    expect(cacheRevision()).not.toEqual(before);
  });
});

describe('media lane restriction isolation', () => {
  it('halts all media on a restriction but continues ordinary list reads', async () => {
    const f = setup(2);
    const stop = jest.fn().mockResolvedValue(undefined);
    (f.engine as any).deps.onMediaBlocked = stop;
    f.read.mockResolvedValue(page('<p>cached body</p>'));
    f.sync.mockImplementation(async (_id, _page, listOnly) =>
      listOnly
        ? { bodyMissing: 0, imageBlocked: 0 }
        : ({
            bodyMissing: 0,
            imageBlocked: 1,
            mediaRequestBlocked: true,
          } as any),
    );
    await f.engine.tick();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.sync.mock.calls.filter((args) => !args[2])).toHaveLength(1);
    f.time(60000);
    await f.engine.tick();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.sync.mock.calls.filter((args) => !args[2])).toHaveLength(1);
    expect(f.read.mock.calls.length).toBeGreaterThan(2);
    expect(cacheSyncState.state).toBe('media-blocked');
    f.engine.close();
  });
});
