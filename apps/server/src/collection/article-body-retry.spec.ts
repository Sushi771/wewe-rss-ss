import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { canonicalArticleUrl } from './collection-format';
import {
  bodyRetryAvailability,
  readBodyRetryResult,
} from './article-body-retry';
import { fetchMp2RssRecent20 } from './mp2rss';

// 真实迁移、SQLite事务、路由和解析器；所有网络与桌面入口均为 mock。
jest.mock('axios');
jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));
jest.mock('./mp2rss', () => ({ fetchMp2RssRecent20: jest.fn() }));

const mpId = 'MP_WXS_1234567890';
const id = 'R'.repeat(22);
const shortUrl = `https://mp.weixin.qq.com/s/${id}`;
const original = canonicalArticleUrl(
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=100&idx=2&sn=abcd',
);
const time = 1700000000;
const title = '窗口外待补正文';
const oldBody =
  '<div id="js_content"><p>原有正文</p><img src="https://mmbiz.qpic.cn/old.png"></div>';

function page(
  options: {
    mid?: string;
    idx?: string;
    biz?: string;
    body?: string;
    title?: string;
    time?: number;
    canonical?: string;
  } = {},
) {
  return `<meta property="og:url" content="${options.canonical ?? shortUrl}">
  <h1 id="activity-name">${options.title ?? title}</h1>
  <div id="js_content">${options.body ?? '<p onclick="bad()">补入正文</p><img data-src="https://mmbiz.qpic.cn/body.png"><script>bad()</script>'}</div>
  <script>var biz="${options.biz ?? 'MTIzNDU2Nzg5MA=='}";var mid="${options.mid ?? '100'}";var idx="${options.idx ?? '2'}";var sn="abcd";var ct=${options.time ?? time};</script>`;
}

