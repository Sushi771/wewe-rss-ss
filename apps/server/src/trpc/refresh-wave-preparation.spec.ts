import { TrpcService } from './trpc.service';
import * as registry from '../collection/provider-registry';
import * as backups from '../collection/sqlite-backup';
import { PreparedRefresh } from '../collection/wechat2rss-subscription-batches';

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

describe('refresh wave preparation (offline)', () => {
  const saved = process.env.WECHAT2RSS_ENABLED;
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.WECHAT2RSS_ENABLED;
    else process.env.WECHAT2RSS_ENABLED = saved;
  });
  function fixture() {
    process.env.WECHAT2RSS_ENABLED = '1';
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const events: string[] = [];
    const service: any = Object.create(TrpcService.prototype);
    service.activeCollections = new Set();
    service.activeSubscriptionAdds = new Set();
    service.preparedRefreshCount = 0;
    service.prismaService = {
      feed: {
        findUnique: jest.fn(async ({ where }) => ({
          id: where.id,
          status: 1,
          collectionChannel: 'wechat2rss',
          providerRefreshAttemptTime: 0,
        })),
        updateMany: jest.fn(async () => {
          events.push('write');
          return { count: 1 };
        }),
      },
    };
    jest
      .spyOn(backups, 'createVerifiedSqliteBackup')
      .mockImplementation(async () => {
        events.push('backup');
        return {} as any;
      });
    const send = jest.fn(async () => {
      events.push('send');
      return { accepted: true, pending: true };
    });
    const provider: any = {
      checkAccountStatus: jest.fn(async () => ({
        available: true,
        challenged: false,
      })),
      prepareRefreshSubscription: jest.fn(async () => {
        events.push('list');
        return send;
      }),
    };
    jest.spyOn(registry, 'wechat2RssProvider').mockReturnValue(provider);
    return { service, events, send, provider };
  }
  it('finishes serial list/durable reservation before exposing network-only closures, and releases guards', async () => {
    const { service, events } = fixture();
    const jobs: PreparedRefresh[] = [];
    for (let i = 0; i < 5; i++)
      jobs.push(
        await service.prepareRefreshWaveItem(
          `MP_WXS_${1234560000 + i}`,
          false,
          'fixture-wave',
        ),
      );
    expect(events).toEqual(
      Array.from({ length: 5 }, () => ['list', 'write']).flat(),
    );
    expect(service.activeCollections.size).toBe(5);
    const writes = service.prismaService.feed.updateMany.mock.calls.length;
    await Promise.all(jobs.map((j) => j.submit!()));
    expect(events.slice(-5)).toEqual(['send', 'send', 'send', 'send', 'send']);
    expect(service.prismaService.feed.updateMany.mock.calls.length).toBe(
      writes,
    );
    jobs.forEach((j) => j.release());
    expect(service.activeCollections.size).toBe(0);
    expect(service.activeSubscriptionAdds.size).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('rejects another wave and restores only an unlaunched reservation when cancelled', async () => {
    const { service, send } = fixture();
    const first = await service.prepareRefreshWaveItem(
      'MP_WXS_1234560000',
      false,
      'first-wave',
    );
    const other = await service.prepareRefreshWaveItem(
      'MP_WXS_1234560001',
      false,
      'other-wave',
    );
    expect(other.submit).toBeUndefined();
    await first.cancel();
    expect(service.prismaService.feed.updateMany.mock.calls[1][0].data).toEqual(
      { providerRefreshAttemptTime: 0 },
    );
    first.release();
    expect(send).not.toHaveBeenCalled();
  });
  it('a restricted account exposes no request closure or database reservation', async () => {
    const { service, provider, send } = fixture();
    provider.checkAccountStatus.mockResolvedValue({
      available: false,
      challenged: true,
    });
    const job = await service.prepareRefreshWaveItem(
      'MP_WXS_1234560000',
      false,
      'fixture-wave',
    );
    expect(job.outcome.sharedRestriction).toBe(true);
    expect(job.submit).toBeUndefined();
    expect(service.prismaService.feed.updateMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
