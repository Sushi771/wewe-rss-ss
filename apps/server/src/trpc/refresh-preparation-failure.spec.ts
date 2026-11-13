import { TrpcService } from './trpc.service';
import * as registry from '../collection/provider-registry';
import * as backups from '../collection/sqlite-backup';
import * as claims from '../collection/refresh-submission-claim';
import { Wechat2RssProvider } from '../collection/providers/wechat2rss';
import { Wechat2RssSourceGate } from '../collection/wechat2rss-source-gate';

describe('real refresh preparation source gate (synthetic, offline)', () => {
  const enabled = process.env.WECHAT2RSS_ENABLED;
  beforeEach(() => {
    process.env.WECHAT2RSS_ENABLED = '1';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (enabled === undefined) delete process.env.WECHAT2RSS_ENABLED;
    else process.env.WECHAT2RSS_ENABLED = enabled;
  });

  function fixture() {
    const pending = Object.freeze({ state: 'pending', status: null });
    const prisma: any = {
      feed: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'MP_WXS_1234567890',
          status: 1,
          collectionChannel: 'wechat2rss',
          providerRefreshAttemptTime: 0,
        }),
        updateMany: jest.fn(),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      // A pending row cannot satisfy gate.begin's WHERE state = 'idle'.
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn(),
    };
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:9',
      'synthetic-dummy-not-a-credential',
      new Wechat2RssSourceGate(prisma),
    );
    jest.spyOn(registry, 'wechat2RssProvider').mockReturnValue(provider);
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('FETCH_FORBIDDEN'));
    const backup = jest
      .spyOn(backups, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('BACKUP_FORBIDDEN'));
    const reserve = jest.spyOn(claims, 'reserveRefreshSubmission');
    const read = jest.spyOn(claims, 'readRefreshSubmission');
    const prepare = jest.spyOn(provider, 'prepareRefreshSubscription');
    const service: any = Object.create(TrpcService.prototype);
    Object.assign(service, {
      prismaService: prisma,
      activeCollections: new Set(),
      activeSubscriptionAdds: new Set(),
      preparedRefreshCount: 0,
    });
    return {
      service,
      prisma,
      provider,
      pending,
      fetch,
      backup,
      reserve,
      read,
      prepare,
    };
  }
  it('retains a pending gate and reports a nonretryable pre-request block', async () => {
    const { service, prisma, pending, fetch, backup, reserve, read, prepare } =
      fixture();
    const job = await service.prepareRefreshWaveItem(
      'MP_WXS_1234567890',
      true,
      'synthetic-wave/1',
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0][0].join('?')).toContain(
      "WHERE id = 1 AND state = 'idle'",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(prisma.feed.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(pending).toEqual({ state: 'pending', status: null });
    expect(job.submit).toBeUndefined();
    expect(service.activeCollections.size).toBe(0);
    expect(service.activeSubscriptionAdds.size).toBe(0);
    expect(service.preparedRefreshCount).toBe(0);
    expect(job.outcome).toMatchObject({
      state: 'blocked',
      accepted: false,
      submissionUnknown: false,
      retryable: false,
      stopBatch: true,
      preparationFailure: {
        code: 'WECHAT2RSS_SOURCE_STOPPED',
        stage: 'account-status',
      },
    });
  });
  it.each([
    'feed-lookup',
    'claim-read',
    'provider-config',
    'subscription-check',
    'reservation',
  ] as const)(
    'retains the exact safe %s stage without exposing exception text',
    async (stage) => {
      const { service, prisma, provider, fetch, backup, reserve, prepare } =
        fixture();
      const raw = Error('DO_NOT_PERSIST private path/token/SQL');
      if (stage === 'feed-lookup')
        prisma.feed.findUnique.mockRejectedValue(raw);
      if (stage === 'claim-read') prisma.$queryRawUnsafe.mockRejectedValue(raw);
      if (stage === 'provider-config')
        jest.mocked(registry.wechat2RssProvider).mockImplementation(() => {
          throw raw;
        });
      if (stage === 'subscription-check' || stage === 'reservation')
        jest.spyOn(provider, 'checkAccountStatus').mockResolvedValue({
          available: true,
          challenged: false,
          retryAfter: undefined,
        });
      if (stage === 'subscription-check') prepare.mockRejectedValue(raw);
      if (stage === 'reservation') {
        prepare.mockResolvedValue(async () => {
          throw Error('SUBMIT_FORBIDDEN');
        });
        reserve.mockRejectedValue(raw);
      }
      const result = await service.prepareRefreshWaveItem(
        'MP_WXS_1234567890',
        true,
        'synthetic-wave/1',
      );
      expect(result.submit).toBeUndefined();
      expect(result.outcome).toMatchObject({
        state: 'failed',
        retryable: true,
        stopBatch: false,
        preparationFailure: { code: 'REFRESH_PREPARATION_FAILED', stage },
      });
      expect(JSON.stringify(result.outcome)).not.toContain('DO_NOT_PERSIST');
      expect(fetch).not.toHaveBeenCalled();
      expect(backup).not.toHaveBeenCalled();
      expect(service.activeCollections.size).toBe(0);
      expect(service.activeSubscriptionAdds.size).toBe(0);
      expect(service.preparedRefreshCount).toBe(0);
    },
  );
});
