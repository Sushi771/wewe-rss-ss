import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { fetchDesktopRecent20, verifyDesktopEvidence } from './desktop-wechat';
import { articlePageRequest, BODY_UNAVAILABLE_MESSAGE } from './article-page';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { FeedsService } from '../feeds/feeds.service';

// 真实解析器、事务、路由和导出；网络、桌面与生产备份均禁止。
jest.mock('axios');
jest.mock('./desktop-wechat', () => ({
  ...jest.requireActual('./desktop-wechat'),
  fetchDesktopRecent20: jest.fn(),
}));
jest.mock('./article-page', () => ({
  ...jest.requireActual('./article-page'),
  articlePageRequest: jest.fn(),
}));
jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));

const mpId = 'MP_WXS_1234567890';
const mpName = '正文状态隔离测试';
const cards = Array.from({ length: 20 }, (_, i) => ({
  rank: i + 1,
  title: `已核验文章${i}`,
  shortUrl: `https://mp.weixin.qq.com/s/${String(i).padStart(22, 'B')}`,
}));
const evidence = JSON.stringify({
  protocolVersion: 2,
  source: 'desktop-wechat',
  account: mpName,
  mpId,
  articles: cards,
  pinnedArticles: [],
});
const id = (index: number) => `WX_1234567890_${100 + index}_1`;
const legacyId = cards[0].shortUrl.split('/').at(-1)!;
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const oldBody = `<div id="js_content" class="rich_media_content"><p>保留旧正文与图片</p><img src="data:image/png;base64,${imageBytes.toString('base64')}"></div>`;

async function verified(missing = [0, 1, 2], invalidIndex = -1) {
  (axios.get as jest.Mock).mockImplementation(async (url: string) => {
    const index = cards.findIndex((card) => card.shortUrl === url);
    if (index < 0) throw new Error('Unexpected request');
    const card = cards[index];
    return {
      data: `<meta property="og:url" content="${card.shortUrl}">
      <meta property="og:image" content="https://mmbiz.qpic.cn/new.jpg">
      <h1 id="activity-name">${card.title}</h1>
      <div id="js_content">${missing.includes(index) ? '' : '<p>新正文</p><img data-src="https://mmbiz.qpic.cn/new-body.jpg">'}</div>
      <script>var biz="MTIzNDU2Nzg5MA==";var mid="${100 + index}";var idx="1";var sn="abcd";
      ${index === invalidIndex ? '' : `var ct=${1700000000 - index};`}</script>`,
    };
  });
  jest.useFakeTimers();
  try {
    const pending = verifyDesktopEvidence(mpId, mpName, evidence).then(
      (value) => ({ value, error: undefined }),
      (error: Error) => ({ value: undefined, error }),
    );
    await jest.runAllTimersAsync();
    const result = await pending;
    if (result.error) throw result.error;
    return result.value!;
  } finally {
    jest.useRealTimers();
  }
}

