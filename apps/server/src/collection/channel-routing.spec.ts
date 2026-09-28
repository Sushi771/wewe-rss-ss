import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { resolveCollectionRoute } from './collection-channel';
import { canonicalArticleUrl } from './collection-format';
import {
  enabledWechat2RssFeedIds,
  wechat2RssProvider,
} from './provider-registry';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { TrpcService } from '../trpc/trpc.service';
import { FeedsService } from '../feeds/feeds.service';

jest.mock('./provider-registry', () => ({
  enabledWechat2RssFeedIds: jest.fn(),
  wechat2RssProvider: jest.fn(),
}));
jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));

const config = {
  get: (key: string) =>
    ({ platform: { url: '' }, feed: { updateDelayTime: 0 } })[key],
} as any;

describe('backend collection routing', () => {
  it('blocks legacy sources and requires an explicit Wechat2RSS selection', () => {
    (enabledWechat2RssFeedIds as jest.Mock).mockReturnValue(new Set());
    expect(
      resolveCollectionRoute({
        id: 'MP_WXS_1000000000',
        collectionChannel: 'desktop-wechat',
      }),
    ).toEqual({ channel: 'unavailable', selectedBy: 'invalid' });
    expect(resolveCollectionRoute({ id: 'MP_WXS_1000000000' })).toEqual({
      channel: 'unavailable',
      selectedBy: 'legacy',
    });
  });

  let root: string;
  let prisma: PrismaClient;
  let service: TrpcService;
  const ids = Array.from({ length: 12 }, (_, i) => `MP_WXS_${1000000000 + i}`);
  const article = (id: string) => {
    const number = id.replace('MP_WXS_', '');
    const identity = canonicalArticleUrl(
      `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=99&idx=1&sn=abcd`,
    );
    return {
      ...identity,
      canonical: null,
      publishTime: 1700000000,
      title: `文章 ${number}`,
      shortUrl: null,
      picUrl: 'https://mmbiz.qpic.cn/new.jpg',
      contentHtml: '<div id="js_content">新正文</div>',
    };
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-backend-route-'));
    const url = `file:${path.join(root, 'test.db').replace(/\\/g, '/')}`;
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const folder = path.join(migrations, name);
      if (!(await fs.stat(folder)).isDirectory()) continue;
      const sql = await fs.readFile(path.join(folder, 'migration.sql'), 'utf8');
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    process.env.WECHAT2RSS_ENABLED = '1';
    (enabledWechat2RssFeedIds as jest.Mock).mockReturnValue(new Set(ids));
    (wechat2RssProvider as jest.Mock).mockReturnValue({
      checkAccountStatus: jest
        .fn()
        .mockResolvedValue({ available: true, challenged: false }),
      refreshSubscription: jest
        .fn()
        .mockResolvedValue({ accepted: true, pending: true }),
      fetchArticles: jest.fn().mockImplementation(async (id: string) => ({
        articles: [article(id)],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: 0,
        imageBlocked: 0,
      })),
    });
    (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
      integrityCheck: 'ok',
    });
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    for (const [index, id] of ids.entries()) {
      await prisma.feed.create({
        data: {
          id,
          mpName: `订阅 ${index}`,
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
          collectionChannel: null,
        },
      });
    }
    service = new TrpcService(
      prisma as any,
      config,
      {} as any,
      new CollectionService(prisma as any),
    );
  });

  afterAll(async () => {
    delete process.env.WECHAT2RSS_ENABLED;
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-backend-route-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  it('visits all 12 feeds, persists unique articles, and repeats with zero new rows', async () => {
    const first =
      await service.refreshAllMpArticlesAndUpdateFeed('local-manual');
    expect(first).toHaveLength(12);
    expect(first.every((item) => item.source === 'wechat2rss')).toBe(true);
    expect(
      new Set(
        (
          wechat2RssProvider as jest.Mock
        ).mock.results[0].value.fetchArticles.mock.calls.map((c) => c[0]),
      ).size,
    ).toBe(12);
    expect(await prisma.article.count()).toBe(12);
    expect(
      await prisma.feed.count({ where: { collectionChannel: 'wechat2rss' } }),
    ).toBe(12);
    const second =
      await service.refreshAllMpArticlesAndUpdateFeed('local-manual');
    expect(second).toHaveLength(12);
    expect(await prisma.article.count()).toBe(12);
    expect((wechat2RssProvider as jest.Mock).mock.calls).toHaveLength(24);
  });

  it('isolates one failed feed and keeps its old body, image, metrics and ID', async () => {
    const old = article(ids[4]);
    await prisma.article.create({
      data: {
        id: old.id,
        mpId: ids[4],
        title: old.title,
        publishTime: old.publishTime,
        picUrl: 'https://mmbiz.qpic.cn/old.jpg',
        sourceUrl: old.url,
        contentHtml: '<div>旧正文</div>',
        metrics: '{"read":{"value":8}}',
        readCount: 8,
        likeCount: null,
      },
    });
    (wechat2RssProvider as jest.Mock).mockImplementation(() => ({
      checkAccountStatus: async () => ({ available: true, challenged: false }),
      refreshSubscription: async () => ({ accepted: true, pending: true }),
      fetchArticles: async (id: string) => {
        if (id === ids[3]) throw new Error('provider unavailable');
        return {
          articles: [article(id)],
          coverage: 'recent-window',
          upstreamCount: 1,
          bodyMissing: 0,
          imageBlocked: 0,
        };
      },
    }));
    const results =
      await service.refreshAllMpArticlesAndUpdateFeed('local-manual');
    expect(results).toHaveLength(12);
    expect(results[3].status).toBe('failed');
    expect(results[4].source).toBe('wechat2rss');
    expect(await prisma.article.count()).toBe(11);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({
      id: old.id,
      contentHtml: '<div>旧正文</div>',
      picUrl: 'https://mmbiz.qpic.cn/old.jpg',
      metrics: '{"read":{"value":8}}',
      readCount: 8,
      likeCount: null,
    });
  });

  it('scheduled updates use the same backend path for enabled feeds', async () => {
    const previous = process.env.DISABLE_SCHEDULED_UPDATES;
    delete process.env.DISABLE_SCHEDULED_UPDATES;
    try {
      await prisma.feed.update({ where: { id: ids[11] }, data: { status: 0 } });
      const scheduled = new FeedsService(prisma as any, service, config);
      await scheduled.handleUpdateFeedsCron();
      expect((wechat2RssProvider as jest.Mock).mock.calls).toHaveLength(11);
      expect(await prisma.article.count()).toBe(11);
      expect(await prisma.article.count({ where: { mpId: ids[11] } })).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULED_UPDATES;
      else process.env.DISABLE_SCHEDULED_UPDATES = previous;
    }
  });
});
