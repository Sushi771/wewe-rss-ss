import { dailyWechat2RssCatchup } from './daily-cache-catchup';
import { FeedsService } from './feeds.service';

const id = 'MP_WXS_1234567890';
const enabled = {
  WECHAT2RSS_DAILY_CATCHUP: '1',
  ENABLE_SCHEDULED_UPDATES: '1',
  DISABLE_SCHEDULED_UPDATES: '0',
  WECHAT2RSS_ENABLED: '1',
  SCHEDULED_MP_IDS: id,
  CRON_EXPRESSION: '35 17 * * *',
};
const afterDue = Date.parse('2026-10-10T18:00:00+08:00');
const due = Date.parse('2026-10-10T17:35:00+08:00') / 1000;

describe('single-subscription missed daily cache read', () => {
  const original = { ...process.env };
  beforeEach(() => Object.assign(process.env, enabled));
  afterEach(() => {
    for (const key of Object.keys(enabled)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    jest.restoreAllMocks();
  });

  it('uses Shanghai time and only the latest due slot after days off', () => {
    expect(dailyWechat2RssCatchup(enabled, afterDue)).toEqual({
      id,
      dueTime: due,
    });
    expect(
      dailyWechat2RssCatchup(enabled, Date.parse('2026-10-10T08:00:00+08:00')),
    ).toEqual({ id, dueTime: due - 86400 });
  });

  it.each([NaN, Infinity, 1e30])('rejects an invalid clock %s', (now) => {
    expect(dailyWechat2RssCatchup(enabled, now)).toBeUndefined();
  });

  it.each([
    { WECHAT2RSS_DAILY_CATCHUP: '0' },
    { ENABLE_SCHEDULED_UPDATES: '0' },
    { DISABLE_SCHEDULED_UPDATES: '1' },
    { WECHAT2RSS_ENABLED: '0' },
    { SCHEDULED_MP_IDS: '' },
    { SCHEDULED_MP_IDS: `${id},MP_WXS_9876543210` },
    { CRON_EXPRESSION: '35 5,17 * * *' },
    { CRON_EXPRESSION: '60 17 * * *' },
    { CRON_EXPRESSION: '35 24 * * *' },
  ])('stops before database reads with %j', async (patch) => {
    Object.assign(process.env, patch);
    const prisma = { feed: { findUnique: jest.fn() } };
    const trpc = { refreshMpArticlesAndUpdateFeed: jest.fn() };
    await new FeedsService(
      prisma as any,
      trpc as any,
      {} as any,
    ).catchUpDailyWechat2Rss(afterDue);
    expect(prisma.feed.findUnique).not.toHaveBeenCalled();
    expect(trpc.refreshMpArticlesAndUpdateFeed).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id, status: 0, collectionChannel: 'wechat2rss', syncTime: 0 },
    { id, status: 1, collectionChannel: 'owner-weread-latest', syncTime: 0 },
    { id, status: 1, collectionChannel: 'wechat2rss', syncTime: due },
    { id, status: 1, collectionChannel: 'wechat2rss', syncTime: due + 10 },
  ])('retains paused/other-source/already-consumed feed %j', async (feed) => {
    const prisma = { feed: { findUnique: jest.fn().mockResolvedValue(feed) } };
    const trpc = { refreshMpArticlesAndUpdateFeed: jest.fn() };
    await new FeedsService(
      prisma as any,
      trpc as any,
      {} as any,
    ).catchUpDailyWechat2Rss(afterDue);
    expect(trpc.refreshMpArticlesAndUpdateFeed).not.toHaveBeenCalled();
  });

  it('consumes once through the scheduled route and retains its in-flight lock', async () => {
    const feed = {
      id,
      status: 1,
      collectionChannel: 'wechat2rss',
      syncTime: 0,
    };
    const prisma = { feed: { findUnique: jest.fn().mockResolvedValue(feed) } };
    let complete: (value: any) => void;
    const trpc = {
      refreshMpArticlesAndUpdateFeed: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      ),
    };
    const service = new FeedsService(prisma as any, trpc as any, {} as any);
    const first = service.catchUpDailyWechat2Rss(afterDue);
    await Promise.resolve();
    await service.catchUpDailyWechat2Rss(afterDue);
    expect(trpc.refreshMpArticlesAndUpdateFeed).toHaveBeenCalledTimes(1);
    expect(trpc.refreshMpArticlesAndUpdateFeed).toHaveBeenCalledWith(
      id,
      1,
      'scheduled',
    );
    feed.syncTime = due;
    complete!({ status: 'partial' });
    await first;
    await service.catchUpDailyWechat2Rss(afterDue);
    expect(trpc.refreshMpArticlesAndUpdateFeed).toHaveBeenCalledTimes(1);
  });

  it('stops on a failed cache read without retries', async () => {
    const prisma = {
      feed: {
        findUnique: jest.fn().mockResolvedValue({
          id,
          status: 1,
          collectionChannel: 'wechat2rss',
          syncTime: 0,
        }),
      },
    };
    const trpc = {
      refreshMpArticlesAndUpdateFeed: jest
        .fn()
        .mockRejectedValue(new Error('NO_NETWORK_RETRY')),
    };
    await new FeedsService(
      prisma as any,
      trpc as any,
      {} as any,
    ).catchUpDailyWechat2Rss(afterDue);
    expect(trpc.refreshMpArticlesAndUpdateFeed).toHaveBeenCalledTimes(1);
  });

  it('queues after bootstrap and cancels queued work during shutdown', () => {
    const service = new FeedsService({} as any, {} as any, {} as any);
    const consume = jest.spyOn(service, 'catchUpDailyWechat2Rss');
    const clear = jest.spyOn(global, 'clearImmediate');
    service.onApplicationBootstrap();
    expect(consume).not.toHaveBeenCalled();
    service.onModuleDestroy();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
