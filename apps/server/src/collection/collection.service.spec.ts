import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { parsePublishTime } from './collection-format';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { FeedsService } from '../feeds/feeds.service';

describe('local collection with real SQLite migrations', () => {
  let root: string,
    directory: string,
    prisma: PrismaClient,
    service: CollectionService;
  let router: TrpcRouter, trpc: TrpcService, feeds: FeedsService;
  const mpId = 'MP_WXS_3286016687';
  const url = (idx: number) =>
    `https://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&mid=100&idx=${idx}&sn=abc`;
  const csv = (read = '100', bad = false) =>
    'title,url,time,read_num,like_num,share_num,comment_count\n' +
    `主条,${url(1)},2024-12-06 08:35:06,${read},0,12,{}\n` +
    `次条,${bad ? 'https://example.com' : url(2)},2024-12-06 08:35:06,10万+,2,,3\n`;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-collection-test-'));
    directory = path.join(root, 'input');
    await fs.mkdir(directory);
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
        .filter(Boolean)) {
        await prisma.$executeRawUnsafe(sql);
      }
    }
    service = new CollectionService(prisma as any);
    const config = {
      get: (key: string) =>
        ({
          platform: { url: '' },
          feed: { updateDelayTime: 0, obsidianPath: path.join(root, 'vault') },
          database: { type: 'sqlite' },
        })[key],
    } as any;
    const weread = {
      getMpArticles: jest
        .fn()
        .mockResolvedValue([
          { id: 'cover-id', title: '封面', publishTime: 1, picUrl: '' },
        ]),
      getArticleContent: jest.fn(),
    } as any;
    trpc = new TrpcService(prisma as any, config, weread, service);
    router = new TrpcRouter(trpc, prisma as any, config, weread, service);
    feeds = new FeedsService(prisma as any, trpc, config);
    jest
      .spyOn(feeds, 'getHtmlByUrl')
      .mockRejectedValue(new Error('Network disabled in test'));
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    // Only the mkdtemp directory created by this suite is removed.
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-collection-test-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('imports multiple articles with cached HTML, sanitizes scripts, and preserves legacy IDs', async () => {
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: '测试号',
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
      },
    });
    await prisma.article.create({
      data: {
        id: 'legacy-short-link',
        mpId,
        title: '主条',
        picUrl: '',
        publishTime: parsePublishTime('2024-12-06 08:35:06'),
      },
    });
    await fs.writeFile(path.join(directory, 'articles.csv'), csv());
    await fs.writeFile(
      path.join(directory, 'pixel.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    await fs.writeFile(
      path.join(directory, 'article.html'),
      `<meta property="og:url" content="${url(1).replace(/&/g, '&amp;')}"><div id="js_content"><p onclick="alert(1)">正文内容</p><script>bad()</script><img src="../../private.png"><img src="pixel.png" data-src="https://mmbiz.qpic.cn/unreachable"></div>`,
    );
    const preview = await service.preview({ directory, mpId });
    expect(preview).toMatchObject({ articles: 2, bodies: 1 });
    expect(await prisma.article.count()).toBe(1); // Preview does not mutate.
    expect(await service.importDirectory({ directory, mpId })).toMatchObject({
      created: 1,
      updated: 1,
      articles: 2,
    });
    const article = await prisma.article.findUniqueOrThrow({
      where: { id: 'legacy-short-link' },
    });
    expect(article.contentHtml).toContain('正文内容');
    expect(article.contentHtml).not.toMatch(/script|onclick|private/);
    expect(article.likeCount).toBe(0);
    expect(article.contentHtml).toContain('data:image/png;base64,');
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } })).hasHistory,
    ).toBe(-1);
  });
  it('exports cached body, local images, and metrics through the real router without network access', async () => {
    const caller = router.appRouter.createCaller({
      errorMsg: null,
      isLocal: true,
    } as any);
    const result = await caller.article.saveToObsidian('legacy-short-link');
    const markdown = await fs.readFile(result.path, 'utf8');
    expect(markdown).toContain('正文内容');
    expect(markdown).toContain('| 收藏 | 未提供 |');
    const image = markdown.match(/attachments\/image_[a-f0-9]+\.png/)?.[0];
    expect(image).toBeTruthy();
    expect(
      (await fs.stat(path.join(path.dirname(result.path), image!))).size,
    ).toBeGreaterThan(0);
    const csv = await caller.collection.exportMetrics({ mpId });
    expect(csv.count).toBe(2);
    expect(csv.csv).toContain('10万+');
    const list = await caller.article.list({
      mpId,
      sort: 'readCount',
      limit: 1,
    });
    expect(list.items[0].title).toBe('次条');
    expect(list.items[0]).not.toHaveProperty('contentHtml');
    const next = await caller.article.list({
      mpId,
      sort: 'readCount',
      limit: 1,
      cursor: list.nextCursor,
    });
    expect(next.items[0].title).toBe('主条');
    const rss = await feeds.handleGenerateFeed({
      id: mpId,
      type: 'rss',
      limit: 20,
      page: 1,
      mode: 'fulltext',
    });
    expect(rss.content).toContain('正文内容');
    expect(rss.content).toContain('__biz');
    await expect(
      router.appRouter
        .createCaller({ errorMsg: null, isLocal: false } as any)
        .collection.preview({ directory }),
    ).rejects.toThrow('本地采集只能');
  });
  it('updates metrics without duplicates and keeps body when HTML is absent', async () => {
    await fs.writeFile(
      path.join(directory, 'articles.csv'),
      csv('200').replace(/&sn=abc/g, ''),
    );
    await fs.unlink(path.join(directory, 'article.html'));
    const caller = router.appRouter.createCaller({
      errorMsg: null,
      isLocal: true,
    } as any);
    expect((await caller.feed.refreshArticles({ mpId }))[0]).toMatchObject({
      source: 'local',
      created: 0,
      updated: 2,
    });
    expect(await prisma.article.count()).toBe(2);
    const article = await prisma.article.findUniqueOrThrow({
      where: { id: 'legacy-short-link' },
    });
    expect(article.readCount).toBe(200);
    expect(article.contentHtml).toContain('正文内容');
  });
  it('does not claim cover polling completed history and reports failures in batch results', async () => {
    await prisma.feed.create({
      data: {
        id: 'cover-feed',
        mpName: '封面测试',
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
        syncTime: 5,
        hasHistory: 1,
      },
    });
    await prisma.account.create({
      data: { id: 'test', name: 'test', token: 'test' },
    });
    expect(
      await trpc.refreshMpArticlesAndUpdateFeed('cover-feed'),
    ).toMatchObject({ source: 'cover', hasHistory: -1 });
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: 'cover-feed' } }))
        .syncTime,
    ).toBe(5);
    await expect(trpc.getHistoryMpArticles('cover-feed')).rejects.toThrow(
      '无法补齐历史',
    );
    await fs.writeFile(path.join(directory, 'articles.csv'), csv('200', true));
    const results = await trpc.refreshAllMpArticlesAndUpdateFeed();
    expect(results.find((r) => r.id === mpId)?.source).toBe('error');
    expect(results.find((r) => r.id === 'cover-feed')?.source).toBe('cover');
  });
  it('rejects an invalid later row without partially changing records or sync time', async () => {
    const before = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    await fs.writeFile(path.join(directory, 'articles.csv'), csv('999', true));
    await expect(
      service.importDirectory({ directory, mpId }),
    ).rejects.toThrow();
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: 'legacy-short-link' },
        })
      ).readCount,
    ).toBe(200);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } })).syncTime,
    ).toBe(before.syncTime);
  });
  it('preserves the existing publication date and skips new undated cover records', async () => {
    const before = await prisma.article.findUniqueOrThrow({
      where: { id: 'cover-id' },
    });
    jest.spyOn(trpc, 'getMpArticles').mockResolvedValueOnce([
      { id: 'cover-id', title: '旧文章封面', picUrl: '', publishTime: null },
      {
        id: 'undated-new-cover',
        title: '未知时间',
        picUrl: '',
        publishTime: null,
      },
    ]);
    const result = await trpc.refreshMpArticlesAndUpdateFeed('cover-feed');
    expect(result).toMatchObject({
      source: 'cover',
      saved: 1,
      skippedUnknownDate: 1,
    });
    expect(
      (await prisma.article.findUniqueOrThrow({ where: { id: 'cover-id' } }))
        .publishTime,
    ).toBe(before.publishTime);
    expect(
      await prisma.article.findUnique({ where: { id: 'undated-new-cover' } }),
    ).toBeNull();
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: 'cover-feed' } }))
        .syncTime,
    ).toBe(5);
  });
});
