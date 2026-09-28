import { FeedsService } from './feeds.service';

describe('隔离启动定时门', () => {
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
