import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
import * as backups from '../collection/sqlite-backup';
import { SubscriptionDiscoveryValidator } from '../collection/subscription-add';
import { CollectionService } from '../collection/collection.service';
import { wechat2RssAddReceipt } from '../collection/wechat2rss-add-receipt';
import { Wechat2RssProvider } from '../collection/providers/wechat2rss';

// Actual router, paid Provider, SQLite transactions and consistent backup.
// Only upstream responses and the native adapter are synthetic; no platform calls.
describe('explicit add source through original router (offline SQLite)', () => {
  const originalEnv = { ...process.env };
  const realBackup = backups.createVerifiedSqliteBackup;
  const number = '3456789012';
  const feedId = `MP_WXS_${number}`;
  const articleUrl = 'https://mp.weixin.qq.com/s/' + 'a'.repeat(22);
  const config = new ConfigService({
    platform: { url: '' },
    feed: { updateDelayTime: 0 },
    auth: { code: 'synthetic-local-access' },
  });
  let root: string, database: string, prisma: PrismaClient;
  let request: jest.SpyInstance, backup: jest.SpyInstance;
  let native: SubscriptionDiscoveryValidator;
  let events: string[];

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-source-selection-'));
    database = path.join(root, 'fixture.sqlite');
    prisma = new PrismaClient({
      datasources: { db: { url: `file:${database.replace(/\\/g, '/')}` } },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const directory of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, directory))).isDirectory())
        continue;
      const sql = await fs.readFile(
        path.join(migrations, directory, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
  }, 60000);

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: `file:${database.replace(/\\/g, '/')}`,
      WECHAT2RSS_ENABLED: '0',
      WECHAT2RSS_BASE_URL: 'http://127.0.0.1:18080/',
      WECHAT2RSS_TOKEN: 'synthetic-provider-token',
    };
    delete process.env.WEWE_ACCEPTANCE_MODE;
    delete process.env.PRIVATE_ONLINE_MODE;
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    await prisma.account.deleteMany();
    await fs.rm(path.join(root, '.wechat2rss-add'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, '.wechat2rss-subscription-tasks'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, '.wechat2rss-subscription-batches'), {
      recursive: true,
      force: true,
    });
    await prisma.account.create({
      data: {
        id: '123',
        name: '合成账号',
        token: 'synthetic-native',
        status: 1,
      },
    });
    events = [];
    backup = jest
      .spyOn(backups, 'createVerifiedSqliteBackup')
      .mockImplementation(async (options) => {
        events.push('backup');
        return realBackup(options);
      });
    native = {
      discover: jest.fn().mockResolvedValue({
        status: 'blocked',
        stage: 'directory',
        code: 'ATTEMPT_STOPPED',
      }),
      repairExisting: jest.fn(),
    };
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    request = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      events.push(url.pathname);
      if (url.origin !== 'http://127.0.0.1:18080')
        throw new Error('NETWORK_FORBIDDEN');
      if (url.pathname === '/login/list')
        return new Response(
          JSON.stringify({
            err: '',
            data: [{ available: true, needCheck: false }],
          }),
        );
      if (url.pathname === `/feed/${number}.json`)
        return new Response(JSON.stringify({ items: [] }));
      if (url.pathname === '/addurl')
        return new Response(
          JSON.stringify({
            err: '',
            data: `http://127.0.0.1:18080/feed/${number}.xml`,
          }),
        );
      if (url.pathname === '/list')
        return new Response(
          JSON.stringify({
            err: '',
            data: [
              {
                id: number,
                name: '合成公众号',
                link: `http://127.0.0.1:18080/feed/${number}.xml`,
              },
            ],
            meta: { total: 1 },
          }),
        );
      throw new Error('UNEXPECTED_SYNTHETIC_ROUTE');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-source-selection-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  function setup(discovery: SubscriptionDiscoveryValidator | null = native) {
    const service = new TrpcService(
      prisma as any,
      config,
      {} as any,
      new CollectionService(prisma as any),
      discovery || undefined,
    );
    const router = new TrpcRouter(
      service,
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    return {
      service,
      router,
      caller: router.appRouter.createCaller({ errorMsg: null, isLocal: true }),
    };
  }

  it('keeps the old default and reports both choices without HTTP, backup or secrets', async () => {
    const { caller } = setup();
    const result = await caller.feed.addCapability();
    expect(result).toMatchObject({
      source: 'native',
      available: true,
      requiresAccount: true,
      existingRepairAvailable: true,
    });
    expect(result.sources.map((s) => [s.source, s.available])).toEqual([
      ['native', true],
      ['wechat2rss', false],
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-provider-token|127\.0\.0\.1:18080|fixture\.sqlite/,
    );
    expect(request).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(native.discover).not.toHaveBeenCalled();
  });

  it('explicit paid choice cannot enable a disabled source or fall back to native', async () => {
    const { caller } = setup();
    expect(
      await caller.feed.addCapability({ source: 'wechat2rss' }),
    ).toMatchObject({
      available: false,
      requiresAccount: false,
      source: 'wechat2rss',
    });
    await expect(
      caller.feed.addFromArticle({
        articleUrl,
        source: 'wechat2rss',
        accountId: '123',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(request).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(native.discover).not.toHaveBeenCalled();
    expect(await prisma.feed.count()).toBe(0);
  });

  it('explicit paid choice bypasses registered native only after the existing config gate and backup', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const { caller } = setup();
    expect(
      await caller.feed.addCapability({ source: 'wechat2rss' }),
    ).toMatchObject({
      available: true,
      requiresAccount: false,
      code: 'SOURCE_CONFIGURED',
      existingRepairAvailable: true,
    });
    expect(request).not.toHaveBeenCalled();
    const result = await caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(result).toMatchObject({
      requestedSource: 'wechat2rss',
      sourceBindingChanged: true,
      accepted: true,
      pending: true,
      feed: { id: feedId, collectionChannel: 'wechat2rss' },
    });
    expect(events).toEqual([
      '/login/list',
      'backup',
      '/addurl',
      '/list',
      'backup',
      `/feed/${number}.xml`,
      '/list',
      `/feed/${number}.json`,
    ]);
    expect(native.discover).not.toHaveBeenCalled();
    expect(native.repairExisting).not.toHaveBeenCalled();
    expect(await prisma.article.count()).toBe(0);
    expect(await prisma.feed.count()).toBe(1);
  });

  it('choosing paid for an already-bound feed leaves all Feed/Article/account fields unchanged', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        mpCover: 'old-cover',
        mpIntro: 'old-intro',
        updateTime: 1700000000,
        syncTime: 1700000001,
        collectionChannel: 'owner-weread-latest',
        lastCollectionResult: 'synthetic-stop',
        providerRefreshAttemptTime: 1700000002,
      },
    });
    await prisma.article.create({
      data: {
        id: 'synthetic-old-short-id',
        mpId: feedId,
        title: '保留旧文',
        publishTime: 1700000000,
        picUrl: 'old-image',
        contentHtml: '<div id="js_content">旧正文</div>',
        readCount: 12,
        likeCount: 3,
      },
    });
    const read = async () => ({
      feeds: await prisma.feed.findMany(),
      articles: await prisma.article.findMany(),
      accounts: await prisma.account.findMany(),
    });
    const before = await read();
    const result = await setup().caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(result).toMatchObject({
      sourceBindingChanged: false,
      pending: false,
      status: 'source-preserved',
      feed: { collectionChannel: 'owner-weread-latest' },
    });
    expect(await read()).toEqual(before);
    expect(native.discover).not.toHaveBeenCalled();
    expect(native.repairExisting).not.toHaveBeenCalled();
  });

  it('explicit native and omitted choice retain native stop with paid enabled, without paid fallback', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const { caller } = setup();
    for (const source of [undefined, 'native'] as const) {
      const result = await caller.feed.addFromArticle({
        articleUrl,
        accountId: '123',
        source,
      });
      expect(result).toMatchObject({
        accepted: false,
        code: 'ATTEMPT_STOPPED',
      });
    }
    expect(native.discover).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(await prisma.feed.count()).toBe(0);
  });

  it.each([1, 0])(
    'repairs an unbound existing publisher through exact vendor identity without another add (status %s)',
    async (status) => {
      process.env.WECHAT2RSS_ENABLED = '1';
      const canonical = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=9&idx=1`;
      await prisma.feed.create({
        data: {
          id: feedId,
          mpName: '合成公众号',
          collectionChannel: null,
          status,
          syncTime: 1700000001,
          mpCover: '',
          mpIntro: '',
          updateTime: 1700000000,
        },
      });
      await prisma.article.create({
        data: {
          id: `WX_${number}_9_1`,
          mpId: feedId,
          title: '旧正文',
          publishTime: 1700000000,
          sourceUrl: canonical,
          contentHtml: '<div id="js_content">保留已编辑正文</div>',
          picUrl: 'old-image',
          readCount: 12,
          likeCount: 3,
        },
      });
      const before = await prisma.article.findMany();
      const result = await setup().caller.feed.addFromArticle({
        articleUrl: canonical,
        source: 'wechat2rss',
      });
      expect(result).toMatchObject({
        created: false,
        sourceBindingChanged: true,
        upstreamSubmitted: false,
        feed: { id: feedId, collectionChannel: 'wechat2rss', status },
        status: status === 1 ? 'pending' : 'blocked',
      });
      expect(events).not.toContain('/addurl');
      expect(events.some((x) => x.startsWith('/add/'))).toBe(false);
      expect(await prisma.article.findMany()).toEqual(before);
      expect(await prisma.feed.count()).toBe(1);
      expect(
        (await prisma.feed.findUniqueOrThrow({ where: { id: feedId } }))
          .syncTime,
      ).toBe(1700000001);
      if (status === 0) expect(events).not.toContain(`/feed/${number}.json`);
    },
  );

  it('preserves an album binding even when its explicit channel field is empty', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const canonical = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=9&idx=1`;
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        collectionChannel: null,
        publicAlbumIds: '123',
        mpCover: '',
        mpIntro: '',
        updateTime: 1700000000,
      },
    });
    await prisma.article.create({
      data: {
        id: `WX_${number}_9_1`,
        mpId: feedId,
        title: '旧文',
        publishTime: 1700000000,
        sourceUrl: canonical,
        picUrl: '',
      },
    });
    const old = await prisma.feed.findUniqueOrThrow({ where: { id: feedId } });
    expect(
      await setup().caller.feed.addFromArticle({
        articleUrl: canonical,
        source: 'wechat2rss',
      }),
    ).toMatchObject({
      status: 'source-preserved',
      sourceBindingChanged: false,
    });
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: feedId } }),
    ).toEqual(old);
    expect(request).not.toHaveBeenCalled();
  });

  it('continues a previously accepted link by binding its existing unbound feed and consuming cache without add replay', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        mpCover: 'old-cover',
        mpIntro: 'old-intro',
        updateTime: 1700000000,
        syncTime: 1700000001,
        collectionChannel: null,
      },
    });
    await prisma.article.create({
      data: {
        id: 'legacy-saved',
        mpId: feedId,
        title: '保留正文',
        picUrl: 'old-image',
        publishTime: 1700000000,
        contentHtml: '<div id="js_content">个人正文</div>',
        readCount: 12,
        likeCount: 3,
      },
    });
    const journal = await wechat2RssAddReceipt(database, articleUrl);
    await journal.accepted(`/feed/${number}.xml`);
    const before = await prisma.article.findUniqueOrThrow({
      where: { id: 'legacy-saved' },
    });
    const original = request.getMockImplementation()!;
    const canonical = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=99&idx=1`;
    request.mockImplementation(async (...args) =>
      new URL(String(args[0])).pathname === `/feed/${number}.json`
        ? new Response(
            JSON.stringify({
              items: [
                {
                  id: canonical,
                  title: '已核缓存',
                  date_published: '2026-10-01T12:00:00+08:00',
                  content_html: '<p>现有缓存完整正文</p>',
                },
              ],
            }),
          )
        : original(...args),
    );
    expect(
      await setup().caller.feed.addFromArticle({
        articleUrl,
        source: 'wechat2rss',
      }),
    ).toMatchObject({
      status: 'updated',
      created: false,
      sourceBindingChanged: true,
      upstreamSubmitted: false,
      feed: { id: feedId, collectionChannel: 'wechat2rss' },
      sync: { articles: 1, created: 1, updated: 0, accepted: false },
    });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: 'legacy-saved' } }),
    ).toEqual(before);
    expect(await prisma.feed.count()).toBe(1);
    expect(events).not.toContain('/addurl');
  });

  it('the protected account status reads only supplier account availability and never merges local accounts', async () => {
    const { caller, router } = setup();
    expect(await caller.account.wechat2rssStatus()).toMatchObject({
      configured: false,
      checkedAt: null,
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(request).not.toHaveBeenCalled();
    process.env.WECHAT2RSS_ENABLED = '1';
    const before = await prisma.account.findMany();
    expect(await caller.account.wechat2rssStatus()).toMatchObject({
      configured: true,
      available: true,
      challenged: false,
      code: 'AVAILABLE',
      checkedAt: expect.any(String),
    });
    expect(events).toEqual(['/login/list']);
    expect(await prisma.account.findMany()).toEqual(before);
    await expect(
      router.appRouter
        .createCaller({ errorMsg: '请先登录' })
        .account.wechat2rssStatus(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(events).toHaveLength(1);
  });

  it.each(['12分钟', 'synthetic-secret-token'])(
    'account status whitelists wait time without echoing supplier values (%s)',
    async (waitTime) => {
      process.env.WECHAT2RSS_ENABLED = '1';
      request.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              err: '',
              data: [
                {
                  available: false,
                  needCheck: true,
                  waitTime,
                  cookie: 'synthetic-cookie',
                  name: 'private-name',
                },
              ],
            }),
          ),
      );
      const result = await setup().caller.account.wechat2rssStatus();
      expect(result).toMatchObject({
        configured: true,
        available: false,
        challenged: true,
        code: 'ACCOUNT_CHALLENGED',
        checkedAt: expect.any(String),
      });
      expect(result.retryAfter).toBe(
        waitTime === '12分钟' ? waitTime : undefined,
      );
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-secret-token|synthetic-cookie|private-name/,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('account status reports a read failure without retrying or returning raw errors', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    request.mockRejectedValue(new Error('synthetic-private-error'));
    const result = await setup().caller.account.wechat2rssStatus();
    expect(result).toMatchObject({
      configured: true,
      available: false,
      code: 'STATUS_CHECK_FAILED',
      checkedAt: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-error');
    expect(request).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
  });

  it('explicit native without a registered adapter never falls back to configured paid', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const { caller: noNative } = setup(null);
    expect(
      await noNative.feed.addCapability({ source: 'native' }),
    ).toMatchObject({ available: false, code: 'NATIVE_SOURCE_UNAVAILABLE' });
    await expect(
      noNative.feed.addFromArticle({
        articleUrl,
        source: 'native',
        accountId: '123',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(request).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  it('retains the old paid default when native is absent and paid config is valid', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const { caller } = setup(null);
    expect(await caller.feed.addCapability()).toMatchObject({
      source: 'wechat2rss',
      available: true,
      requiresAccount: false,
      existingRepairAvailable: false,
    });
    const result = await caller.feed.addFromArticle({ articleUrl });
    expect(result).toMatchObject({
      requestedSource: 'wechat2rss',
      accepted: true,
      pending: true,
    });
    expect(events).toEqual([
      '/login/list',
      'backup',
      '/addurl',
      '/list',
      'backup',
      `/feed/${number}.xml`,
      '/list',
      `/feed/${number}.json`,
    ]);
  });

  it.each(['', 'https://example.com/', 'http://user:secret@127.0.0.1:18080/'])(
    'rejects enabled but invalid private config %s before calls, without leaking it',
    async (base) => {
      process.env.WECHAT2RSS_ENABLED = '1';
      process.env.WECHAT2RSS_BASE_URL = base;
      const { caller } = setup();
      const capability = await caller.feed.addCapability({
        source: 'wechat2rss',
      });
      expect(capability).toMatchObject({
        available: false,
        code: 'SOURCE_CONFIG_INVALID',
      });
      expect(JSON.stringify(capability)).not.toMatch(
        /example\.com|user:secret|synthetic-provider-token/,
      );
      await expect(
        caller.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(request).not.toHaveBeenCalled();
      expect(backup).not.toHaveBeenCalled();
      expect(native.discover).not.toHaveBeenCalled();
    },
  );

  it('backup failure prevents /addurl and preserves the empty database', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    backup.mockRejectedValueOnce(new Error('synthetic-backup-failure'));
    await expect(
      setup().caller.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
    ).resolves.toMatchObject({
      status: 'failed',
      accepted: false,
      code: 'ADD_FAILED',
    });
    expect(events).toEqual(['/login/list']);
    expect(await prisma.feed.count()).toBe(0);
    expect(native.discover).not.toHaveBeenCalled();
  });

  it('rejects a concurrent paid add before backup or upstream and releases its lock on completion', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const { caller } = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    backup.mockImplementationOnce(async (options) => {
      entered();
      await gate;
      return realBackup(options);
    });
    const first = caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    await started;
    try {
      await expect(
        caller.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // 不同文章可能属于同一公众号；上游响应之前不能按链接区分 Feed。
      await expect(
        caller.feed.addFromArticle({
          articleUrl: 'https://mp.weixin.qq.com/s/synthetic-other-article',
          source: 'wechat2rss',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(backup).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['/login/list']);
    } finally {
      release();
      await first;
    }
    expect(await prisma.feed.count()).toBe(1);
    const later = await caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(later).toMatchObject({ sourceBindingChanged: false });
    expect(native.discover).not.toHaveBeenCalled();
  });

  it('releases the paid add lock after backup or upstream failure without automatic replay', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const { caller } = setup();
    backup.mockRejectedValueOnce(new Error('synthetic-backup-failure'));
    await expect(
      caller.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
    ).resolves.toMatchObject({ status: 'failed', accepted: false });
    expect(events).toEqual(['/login/list']);
    request.mockRejectedValueOnce(
      new Error('synthetic-private-request-failure'),
    );
    await expect(
      caller.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
    ).resolves.toMatchObject({ status: 'failed', accepted: false });
    expect(request).toHaveBeenCalledTimes(2);
    expect(await prisma.feed.count()).toBe(0);
    const later = await caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(later).toMatchObject({ sourceBindingChanged: true });
    expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
    expect(native.discover).not.toHaveBeenCalled();
  });

  it('paid rejection is a paid failure, never a native attempt or local successful binding', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ err: 'synthetic-provider-token-rejected', data: [] }),
      ),
    );
    await expect(
      setup().caller.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
    ).resolves.toMatchObject({
      status: 'failed',
      accepted: false,
      code: 'ADD_FAILED',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(native.discover).not.toHaveBeenCalled();
    expect(await prisma.feed.count()).toBe(0);
  });

  it('rejects authentication parameters and non-official URLs before backup or either source', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const { caller } = setup();
    for (const url of [
      articleUrl + '?pass_ticket=synthetic',
      'https://example.com/s/x',
    ])
      await expect(
        caller.feed.addFromArticle({ articleUrl: url, source: 'wechat2rss' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(request).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(native.discover).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous legacy item isolated and never reports full cache readiness or submits another add', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const canonical = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=9&idx=1`;
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
        collectionChannel: 'wechat2rss',
      },
    });
    const old = await prisma.article.create({
      data: {
        id: 'legacy-unverified',
        mpId: feedId,
        title: 'Sanitized legacy collision',
        publishTime: 1790827200,
        picUrl: '',
        contentHtml: '<p>Keep old note</p>',
      },
    });
    const journal = await wechat2RssAddReceipt(database, canonical);
    await journal.accepted(`/feed/${number}.xml`);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) =>
      new URL(String(args[0])).pathname === `/feed/${number}.json`
        ? new Response(
            JSON.stringify({
              items: [
                {
                  id: canonical,
                  title: old.title,
                  date_published: new Date(
                    old.publishTime * 1000,
                  ).toISOString(),
                  content_html: '<p>Cache</p>',
                },
              ],
            }),
          )
        : original(...args),
    );
    const result = await setup().caller.feed.addFromArticle({
      articleUrl: canonical,
      source: 'wechat2rss',
    });
    expect(result).toMatchObject({
      status: 'pending',
      code: 'LEGACY_IDENTITY_UNVERIFIED',
      upstreamSubmitted: false,
      sync: { articles: 0, identitySkipped: 1, bodyReady: false },
    });
    expect(
      events.filter(
        (event) => event === '/addurl' || event.startsWith('/add/'),
      ),
    ).toEqual([]);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
  });

  it('new subscription imports a ready cache then duplicates and restart only read it', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const original = request.getMockImplementation()!;
    const canonical = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=9&idx=1`;
    request.mockImplementation(async (...args) =>
      new URL(String(args[0])).pathname === `/feed/${number}.json`
        ? new Response(
            JSON.stringify({
              items: [
                {
                  id: canonical,
                  title: '合成完整正文',
                  date_published: '2026-10-01T12:00:00+08:00',
                  content_html: '<p>合成完整正文与段落</p>',
                },
              ],
            }),
          )
        : original(...args),
    );
    const first = await setup().caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(first).toMatchObject({
      status: 'updated',
      created: true,
      pending: false,
      upstreamSubmitted: true,
      feed: { collectionChannel: 'wechat2rss' },
      sync: {
        articles: 1,
        created: 1,
        accepted: false,
        bodyMissing: 0,
        imageBlocked: 0,
      },
    });
    expect(await prisma.article.count()).toBe(1);
    const old = await prisma.article.findMany();
    const second = await setup().caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(second).toMatchObject({
      status: 'updated',
      created: false,
      pending: false,
      upstreamSubmitted: false,
      sync: { created: 0, updated: 0 },
    });
    expect(await prisma.article.findMany()).toEqual(old);
    expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
    expect(events.some((x) => x.startsWith('/add/'))).toBe(false);
    const known = await setup().caller.feed.addFromArticle({
      articleUrl: canonical,
      source: 'wechat2rss',
    });
    expect(known).toMatchObject({
      status: 'updated',
      created: false,
      upstreamSubmitted: false,
    });
    expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
  });

  it('empty first cache preserves the new subscription without advancing successful sync time', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const result = await setup().caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(result).toMatchObject({
      status: 'pending',
      accepted: true,
      pending: true,
      created: true,
      feed: { syncTime: 0 },
      sync: { articles: 0, accepted: false },
    });
    expect(await prisma.feed.count()).toBe(1);
    expect(await prisma.article.count()).toBe(0);
  });

  it('one original submission establishes a delayed identity without a second user submission', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const original = request.getMockImplementation()!;
    const originalTimeout = global.setTimeout;
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((
        handler: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        originalTimeout(
          handler,
          delay === 3000 || delay === 27000 ? 0 : delay,
          ...args,
        )) as typeof setTimeout);
    let reads = 0;
    request.mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === '/list' && reads++ < 2) {
        events.push('/list');
        return new Response(
          JSON.stringify({ err: '', data: [], meta: { total: 0 } }),
        );
      }
      return original(...args);
    });
    const result = await setup().caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(result).toMatchObject({
      accepted: true,
      created: true,
      feed: { id: feedId },
      status: 'pending',
      upstreamSubmitted: true,
      sync: { articles: 0 },
    });
    expect(await prisma.feed.count()).toBe(1);
    expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
    expect(events.some((x) => x.startsWith('/add/'))).toBe(false);
  });

  it('stops an accepted identity wait on new account restrictions without another list or add', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const original = request.getMockImplementation()!;
    const originalTimeout = global.setTimeout;
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((
        handler: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        originalTimeout(
          handler,
          delay === 3000 || delay === 27000 ? 0 : delay,
          ...args,
        )) as typeof setTimeout);
    let accounts = 0;
    request.mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === '/login/list' && accounts++ > 0) {
        events.push(path);
        return new Response(
          JSON.stringify({
            err: '',
            data: [{ available: true, needCheck: true }],
          }),
        );
      }
      if (path === '/list') {
        events.push(path);
        return new Response(
          JSON.stringify({ err: '', data: [], meta: { total: 0 } }),
        );
      }
      return original(...args);
    });
    const result = await setup().caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(result).toMatchObject({
      status: 'blocked',
      accepted: true,
      created: false,
      feed: null,
      upstreamSubmitted: true,
      code: 'ACCOUNT_UNAVAILABLE_DURING_IDENTITY_CHECK',
    });
    expect(await prisma.feed.count()).toBe(0);
    expect(events.filter((x) => x === '/list')).toHaveLength(1);
    expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
  });

  it('accepted identity pending resumes /list without replaying /addurl', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const original = request.getMockImplementation()!;
    let phase = 0;
    const originalTimeout = global.setTimeout;
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((
        handler: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        originalTimeout(
          handler,
          delay === 3000 || delay === 27000 ? 0 : delay,
          ...args,
        )) as typeof setTimeout);
    request.mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === '/list') {
        const current = phase;
        if (current < 2)
          return new Response(
            JSON.stringify({
              err: '',
              data:
                current === 0
                  ? []
                  : [
                      {
                        id: feedId.slice(7),
                        name: ' ',
                        link: `http://127.0.0.1:18080/feed/${number}.xml`,
                      },
                    ],
              meta: { total: current === 0 ? 0 : 1 },
            }),
          );
      }
      return original(...args);
    });
    expect(
      await setup().caller.feed.addFromArticle({
        articleUrl,
        source: 'wechat2rss',
      }),
    ).toMatchObject({
      accepted: true,
      status: 'pending',
      feed: null,
      code: 'SUBSCRIPTION_ID_PENDING',
      message:
        '请求已受理，正在自动等待订阅和文章；关闭弹窗后仍会继续，完成后列表会自动更新。',
    });
    expect(await prisma.feed.count()).toBe(0);
    phase++;
    expect(
      await setup().caller.feed.addFromArticle({
        articleUrl,
        source: 'wechat2rss',
      }),
    ).toMatchObject({
      status: 'pending',
      feed: null,
      code: 'SUBSCRIPTION_ID_PENDING',
      message:
        '请求已受理，正在自动等待订阅和文章；关闭弹窗后仍会继续，完成后列表会自动更新。',
      upstreamSubmitted: false,
    });
    expect(await prisma.feed.count()).toBe(0);
    phase++;
    expect(
      await setup().caller.feed.addFromArticle({
        articleUrl,
        source: 'wechat2rss',
      }),
    ).toMatchObject({
      accepted: true,
      status: 'pending',
      created: true,
      upstreamSubmitted: false,
      feed: { id: feedId },
    });
    expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
  });

  it('one accepted request automatically binds and imports cache across restart without another add', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest
      .spyOn(Wechat2RssProvider.prototype, 'waitForAcceptedSubscription')
      .mockResolvedValue(null);
    const original = request.getMockImplementation()!;
    let ready = false;
    const canonical = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=9&idx=1`;
    request.mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === `/feed/${number}.json`)
        return new Response(
          JSON.stringify({
            items: ready
              ? [
                  {
                    id: canonical,
                    title: '自动接续正文',
                    date_published: '2026-10-09T12:00:00+08:00',
                    content_html:
                      '<div id="js_content"><p>合成完整正文。</p></div>',
                  },
                ]
              : [],
          }),
        );
      return original(...args);
    });
    const first = setup();
    const accepted = await first.caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(accepted).toMatchObject({
      accepted: true,
      feed: null,
      taskId: expect.any(String),
    });
    const taskId = (accepted as any).taskId;
    first.service.onModuleDestroy(); // A server restart preserves the accepted task.
    const restarted = setup();
    const tasks = (restarted.service as any).subscriptionTasks;
    await tasks.init();
    try {
      clock += 30000;
      await tasks.runDue();
      expect(
        await restarted.caller.feed.subscriptionTask({ taskId }),
      ).toMatchObject({ state: 'pending', phase: 'cache', feedId });
      expect(await prisma.feed.count()).toBe(1);
      expect(await prisma.article.count()).toBe(0);
      ready = true;
      clock += 30000;
      await tasks.runDue();
      expect(
        await restarted.caller.feed.subscriptionTask({ taskId }),
      ).toMatchObject({ state: 'succeeded', feedId });
      expect(await prisma.article.count()).toBe(1);
      const snapshot = await prisma.article.findMany();
      clock += 30000;
      await tasks.runDue();
      expect(await prisma.article.findMany()).toEqual(snapshot);
      expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
      expect(events.some((x) => x.startsWith('/add/'))).toBe(false);
    } finally {
      restarted.service.onModuleDestroy();
    }
  });

  it('persists a complete batch and stages trusted numeric IDs without waiting for names or media', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const ids = [number, '3456789013'];
    const links = [articleUrl, 'https://mp.weixin.qq.com/s/' + 'b'.repeat(22)];
    let namesReady = false;
    const avatar = 'https://wx.qlogo.cn/mmhead/synthetic-publisher/0';
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, ...rest) => {
      const url = new URL(String(input));
      if (url.pathname === '/addurl') {
        events.push('/addurl');
        const index = links.indexOf(url.searchParams.get('url')!);
        if (index < 0) throw new Error('UNREQUESTED_LINK');
        return new Response(
          JSON.stringify({
            err: '',
            data: `http://127.0.0.1:18080/feed/${ids[index]}.xml`,
          }),
        );
      }
      if (url.pathname === '/list') {
        events.push('/list');
        return new Response(
          JSON.stringify({
            err: '',
            data: ids.map((id, i) => ({
              id,
              name: namesReady ? `合成号${i}` : '',
              link: `http://127.0.0.1:18080/feed/${id}.xml`,
            })),
            meta: { total: 2 },
          }),
        );
      }
      const match = /^\/feed\/(\d+)\.json$/.exec(url.pathname);
      if (namesReady && /^\/feed\/\d+\.xml$/.test(url.pathname)) {
        events.push(url.pathname);
        return new Response(
          `<rss><channel><image><url>${avatar}</url></image></channel></rss>`,
        );
      }
      if (match) {
        events.push(url.pathname);
        const canonical = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(match[1]).toString('base64')}&mid=9&idx=1`;
        return new Response(
          JSON.stringify({
            items: [
              {
                id: canonical,
                title: `合成文章${match[1]}`,
                date_published: '2026-10-09T12:00:00+08:00',
                content_html:
                  '<div id="js_content"><p>真实字段合成完整正文。</p></div>',
              },
            ],
          }),
        );
      }
      return original(input, ...rest);
    });
    const first = setup();
    const batch = await first.caller.feed.addSubscriptionBatch({
      articleUrls: links,
    });
    expect(events).toEqual([]);
    const batches = (first.service as any).subscriptionBatches;
    await batches.runDue();
    expect(
      await prisma.feed.findUnique({ where: { id: feedId } }),
    ).toMatchObject({
      mpName: '',
      collectionChannel: 'wechat2rss',
      syncTime: 0,
    });
    expect(await prisma.article.findFirst()).toBeNull();
    expect(events.some((event) => /\/feed\/\d+\.json$/.test(event))).toBe(
      false,
    );
    expect(events.filter((e) => e === '/list')).toHaveLength(0);
    expect(events.filter((e) => e === '/addurl')).toHaveLength(1);
    expect(
      (await first.caller.feed.subscriptionBatches()).items[0],
    ).toMatchObject({
      batchId: batch.batchId,
      items: [{ state: 'waiting', feedId }, { state: 'queued' }],
    });
    first.service.onModuleDestroy();
    const next = setup();
    const tasks = (next.service as any).subscriptionTasks;
    const queue = (next.service as any).subscriptionBatches;
    clock += 5000;
    await queue.runDue();
    expect(events.filter((event) => event === '/addurl')).toHaveLength(2);
    expect(await prisma.article.count()).toBe(0);
    clock += 30000;
    await tasks.runDue();
    await queue.runDue();
    expect(await prisma.article.findFirst()).toMatchObject({
      lastBodyStatus: 'available',
    });
    expect(
      (await next.caller.feed.subscriptionTasks()).items.find(
        (task) => task.feedId === feedId,
      ),
    ).toMatchObject({ phase: 'metadata', bodyReady: true });
    // A pending display name does not hold up a different authorized URL.
    await queue.runDue();
    expect(events.filter((e) => e === '/addurl')).toHaveLength(2);
    clock += 30000;
    await tasks.runDue();
    await queue.runDue();
    expect(await prisma.feed.count()).toBe(2);
    expect(await prisma.article.count()).toBe(2);
    namesReady = true;
    const keptAvatar = 'https://wx.qlogo.cn/mmhead/existing-owned-avatar/0';
    await prisma.feed.update({
      where: { id: `MP_WXS_${ids[1]}` },
      data: { mpCover: keptAvatar },
    });
    clock += 30000;
    await tasks.runDue();
    clock += 30000;
    await tasks.runDue();
    expect(
      (await prisma.feed.findMany()).every((f) =>
        f.mpName.startsWith('合成号'),
      ),
    ).toBe(true);
    expect(events.filter((e) => e === '/addurl')).toHaveLength(2);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: feedId } })).mpCover,
    ).toBe(avatar);
    expect(
      (
        await prisma.feed.findUniqueOrThrow({
          where: { id: `MP_WXS_${ids[1]}` },
        })
      ).mpCover,
    ).toBe(keptAvatar);
    expect(events.some((e) => e.startsWith('/add/'))).toBe(false);
    next.service.onModuleDestroy();
  });

  it('an uncertain batch submission pauses remaining links and restart cannot replay addurl', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, ...rest) => {
      if (new URL(String(input)).pathname === '/addurl') {
        events.push('/addurl');
        throw Error('private-error');
      }
      return original(input, ...rest);
    });
    const first = setup();
    const batch = await first.caller.feed.addSubscriptionBatch({
      articleUrls: [articleUrl, 'https://mp.weixin.qq.com/s/' + 'b'.repeat(22)],
    });
    await (first.service as any).subscriptionBatches.runDue();
    first.service.onModuleDestroy();
    const second = setup();
    await second.caller.feed.resumeSubscriptionBatch({
      batchId: batch.batchId,
    });
    clock += 30000;
    await (second.service as any).subscriptionBatches.runDue();
    expect(
      (await second.caller.feed.subscriptionBatches()).items[0],
    ).toMatchObject({
      state: 'paused',
      items: [{ state: 'failed' }, { state: 'queued' }],
    });
    expect(events.filter((e) => e === '/addurl')).toHaveLength(1);
    second.service.onModuleDestroy();
  });
  it('single-download intent may subscribe upstream without changing another saved local source', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        mpCover: '',
        mpIntro: '',
        collectionChannel: 'owner-web-search',
        updateTime: 1700000000,
      },
    });
    await prisma.article.create({
      data: {
        id: 'WX_' + number + '_1_1',
        mpId: feedId,
        title: '旧笔记',
        publishTime: 1700000000,
        sourceUrl: articleUrl,
        contentHtml: '<p>保留私人编辑</p>',
        picUrl: '',
      },
    });
    const old = await prisma.article.findMany();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, ...rest) =>
      new URL(String(input)).pathname === '/list'
        ? new Response(
            JSON.stringify({ err: '', data: [], meta: { total: 0 } }),
          )
        : original(input, ...rest),
    );
    const { service } = setup();
    const batch = await service.addSingleDownloadBatch([articleUrl]);
    await (service as any).subscriptionBatches.runDue();
    expect((await service.subscriptionBatchList())[0]).toMatchObject({
      batchId: batch.batchId,
      state: 'completed',
      items: [{ state: 'succeeded', feedId }],
    });
    expect(events.filter((x) => x === '/addurl')).toHaveLength(1);
    expect(
      await prisma.feed.findUnique({ where: { id: feedId } }),
    ).toMatchObject({
      collectionChannel: 'owner-web-search',
      mpName: '合成公众号',
    });
    expect(await prisma.article.findMany()).toEqual(old);
    service.onModuleDestroy();
  });

  it('uncertain /addurl response stays pending across restart with no replay or raw error', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    const original = request.getMockImplementation()!;
    let adds = 0;
    request.mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === '/addurl') {
        adds++;
        throw Error('synthetic-token-secret');
      }
      return original(...args);
    });
    const first = await setup().caller.feed.addFromArticle({
      articleUrl,
      source: 'wechat2rss',
    });
    expect(first).toMatchObject({
      status: 'failed',
      accepted: false,
      upstreamSubmitted: true,
      feed: null,
    });
    expect(JSON.stringify(first)).not.toContain('synthetic-token-secret');
    expect(
      await setup().caller.feed.addFromArticle({
        articleUrl,
        source: 'wechat2rss',
      }),
    ).toMatchObject({
      status: 'pending',
      accepted: false,
      upstreamSubmitted: false,
      code: 'ADD_RESULT_UNCONFIRMED',
    });
    expect(adds).toBe(1);
    expect(await prisma.feed.count()).toBe(0);
  });

  it('reports missing image sources without claiming a complete body sync or checking login', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        mpCover: '',
        mpIntro: '',
        collectionChannel: 'wechat2rss',
        updateTime: 0,
        syncTime: 1700000000,
      },
    });
    const journal = await wechat2RssAddReceipt(database, articleUrl);
    await journal.claim();
    await journal.accepted(`/feed/${number}.xml`);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, ...rest) => {
      const route = new URL(String(input)).pathname;
      if (route === '/login/list') throw Error('LOGIN_MUST_NOT_GATE_CACHE');
      if (route === `/feed/${number}.json`)
        return new Response(
          JSON.stringify({
            items: [
              {
                url: `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=101&idx=1`,
                title: '已核正文',
                date_published: new Date(1700001000000).toISOString(),
                content_html: '<p>已核正文</p><img class="rich_pages wxw-img">',
              },
            ],
          }),
        );
      return original(input, ...rest);
    });
    const { service } = setup();
    const saved = await (service as any).subscriptionTasks.enqueue({
      articleUrl,
      feedPath: `/feed/${number}.xml`,
      feedId,
      phase: 'cache',
    });
    const task = JSON.parse(
      await fs.readFile(
        path.join(
          root,
          '.wechat2rss-subscription-tasks',
          saved.taskId + '.json',
        ),
        'utf8',
      ),
    );
    const result = await (service as any).continueAcceptedSubscription(task);
    expect(result).toMatchObject({
      state: 'succeeded',
      code: 'CACHE_IMAGES_PENDING',
      bodyReady: false,
      imagePendingCount: 1,
      feedId,
    });
    expect(result.message).toContain('媒体完整性未确认');
    expect(result.message).toContain('正文和有效图片可保存');
    expect(result.message).not.toContain('完整离线保存尚未就绪');
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: feedId } })).syncTime,
    ).toBe(1700000000);
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: `WX_${number}_101_1` },
        })
      ).contentHtml,
    ).toContain('已核正文');
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: `WX_${number}_101_1` },
        })
      ).lastBodyStatus,
    ).toBe('images-pending');
    expect(events).not.toContain('/addurl');
    service.onModuleDestroy();
  });

  it('accepted cache continuation isolates one legacy identity without pausing proved articles or checking login', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        mpCover: '',
        mpIntro: '',
        collectionChannel: 'wechat2rss',
        updateTime: 0,
      },
    });
    const old = await prisma.article.create({
      data: {
        id: 'unproved-old-short-id',
        mpId: feedId,
        title: '旧正文标题',
        publishTime: 1700000000,
        sourceUrl: articleUrl,
        contentHtml: '<p>保留用户修改</p>',
        picUrl: '',
        metrics: '{"readCount":42}',
      },
    });
    const journal = await wechat2RssAddReceipt(database, articleUrl);
    await journal.claim();
    await journal.accepted(`/feed/${number}.xml`);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, ...rest) => {
      const route = new URL(String(input)).pathname;
      if (route === '/login/list')
        throw Error('LOGIN_MUST_NOT_GATE_ACCEPTED_CACHE');
      if (route === `/feed/${number}.json`) {
        events.push(route);
        return new Response(
          JSON.stringify({
            items: [
              {
                url: `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=100&idx=1`,
                title: '旧正文标题',
                date_published: new Date(1700000000000).toISOString(),
                content_html: '<p>供应商旧正文</p>',
              },
              {
                url: `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=101&idx=1`,
                title: '已核新正文',
                date_published: new Date(1700001000000).toISOString(),
                content_html: '<p>供应商新正文</p>',
              },
            ],
          }),
        );
      }
      return original(input, ...rest);
    });
    const { service } = setup();
    const saved = await (service as any).subscriptionTasks.enqueue({
      articleUrl,
      feedPath: `/feed/${number}.xml`,
      feedId,
      phase: 'cache',
    });
    const task = JSON.parse(
      await fs.readFile(
        path.join(
          root,
          '.wechat2rss-subscription-tasks',
          saved.taskId + '.json',
        ),
        'utf8',
      ),
    );
    const result = await (service as any).continueAcceptedSubscription(task);
    expect(result).toMatchObject({
      state: 'succeeded',
      code: 'LEGACY_IDENTITY_UNVERIFIED',
      feedId,
      listReady: true,
      bodyReady: false,
    });
    expect(await prisma.article.findUnique({ where: { id: old.id } })).toEqual(
      old,
    );
    expect(
      await prisma.article.findUnique({ where: { id: `WX_${number}_101_1` } }),
    ).toMatchObject({ contentHtml: expect.stringContaining('供应商新正文') });
    expect(events).not.toContain('/login/list');
    expect(events).not.toContain('/addurl');
    service.onModuleDestroy();
  });

  it('a disabled local subscription remains blocked for its own reason with no cache or login reads', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: '合成公众号',
        mpCover: '',
        mpIntro: '',
        collectionChannel: 'wechat2rss',
        updateTime: 0,
        status: 0,
      },
    });
    const journal = await wechat2RssAddReceipt(database, articleUrl);
    await journal.claim();
    await journal.accepted(`/feed/${number}.xml`);
    const { service } = setup();
    const saved = await (service as any).subscriptionTasks.enqueue({
      articleUrl,
      feedPath: `/feed/${number}.xml`,
      feedId,
      phase: 'cache',
    });
    const task = JSON.parse(
      await fs.readFile(
        path.join(
          root,
          '.wechat2rss-subscription-tasks',
          saved.taskId + '.json',
        ),
        'utf8',
      ),
    );
    expect(
      await (service as any).continueAcceptedSubscription(task),
    ).toMatchObject({ state: 'blocked', code: 'SUBSCRIPTION_PAUSED' });
    expect(events).toEqual(['backup']);
    service.onModuleDestroy();
  });

  it('account challenge stops before backup, /addurl, list or new feed', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    request.mockResolvedValue(
      new Response(
        JSON.stringify({
          err: '',
          data: [{ available: false, needCheck: true }],
        }),
      ),
    );
    expect(
      await setup().caller.feed.addFromArticle({
        articleUrl,
        source: 'wechat2rss',
      }),
    ).toMatchObject({
      status: 'blocked',
      code: 'ACCOUNT_CHALLENGED',
      accepted: false,
      feed: null,
    });
    expect(backup).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await prisma.feed.count()).toBe(0);
  });

  it('rejects unsupported sources and unauthenticated capability/mutation before either source', async () => {
    const { caller, router } = setup();
    await expect(
      caller.feed.addCapability({ source: 'arbitrary-url' as any }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.feed.addFromArticle({
        articleUrl,
        source: 'arbitrary-url' as any,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const anonymous = router.appRouter.createCaller({ errorMsg: '请先登录' });
    await expect(
      anonymous.feed.addCapability({ source: 'wechat2rss' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      anonymous.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(request).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(native.discover).not.toHaveBeenCalled();
  });
});
