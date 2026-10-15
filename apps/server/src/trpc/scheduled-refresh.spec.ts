import { TrpcService } from './trpc.service';
import { FeedsService } from '../feeds/feeds.service';
import { wechat2RssProvider } from '../collection/provider-registry';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
jest.mock('../collection/provider-registry', () => ({
  wechat2RssProvider: jest.fn(),
  enabledWechat2RssFeedIds: () => new Set(),
}));
jest.mock('../collection/sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest.fn(),
}));

jest.mock('../collection/refresh-submission-claim', () => ({
  readRefreshSubmission: jest.fn().mockResolvedValue(undefined),
  reserveRefreshSubmission: jest.fn(async (prisma, feed, _batch, now) => {
    const reserved = await prisma.feed.updateMany({
      where: {
        id: feed.id,
        status: 1,
        collectionChannel: feed.collectionChannel,
        providerRefreshAttemptTime: { lte: now - 900 },
      },
      data: { providerRefreshAttemptTime: now },
    });
    return reserved.count === 1
      ? {
          ticket: {
            id: 'synthetic',
            mpId: feed.id,
            reservedAt: now,
            previousAt: feed.providerRefreshAttemptTime || 0,
          },
        }
      : { outcome: { state: 'skipped', accepted: false, stopBatch: false } };
  }),
  beginRefreshSubmission: jest.fn().mockResolvedValue(undefined),
  finishRefreshSubmission: jest.fn().mockResolvedValue(undefined),
  cancelRefreshPreparation: jest.fn(async (prisma, ticket) => {
    await prisma.feed.updateMany({
      where: { id: ticket.mpId, providerRefreshAttemptTime: ticket.reservedAt },
      data: { providerRefreshAttemptTime: ticket.previousAt },
    });
  }),
}));

