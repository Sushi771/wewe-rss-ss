import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from '../collection/collection.service';
import { TrpcService } from '../trpc/trpc.service';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
import { cacheRevision } from './cache-sync-state';
import { ProviderPage } from '../collection/subscription-provider';
import { canonicalArticleUrl } from '../collection/collection-format';
jest.mock('../collection/sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));
describe('cache delta through original SQLite merge', () => {
  let root: string, prisma: PrismaClient, trpc: TrpcService;
  let articleReads = 0;
  const mpId = 'MP_WXS_1234567890';
  const url = 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=9&idx=1';
  const identity = canonicalArticleUrl(url);
  const page = (body: string | null, blocked = 0): ProviderPage => ({
    articles: [
      {
        ...identity,
        title: 'fixture',
        publishTime: 1760000000,
        contentHtml: body,
        picUrl: '',
      },
    ],
    upstreamCount: 1,
    bodyMissing: body ? 0 : 1,
    imageBlocked: blocked,
    coverage: 'recent-window',
  });
  const oldEnv = {
    enabled: process.env.WECHAT2RSS_ENABLED,
    base: process.env.WECHAT2RSS_BASE_URL,
    token: process.env.WECHAT2RSS_TOKEN,
  };
  beforeAll(async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    process.env.WECHAT2RSS_BASE_URL = 'http://127.0.0.1:18080/';
    process.env.WECHAT2RSS_TOKEN = 'offline-fixture-token';
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-cache-storage-'));
    prisma = new PrismaClient({
      datasources: {
        db: { url: 'file:' + path.join(root, 'test.db').replace(/\\/g, '/') },
      },
    });
    prisma.$use(async (params, next) => {
      if (params.model === 'Article' && params.action === 'findMany')
        articleReads++;
      return next(params);
    });
    const directory = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name, 'migration.sql');
      const sql = await fs.readFile(file, 'utf8').catch(() => '');
      for (const statement of sql
        .split(';')
        .map((row) => row.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: 'fixture',
        mpIntro: '',
        mpCover: '',
        collectionChannel: 'wechat2rss',
        status: 1,
        updateTime: 0,
      },
    });
    trpc = new TrpcService(
      prisma as any,
      { get: () => ({ url: '', updateDelayTime: 0 }) } as any,
      {} as any,
      new CollectionService(prisma as any),
    );
  });
  afterAll(async () => {
    trpc?.onModuleDestroy();
    await prisma?.$disconnect();
    for (const [name, value] of Object.entries(oldEnv)) {
      const key = {
        enabled: 'WECHAT2RSS_ENABLED',
        base: 'WECHAT2RSS_BASE_URL',
        token: 'WECHAT2RSS_TOKEN',
      }[name]!;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (
      root &&
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('saves real list identity, later fills body with original time, preserves metrics; no unchanged backup/revision', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    try {
      const initial = cacheRevision().revision;
      expect(
        await trpc.syncCachedWechat2RssPage(mpId, page(null), true),
      ).toMatchObject({ created: 1 });
      expect(cacheRevision().revision).not.toBe(initial);
      await prisma.article.update({
        where: { id: identity.id },
        data: { metrics: '{"read":7}', readCount: 7 },
      });
      const version = cacheRevision().revision;
      const backupCount = (createVerifiedSqliteBackup as jest.Mock).mock.calls
        .length;
      await trpc.syncCachedWechat2RssPage(mpId, page(null), true);
      expect(cacheRevision().revision).toBe(version);
      expect((createVerifiedSqliteBackup as jest.Mock).mock.calls).toHaveLength(
        backupCount,
      );
      const pending =
        '<div class="rich_media_content" id="js_content" data-wewe-image-pending="1"><p>body</p><img data-wewe-image-unconfirmed="true"></div>';
      expect(
        await trpc.syncCachedWechat2RssPage(mpId, page(pending, 1), false),
      ).toMatchObject({ updated: 1 });
      const saved = await prisma.article.findUniqueOrThrow({
        where: { id: identity.id },
      });
      expect(saved).toMatchObject({
        publishTime: 1760000000,
        metrics: '{"read":7}',
        readCount: 7,
        lastBodyStatus: 'images-pending',
      });
      expect(saved.contentHtml).toContain('body');
      expect(cacheRevision().revision).not.toBe(version);
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
  it('reads cached candidates in bounded chunks and preserves ambiguous legacy rows', async () => {
    const articles = Array.from({ length: 81 }, (_, index) => ({
      ...canonicalArticleUrl(
        `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${100 + index}&idx=1`,
      ),
      title: `batch-${index}`,
      publishTime: 1760000000 + index,
      contentHtml: null,
      picUrl: '',
    }));
    await prisma.article.create({
      data: {
        id: 'opaque-legacy',
        mpId,
        title: articles[80].title,
        publishTime: articles[80].publishTime,
        picUrl: '',
        contentHtml: '<p>old body and note</p>',
        metrics: '{"read":19}',
        readCount: 19,
      },
    });
    const old = await prisma.article.findUniqueOrThrow({
      where: { id: 'opaque-legacy' },
    });
    articleReads = 0;
    const result = await trpc.syncCachedWechat2RssPage(
      mpId,
      {
        articles,
        upstreamCount: articles.length,
        bodyMissing: articles.length,
        imageBlocked: 0,
        coverage: 'recent-window',
      },
      true,
    );
    expect(result).toMatchObject({
      created: 80,
      updated: 0,
      identitySkipped: 1,
    });
    // One preflight plus three <=40-item candidate reads; no per-article reads.
    expect(articleReads).toBe(4);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
    expect(await prisma.article.count({ where: { id: articles[80].id } })).toBe(
      0,
    );
    const backups = (createVerifiedSqliteBackup as jest.Mock).mock.calls.length;
    const revision = cacheRevision().revision;
    const repeated = await trpc.syncCachedWechat2RssPage(
      mpId,
      {
        articles,
        upstreamCount: articles.length,
        bodyMissing: articles.length,
        imageBlocked: 0,
        coverage: 'recent-window',
      },
      true,
    );
    expect(repeated).toMatchObject({
      created: 0,
      updated: 0,
      identitySkipped: 1,
    });
    expect((createVerifiedSqliteBackup as jest.Mock).mock.calls).toHaveLength(
      backups,
    );
    expect(cacheRevision().revision).toBe(revision);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
  });
  it('rejects two saved identities and rolls the whole cache batch back', async () => {
    const item = {
      ...canonicalArticleUrl(
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=900&idx=1',
      ),
      title: 'collision',
      publishTime: 1760001000,
      contentHtml: '<p>new</p>',
      picUrl: '',
    };
    for (const [index, suffix] of ['&sn=a', '&sn=b'].entries()) {
      await prisma.article.create({
        data: {
          id: `collision-legacy-${index}`,
          mpId,
          title: 'collision',
          publishTime: item.publishTime,
          picUrl: '',
          sourceUrl: item.url + suffix,
          contentHtml: '<p>protected old</p>',
          metrics: '{"read":31}',
        },
      });
    }
    const before = await prisma.article.findMany({
      where: { id: { startsWith: 'collision-legacy-' } },
    });
    const revision = cacheRevision().revision;
    await expect(
      trpc.syncCachedWechat2RssPage(
        mpId,
        {
          articles: [item],
          upstreamCount: 1,
          bodyMissing: 0,
          imageBlocked: 0,
          coverage: 'recent-window',
        },
        false,
      ),
    ).rejects.toThrow();
    expect(
      await prisma.article.findMany({
        where: { id: { startsWith: 'collision-legacy-' } },
      }),
    ).toEqual(before);
    expect(cacheRevision().revision).toBe(revision);
  });
});
