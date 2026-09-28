import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { fetchDesktopRecent20 } from './desktop-wechat';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { TrpcService } from '../trpc/trpc.service';
import { FeedsService } from '../feeds/feeds.service';

jest.mock('./desktop-wechat', () => ({ fetchDesktopRecent20: jest.fn() }));
jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));

const mpId = 'MP_WXS_1234567890';
const mpName = '隔离测试号';
const config = {
  get: (key: string) =>
    ({ platform: { url: '' }, feed: { updateDelayTime: 0 } })[key],
} as any;
const result = {
  source: 'desktop-wechat',
  status: 'partial',
  complete: false,
  coverage: 'article-tab-latest-20-unique',
  articles: 20,
  message: '隔离测试',
};

describe('桌面采集入口的备份与触发边界', () => {
  let trpc: TrpcService;
  let prisma: any;
  let collect: jest.Mock;
  const oldIds = process.env.WECHAT_DESKTOP_MP_IDS;
  const oldScheduled = process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WECHAT_DESKTOP_MP_IDS = mpId;
    delete process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED;
    (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
      integrityCheck: 'ok',
    });
    prisma = {
      feed: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: mpId, mpName }),
        findMany: jest.fn().mockResolvedValue([{ id: mpId, mpName }]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    collect = jest.fn().mockResolvedValue(result);
    trpc = new TrpcService(
      prisma,
      config,
      {} as any,
      { collectDesktopRecent20: collect } as any,
    );
  });
  afterAll(() => {
    if (oldIds === undefined) delete process.env.WECHAT_DESKTOP_MP_IDS;
    else process.env.WECHAT_DESKTOP_MP_IDS = oldIds;
    if (oldScheduled === undefined)
      delete process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED;
    else process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED = oldScheduled;
  });
  it('备份完成前不写running，也不启动helper', async () => {
    let release!: () => void;
    (createVerifiedSqliteBackup as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = trpc.collectDesktopRecent20(mpId);
    await Promise.resolve();
    await Promise.resolve();
    expect(prisma.feed.update).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    release();
    await pending;
    expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(createVerifiedSqliteBackup).toHaveBeenCalledWith({
      allowMysqlSkip: false,
    });
    expect(collect).toHaveBeenCalledWith({
      mpId,
      mpName,
      resumeAfterUserConsent: true,
    });
    expect(
      JSON.parse(prisma.feed.update.mock.calls[0][0].data.lastCollectionResult)
        .status,
    ).toBe('running');
  });
  it('备份失败零写入，释放同号锁后可重试', async () => {
    (createVerifiedSqliteBackup as jest.Mock).mockRejectedValueOnce(
      new Error('备份失败'),
    );
    await expect(trpc.collectDesktopRecent20(mpId)).rejects.toThrow('备份失败');
    expect(prisma.feed.update).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    await expect(trpc.collectDesktopRecent20(mpId)).resolves.toEqual(result);
  });
  it('helper失败仅保存失败状态，不报告0篇成功', async () => {
    collect.mockRejectedValueOnce(new Error('USER_CANCELLED'));
    await expect(trpc.collectDesktopRecent20(mpId)).rejects.toThrow(
      'USER_CANCELLED',
    );
    expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(
      prisma.feed.update.mock.calls.at(-1)[0].data.lastCollectionResult,
    );
    expect(saved).toMatchObject({
      source: 'error',
      status: 'failed',
      complete: false,
      coverage: 'none',
    });
  });
  it('公开RSS更新不能启动桌面或写状态', async () => {
    await expect(trpc.refreshMpArticlesAndUpdateFeed(mpId)).rejects.toThrow(
      '公开订阅请求不会操作桌面',
    );
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    expect(prisma.feed.update).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });
  it('定时默认关闭，显式启用后复用同一采集实现且不恢复暂停', async () => {
    await expect(
      trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'scheduled'),
    ).rejects.toThrow('尚未启用');
    expect(collect).not.toHaveBeenCalled();
    process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED = '1';
    const feeds = new FeedsService(prisma, trpc, config);
    await feeds.handleUpdateFeedsCron();
    expect(collect).toHaveBeenCalledWith({ mpId, mpName });
    expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(createVerifiedSqliteBackup).toHaveBeenCalledWith({
      allowMysqlSkip: false,
    });
  });
  it('本机普通更新与专用按钮复用同一通道', async () => {
    await trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual');
    expect(collect).toHaveBeenCalledWith({ mpId, mpName });
  });
});