describe('已核验元数据与独立正文状态（隔离SQLite）', () => {
  let root: string;
  let prisma: PrismaClient;
  let service: CollectionService;
  let trpc: TrpcService;
  let router: TrpcRouter;
  let feeds: FeedsService;
  let cachedBefore: Awaited<
    ReturnType<PrismaClient['article']['findUniqueOrThrow']>
  >;
  let missingBefore: Awaited<
    ReturnType<PrismaClient['article']['findUniqueOrThrow']>
  >;
  const rows = () => prisma.article.findMany({ orderBy: { id: 'asc' } });
  const collect = async () => {
    (fetchDesktopRecent20 as jest.Mock).mockResolvedValue(await verified());
    return trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual');
  };
  const caller = () =>
    router.appRouter.createCaller({ errorMsg: null, isLocal: true } as any);

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-body-state-'));
    prisma = new PrismaClient({
      datasources: {
        db: { url: `file:${path.join(root, 'test.db').replace(/\\/g, '/')}` },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    const config = {
      get: (key: string) =>
        ({
          platform: { url: '' },
          feed: { updateDelayTime: 0, obsidianPath: path.join(root, 'vault') },
        })[key],
    } as any;
    service = new CollectionService(prisma as any);
    (axios.create as jest.Mock).mockReturnValue({
      interceptors: { response: { use: jest.fn() } },
    });
    const weread = {
      getArticleContent: jest.fn(() => {
        throw new Error('Unexpected WeRead request');
      }),
    } as any;
    trpc = new TrpcService(prisma as any, config, weread, service);
    router = new TrpcRouter(trpc, prisma as any, config, weread, service);
    feeds = new FeedsService(prisma as any, trpc, config);
    jest
      .spyOn(feeds, 'getHtmlByUrl')
      .mockRejectedValue(new Error('Unexpected RSS fetch'));
    (articlePageRequest as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('Unexpected export fetch');
    });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
      integrityCheck: 'ok',
    });
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName,
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
        collectionChannel: 'desktop-wechat',
      },
    });
    cachedBefore = await prisma.article.create({
      data: {
        id: legacyId,
        mpId,
        title: cards[0].title,
        publishTime: 1700000000,
        picUrl: 'https://mmbiz.qpic.cn/old.jpg',
        sourceUrl:
          'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=100&idx=1&sn=old',
        contentHtml: oldBody,
        readCount: 8,
        likeCount: 0,
        metrics: '{"read":{"value":8}}',
      },
    });
    missingBefore = await prisma.article.create({
      data: {
        id: id(1),
        mpId,
        title: cards[1].title,
        publishTime: 1699999999,
        picUrl: 'https://mmbiz.qpic.cn/old-no-body.jpg',
        sourceUrl: cards[1].shortUrl,
      },
    });
    await prisma.article.create({
      data: {
        id: 'outside-window',
        mpId,
        title: '保留历史',
        publishTime: 1500000000,
        picUrl: '',
        contentHtml: '<p>窗口外正文</p>',
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-body-state-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  it('保存20篇元数据与独立状态，缺正文保持null且旧缓存/图片/来源/指标全保留', async () => {
    expect(await collect()).toMatchObject({
      articles: 20,
      created: 18,
      updated: 2,
      complete: false,
      bodyFetch: { succeeded: 17, unavailable: 3 },
      bodyCache: { available: 18, retained: 1, missing: 2 },
      bodyUnavailable: [
        { id: legacyId, cached: true },
        { id: id(1), cached: false },
        { id: id(2), cached: false },
      ],
    });
    const saved = await prisma.article.findUniqueOrThrow({
      where: { id: legacyId },
    });
    expect(saved).toEqual({
      ...cachedBefore,
      lastBodyStatus: 'unavailable',
      verifiedSourceUrl:
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=100&idx=1&sn=abcd',
      updatedAt: expect.any(Date),
    });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: id(1) } }),
    ).toEqual({
      ...missingBefore,
      lastBodyStatus: 'unavailable',
      verifiedSourceUrl:
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=101&idx=1&sn=abcd',
      updatedAt: expect.any(Date),
    });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: id(2) } }),
    ).toMatchObject({
      contentHtml: null,
      lastBodyStatus: 'unavailable',
      readCount: null,
      likeCount: null,
      metrics: null,
    });
    expect(await prisma.article.count()).toBe(21);
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    expect(JSON.parse(feed.lastCollectionResult!)).toMatchObject({
      articles: 20,
      bodyFetch: { succeeded: 17, unavailable: 3 },
      bodyCache: { available: 18, retained: 1, missing: 2 },
    });
    const list = await caller().article.list({ mpId, limit: 30 });
    expect(list.items.find((item) => item.id === id(2))).toMatchObject({
      lastBodyStatus: 'unavailable',
    });
    expect(list.items[0]).not.toHaveProperty('contentHtml');
    expect((await caller().article.summary({ mpId })).cachedBodies).toBe(19);
  });

  it('缺正文再次更新新增0、更新0，不改文章时间戳或保护字段', async () => {
    await collect();
    const before = await rows();
    expect(
      await trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual'),
    ).toMatchObject({ created: 0, updated: 0, bodyFetch: { unavailable: 3 } });
    expect(await rows()).toEqual(before);
  });

  it('旧短链已绑定的原文不能在后续窗口改绑，整批回滚', async () => {
    await collect();
    const before = await rows();
    const next = await verified();
    next[0].id = 'WX_1234567890_999_1';
    next[0].url = next[0].url.replace('mid=100', 'mid=999');
    (fetchDesktopRecent20 as jest.Mock).mockResolvedValueOnce(next);
    await expect(
      service.collectDesktopRecent20({ mpId, mpName }),
    ).rejects.toThrow('身份冲突');
    expect(await rows()).toEqual(before);
  });

  it('后续正文重试成功只补空缓存，旧正文不替换且身份不增加', async () => {
    await collect();
    (fetchDesktopRecent20 as jest.Mock).mockResolvedValue(await verified([]));
    expect(
      await trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual'),
    ).toMatchObject({
      created: 0,
      updated: 3,
      bodyFetch: { succeeded: 20, unavailable: 0 },
      bodyCache: { available: 20, retained: 18, missing: 0 },
      bodyUnavailable: [],
    });
    expect(
      (await prisma.article.findUniqueOrThrow({ where: { id: legacyId } }))
        .contentHtml,
    ).toBe(oldBody);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: id(1) } }),
    ).toMatchObject({
      lastBodyStatus: 'available',
      contentHtml: expect.stringContaining('新正文'),
      readCount: null,
    });
    expect(await prisma.article.count()).toBe(21);
    expect(
      await trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual'),
    ).toMatchObject({ created: 0, updated: 0 });
  });

  it('末条日期无法核验时整批不写，先前可核验元数据不能凑成20篇', async () => {
    const before = await rows();
    (fetchDesktopRecent20 as jest.Mock).mockImplementation(() =>
      verified([0, 1, 2], 19),
    );
    await expect(
      trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual'),
    ).rejects.toThrow('日期');
    expect(await rows()).toEqual(before);
    expect(
      JSON.parse(
        (await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }))
          .lastCollectionResult!,
      ),
    ).toMatchObject({ status: 'failed', coverage: 'none' });
  });

  it('文章事务末写入失败时回滚元数据、正文和状态，之后可重试', async () => {
    (fetchDesktopRecent20 as jest.Mock).mockResolvedValue(await verified());
    const before = await rows();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_final_body BEFORE INSERT ON articles WHEN NEW.id = '${id(19)}' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`,
    );
    try {
      await expect(
        service.collectDesktopRecent20({ mpId, mpName }),
      ).rejects.toThrow();
      expect(await rows()).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_final_body');
    }
    expect(
      await service.collectDesktopRecent20({ mpId, mpName }),
    ).toMatchObject({ created: 18 });
  });

  it('RSS保留缺正文条目并说明状态，旧正文可导出到Obsidian且图片字节不变', async () => {
    await collect();
    const rss = await feeds.handleGenerateFeed({
      id: mpId,
      type: 'rss',
      limit: 30,
      page: 1,
      mode: 'fulltext',
    });
    expect(rss.content).toContain(BODY_UNAVAILABLE_MESSAGE);
    expect(rss.content).toContain(cards[2].shortUrl);
    expect(rss.content).toContain('保留旧正文与图片');
    expect(feeds.getHtmlByUrl).not.toHaveBeenCalled();
    const exported = await caller().article.saveToObsidian(legacyId);
    const markdown = await fs.readFile(exported.path, 'utf8');
    expect(markdown).toContain('保留旧正文与图片');
    const image = markdown.match(/attachments\/image_[a-f0-9]+\.png/)?.[0];
    expect(image).toBeTruthy();
    expect(
      await fs.readFile(path.join(path.dirname(exported.path), image!)),
    ).toEqual(imageBytes);
    expect(
      (await caller().article.exportMarkdown(legacyId)).markdown,
    ).toContain('保留旧正文与图片');
    expect(await fs.readFile(exported.path, 'utf8')).toBe(markdown);
    const beforeFiles = await fs.readdir(path.join(root, 'vault'), {
      recursive: true,
    });
    for (const method of ['exportMarkdown', 'saveToObsidian'] as const)
      await expect(caller().article[method](id(2))).rejects.toThrow(
        BODY_UNAVAILABLE_MESSAGE,
      );
    expect(
      await fs.readdir(path.join(root, 'vault'), { recursive: true }),
    ).toEqual(beforeFiles);
    expect(articlePageRequest).not.toHaveBeenCalled();
  });
});
