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
      {} as any,
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
    expect(events).toEqual(['backup', '/addurl', '/list']);
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
      pending: true,
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
    expect(events).toEqual(['backup', '/addurl', '/list']);
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

  it('backup failure prevents paid requests and preserves the empty database', async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    backup.mockRejectedValueOnce(new Error('synthetic-backup-failure'));
    await expect(
      setup().caller.feed.addFromArticle({ articleUrl, source: 'wechat2rss' }),
    ).rejects.toThrow('synthetic-backup-failure');
    expect(request).not.toHaveBeenCalled();
    expect(await prisma.feed.count()).toBe(0);
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
    ).rejects.toThrow('WECHAT2RSS_UPSTREAM_REJECTED');
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
