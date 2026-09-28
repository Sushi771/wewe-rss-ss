import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { resolveCollectionRoute } from './collection-channel';
import { canonicalArticleUrl } from './collection-format';
import { fetchMp2RssRecent20 } from './mp2rss';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { TrpcService } from '../trpc/trpc.service';
import { FeedsService } from '../feeds/feeds.service';

jest.mock('./mp2rss', () => ({ fetchMp2RssRecent20: jest.fn() }));
jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));

const config = {
  get: (key: string) =>
    ({ platform: { url: '' }, feed: { updateDelayTime: 0 } })[key],
} as any;

describe('backend collection routing', () => {
  it('migrates a saved desktop choice in memory without changing data', () => {
    expect(
      resolveCollectionRoute({
        id: 'MP_WXS_1000000000',
        collectionChannel: 'desktop-wechat',
      }),
    ).toEqual({ channel: 'mp2rss', selectedBy: 'saved' });
    expect(resolveCollectionRoute({ id: 'MP_WXS_1000000000' })).toEqual({
      channel: 'mp2rss',
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
          collectionChannel: index === 0 ? 'desktop-wechat' : null,
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
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-backend-route-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  it('visits all 12 feeds, persists unique articles, and repeats with zero new rows', async () => {
    (fetchMp2RssRecent20 as jest.Mock).mockImplementation(
      async (id: string) => [article(id)],
    );
    const first =
      await service.refreshAllMpArticlesAndUpdateFeed('local-manual');
    expect(first).toHaveLength(12);
    expect(first.every((item) => item.source === 'mp2rss')).toBe(true);
    expect(
      new Set((fetchMp2RssRecent20 as jest.Mock).mock.calls.map((c) => c[0]))
        .size,
    ).toBe(12);
    expect(await prisma.article.count()).toBe(12);
    expect(
      await prisma.feed.count({ where: { collectionChannel: 'mp2rss' } }),
    ).toBe(12);
    const second =
      await service.refreshAllMpArticlesAndUpdateFeed('local-manual');
    expect(second).toHaveLength(12);
    expect(await prisma.article.count()).toBe(12);
    expect((fetchMp2RssRecent20 as jest.Mock).mock.calls).toHaveLength(24);
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
    (fetchMp2RssRecent20 as jest.Mock).mockImplementation(
      async (id: string) => {
        if (id === ids[3]) throw new Error('provider unavailable');
        return [article(id)];
      },
    );
    const results =
      await service.refreshAllMpArticlesAndUpdateFeed('local-manual');
    expect(results).toHaveLength(12);
    expect(results[3].status).toBe('failed');
    expect(results[4].source).toBe('mp2rss');
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
      (fetchMp2RssRecent20 as jest.Mock).mockImplementation(
        async (id: string) => [article(id)],
      );
      const scheduled = new FeedsService(prisma as any, service, config);
      await scheduled.handleUpdateFeedsCron();
      expect((fetchMp2RssRecent20 as jest.Mock).mock.calls).toHaveLength(11);
      expect(await prisma.article.count()).toBe(11);
      expect(await prisma.article.count({ where: { mpId: ids[11] } })).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULED_UPDATES;
      else process.env.DISABLE_SCHEDULED_UPDATES = previous;
    }
  });
});
