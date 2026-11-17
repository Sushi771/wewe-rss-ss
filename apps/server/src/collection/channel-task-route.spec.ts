import { ConfigService } from '@nestjs/config';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { ChannelTaskHistory } from './channel-task-history';
import { recoveryHoldLocalProcedure } from '../recovery-hold-http';

it('keeps channel management local, authenticated, strict, and source-free even during global hold', async () => {
  const previous = process.env.WECHAT2RSS_RECOVERY_HOLD;
  const config = new ConfigService({
    auth: { code: 'fixture' },
    platform: { url: '' },
    feed: { updateDelayTime: 0 },
  });
  const service = new TrpcService({} as any, config, {} as any, {} as any);
  const router = new TrpcRouter(
    service,
    {} as any,
    config,
    {} as any,
    {} as any,
  ).appRouter;
  const preview = jest
    .spyOn(ChannelTaskHistory.prototype, 'preview')
    .mockResolvedValue({ channel: 'wechat' } as any);
  const confirm = jest
    .spyOn(ChannelTaskHistory.prototype, 'confirm')
    .mockResolvedValue({ paused: true } as any);
  const source = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(Error('SOURCE_FORBIDDEN'));
  try {
    process.env.WECHAT2RSS_RECOVERY_HOLD = '1';
    await expect(
      router
        .createCaller({ errorMsg: 'unauthenticated', isLocalSave: true })
        .channelTasks.preview({ channel: 'wechat', action: 'archive' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      router
        .createCaller({ isLocalSave: false })
        .channelTasks.preview({ channel: 'wechat', action: 'archive' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const local = router.createCaller({ isLocalSave: true });
    await expect(
      local.channelTasks.preview({ channel: 'bad', action: 'archive' } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      local.channelTasks.preview({
        channel: 'wechat',
        action: 'archive',
        unsafe: true,
      } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      local.channelTasks.confirm({
        channel: 'wechat',
        action: 'archive',
        digest: 'a'.repeat(64),
        acknowledged: false,
      } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      await local.channelTasks.preview({
        channel: 'wechat',
        action: 'archive',
      }),
    ).toEqual({ channel: 'wechat' });
    expect(
      await local.channelTasks.confirm({
        channel: 'wechat',
        action: 'archive',
        digest: 'a'.repeat(64),
        acknowledged: true,
      }),
    ).toEqual({ paused: true });
    expect(
      recoveryHoldLocalProcedure('channelTasks.confirm', 'mutation', {
        isLocalXhsRead: true,
      }),
    ).toBe(false);
    expect(
      recoveryHoldLocalProcedure(
        'channelTasks.confirm,feed.beginRefreshAll',
        'mutation',
        { isLocalSave: true },
      ),
    ).toBe(false);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(source).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.WECHAT2RSS_RECOVERY_HOLD;
    else process.env.WECHAT2RSS_RECOVERY_HOLD = previous;
    service.onModuleDestroy();
    jest.restoreAllMocks();
  }
});