describe('dynamic automatic subscription boundary (offline)', () => {
  const original = { ...process.env };
  const id = 'MP_WXS_1234567890',
    futureId = 'MP_WXS_2234567890';
  let service: any, feed: any, provider: any;
  beforeEach(() => {
    Object.assign(process.env, {
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
      WECHAT2RSS_ENABLED: '1',
    });
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-12T09:15:00+08:00'));
    feed = { id, status: 1, collectionChannel: 'wechat2rss' };
    service = Object.create(TrpcService.prototype);
    service.activeCollections = new Set();
    service.activeSubscriptionAdds = new Set();
    service.isRefreshAllMpArticlesRunning = false;
    service.prismaService = {
      feed: {
        findMany: jest.fn().mockResolvedValue([feed]),
        findUnique: jest.fn().mockImplementation(async () => feed),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service.subscriptionBatches = {
      enqueueRefresh: jest.fn().mockResolvedValue({}),
      list: jest.fn().mockResolvedValue([]),
    };
    provider = {
      checkAccountStatus: jest
        .fn()
        .mockResolvedValue({ available: true, challenged: false }),
      refreshSubscription: jest.fn().mockResolvedValue({ accepted: true }),
    };
    (wechat2RssProvider as jest.Mock).mockReturnValue(provider);
    (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
      source: 'synthetic',
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    for (const key of [
      'WECHAT2RSS_ACTIVE_SCHEDULE',
      'ENABLE_SCHEDULED_UPDATES',
      'DISABLE_SCHEDULED_UPDATES',
      'WECHAT2RSS_ENABLED',
    ]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  it('dynamically includes future valid feeds without the legacy whitelist and excludes disabled/other channels', async () => {
    process.env.SCHEDULED_MP_IDS = id;
    const key = 'a'.repeat(64);
    try {
      await service.beginScheduledRefreshAll(key);
      service.prismaService.feed.findMany.mockResolvedValue([
        feed,
        { ...feed, id: futureId },
        { ...feed, id: 'MP_WXS_3234567890', status: 0 },
        {
          ...feed,
          id: 'MP_WXS_4234567890',
          collectionChannel: 'owner-weread-latest',
        },
      ]);
      await service.beginScheduledRefreshAll('b'.repeat(64));
      expect(service.subscriptionBatches.enqueueRefresh.mock.calls).toEqual([
        [[id], key, 'scheduled-refresh'],
        [[id, futureId], 'b'.repeat(64), 'scheduled-refresh'],
      ]);
      expect(
        service.prismaService.feed.findMany.mock.calls[1][0].where,
      ).toEqual({ status: 1 });
      expect(provider.refreshSubscription).not.toHaveBeenCalled();
    } finally {
      if (original.SCHEDULED_MP_IDS === undefined)
        delete process.env.SCHEDULED_MP_IDS;
      else process.env.SCHEDULED_MP_IDS = original.SCHEDULED_MP_IDS;
    }
  });
  it.each([
    null,
    { status: 0, collectionChannel: 'wechat2rss' },
    { status: 1, collectionChannel: 'owner-weread-latest' },
  ])(
    'skips deleted/disabled/source-changed item without pausing the remaining round',
    async (changed) => {
      feed = changed;
      expect(
        await service.runManualRefresh(id, 'submit', true, {
          claimKey: 'synthetic',
        }),
      ).toMatchObject({
        state: 'skipped',
        accepted: false,
      });
      expect(provider.refreshSubscription).not.toHaveBeenCalled();
      expect(service.prismaService.feed.updateMany).not.toHaveBeenCalled();
    },
  );
  it('shares the 15-minute reservation with single manual refresh, skipping a cooling automatic item', async () => {
    service.prismaService.feed.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await service.runManualRefresh(id, 'submit', true, {
        claimKey: 'synthetic',
      }),
    ).toMatchObject({
      state: 'skipped',
      accepted: false,
    });
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
  });
  it('account risk control blocks the round, while upstream paused/missing records are never reenabled', async () => {
    provider.checkAccountStatus.mockResolvedValue({
      available: false,
      challenged: true,
      retryAfter: '3600',
    });
    expect(
      await service.runManualRefresh(id, 'submit', true, {
        claimKey: 'synthetic',
      }),
    ).toMatchObject({
      state: 'blocked',
      accepted: false,
    });
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
    provider.checkAccountStatus.mockResolvedValue({
      available: true,
      challenged: false,
    });
    provider.refreshSubscription.mockRejectedValue(
      Error('WECHAT2RSS_SUBSCRIPTION_PAUSED'),
    );
    expect(
      await service.runManualRefresh(id, 'submit', true, {
        claimKey: 'synthetic',
      }),
    ).toMatchObject({
      state: 'skipped',
      accepted: false,
    });
  });
  it('midnight closes before any account/provider lookup', async () => {
    (Date.now as jest.Mock).mockReturnValue(
      Date.parse('2026-10-13T00:00:00+08:00'),
    );
    expect(
      await service.runManualRefresh(id, 'submit', true, {
        claimKey: 'synthetic',
      }),
    ).toMatchObject({
      state: 'queued',
      accepted: false,
    });
    expect(provider.checkAccountStatus).not.toHaveBeenCalled();
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
  });
  it('new mode suppresses both old cron and old startup catchup, even with legacy 17:35 config', async () => {
    const prisma = { feed: { findMany: jest.fn(), findUnique: jest.fn() } };
    const trpc = { refreshMpArticlesAndUpdateFeed: jest.fn() };
    const feeds = new FeedsService(prisma as any, trpc as any, {} as any);
    await feeds.handleUpdateFeedsCron();
    await feeds.catchUpDailyWechat2Rss();
    expect(prisma.feed.findMany).not.toHaveBeenCalled();
    expect(prisma.feed.findUnique).not.toHaveBeenCalled();
    expect(trpc.refreshMpArticlesAndUpdateFeed).not.toHaveBeenCalled();
  });
});
