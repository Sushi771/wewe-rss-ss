import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { TrpcService } from '../trpc/trpc.service';
import { canonicalArticleUrl } from './collection-format';
import { fetchPublicAlbums, resolvePublicArticle } from './public-album';

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
        picUrl: '',
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
      sourceUrl: articles[0].url,
      publishTime: time,
    });
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
  it('refresh and history fetch the bound online album and create no duplicates', async () => {
    const files = jest.spyOn(service, 'importDirectory');
    expect(await trpc.refreshMpArticlesAndUpdateFeed(mpId)).toMatchObject({
      source: 'public-album',
      created: 0,
      updated: 2,
    });
    expect(await trpc.getHistoryMpArticles(mpId)).toMatchObject({
      source: 'public-album',
      created: 0,
      updated: 2,
    });
    expect(files).not.toHaveBeenCalled();
    expect(fetchPublicAlbums).toHaveBeenLastCalledWith(mpId, albumIds);
    expect(await prisma.article.count()).toBe(2);
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

  it('merges only identity-proven duplicates into the legacy ID and retains original publication time', async () => {
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
      },
    });
    (fetchPublicAlbums as jest.Mock).mockResolvedValueOnce({
      articles: articles.map((article) => ({
        ...article,
        url: article.url.split('&sn=')[0],
      })),
      pages: 2,
      albums: [{ id: albumIds[0], title: '测试合集', pages: 2, articles: 2 }],
    });
    expect(await service.collectPublicAlbums({ mpId, albumIds })).toMatchObject(
      { created: 0, updated: 2, merged: 1 },
    );
    expect(
      await prisma.article.findUnique({ where: { id: articles[0].id } }),
    ).toBeNull();
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: 'legacy-short' } }),
    ).toMatchObject({
      publishTime: time,
      sourceUrl: articles[0].url,
      readCount: 5,
      likeCount: 0,
      contentHtml: '<div id="js_content">保留正文</div>',
    });
    expect(await prisma.article.count()).toBe(2);
  });

  it('leaves all records and binding unchanged when a legacy identity cannot be verified', async () => {
    await prisma.article.update({
      where: { id: 'legacy-short' },
      data: { sourceUrl: null },
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