describe('本机单篇正文重试（隔离SQLite）', () => {
  let root: string;
  let databaseUrl: string;
  let prisma: PrismaClient;
  let collection: CollectionService;
  let trpc: TrpcService;
  let router: TrpcRouter;
  const oldProxy = process.env.WECHAT_PUBLIC_PROXY_URL;
  const read = (articleId = id) =>
    prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  const caller = (isLocal = true, errorMsg: string | null = null) =>
    router.appRouter.createCaller({ isLocal, errorMsg } as any);
  const protectedFields = (article: Awaited<ReturnType<typeof read>>) =>
    Object.fromEntries(
      Object.entries(article).filter(
        ([key]) =>
          ![
            'contentHtml',
            'lastBodyStatus',
            'lastBodyRetry',
            'verifiedSourceUrl',
            'updatedAt',
          ].includes(key),
      ),
    );
  const config = {
    get: (key: string) =>
      ({ platform: { url: '' }, feed: { updateDelayTime: 0 } })[key],
  } as any;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-body-retry-'));
    databaseUrl = `file:${path.join(root, 'test.db').replace(/\\/g, '/')}`;
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
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
    collection = new CollectionService(prisma as any);
    (axios.create as jest.Mock).mockReturnValue({
      interceptors: { response: { use: jest.fn() } },
    });
    trpc = new TrpcService(prisma as any, config, {} as any, collection);
    router = new TrpcRouter(trpc, prisma as any, config, {} as any, collection);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.WECHAT_PUBLIC_PROXY_URL;
    (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
      integrityCheck: 'ok',
    });
    (axios.get as jest.Mock)
      .mockReset()
      .mockResolvedValue({ status: 200, data: page() });
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: '单篇隔离测试号',
        mpCover: '',
        mpIntro: '',
        updateTime: time + 100,
        collectionChannel: 'desktop-wechat',
        lastCollectionResult: '{"status":"partial","articles":20}',
      },
    });
    await prisma.article.create({
      data: {
        id,
        mpId,
        title,
        publishTime: time,
        picUrl: 'https://mmbiz.qpic.cn/old.png',
        sourceUrl: shortUrl,
        verifiedSourceUrl: original.url,
        lastBodyStatus: 'unavailable',
        readCount: 0,
        likeCount: null,
        metrics: '{"read":{"value":0,"display":"0"}}',
      },
    });
    // 当前最新20篇均在它之后，证明重试不会重新发现或裁剪订阅列表。
    for (let i = 0; i < 20; i++)
      await prisma.article.create({
        data: {
          id: `recent-${i}`,
          mpId,
          title: `近期${i}`,
          publishTime: time + i + 1,
          picUrl: '',
        },
      });
  });

  afterAll(async () => {
    if (oldProxy === undefined) delete process.env.WECHAT_PUBLIC_PROXY_URL;
    else process.env.WECHAT_PUBLIC_PROXY_URL = oldProxy;
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-body-retry-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  it('窗口外旧短链只补空正文，保留ID/标题/日期/来源/封面/有效及null指标；不改订阅状态', async () => {
    const before = await read();
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    const result = await caller().article.retryBody(id);
    expect(result).toMatchObject({
      status: 'available',
      cached: true,
      filled: true,
    });
    const after = await read();
    expect(protectedFields(after)).toEqual(protectedFields(before));
    expect(after.contentHtml).toContain('补入正文');
    expect(after.contentHtml).toContain('src="https://mmbiz.qpic.cn/body.png"');
    expect(after.contentHtml).not.toMatch(/onclick|<script|data-src/);
    expect(after.lastBodyStatus).toBe('available');
    expect(JSON.parse(after.lastBodyRetry!)).toEqual(result);
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(feed);
    expect(await prisma.article.count()).toBe(21);
    expect(
      await prisma.article.findUnique({ where: { id: original.id } }),
    ).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(
      original.url,
      expect.objectContaining({
        maxRedirects: 0,
        proxy: false,
        timeout: 15000,
      }),
    );
    expect(fetchMp2RssRecent20).not.toHaveBeenCalled();
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: page({ body: '<p>后来的正文不得替换</p>' }),
    });
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'available',
      filled: false,
    });
    expect((await read()).contentHtml).toBe(after.contentHtml);
    expect(await prisma.article.count()).toBe(21);
  });

  it.each([
    '',
    '<script>只有脚本</script>',
    '<img src="http://evil.example/image">',
  ])('清洗后没有正文时保持缓存并独立记录unavailable（%s）', async (body) => {
    await prisma.article.update({
      where: { id },
      data: { contentHtml: oldBody },
    });
    const before = await read();
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: page({ body }),
    });
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'unavailable',
      cached: true,
      filled: false,
    });
    const after = await read();
    expect(after.contentHtml).toBe(oldBody);
    expect(protectedFields(after)).toEqual(protectedFields(before));
    expect(after.lastBodyStatus).toBe('unavailable');
  });

  it('无缓存且原文空正文时不生成空缓存，不报告成功', async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: page({ body: '' }),
    });
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'unavailable',
      cached: false,
      filled: false,
    });
    expect((await read()).contentHtml).toBeNull();
  });

  it.each([
    ['另一篇', page({ mid: '101' }), 'identity_mismatch'],
    ['同消息不同idx', page({ idx: '1' }), 'identity_mismatch'],
    ['另一账号', page({ biz: 'MjM0NTY3ODkwMQ==' }), 'identity_mismatch'],
    [
      '另一短链',
      page({ canonical: `https://mp.weixin.qq.com/s/${'S'.repeat(22)}` }),
      'identity_mismatch',
    ],
    [
      '标题变化',
      page({ title: '相同身份也先拒绝标题变化' }),
      'identity_mismatch',
    ],
    ['日期变化', page({ time: time - 1 }), 'identity_mismatch'],
    ['缺日期', page().replace(`var ct=${time};`, ''), 'invalid_page'],
    [
      '验证页',
      page() + '<iframe src="https://captcha.gtimg.com/test"></iframe>',
      'invalid_page',
    ],
    ['错误页', page() + '<div class="weui_msg">错误</div>', 'invalid_page'],
    ['缺结构', '<h1>普通网页</h1>', 'invalid_page'],
    [
      '非官方canonical',
      page({ canonical: 'https://evil.example/test' }),
      'invalid_page',
    ],
  ])('拒绝%s，不覆盖旧正文或上一次正文状态', async (_name, html, code) => {
    await prisma.article.update({
      where: { id },
      data: { contentHtml: oldBody, lastBodyStatus: 'available' },
    });
    const before = await read();
    (axios.get as jest.Mock).mockResolvedValueOnce({ status: 200, data: html });
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'failed',
      code,
      cached: true,
      filled: false,
    });
    const after = await read();
    expect(protectedFields(after)).toEqual(protectedFields(before));
    expect(after.contentHtml).toBe(oldBody);
    expect(after.lastBodyStatus).toBe('available');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it.each([302, 403, 500])(
    'HTTP %s 不跟随跳转、不重试，记录失败',
    async (status) => {
      (axios.get as jest.Mock).mockResolvedValueOnce({ status, data: page() });
      expect(await caller().article.retryBody(id)).toMatchObject({
        status: 'failed',
        code: 'request_failed',
      });
      expect((await read()).contentHtml).toBeNull();
      expect(axios.get).toHaveBeenCalledTimes(1);
    },
  );

  it('原始网络错误不出现在返回值或持久状态，失败后锁释放', async () => {
    (axios.get as jest.Mock).mockRejectedValueOnce({
      isAxiosError: true,
      message: 'https://evil.example?token=SECRET',
      config: { headers: { Cookie: 'SECRET' } },
    });
    const result = await caller().article.retryBody(id);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|evil|Cookie/);
    expect((await read()).lastBodyRetry).not.toMatch(/SECRET|evil|Cookie/);
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'available',
    });
  });

  it('未绑定旧短链明确拒绝，不备份、不请求、不写状态', async () => {
    await prisma.article.update({
      where: { id },
      data: { verifiedSourceUrl: null },
    });
    const before = await read();
    await expect(caller().article.retryBody(id)).rejects.toThrow('尚无可核验');
    expect(await read()).toEqual(before);
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('旧规范ID与已存完整来源相符时允许，核验后建立绑定但保留原始来源', async () => {
    const sourceUrl = `${original.url}&scene=21&pass_ticket=NEVER_SEND`;
    await prisma.article.update({
      where: { id },
      data: { id: original.id, verifiedSourceUrl: null, sourceUrl },
    });
    expect(await caller().article.retryBody(original.id)).toMatchObject({
      status: 'available',
    });
    const saved = await read(original.id);
    expect(saved.sourceUrl).toBe(sourceUrl);
    expect(saved.verifiedSourceUrl).toBe(original.url);
    expect(axios.get).toHaveBeenCalledWith(original.url, expect.any(Object));
    expect(JSON.stringify((axios.get as jest.Mock).mock.calls)).not.toContain(
      'NEVER_SEND',
    );
  });

  it('合集列表时间与原文 ct 相差 34 秒时，以同身份原文核验并校正时间', async () => {
    await prisma.article.update({
      where: { id },
      data: {
        id: original.id,
        sourceUrl: original.url,
        verifiedSourceUrl: null,
        publishTime: time - 34,
      },
    });
    expect(await caller().article.retryBody(original.id)).toMatchObject({
      status: 'available',
      filled: true,
    });
    const saved = await read(original.id);
    expect(saved.publishTime).toBe(time);
    expect(saved.verifiedSourceUrl).toBe(original.url);
    expect(saved.contentHtml).toContain('补入正文');
  });

  it('合集时间偏差超过一分钟时拒绝原文绑定且保留旧值', async () => {
    await prisma.article.update({
      where: { id },
      data: {
        id: original.id,
        sourceUrl: original.url,
        verifiedSourceUrl: null,
        publishTime: time - 61,
      },
    });
    expect(await caller().article.retryBody(original.id)).toMatchObject({
      status: 'failed',
      code: 'identity_mismatch',
    });
    const saved = await read(original.id);
    expect(saved.publishTime).toBe(time - 61);
    expect(saved.verifiedSourceUrl).toBeNull();
    expect(saved.contentHtml).toBeNull();
  });

  it('恰好22字符的规范ID不误当旧短链ID', async () => {
    const canonical = canonicalArticleUrl(
      original.url.replace('mid=100', 'mid=123456'),
    );
    expect(canonical.id).toHaveLength(22);
    await prisma.article.update({
      where: { id },
      data: {
        id: canonical.id,
        sourceUrl: canonical.url,
        verifiedSourceUrl: null,
      },
    });
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: page({ mid: '123456' }),
    });
    expect(await caller().article.retryBody(canonical.id)).toMatchObject({
      status: 'available',
    });
  });

  it.each([
    { verifiedSourceUrl: shortUrl },
    { verifiedSourceUrl: 'https://evil.example/s?mid=100' },
    { sourceUrl: original.url.replace('mid=100', 'mid=999') },
    { mpId: 'MP_WXS_2345678901' },
    { id: 'WX_1234567890_101_2' },
  ])('冲突或无效持久身份不可重试：%j', (override) => {
    expect(
      bodyRetryAvailability({
        id,
        mpId,
        title,
        publishTime: time,
        sourceUrl: shortUrl,
        verifiedSourceUrl: original.url,
        ...override,
      }).allowed,
    ).toBe(false);
  });

  it('远程或未认证请求在备份及网络之前拒绝', async () => {
    const before = await read();
    await expect(caller(false).article.retryBody(id)).rejects.toThrow('本机');
    await expect(caller(true, '未登录').article.retryBody(id)).rejects.toThrow(
      '未登录',
    );
    expect(await read()).toEqual(before);
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('备份等待期间零请求零写入，失败后可再试', async () => {
    const before = await read();
    let reject!: (error: Error) => void;
    (createVerifiedSqliteBackup as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = caller()
      .article.retryBody(id)
      .catch((e) => e);
    while (!reject) await new Promise((resolve) => setImmediate(resolve));
    expect(axios.get).not.toHaveBeenCalled();
    expect(await read()).toEqual(before);
    reject(new Error('备份失败'));
    expect((await pending).message).toContain('备份失败');
    expect(await read()).toEqual(before);
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'available',
    });
  });

  it('请求期间与同篇、同号手动/定时/合集操作互斥', async () => {
    let release!: (value: unknown) => void;
    (axios.get as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = caller().article.retryBody(id);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await expect(caller().article.retryBody(id)).rejects.toThrow(
      '正在采集或重试',
    );
    await expect(
      trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'scheduled'),
    ).rejects.toThrow('正在采集');
    await expect(
      trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual'),
    ).rejects.toThrow('正在采集');
    await expect(
      collection.collectMp2RssRecent20({ mpId, mpName: '单篇隔离测试号' }),
    ).rejects.toThrow('正在更新');
    await expect(
      collection.collectPublicAlbums({ mpId, albumIds: [] }),
    ).rejects.toThrow('正在采集');
    expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    release({ status: 200, data: page() });
    await pending;
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'available',
    });
  });

  it('请求期间其他路径补入正文时保留新缓存', async () => {
    (axios.get as jest.Mock).mockImplementationOnce(async () => {
      await prisma.article.update({
        where: { id },
        data: { contentHtml: oldBody },
      });
      return { status: 200, data: page() };
    });
    expect(await caller().article.retryBody(id)).toMatchObject({
      filled: false,
      cached: true,
    });
    expect((await read()).contentHtml).toBe(oldBody);
  });

  it('请求期间身份被改动则拒绝保存正文及结果', async () => {
    (axios.get as jest.Mock).mockImplementationOnce(async () => {
      await prisma.article.update({
        where: { id },
        data: { sourceUrl: original.url.replace('mid=100', 'mid=999') },
      });
      return { status: 200, data: page() };
    });
    await expect(caller().article.retryBody(id)).rejects.toThrow(
      '重试期间已变更',
    );
    expect((await read()).contentHtml).toBeNull();
    expect((await read()).lastBodyRetry).toBeNull();
  });

  it('真实SQLite写正文失败使正文与状态回滚，再独立记录失败而非成功', async () => {
    const before = await read();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_body BEFORE UPDATE OF content_html ON articles BEGIN SELECT RAISE(ABORT, 'BODY_TEST_ABORT'); END`,
    );
    try {
      expect(await caller().article.retryBody(id)).toMatchObject({
        status: 'failed',
        code: 'save_failed',
        filled: false,
      });
      const after = await read();
      expect(after.contentHtml).toBeNull();
      expect(after.lastBodyStatus).toBe(before.lastBodyStatus);
      expect(protectedFields(after)).toEqual(protectedFields(before));
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_body');
    }
    expect(await caller().article.retryBody(id)).toMatchObject({
      status: 'available',
      filled: true,
    });
  });

  it('重建client后绑定与结果持久保留；列表不返回正文且查询不触发重试', async () => {
    await caller().article.retryBody(id);
    const another = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    try {
      const stored = await another.article.findUniqueOrThrow({ where: { id } });
      expect(stored.verifiedSourceUrl).toBe(original.url);
      expect(readBodyRetryResult(stored.lastBodyRetry)?.status).toBe(
        'available',
      );
    } finally {
      await another.$disconnect();
    }
    jest.clearAllMocks();
    const list = await caller().article.list({
      mpId,
      search: title,
      limit: 20,
    });
    expect(list.items[0]).toMatchObject({
      id,
      bodyCached: true,
      bodyRetry: { allowed: true },
      bodyRetryResult: { status: 'available' },
    });
    expect(list.items[0]).not.toHaveProperty('contentHtml');
    expect(await caller().article.byId(id)).toMatchObject({ bodyCached: true });
    expect(await caller(false).article.byId(id)).toMatchObject({
      bodyRetry: { allowed: false },
    });
    expect(axios.get).not.toHaveBeenCalled();
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
});
