import { TrpcService } from './trpc.service';
import { wechat2RssProvider } from '../collection/provider-registry';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
jest.mock('../collection/provider-registry', () => ({
  wechat2RssProvider: jest.fn(),
  enabledWechat2RssFeedIds: () => new Set(),
}));
jest.mock('../collection/sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest.fn(),
}));

describe('explicit manual all-refresh boundary (offline)', () => {
  const id = 'MP_WXS_1234567890';
  let service: any, provider: any, feed: any;
  const previousEnabled = process.env.WECHAT2RSS_ENABLED;
  afterAll(() => {
    if (previousEnabled === undefined) delete process.env.WECHAT2RSS_ENABLED;
    else process.env.WECHAT2RSS_ENABLED = previousEnabled;
  });
  beforeEach(() => {
    process.env.WECHAT2RSS_ENABLED = '1';
    jest.clearAllMocks();
    feed = {
      id,
      status: 1,
      collectionChannel: 'wechat2rss',
      providerRefreshAttemptTime: 0,
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
    service = Object.create(TrpcService.prototype);
    service.activeCollections = new Set();
    service.activeSubscriptionAdds = new Set();
    service.isRefreshAllMpArticlesRunning = false;
    service.prismaService = {
      feed: {
        findUnique: jest.fn().mockImplementation(async () => feed),
        findMany: jest.fn().mockResolvedValue([feed]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service.subscriptionBatches = {
      enqueueRefresh: jest.fn().mockResolvedValue({
        batchId: 'synthetic',
        purpose: 'manual-refresh',
        items: [{ feedId: id, state: 'queued' }],
        reused: false,
      }),
      list: jest
        .fn()
        .mockResolvedValue([
          { purpose: 'subscription' },
          { purpose: 'manual-refresh' },
        ]),
    };
    service.refreshMpArticlesAndUpdateFeed = jest.fn().mockResolvedValue({
      articles: 10,
      bodyMissing: 0,
      imageBlocked: 0,
      status: 'partial',
    });
  });
  it('immediately acknowledges the frozen eligible set without performing a provider update or cache fetch', async () => {
    const reply = await service.beginManualRefreshAll([id]);
    expect(reply).toMatchObject({ total: 1, queuedCount: 1, skippedCount: 0 });
    expect(service.prismaService.feed.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [id] },
    });
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
    expect(service.refreshMpArticlesAndUpdateFeed).not.toHaveBeenCalled();
  });
  it('ordinary subscription projections keep all original batches and do not expose manual ones', async () => {
    expect(await service.subscriptionBatchList()).toEqual([
      { purpose: 'subscription' },
    ]);
    expect(await service.subscriptionBatchList(true)).toHaveLength(2);
  });
  it('an original-click intent rejoins its durable completed record without querying changed subscriptions or submitting', async () => {
    const intentKey = 'a'.repeat(64);
    service.subscriptionBatches.list.mockResolvedValue([
      {
        batchId: 'original',
        purpose: 'manual-refresh',
        intentKey,
        state: 'completed',
        items: [{ state: 'succeeded' }],
      },
    ]);
    service.isRefreshAllMpArticlesRunning = true;
    expect(await service.beginManualRefreshAll([id], intentKey)).toMatchObject({
      batchId: 'original',
      reused: true,
      total: 1,
      queuedCount: 0,
    });
    expect(service.prismaService.feed.findMany).not.toHaveBeenCalled();
    expect(service.subscriptionBatches.enqueueRefresh).not.toHaveBeenCalled();
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
  });
  it('the old in-flight cache batch prevents another all-refresh request', async () => {
    service.isRefreshAllMpArticlesRunning = true;
    await expect(service.beginManualRefreshAll()).rejects.toThrow(
      '原批量缓存同步仍在后台运行',
    );
    expect(service.subscriptionBatches.enqueueRefresh).not.toHaveBeenCalled();
  });
  it('backs up and atomically reserves the existing per-feed 15-minute cooldown before one provider update', async () => {
    expect(await service.runManualRefresh(id, 'submit')).toMatchObject({
      state: 'waiting',
      accepted: true,
    });
    const reservation = service.prismaService.feed.updateMany.mock.calls[0][0];
    expect(reservation.where).toMatchObject({
      id,
      status: 1,
      collectionChannel: 'wechat2rss',
    });
    expect(
      reservation.data.providerRefreshAttemptTime -
        reservation.where.providerRefreshAttemptTime.lte,
    ).toBe(900);
    expect(
      (createVerifiedSqliteBackup as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(
      service.prismaService.feed.updateMany.mock.invocationCallOrder[0],
    );
    expect(
      service.prismaService.feed.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(provider.refreshSubscription.mock.invocationCallOrder[0]);
    expect(provider.refreshSubscription).toHaveBeenCalledTimes(1);
    expect(service.activeCollections.size).toBe(0);
    expect(service.activeSubscriptionAdds.size).toBe(0);
  });
  it('account challenge, cooldown and paused/source-changed feeds cannot submit /add', async () => {
    provider.checkAccountStatus.mockResolvedValue({
      available: true,
      challenged: true,
    });
    expect(await service.runManualRefresh(id, 'submit')).toMatchObject({
      state: 'blocked',
      accepted: false,
    });
    provider.checkAccountStatus.mockResolvedValue({
      available: true,
      challenged: false,
    });
    service.prismaService.feed.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.runManualRefresh(id, 'submit')).toMatchObject({
      state: 'blocked',
      accepted: false,
    });
    feed.status = 0;
    expect(await service.runManualRefresh(id, 'submit')).toMatchObject({
      state: 'blocked',
      accepted: false,
    });
    feed.status = 1;
    feed.collectionChannel = 'public-album';
    expect(await service.runManualRefresh(id, 'submit')).toMatchObject({
      state: 'blocked',
      accepted: false,
    });
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
  });
  it('an unknown upstream receipt releases locks but retains its cooldown reservation', async () => {
    provider.refreshSubscription.mockRejectedValue(
      new Error('synthetic unknown receipt'),
    );
    await expect(service.runManualRefresh(id, 'submit')).rejects.toThrow(
      'synthetic unknown receipt',
    );
    expect(service.prismaService.feed.updateMany).toHaveBeenCalledTimes(1);
    expect(service.activeCollections.size).toBe(0);
    expect(service.activeSubscriptionAdds.size).toBe(0);
  });
  it('accepted continuation only reads cache and never calls refreshSubscription', async () => {
    expect(await service.runManualRefresh(id, 'cache')).toMatchObject({
      state: 'succeeded',
      accepted: true,
      listReady: true,
      bodyReady: true,
    });
    expect(service.refreshMpArticlesAndUpdateFeed).toHaveBeenCalledWith(
      id,
      1,
      'local-manual',
    );
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
    expect(provider.checkAccountStatus).not.toHaveBeenCalled();
  });
  it('rechecks a lock acquired during feed lookup without removing another operation lock', async () => {
    service.prismaService.feed.findUnique.mockImplementation(async () => {
      service.activeCollections.add(id);
      return feed;
    });
    expect(await service.runManualRefresh(id, 'submit')).toMatchObject({
      state: 'queued',
      accepted: false,
    });
    expect(provider.refreshSubscription).not.toHaveBeenCalled();
    expect(service.activeCollections.has(id)).toBe(true);
  });
});
