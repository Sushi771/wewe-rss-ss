import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import * as startup from '../startup-audit';

describe('unknown occupancy local control authorization (no storage or HTTP)', () => {
  const input = {
    batchId: '11111111-1111-4111-8111-111111111111',
    feedId: 'MP_WXS_1234567890',
    approvalFile: 'never-read.json',
    approvalSha256: 'a'.repeat(64),
    evidenceFile: 'never-read.txt',
  };
  let service: TrpcService, router: TrpcRouter;
  let binding: jest.SpyInstance, release: jest.SpyInstance;
  beforeEach(() => {
    const config = { get: () => ({ url: '', updateDelayTime: 0 }) } as any;
    service = new TrpcService({} as any, config, {} as any, {} as any);
    binding = jest
      .spyOn(service, 'unknownRefreshReleaseBinding')
      .mockResolvedValue({} as any);
    release = jest
      .spyOn(service, 'releaseUnknownRefreshOccupancy')
      .mockResolvedValue({ reused: false } as any);
    router = new TrpcRouter(service, {} as any, config, {} as any, {} as any);
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });
  it.each([
    [{ isLocal: false, errorMsg: null }, 'FORBIDDEN'],
    [{ isLocal: true, errorMsg: 'synthetic unauthorized' }, 'UNAUTHORIZED'],
  ] as const)(
    'refuses an unauthorized control context %s',
    async (ctx, code) => {
      const caller = router.appRouter.createCaller(ctx as any);
      await expect(
        caller.feed.unknownRefreshReleaseBinding(input),
      ).rejects.toMatchObject({ code });
      await expect(
        caller.feed.releaseUnknownRefreshOccupancy(input),
      ).rejects.toMatchObject({ code });
      expect(binding).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
  it('allows an authorized local control but retains the startup mutation gate', async () => {
    const caller = router.appRouter.createCaller({
      isLocal: true,
      errorMsg: null,
    } as any);
    await expect(
      caller.feed.unknownRefreshReleaseBinding(input),
    ).resolves.toEqual({});
    const gate = jest
      .spyOn(startup, 'databaseWritesAllowed')
      .mockReturnValue(false);
    await expect(
      caller.feed.releaseUnknownRefreshOccupancy(input),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(release).not.toHaveBeenCalled();
    gate.mockRestore();
    await expect(
      caller.feed.releaseUnknownRefreshOccupancy(input),
    ).resolves.toMatchObject({ reused: false });
    expect(release).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