describe('桌面最新20篇在隔离SQLite中的保护与重复更新', () => {
  let root: string;
  let prisma: PrismaClient;
  let service: CollectionService;
  const articles = Array.from({ length: 20 }, (_, i) => ({
    id: `WX_1234567890_${100 + i}_1`,
    mpId,
    rank: i + 1,
    title: `文章${i}`,
    publishTime: 1700000000 - i,
    shortUrl: `https://mp.weixin.qq.com/s/${String(i).padStart(22, 'a')}`,
    url: `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=${100 + i}&idx=1&sn=abcd`,
    contentHtml: `<div id="js_content">新正文${i}</div>`,
    lastBodyStatus: 'available',
    picUrl: '',
  }));
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-desktop-test-'));
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
    service = new CollectionService(prisma as any);
    await prisma.feed.create({
      data: { id: mpId, mpName, mpCover: '', mpIntro: '', updateTime: 0 },
    });
    await prisma.article.create({
      data: {
        id: articles[0].shortUrl.split('/').at(-1)!,
        mpId,
        title: articles[0].title,
        publishTime: articles[0].publishTime,
        picUrl: 'https://mmbiz.qpic.cn/old.jpg',
        sourceUrl: articles[0].url,
        contentHtml: '<p>必须保留</p>',
        readCount: 8,
        likeCount: 0,
        metrics: '{"read":{"value":8}}',
      },
    });
    await prisma.article.create({
      data: {
        id: 'old-outside-window',
        mpId,
        title: '旧文章',
        publishTime: 1500000000,
        picUrl: '',
        contentHtml: '<p>旧正文</p>',
      },
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-desktop-test-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('保留旧ID、正文、封面、带sn来源和有效指标，窗口外文章不裁剪', async () => {
    (fetchDesktopRecent20 as jest.Mock).mockResolvedValue(articles);
    expect(
      await service.collectDesktopRecent20({ mpId, mpName }),
    ).toMatchObject({ created: 19, articles: 20, complete: false });
    expect(await prisma.article.count()).toBe(21);
    expect(
      await prisma.article.findUnique({ where: { id: articles[0].id } }),
    ).toBeNull();
    expect(
      await prisma.article.findUniqueOrThrow({
        where: { id: articles[0].shortUrl.split('/').at(-1)! },
      }),
    ).toMatchObject({
      contentHtml: '<p>必须保留</p>',
      picUrl: 'https://mmbiz.qpic.cn/old.jpg',
      sourceUrl: articles[0].url,
      readCount: 8,
      likeCount: 0,
      metrics: '{"read":{"value":8}}',
    });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: articles[1].id } }),
    ).toMatchObject({ readCount: null, likeCount: null, metrics: null });
    expect(
      await prisma.article.findUniqueOrThrow({
        where: { id: 'old-outside-window' },
      }),
    ).toMatchObject({ contentHtml: '<p>旧正文</p>' });
  });
  it('相同20篇再次更新新增0，旧正文与指标不变', async () => {
    expect(
      await service.collectDesktopRecent20({ mpId, mpName }),
    ).toMatchObject({ created: 0, updated: 0 });
    expect(await prisma.article.count()).toBe(21);
  });
  it('列表失败不启动事务且原数据不变', async () => {
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    (fetchDesktopRecent20 as jest.Mock).mockRejectedValueOnce(
      new Error('PINNED_CARD_UNVERIFIED'),
    );
    await expect(
      service.collectDesktopRecent20({ mpId, mpName }),
    ).rejects.toThrow('PINNED_CARD_UNVERIFIED');
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
  });
});
