import { TrpcService } from './trpc.service';

describe('WeRead cover history boundary', () => {
  const createService = (articles: any[]) => {
    const prisma = {
      article: { upsert: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
      feed: { update: jest.fn().mockResolvedValue({}) },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'platform') return { url: 'http://127.0.0.1:1' };
        if (key === 'feed') return { updateDelayTime: 0 };
        if (key === 'database') return { type: 'sqlite' };
      }),
    };
    const weread = {};
    const service = new TrpcService(prisma as any, config as any, weread as any);
    service.getMpArticles = jest.fn().mockResolvedValue(articles);
    return { service, prisma };
  };

  it.each([
    { articles: [] },
    { articles: [{ id: 'article-1', title: 'title', picUrl: '', publishTime: 1 }] },
  ])(
    'keeps history unknown after a latest-cover response',
    async ({ articles }) => {
      const { service, prisma } = createService(articles);

      await expect(service.refreshMpArticlesAndUpdateFeed('creator-1')).resolves.toEqual({
        hasHistory: -1,
      });
      expect(prisma.feed.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'creator-1' },
          data: expect.objectContaining({ hasHistory: -1 }),
        }),
      );
    },
  );

  it('rejects page two before fetching or writing', async () => {
    const { service, prisma } = createService([]);

    await expect(service.refreshMpArticlesAndUpdateFeed('creator-1', 2)).rejects.toThrow(
      '无法按页获取公众号历史文章',
    );
    expect(service.getMpArticles).not.toHaveBeenCalled();
    expect(prisma.feed.update).not.toHaveBeenCalled();
  });

  it('rejects the legacy history action without changing saved articles', async () => {
    const { service, prisma } = createService([]);

    await expect(service.getHistoryMpArticles('creator-1')).rejects.toThrow(
      '历史获取尚不可用',
    );
    expect(service.getMpArticles).not.toHaveBeenCalled();
    expect(prisma.feed.update).not.toHaveBeenCalled();
  });
});
