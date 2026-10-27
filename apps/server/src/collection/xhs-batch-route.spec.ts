import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';

it('protects each batch route and forwards only validated local calls', async () => {
  const config = new ConfigService({
    auth: { code: 'synthetic' },
    platform: { url: '' },
    feed: { updateDelayTime: 0 },
  });
  const batch: any = {
    start: jest.fn(async () => ({ state: 'queued' })),
    status: jest.fn(async () => ({ state: 'paused' })),
    resume: jest.fn(async () => ({ state: 'queued' })),
    cancel: jest.fn(async () => ({ state: 'cancelled' })),
  };
  const router = new TrpcRouter(
    new TrpcService({} as any, config, {} as any, {} as any),
    {} as any,
    config,
    {} as any,
    {} as any,
    undefined,
    undefined,
    {} as any,
    undefined,
    undefined,
    batch,
  ).appRouter;
  const input = {
    clientRequestId: '11111111-1111-4111-8111-111111111111',
    text: 'synthetic https://xhslink.cn/o/example',
  };
  await expect(
    router
      .createCaller({ errorMsg: 'unauthenticated', isLocalSave: true })
      .xiaohongshu.startSubscriptionBatch(input),
  ).rejects.toThrow();
  await expect(
    router
      .createCaller({ errorMsg: null, isLocalSave: false })
      .xiaohongshu.startSubscriptionBatch(input),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const local = router.createCaller({ errorMsg: null, isLocalSave: true });
  await expect(
    local.xiaohongshu.startSubscriptionBatch({
      ...input,
      clientRequestId: 'invalid',
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(batch.start).not.toHaveBeenCalled();
  expect(await local.xiaohongshu.startSubscriptionBatch(input)).toEqual({
    state: 'queued',
  });
  expect(
    await local.xiaohongshu.subscriptionBatch({
      batchId: input.clientRequestId,
    }),
  ).toEqual({ state: 'paused' });
  expect(
    await local.xiaohongshu.resumeSubscriptionBatch({
      batchId: input.clientRequestId,
      text: input.text,
    }),
  ).toEqual({ state: 'queued' });
  expect(
    await local.xiaohongshu.cancelSubscriptionBatch({
      batchId: input.clientRequestId,
    }),
  ).toEqual({ state: 'cancelled' });
  expect(batch.start).toHaveBeenCalledTimes(1);
});
