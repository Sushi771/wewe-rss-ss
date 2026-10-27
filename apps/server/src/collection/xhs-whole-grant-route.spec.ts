import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';

it('requires explicit local authorization and never starts the prepared job', async () => {
  const config = new ConfigService({
    auth: { code: 'synthetic' },
    platform: { url: '' },
    feed: { updateDelayTime: 0 },
  });
  const whole: any = {
    prepareHistoryGrant: jest
      .fn()
      .mockResolvedValue({ id: 'synthetic', state: 'paused' }),
    resume: jest.fn(),
    extendHistoryPhase: jest.fn().mockResolvedValue({ state: 'paused' }),
  };
  const router = new TrpcRouter(
    new TrpcService({} as any, config, {} as any, {} as any),
    {} as any,
    config,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    whole,
  ).appRouter;
  const input = {
    creatorId: 'synthetic',
    expectedAuthorId: 'author',
    requestLimit: 20,
    intervalMs: 1000,
    phaseLimits: { profile: 2, list: 2, detail: 10, metrics: 2 },
    confirmHistoryGrant: true as const,
  };
  await expect(
    router
      .createCaller({ errorMsg: 'unauthenticated', isLocalSave: true })
      .xiaohongshu.prepareWholeCreatorHistoryGrant(input),
  ).rejects.toThrow();
  await expect(
    router
      .createCaller({ errorMsg: null, isLocalSave: false })
      .xiaohongshu.prepareWholeCreatorHistoryGrant(input),
  ).rejects.toThrow();
  const local = router.createCaller({ errorMsg: null, isLocalSave: true });
  await expect(
    local.xiaohongshu.prepareWholeCreatorHistoryGrant({
      ...input,
      confirmHistoryGrant: false,
    } as any),
  ).rejects.toThrow();
  expect(whole.prepareHistoryGrant).not.toHaveBeenCalled();
  expect(
    await local.xiaohongshu.prepareWholeCreatorHistoryGrant(input),
  ).toMatchObject({ state: 'paused' });
  expect(whole.prepareHistoryGrant).toHaveBeenCalledTimes(1);
  expect(whole.resume).not.toHaveBeenCalled();
});
