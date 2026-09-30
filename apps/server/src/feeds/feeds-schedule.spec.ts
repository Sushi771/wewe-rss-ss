import { FeedsService } from './feeds.service';

describe('隔离启动定时门', () => {
  it('已选单号调用真实定时入口而不改其他订阅', async () => {
    const previous = {
      disabled: process.env.DISABLE_SCHEDULED_UPDATES,
      ids: process.env.SCHEDULED_MP_IDS,
    };
    process.env.DISABLE_SCHEDULED_UPDATES = '0';
    process.env.SCHEDULED_MP_IDS = 'MP_WXS_3895431412';
    const prisma = {
      feed: {
        findMany: jest.fn().mockResolvedValue([{ id: 'MP_WXS_3895431412' }]),
      },
    };
    const trpc = {
      refreshMpArticlesAndUpdateFeed: jest.fn().mockResolvedValue({
        status: 'partial',
        coverage: 'selected-albums',
        message: '新增 0',
      }),
    };
    try {
      await new FeedsService(
        prisma as any,
        trpc as any,
        { get: () => ({ updateDelayTime: 0 }) } as any,
      ).handleUpdateFeedsCron();
      expect(trpc.refreshMpArticlesAndUpdateFeed).toHaveBeenCalledTimes(1);
      expect(trpc.refreshMpArticlesAndUpdateFeed).toHaveBeenCalledWith(
        'MP_WXS_3895431412',
        1,
        'scheduled',
      );
    } finally {
      for (const [key, value] of [
        ['DISABLE_SCHEDULED_UPDATES', previous.disabled],
        ['SCHEDULED_MP_IDS', previous.ids],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  it.each([
    ['MP_WXS_3895431412', { status: 1, id: { in: ['MP_WXS_3895431412'] } }],
    [undefined, { status: 1 }],
  ])('白名单 %s 限制定时查询并保持默认语义', async (ids, where) => {
    const previous = {
      disabled: process.env.DISABLE_SCHEDULED_UPDATES,
      ids: process.env.SCHEDULED_MP_IDS,
    };
    process.env.DISABLE_SCHEDULED_UPDATES = '0';
    if (ids === undefined) delete process.env.SCHEDULED_MP_IDS;
    else process.env.SCHEDULED_MP_IDS = ids as string;
    const prisma = { feed: { findMany: jest.fn().mockResolvedValue([]) } };
    const trpc = { refreshMpArticlesAndUpdateFeed: jest.fn() };
    try {
      const service = new FeedsService(
        prisma as any,
        trpc as any,
        { get: () => ({ updateDelayTime: 0 }) } as any,
      );
      await service.handleUpdateFeedsCron();
      expect(prisma.feed.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(trpc.refreshMpArticlesAndUpdateFeed).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of [
        ['DISABLE_SCHEDULED_UPDATES', previous.disabled],
        ['SCHEDULED_MP_IDS', previous.ids],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each(['', ' ', 'MP_WXS_3895431412,', 'MP_WXS_3895431412,invalid'])(
    '非法或空白名单 %s 在数据库和采集前停止',
    async (ids) => {
      const previous = {
        disabled: process.env.DISABLE_SCHEDULED_UPDATES,
        ids: process.env.SCHEDULED_MP_IDS,
      };
      process.env.DISABLE_SCHEDULED_UPDATES = '0';
      process.env.SCHEDULED_MP_IDS = ids;
      const prisma = { feed: { findMany: jest.fn() } };
      const trpc = { refreshMpArticlesAndUpdateFeed: jest.fn() };
      try {
        await new FeedsService(
          prisma as any,
          trpc as any,
          {} as any,
        ).handleUpdateFeedsCron();
        expect(prisma.feed.findMany).not.toHaveBeenCalled();
        expect(trpc.refreshMpArticlesAndUpdateFeed).not.toHaveBeenCalled();
      } finally {
        for (const [key, value] of [
          ['DISABLE_SCHEDULED_UPDATES', previous.disabled],
          ['SCHEDULED_MP_IDS', previous.ids],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
  it('关闭时在数据库读取、账号读取或采集前返回', async () => {
    const previous = process.env.DISABLE_SCHEDULED_UPDATES;
    process.env.DISABLE_SCHEDULED_UPDATES = '1';
    const prisma = { feed: { findMany: jest.fn() } };
    const trpc = { refreshMpArticlesAndUpdateFeed: jest.fn() };
    const config = { get: jest.fn() };
    try {
      const service = new FeedsService(
        prisma as any,
        trpc as any,
        config as any,
      );
      await service.handleUpdateFeedsCron();
      expect(prisma.feed.findMany).not.toHaveBeenCalled();
      expect(trpc.refreshMpArticlesAndUpdateFeed).not.toHaveBeenCalled();
      expect(config.get).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULED_UPDATES;
      else process.env.DISABLE_SCHEDULED_UPDATES = previous;
    }
  });
});
