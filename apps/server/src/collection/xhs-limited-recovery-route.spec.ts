import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';

it('requires authenticated local access and explicit confirmation before limited recovery', async () => {
  const config = new ConfigService({
    auth: { code: 'synthetic' },
    platform: { url: '' },
    feed: { updateDelayTime: 0 },
  });
  const runtime: any = {
    resolveLimitedRecovery: jest.fn(async () => ({
      owner: 'internal',
      originalUrl:
        'https://www.xiaohongshu.com/explore/synthetic?xsec_token=synthetic',
      author: {},
      note: {},
    })),
  };
  const subscriptions: any = {
    commitLimitedRecovery: jest.fn(async () => ({
      subscribed: true,
      body: 'saved',
      media: 'pending',
    })),
  };
  const router = new TrpcRouter(
    new TrpcService({} as any, config, {} as any, {} as any),
    {} as any,
    config,
    {} as any,
    {} as any,
    undefined,
    subscriptions,
    runtime,
  ).appRouter;
  const input = {
    url: 'https://www.xiaohongshu.com/explore/synthetic?xsec_token=synthetic',
    expectedAuthorId: 'synthetic-author',
    confirmLimitedRecovery: true as const,
  };
  await expect(
    router
      .createCaller({ errorMsg: 'unauthenticated', isLocalSave: true })
      .xiaohongshu.recoverSingleNote(input),
  ).rejects.toThrow();
  await expect(
    router
      .createCaller({ errorMsg: null, isLocalSave: false })
      .xiaohongshu.recoverSingleNote(input),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const local = router.createCaller({ errorMsg: null, isLocalSave: true });
  await expect(
    local.xiaohongshu.recoverSingleNote({
      ...input,
      confirmLimitedRecovery: false,
    } as any),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(runtime.resolveLimitedRecovery).not.toHaveBeenCalled();
  expect(await local.xiaohongshu.recoverSingleNote(input)).toMatchObject({
    subscribed: true,
    body: 'saved',
    media: 'pending',
  });
  expect(runtime.resolveLimitedRecovery).toHaveBeenCalledTimes(1);
  expect(subscriptions.commitLimitedRecovery).toHaveBeenCalledTimes(1);
});
