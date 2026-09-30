import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { TrpcService } from '../trpc/trpc.service';
import { canonicalArticleUrl } from './collection-format';
import { bodyRetryAvailability, fetchArticleBody } from './article-body-retry';
import { FeedsService } from '../feeds/feeds.service';
import { fetchPublicAlbums, resolvePublicArticle } from './public-album';

jest.mock('./article-body-retry', () => ({
  ...jest.requireActual('./article-body-retry'),
  fetchArticleBody: jest.fn(),
}));

jest.mock('./public-album', () => ({
  fetchPublicAlbums: jest.fn(),
  resolvePublicArticle: jest.fn(),
}));
// 本套件使用独立临时库；备份顺序由 desktop-collection.spec 单独验证。
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));

describe('public album integration in isolated SQLite', () => {
  let root: string,
    prisma: PrismaClient,
    service: CollectionService,
    trpc: TrpcService;
  const mpId = 'MP_WXS_3895431412';
  const albumIds = ['2527940920407949313'];
  const time = 1790400091;
  const articles = [1, 2].map((idx) => ({
    ...canonicalArticleUrl(
      `https://mp.weixin.qq.com/s?__biz=Mzg5NTQzMTQxMg==&mid=2247493540&idx=${idx}&sn=abc`,
    ),
    title: idx === 1 ? '主条' : '次条',
    publishTime: time - 39,
    picUrl: '',
  }));
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-album-test-'));
    prisma = new PrismaClient({
      datasources: {
        db: { url: `file:${path.join(root, 'test.db').replace(/\\/g, '/')}` },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of (
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
      )
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(sql);
    }
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: '隔离测试',
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
        localDirectory: 'C:/never-read',
      },
    });
    await prisma.article.create({
      data: {
        id: 'legacy-short',
        mpId,
        title: '主条',
        publishTime: time,
        picUrl: 'https://mmbiz.qpic.cn/old.png',
        contentHtml: '<div id="js_content">保留正文</div>',
        readCount: 5,
        likeCount: 0,
        metrics: '{"read":{"value":5,"display":"5","fileTime":"2026-09-27"}}',
      },
    });
    service = new CollectionService(prisma as any);
    trpc = new TrpcService(
      prisma as any,
      {
        get: (key: string) =>
          ({ platform: { url: '' }, feed: { updateDelayTime: 0 } })[key],
      } as any,
      {
        getMpArticles: jest.fn(() => {
          throw new Error('Cover should not be called');
        }),
      } as any,
      service,
    );
    (fetchArticleBody as jest.Mock).mockImplementation(async (article) => ({
      contentHtml: '<div class="rich_media_content"><p>新核验正文</p></div>',
      originalPublishTime:
        article.publishTime + (article.verifiedSourceUrl ? 0 : 39),
      verifiedSourceUrl: article.sourceUrl,
    }));
    (fetchPublicAlbums as jest.Mock).mockResolvedValue({
      articles,
      pages: 2,
      albums: [{ id: albumIds[0], title: '测试合集', pages: 2, articles: 2 }],
    });
    (resolvePublicArticle as jest.Mock).mockResolvedValue({
      ...articles[0],
      publishTime: time,
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-album-test-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('merges legacy IDs, preserves cached content and metrics, and retains secondary identity', async () => {
    expect(await service.collectPublicAlbums({ mpId, albumIds })).toMatchObject(
      { created: 1, updated: 1, articles: 2, pages: 2, hasHistory: -1 },
    );
    expect(await prisma.article.count()).toBe(2);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: 'legacy-short' } }),
    ).toMatchObject({
      readCount: 5,
      likeCount: 0,
      contentHtml: '<div id="js_content">保留正文</div>',
      picUrl: 'https://mmbiz.qpic.cn/old.png',
      sourceUrl: articles[0].url,
      verifiedSourceUrl: articles[0].url,
      publishTime: time,
    });
    expect(
      bodyRetryAvailability(
        await prisma.article.findUniqueOrThrow({
          where: { id: 'legacy-short' },
        }),
      ).allowed,
    ).toBe(true);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: articles[1].id } }),
    ).toMatchObject({ readCount: null, likeCount: null });
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toMatchObject({
      publicAlbumIds: JSON.stringify(albumIds),
      localDirectory: null,
      hasHistory: -1,
    });
  });
  it('does not bind a legacy body retry to a different signed article URL', async () => {
    await prisma.article.update({
      where: { id: 'legacy-short' },
      data: { sourceUrl: null, verifiedSourceUrl: null },
    });
    (resolvePublicArticle as jest.Mock).mockResolvedValueOnce({
      ...articles[0],
      url: articles[0].url.replace('sn=abc', 'sn=different'),
      publishTime: time,
    });
    await service.collectPublicAlbums({ mpId, albumIds });
    const legacy = await prisma.article.findUniqueOrThrow({
      where: { id: 'legacy-short' },
    });
    expect(legacy.verifiedSourceUrl).toBeNull();
    expect(bodyRetryAvailability(legacy).allowed).toBe(false);
    expect(legacy.contentHtml).toBe('<div id="js_content">保留正文</div>');
  });
  it('refresh and history fetch the bound online album and create no duplicates', async () => {
    const files = jest.spyOn(service, 'importDirectory');
    expect(await trpc.refreshMpArticlesAndUpdateFeed(mpId)).toMatchObject({
      source: 'public-album',
      created: 0,
      updated: 0,
    });
    expect(await trpc.getHistoryMpArticles(mpId)).toMatchObject({
      source: 'public-album',
      created: 0,
      updated: 0,
    });
    expect(files).not.toHaveBeenCalled();
    expect(fetchPublicAlbums).toHaveBeenLastCalledWith(mpId, albumIds);
    expect(await prisma.article.count()).toBe(2);
  });
  it('stops a blocked original before any article writes or later body requests', async () => {
    await prisma.article.update({
      where: { id: articles[1].id },
      data: { contentHtml: null },
    });
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    const beforeFeed = await prisma.feed.findUniqueOrThrow({
      where: { id: mpId },
    });
    const calls = (fetchArticleBody as jest.Mock).mock.calls.length;
    (fetchArticleBody as jest.Mock).mockRejectedValueOnce(
      new Error('challenge'),
    );
    await expect(
      service.collectPublicAlbums({ mpId, albumIds }),
    ).rejects.toThrow('已停止后续请求');
    expect((fetchArticleBody as jest.Mock).mock.calls.length).toBe(calls + 1);
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(beforeFeed);
    await service.collectPublicAlbums({ mpId, albumIds });
  });

  it('corrects only unverified canonical list times to the current original ct, once', async () => {
    await prisma.article.update({
      where: { id: articles[1].id },
      data: {
        contentHtml: null,
        verifiedSourceUrl: null,
        publishTime: articles[1].publishTime,
      },
    });
    expect(await service.collectPublicAlbums({ mpId, albumIds })).toMatchObject(
      { correctedPublishTimes: 1 },
    );
    const verified = await prisma.article.findUniqueOrThrow({
      where: { id: articles[1].id },
    });
    expect(verified).toMatchObject({
      publishTime: time,
      verifiedSourceUrl: articles[1].url,
    });
    expect(await service.collectPublicAlbums({ mpId, albumIds })).toMatchObject(
      { created: 0, updated: 0, correctedPublishTimes: 0 },
    );
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: articles[1].id } }),
    ).toEqual(verified);
  });

  it('does not correct a cached or verified publication time', async () => {
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    expect(await service.collectPublicAlbums({ mpId, albumIds })).toMatchObject(
      { correctedPublishTimes: 0 },
    );
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
  });

  it('rejects a changed unverified time that cannot be proven to be the current list time', async () => {
    await prisma.article.update({
      where: { id: articles[1].id },
      data: {
        contentHtml: null,
        verifiedSourceUrl: null,
        publishTime: articles[1].publishTime + 3,
      },
    });
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    await expect(
      service.collectPublicAlbums({ mpId, albumIds }),
    ).rejects.toThrow('无法证明');
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    await prisma.article.update({
      where: { id: articles[1].id },
      data: { publishTime: articles[1].publishTime },
    });
    await service.collectPublicAlbums({ mpId, albumIds });
  });

  it('rechecks unverified list-time correction conditions inside the transaction', async () => {
    await prisma.article.update({
      where: { id: articles[1].id },
      data: {
        contentHtml: null,
        verifiedSourceUrl: null,
        publishTime: articles[1].publishTime,
      },
    });
    (fetchArticleBody as jest.Mock).mockImplementationOnce(async (article) => {
      await prisma.article.update({
        where: { id: articles[1].id },
        data: { verifiedSourceUrl: articles[1].url },
      });
      return {
        contentHtml: '<div class="rich_media_content"><p>正文</p></div>',
        originalPublishTime: article.publishTime + 39,
        verifiedSourceUrl: article.sourceUrl,
      };
    });
    await expect(
      service.collectPublicAlbums({ mpId, albumIds }),
    ).rejects.toThrow('校正条件已变化');
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: articles[1].id },
        })
      ).publishTime,
    ).toBe(articles[1].publishTime);
    await prisma.article.update({
      where: { id: articles[1].id },
      data: { verifiedSourceUrl: null },
    });
    await service.collectPublicAlbums({ mpId, albumIds });
  });

  it('uses persisted binding after service restart for manual and scheduled updates with zero additions', async () => {
    const bodyCalls = (fetchArticleBody as jest.Mock).mock.calls.length;
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    const restartedCollection = new CollectionService(prisma as any);
    const config = { get: () => ({ updateDelayTime: 0 }) };
    const restartedTrpc = new TrpcService(
      prisma as any,
      config as any,
      {} as any,
      restartedCollection,
    );
    expect(
      await restartedTrpc.refreshMpArticlesAndUpdateFeed(
        mpId,
        1,
        'local-manual',
      ),
    ).toMatchObject({
      source: 'public-album',
      coverage: 'selected-albums',
      created: 0,
      updated: 0,
      bodyFetch: { succeeded: 0, unavailable: 0 },
      bodyCache: { available: 2, retained: 2, missing: 0 },
    });
    const cron = new FeedsService(prisma as any, restartedTrpc, config as any);
    await cron.handleUpdateFeedsCron();
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect((fetchArticleBody as jest.Mock).mock.calls.length).toBe(bodyCalls);
    expect(
      JSON.parse(
        (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }))
          .lastCollectionResult!,
      ),
    ).toMatchObject({
      source: 'public-album',
      created: 0,
      pages: 2,
      coverage: 'selected-albums',
    });
  });

  it('upstream failure changes neither article records nor source binding', async () => {
    const before = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    (fetchPublicAlbums as jest.Mock).mockRejectedValueOnce(
      new Error('分页验证失败'),
    );
    await expect(
      service.collectPublicAlbums({ mpId, albumIds: ['9999999999999'] }),
    ).rejects.toThrow('分页验证失败');
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(before);
    expect(await prisma.article.count()).toBe(2);
  });

  it('rejects ambiguous duplicate identities without deleting any old IDs', async () => {
    await prisma.article.update({
      where: { id: 'legacy-short' },
      data: { sourceUrl: null },
    });
    await prisma.article.create({
      data: {
        id: articles[0].id,
        mpId,
        title: '主条',
        publishTime: time - 39,
        picUrl: '',
        sourceUrl: articles[0].url,
        verifiedSourceUrl: articles[0].url,
      },
    });
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    await expect(
      service.collectPublicAlbums({ mpId, albumIds }),
    ).rejects.toThrow('多条旧记录');
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    await prisma.article.delete({ where: { id: articles[0].id } });
  });

  it('leaves all records and binding unchanged when a legacy identity cannot be verified', async () => {
    await prisma.article.update({
      where: { id: 'legacy-short' },
      data: { sourceUrl: null, verifiedSourceUrl: null },
    });
    const beforeFeed = await prisma.feed.findUniqueOrThrow({
      where: { id: mpId },
    });
    const beforeArticles = await prisma.article.findMany({
      orderBy: { id: 'asc' },
    });
    (resolvePublicArticle as jest.Mock).mockRejectedValueOnce(
      new Error('无法核验旧文章'),
    );
    await expect(
      service.collectPublicAlbums({ mpId, albumIds }),
    ).rejects.toThrow('无法核验旧文章');
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(beforeFeed);
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      beforeArticles,
    );
  });
  it('persists explicit album collection coverage without collecting twice and records failures', async () => {
    const callsBefore = (fetchPublicAlbums as jest.Mock).mock.calls.length;
    expect(await trpc.collectPublicAlbums({ mpId, albumIds })).toMatchObject({
      status: 'partial',
      complete: false,
      coverage: 'selected-albums',
    });
    expect((fetchPublicAlbums as jest.Mock).mock.calls.length).toBe(
      callsBefore + 1,
    );
    expect(
      JSON.parse(
        (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }))
          .lastCollectionResult!,
      ),
    ).toMatchObject({
      source: 'public-album',
      status: 'partial',
      complete: false,
      pages: 2,
      albums: [{ id: albumIds[0], title: '测试合集', pages: 2, articles: 2 }],
      created: 0,
      bodyCache: { available: 2, retained: 2, missing: 0 },
    });
    (fetchPublicAlbums as jest.Mock).mockRejectedValueOnce(
      new Error('公开合集返回验证页或无效列表，本次未写入'),
    );
    await expect(trpc.collectPublicAlbums({ mpId, albumIds })).rejects.toThrow(
      '公开合集返回验证页',
    );
    expect(
      JSON.parse(
        (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }))
          .lastCollectionResult!,
      ),
    ).toMatchObject({
      source: 'error',
      status: 'failed',
      complete: false,
    });
  });
  it('preserves the running operation status when a concurrent update is rejected', async () => {
    let resolvePage!: (value: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    (fetchPublicAlbums as jest.Mock).mockImplementationOnce(() => {
      markStarted();
      return new Promise((resolve) => {
        resolvePage = resolve;
      });
    });
    const first = trpc.collectPublicAlbums({ mpId, albumIds });
    await started;
    const running = (
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } })
    ).lastCollectionResult;
    expect(JSON.parse(running!)).toMatchObject({
      status: 'running',
      complete: false,
    });
    await expect(trpc.refreshMpArticlesAndUpdateFeed(mpId)).rejects.toThrow(
      '正在采集',
    );
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }))
        .lastCollectionResult,
    ).toBe(running);
    resolvePage({ articles, pages: 2, albums: [] });
    await first;
    expect(
      JSON.parse(
        (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }))
          .lastCollectionResult!,
      ),
    ).toMatchObject({ status: 'partial' });
    // The mutex must also be released after completion.
    await expect(
      trpc.refreshMpArticlesAndUpdateFeed(mpId),
    ).resolves.toMatchObject({ status: 'partial' });
  });
});
