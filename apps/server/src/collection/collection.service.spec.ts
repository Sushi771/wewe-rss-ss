import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { canonicalArticleUrl, parsePublishTime } from './collection-format';
import { resolvePublicArticle } from './public-album';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { FeedsService } from '../feeds/feeds.service';
import { archiveProviderImages } from './archive-provider-images';

jest.mock('./public-album', () => ({
  fetchPublicAlbums: jest.fn(),
  resolvePublicArticle: jest.fn(),
}));
// 禁止隔离测试读取环境中可能指向生产库的 DATABASE_URL。
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));

describe('local collection with real SQLite migrations', () => {
  let root: string,
    directory: string,
    prisma: PrismaClient,
    service: CollectionService;
  let router: TrpcRouter, trpc: TrpcService, feeds: FeedsService;
  let config: any;
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
    (resolvePublicArticle as jest.Mock).mockResolvedValue({
      ...canonicalArticleUrl(url(1)),
      publishTime: parsePublishTime('2024-12-06 08:35:06'),
    });
    config = {
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
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toMatchObject({
      hasHistory: 1,
      localDirectory: null,
      syncTime: 0,
    });
  });
  it('exports cached body, local images, and metrics through the real router without network access', async () => {
    const caller = router.appRouter.createCaller({
      errorMsg: null,
      isLocal: true,
    } as any);
    const browserExport =
      await caller.article.exportMarkdown('legacy-short-link');
    expect(browserExport.markdown).toContain('正文内容');
    await expect(fs.stat(path.join(root, 'vault'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const result = await caller.article.saveToObsidian('legacy-short-link');
    const markdown = await fs.readFile(result.path, 'utf8');
    expect(markdown).toContain('正文内容');
    expect(markdown).toContain('| 收藏 | 未提供 |');
    const image = markdown.match(/image\/image_[a-f0-9]+\.png/)?.[0];
    expect(image).toBeTruthy();
    expect(
      (await fs.stat(path.join(path.dirname(result.path), image!))).size,
    ).toBeGreaterThan(0);
    const offlineDirectory = path.join(root, 'offline-feed');
    const offline = await router.buildOfflineFeedDirectory(
      mpId,
      offlineDirectory,
    );
    expect(offline).toMatchObject({ articles: 2, complete: 1 });
    const exported = await fs.readFile(
      path.join(offlineDirectory, offline!.incomplete[0], '正文.md'),
      'utf8',
    );
    expect(exported).toContain('无法离线阅读');
    const completedFolder = (
      await fs.readdir(path.join(offlineDirectory, 'articles'))
    ).find((name) => !offline!.incomplete.some((item) => item.endsWith(name)));
    expect(completedFolder).toBeTruthy();
    const completeMarkdown = await fs.readFile(
      path.join(offlineDirectory, 'articles', completedFolder!, '正文.md'),
      'utf8',
    );
    expect(completeMarkdown).toMatch(/image\/image_[a-f0-9]+\.png/);
    const readme = await fs.readFile(
      path.join(offlineDirectory, 'README.md'),
      'utf8',
    );
    expect(readme).toContain('未完整 1 篇');
    process.env.PRIVATE_ONLINE_MODE = '1';
    try {
      // Restored owner management stays behind the existing private login.
      await prisma.account.create({
        data: { id: 'legacy-account', name: 'owner', token: 'private-fixture' },
      });
      const account = await caller.account.byId('legacy-account');
      expect(account.name).toBe('owner');
      expect(account).not.toHaveProperty('token');
      const anonymous = router.appRouter.createCaller({ errorMsg: '请先登录' });
      await expect(anonymous.account.byId('legacy-account')).rejects.toThrow(
        '请先登录',
      );
      await expect(anonymous.platform.createLoginUrl()).rejects.toThrow(
        '请先登录',
      );
    } finally {
      delete process.env.PRIVATE_ONLINE_MODE;
    }
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
  it('uses persisted image bytes after a router restart even when a stale data-src remains', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const inline = `data:image/png;base64,${png.toString('base64')}`;
    const contentHtml = `<div class="rich_media_content"><p>正文内容</p><img data-src="https://mmbiz.qpic.cn/stale" src="${inline}"></div>`;
    await prisma.article.update({
      where: { id: 'legacy-short-link' },
      data: { contentHtml },
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Network disabled in test'));
    try {
      const restarted = new TrpcRouter(
        trpc,
        prisma as any,
        config,
        {} as any,
        service,
      );
      const caller = restarted.appRouter.createCaller({
        errorMsg: null,
        isLocal: true,
      } as any);
      const browser = await caller.article.exportMarkdown('legacy-short-link');
      expect(browser.markdown).toContain('data:image/png;base64,');
      expect(browser.markdown).not.toContain('mmbiz.qpic.cn/stale');
      const exported = await caller.article.saveToObsidian('legacy-short-link');
      const markdown = await fs.readFile(exported.path, 'utf8');
      const attachment = markdown.match(/image\/image_[a-f0-9]+\.png/)?.[0];
      expect(attachment).toBeTruthy();
      expect(
        await fs.readFile(path.join(path.dirname(exported.path), attachment!)),
      ).toEqual(png);
      const offlineDirectory = path.join(root, 'offline-after-restart');
      const offline = await restarted.buildOfflineFeedDirectory(
        mpId,
        offlineDirectory,
      );
      expect(offline?.complete).toBe(1);
      const cutOff = `data:image/png;base64,${png
        .subarray(0, -12)
        .toString('base64')}`;
      await prisma.article.update({
        where: { id: 'legacy-short-link' },
        data: { contentHtml: contentHtml.replace(inline, cutOff) },
      });
      try {
        const incomplete = await restarted.buildOfflineFeedDirectory(
          mpId,
          path.join(root, 'offline-corrupt-image'),
        );
        expect(incomplete?.complete).toBe(0);
        expect(incomplete?.incomplete).toHaveLength(2);
      } finally {
        await prisma.article.update({
          where: { id: 'legacy-short-link' },
          data: { contentHtml },
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        (
          await prisma.article.findUniqueOrThrow({
            where: { id: 'legacy-short-link' },
          })
        ).contentHtml,
      ).toBe(contentHtml);
    } finally {
      fetchMock.mockRestore();
    }
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
    expect(
      await caller.collection.importDirectory({ directory, mpId }),
    ).toMatchObject({
      source: 'local',
      status: 'partial',
      complete: false,
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
  it('keeps existing subscription configuration during explicit import', async () => {
    const binding = JSON.stringify(['2527940920407949313']);
    await prisma.feed.update({
      where: { id: mpId },
      data: {
        publicAlbumIds: binding,
        localDirectory: 'C:/legacy-path',
        status: 0,
        syncTime: 15,
      },
    });
    await service.importDirectory({ directory, mpId });
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toMatchObject({
      publicAlbumIds: binding,
      localDirectory: 'C:/legacy-path',
      status: 0,
      syncTime: 15,
    });
    await prisma.feed.update({
      where: { id: mpId },
      data: { publicAlbumIds: null, status: 1 },
    });
  });
  it('creates a one-time imported feed without enabling scheduling or directory binding', async () => {
    const other = 'MP_WXS_123456789';
    const newDir = path.join(root, 'new-account');
    await fs.mkdir(newDir);
    await fs.writeFile(
      path.join(newDir, 'articles.csv'),
      'title,url,time\n新号,https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5&mid=200&idx=1,2024-12-06 08:35:06\n',
    );
    await service.importDirectory({ directory: newDir, mpName: '仅历史导入' });
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: other } }),
    ).toMatchObject({
      status: 0,
      localDirectory: null,
      publicAlbumIds: null,
      syncTime: 0,
    });
    await prisma.feed.delete({ where: { id: other } });
  });
  it('blocks an unselected provider without reading a legacy directory', async () => {
    await prisma.feed.update({
      where: { id: mpId },
      data: { localDirectory: directory },
    });
    const readFiles = jest.spyOn(service, 'importDirectory');
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    expect((await trpc.refreshMpArticlesAndUpdateFeed(mpId)).status).toBe(
      'blocked',
    );
    const results = await trpc.refreshAllMpArticlesAndUpdateFeed();
    expect(results.find((result) => result.id === mpId)?.status).toBe(
      'blocked',
    );
    expect(readFiles).not.toHaveBeenCalled();
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    readFiles.mockRestore();
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
  it('does not merge a same-title same-time short link with a different proven identity', async () => {
    await fs.writeFile(path.join(directory, 'articles.csv'), csv());
    await prisma.article.create({
      data: {
        id: 'unrelated-short',
        mpId,
        title: '主条',
        picUrl: '',
        publishTime: parsePublishTime('2024-12-06 08:35:06'),
      },
    });
    (resolvePublicArticle as jest.Mock).mockResolvedValueOnce({
      ...canonicalArticleUrl(url(9)),
      publishTime: parsePublishTime('2024-12-06 08:35:06'),
    });
    expect(await service.importDirectory({ directory, mpId })).toMatchObject({
      created: 0,
      updated: 2,
      merged: 0,
    });
    expect(
      await prisma.article.findUniqueOrThrow({
        where: { id: 'unrelated-short' },
      }),
    ).toMatchObject({ sourceUrl: null });
    await prisma.article.delete({ where: { id: 'unrelated-short' } });
  });

  it('requires original identity before changing any rows or directory binding', async () => {
    await prisma.article.update({
      where: { id: 'legacy-short-link' },
      data: { sourceUrl: null },
    });
    const beforeFeed = await prisma.feed.findUniqueOrThrow({
      where: { id: mpId },
    });
    const beforeArticles = await prisma.article.findMany({
      orderBy: { id: 'asc' },
    });
    (resolvePublicArticle as jest.Mock).mockRejectedValueOnce(
      new Error('无法核验原文'),
    );
    await expect(service.importDirectory({ directory, mpId })).rejects.toThrow(
      '无法核验原文',
    );
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(beforeFeed);
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      beforeArticles,
    );
  });

  it('merges proven cross-source duplicates despite date skew and preserves body, metrics and legacy ID on repeat', async () => {
    const identity = canonicalArticleUrl(url(1));
    await prisma.article.create({
      data: {
        id: identity.id,
        mpId,
        title: '主条',
        picUrl: '',
        sourceUrl: identity.url,
        publishTime: parsePublishTime('2024-12-06 08:34:27'),
        metrics: JSON.stringify({
          favorite: { value: 4, display: '4', fileTime: '2026-09-27' },
        }),
      },
    });
    await fs.writeFile(
      path.join(directory, 'articles.csv'),
      csv().replaceAll('08:35:06', '08:34:27').replaceAll('&sn=abc', ''),
    );
    expect(await service.importDirectory({ directory, mpId })).toMatchObject({
      created: 0,
      updated: 2,
      merged: 1,
    });
    expect(
      await prisma.article.findUnique({ where: { id: identity.id } }),
    ).toBeNull();
    const original = await prisma.article.findUniqueOrThrow({
      where: { id: 'legacy-short-link' },
    });
    expect(original.publishTime).toBe(parsePublishTime('2024-12-06 08:35:06'));
    expect(original.sourceUrl).toBe(identity.url);
    expect(original.contentHtml).toContain('正文内容');
    expect(JSON.parse(original.metrics!).favorite.value).toBe(4);
    expect(await service.importDirectory({ directory, mpId })).toMatchObject({
      created: 0,
      updated: 2,
      merged: 0,
    });
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: 'legacy-short-link' },
        })
      ).publishTime,
    ).toBe(original.publishTime);
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: 'legacy-short-link' },
        })
      ).sourceUrl,
    ).toBe(identity.url);
  });
  it('saves newly archived images into an existing body and remains duplicate-safe', async () => {
    const identity = canonicalArticleUrl(url(99));
    const original = await prisma.article.create({
      data: {
        id: 'legacy-image-save',
        mpId,
        title: 'saved-image',
        picUrl: '',
        publishTime: 1700000000,
        sourceUrl: identity.url,
        verifiedSourceUrl: identity.url,
        contentHtml:
          '<div class="rich_media_content"><p>saved annotation</p><img src="https://mmbiz.qpic.cn/a.jpg" alt="keep"></div>',
        metrics: '{"read":{"value":20}}',
        readCount: 20,
        likeCount: 4,
      },
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    try {
      const page = await archiveProviderImages({
        articles: [
          {
            ...identity,
            url: identity.url,
            mpId,
            title: original.title,
            publishTime: original.publishTime,
            picUrl: '',
            contentHtml:
              '<div class="rich_media_content"><p>incoming text</p><img src="https://mmbiz.qpic.cn/a.jpg"></div>',
          },
        ],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: 0,
        imageBlocked: 0,
      });
      expect(await (service as any).saveVerifiedSearchPage(mpId, page)).toEqual(
        { created: 0, updated: 1 },
      );
      const saved = await prisma.article.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(saved.contentHtml).toContain('saved annotation');
      expect(saved.contentHtml).not.toContain('incoming text');
      expect(saved.contentHtml).toContain('data:image/png;base64,');
      expect(saved.contentHtml).toContain('alt="keep"');
      for (const field of [
        'id',
        'mpId',
        'title',
        'publishTime',
        'sourceUrl',
        'verifiedSourceUrl',
        'metrics',
        'readCount',
        'likeCount',
        'createdAt',
      ] as const)
        expect(saved[field]).toEqual(original[field]);
      expect(await (service as any).saveVerifiedSearchPage(mpId, page)).toEqual(
        { created: 0, updated: 0 },
      );
      expect(
        await prisma.article.findUniqueOrThrow({ where: { id: original.id } }),
      ).toEqual(saved);
      const conflicting = {
        ...page,
        articles: page.articles.map((a) => ({
          ...a,
          publishTime: a.publishTime + 38,
        })),
      };
      await expect(
        (service as any).saveVerifiedSearchPage(mpId, conflicting),
      ).rejects.toThrow('SEARCH_REPLAY_SAVED_METADATA_CONFLICT');
      expect(
        await prisma.article.findUniqueOrThrow({ where: { id: original.id } }),
      ).toEqual(saved);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
