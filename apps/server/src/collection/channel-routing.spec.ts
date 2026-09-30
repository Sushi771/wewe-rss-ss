import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { resolveCollectionRoute } from './collection-channel';
import { canonicalArticleUrl } from './collection-format';
import { parseWechat2RssJsonFeed } from './provider-article';
import {
  enabledWechat2RssFeedIds,
  wechat2RssProvider,
} from './provider-registry';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
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

  const mockArticlePage = (incoming: ReturnType<typeof article>) => {
    (wechat2RssProvider as jest.Mock).mockReturnValue({
      checkAccountStatus: async () => ({ available: true, challenged: false }),
      refreshSubscription: async () => ({ accepted: true, pending: true }),
      fetchArticles: async () => ({
        articles: [incoming],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: 0,
        imageBlocked: 0,
      }),
    });
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

  it('matches a short-ID row across sn and incoming parameter order while filling only missing fields', async () => {
    const incoming = article(ids[0]);
    incoming.contentHtml =
      '<div class="rich_media_content" id="js_content">新正文</div>';
    const canonical = new URL(incoming.url);
    const reordered = new URL('https://mp.weixin.qq.com/s');
    for (const key of ['sn', 'idx', 'mid', '__biz'])
      reordered.searchParams.set(key, canonical.searchParams.get(key)!);
    reordered.searchParams.set('tracking', 'ignored');
    const previousUrl = incoming.url.replace('sn=abcd', 'sn=previous');
    await prisma.article.create({
      data: {
        id: 'legacy-short-id',
        mpId: ids[0],
        title: '旧标题',
        publishTime: incoming.publishTime - 100,
        sourceUrl: previousUrl,
        picUrl: 'https://mmbiz.qpic.cn/old.jpg',
        contentHtml: null,
        lastBodyStatus: 'unavailable',
        metrics: '{"read":{"value":0}}',
        readCount: 0,
        likeCount: 0,
      },
    });
    mockArticlePage({ ...incoming, url: reordered.toString() });
    expect(
      await service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual'),
    ).toMatchObject({ created: 0, updated: 1 });
    expect(await prisma.article.count({ where: { mpId: ids[0] } })).toBe(1);
    expect(
      await prisma.article.findUniqueOrThrow({
        where: { id: 'legacy-short-id' },
      }),
    ).toMatchObject({
      title: '旧标题',
      publishTime: incoming.publishTime - 100,
      sourceUrl: previousUrl,
      verifiedSourceUrl: incoming.url,
      picUrl: 'https://mmbiz.qpic.cn/old.jpg',
      contentHtml: incoming.contentHtml,
      lastBodyStatus: 'available',
      metrics: '{"read":{"value":0}}',
      readCount: 0,
      likeCount: 0,
    });
    expect(
      await service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual'),
    ).toMatchObject({ created: 0, updated: 0 });
  });

  it('keeps an existing body and its last retry status when a provider repeats cached content', async () => {
    const incoming = article(ids[0]);
    incoming.contentHtml =
      '<div class="rich_media_content" id="js_content">新正文</div>';
    await prisma.article.create({
      data: {
        id: 'legacy-with-body',
        mpId: ids[0],
        title: '旧标题',
        publishTime: incoming.publishTime,
        sourceUrl: incoming.url.replace('sn=abcd', 'sn=previous'),
        picUrl: 'https://mmbiz.qpic.cn/old.jpg',
        contentHtml: '<div>旧正文</div>',
        lastBodyStatus: 'unavailable',
      },
    });
    mockArticlePage(incoming);
    expect(
      await service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual'),
    ).toMatchObject({ created: 0, updated: 1 });
    expect(
      await prisma.article.findUniqueOrThrow({
        where: { id: 'legacy-with-body' },
      }),
    ).toMatchObject({
      contentHtml: '<div>旧正文</div>',
      lastBodyStatus: 'unavailable',
      verifiedSourceUrl: incoming.url,
    });
  });

  it('rejects multiple legacy matches and cross-feed identity conflicts without saving an article', async () => {
    const incoming = article(ids[0]);
    for (const [id, sn] of [
      ['legacy-one', 'first'],
      ['legacy-two', 'second'],
    ]) {
      await prisma.article.create({
        data: {
          id,
          mpId: ids[0],
          title: id,
          publishTime: incoming.publishTime,
          sourceUrl: incoming.url.replace('sn=abcd', `sn=${sn}`),
          picUrl: '',
        },
      });
    }
    mockArticlePage(incoming);
    await expect(
      service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual'),
    ).rejects.toThrow('原文身份对应多条旧记录');
    expect(await prisma.article.count({ where: { mpId: ids[0] } })).toBe(2);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } })).syncTime,
    ).toBe(0);

    await prisma.article.deleteMany({ where: { mpId: ids[0] } });
    await prisma.article.create({
      data: {
        id: 'wrong-feed-short-id',
        mpId: ids[1],
        title: '错误绑定',
        publishTime: incoming.publishTime,
        sourceUrl: incoming.url.replace('sn=abcd', 'sn=previous'),
        picUrl: '',
      },
    });
    await expect(
      service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual'),
    ).rejects.toThrow('已保存文章与原文身份冲突');
    expect(await prisma.article.count({ where: { mpId: ids[0] } })).toBe(0);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } })).syncTime,
    ).toBe(0);
  });

  it('keeps the refresh cooldown across service restart and retries after it expires', async () => {
    await service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual');
    const firstProvider = (wechat2RssProvider as jest.Mock).mock.results[0]
      .value;
    expect(firstProvider.refreshSubscription).toHaveBeenCalledTimes(1);
    const attempted = await prisma.feed.findUniqueOrThrow({
      where: { id: ids[0] },
    });
    expect(attempted.providerRefreshAttemptTime).toBeGreaterThan(0);

    const restarted = new TrpcService(
      prisma as any,
      config,
      {} as any,
      new CollectionService(prisma as any),
    );
    const cached = await restarted.refreshMpArticlesAndUpdateFeed(
      ids[0],
      1,
      'local-manual',
    );
    expect(cached).toMatchObject({ accepted: false, created: 0 });
    const secondProvider = (wechat2RssProvider as jest.Mock).mock.results[1]
      .value;
    expect(secondProvider.refreshSubscription).toHaveBeenCalledTimes(1);

    await prisma.feed.update({
      where: { id: ids[0] },
      data: {
        providerRefreshAttemptTime:
          attempted.providerRefreshAttemptTime - 16 * 60,
      },
    });
    await restarted.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual');
    const thirdProvider = (wechat2RssProvider as jest.Mock).mock.results[2]
      .value;
    expect(thirdProvider.refreshSubscription).toHaveBeenCalledTimes(2);
  });

  it('retains a failed /add attempt and does not advance successful cache time', async () => {
    (wechat2RssProvider as jest.Mock).mockReturnValue({
      checkAccountStatus: async () => ({ available: true, challenged: false }),
      refreshSubscription: jest
        .fn()
        .mockRejectedValue(new Error('upstream failed')),
      fetchArticles: jest.fn().mockResolvedValue({
        articles: [],
        coverage: 'recent-window',
        upstreamCount: 0,
        bodyMissing: 0,
        imageBlocked: 0,
      }),
    });
    await expect(
      service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual'),
    ).rejects.toThrow('upstream failed');
    const afterFailure = await prisma.feed.findUniqueOrThrow({
      where: { id: ids[0] },
    });
    expect(afterFailure.providerRefreshAttemptTime).toBeGreaterThan(0);
    expect(afterFailure.syncTime).toBe(0);

    const restarted = new TrpcService(
      prisma as any,
      config,
      {} as any,
      new CollectionService(prisma as any),
    );
    const result = await restarted.refreshMpArticlesAndUpdateFeed(
      ids[0],
      1,
      'local-manual',
    );
    expect(result).toMatchObject({ status: 'pending', accepted: false });
    const provider = (wechat2RssProvider as jest.Mock).mock.results[0].value;
    expect(provider.refreshSubscription).toHaveBeenCalledTimes(1);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } })).syncTime,
    ).toBe(0);
  });

  it('exports a parsed provider body and its image as a local attachment', async () => {
    const identity = article(ids[0]);
    const imageUrl = 'https://mmbiz.qpic.cn/offline.png';
    const page = parseWechat2RssJsonFeed(
      {
        items: [
          {
            url: identity.url,
            title: '离线正文',
            date_published: '2024-01-02T03:04:05+08:00',
            content_html: `<p>可离线阅读</p><img src="${imageUrl}">`,
          },
        ],
      },
      ids[0],
    );
    (wechat2RssProvider as jest.Mock).mockReturnValue({
      checkAccountStatus: async () => ({ available: true, challenged: false }),
      refreshSubscription: async () => ({ accepted: true, pending: true }),
      fetchArticles: async () => page,
    });
    await service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual');
    const offlineConfig = {
      get: (key: string) =>
        ({
          platform: { url: '' },
          feed: {
            updateDelayTime: 0,
            obsidianPath: path.join(root, 'vault'),
          },
        })[key],
    } as any;
    const router = new TrpcRouter(
      service,
      prisma as any,
      offlineConfig,
      {} as any,
      new CollectionService(prisma as any),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(png, { headers: { 'content-type': 'image/png' } }),
      );
    try {
      await service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual');
      const caller = router.appRouter.createCaller({
        errorMsg: null,
        isLocal: true,
      } as any);
      const exported = await caller.article.saveToObsidian(identity.id);
      const markdown = await fs.readFile(exported.path, 'utf8');
      expect(markdown).toContain('可离线阅读');
      const attachment = markdown.match(
        /attachments\/image_[a-f0-9]+\.png/,
      )?.[0];
      expect(attachment).toBeTruthy();
      expect(markdown).not.toContain(imageUrl);
      expect(
        await fs.readFile(path.join(path.dirname(exported.path), attachment!)),
      ).toEqual(png);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0].toString()).toBe(imageUrl);
    } finally {
      fetchMock.mockRestore();
    }
  }, 15_000);

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

  it('does not save an article or advance sync time when a provider returns another feed identity', async () => {
    const mismatched = article(ids[0]);
    mismatched.mpId = ids[1];
    (wechat2RssProvider as jest.Mock).mockReturnValue({
      checkAccountStatus: async () => ({ available: true, challenged: false }),
      refreshSubscription: async () => ({ accepted: true, pending: true }),
      fetchArticles: async () => ({
        articles: [mismatched],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: 0,
        imageBlocked: 0,
      }),
    });
    await expect(
      service.refreshMpArticlesAndUpdateFeed(ids[0], 1, 'local-manual'),
    ).rejects.toThrow('PROVIDER_ARTICLE_IDENTITY_INVALID');
    expect(await prisma.article.count()).toBe(0);
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(feed.syncTime).toBe(0);
    expect(JSON.parse(feed.lastCollectionResult || '{}')).toMatchObject({
      status: 'failed',
      coverage: 'none',
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
