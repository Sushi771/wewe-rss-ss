import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { Test, TestingModule } from '@nestjs/testing';
import { FeedsService } from './feeds.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcService } from '../trpc/trpc.service';
import { INestApplication } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FeedsController } from './feeds.controller';
import { startupAuditHttpGuard } from '../startup-audit';
import * as backup from '../collection/sqlite-backup';
import { canonicalArticleUrl } from '../collection/collection-format';
import { CollectionService } from '../collection/collection.service';
import { ProviderPage } from '../collection/subscription-provider';
import { findArticleListRows } from '../article-list-page';
import { noisePng } from '../../test/fixtures/cache-noise-png';

describe('FeedsService', () => {
  let service: FeedsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: {} },
        { provide: TrpcService, useValue: {} },
      ],
    }).compile();

    service = module.get<FeedsService>(FeedsService);
  });

  it('uses imported full text without requesting WeChat', async () => {
    const fetch = jest.spyOn(service, 'getHtmlByUrl');
    expect(
      await service.tryGetContent(
        'id',
        'https://mp.weixin.qq.com/s?id=1',
        '<p>本地正文</p>',
      ),
    ).toBe('<p>本地正文</p>');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('startup and RSS summary with the shared SQLite connection', () => {
  const original = { ...process.env };
  const feedId = 'MP_WXS_3895431412';
  let root: string;
  let prisma: PrismaService;
  let application: INestApplication;
  let service: FeedsService;
  let base: string;
  let finishCatchup: () => void;
  let html: jest.SpyInstance;
  let articleReads: any[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-rss-readiness-'));
    Object.assign(process.env, {
      DATABASE_URL:
        'file:' + path.join(root, 'synthetic.db') + '?connection_limit=1',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
      WECHAT2RSS_ENABLED: '1',
      WECHAT2RSS_DAILY_CATCHUP: '1',
      WECHAT2RSS_ACTIVE_SCHEDULE: '0',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
      SCHEDULED_MP_IDS: feedId,
      CRON_EXPRESSION: '15 9 * * *',
    });
    prisma = new PrismaService();
    articleReads = [];
    prisma.$use(async (params, next) => {
      if (params.model === 'Article' && params.action === 'findMany')
        articleReads.push(params.args);
      return next(params);
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const sql = await fs
        .readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: 'Synthetic feed',
        mpCover: '',
        mpIntro: '',
        updateTime: 1,
      },
    });
    for (let i = 0; i < 20; i++)
      await prisma.article.create({
        data: {
          id: `synthetic-${i}`,
          mpId: feedId,
          title: `Synthetic ${i}`,
          picUrl: '',
          publishTime: 1700000000 + i,
          contentHtml: '<p>' + 'synthetic body '.repeat(512) + '</p>',
        },
      });
    jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('RSS_READINESS_MUST_NOT_CREATE_BACKUP'));
    const module = await Test.createTestingModule({
      controllers: [FeedsController],
      providers: [
        FeedsService,
        { provide: PrismaService, useValue: prisma },
        { provide: TrpcService, useValue: {} },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            feed: { originUrl: 'http://127.0.0.1', mode: 'fulltext' },
          }),
        },
      ],
    }).compile();
    service = module.get(FeedsService);
    html = jest
      .spyOn(service, 'getHtmlByUrl')
      .mockRejectedValue(new Error('RSS_SUMMARY_MUST_NOT_FETCH_UPSTREAM'));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const catchup = new Promise<void>((resolve) => {
      finishCatchup = resolve;
    });
    jest
      .spyOn(service, 'catchUpDailyWechat2Rss')
      .mockImplementation(async () => {
        entered();
        await catchup;
      });
    application = module.createNestApplication();
    application.use(startupAuditHttpGuard);
    // The release gate fetches the shell; it does not run browser JavaScript.
    application
      .getHttpAdapter()
      .get('/dash', (_req, res) => res.send('synthetic shell'));
    await application.listen(0, '127.0.0.1');
    base = 'http://127.0.0.1:' + application.getHttpServer().address().port;
    await started;
  }, 30000);

  afterEach(async () => {
    finishCatchup?.();
    await application?.close();
    await prisma?.$disconnect();
    jest.restoreAllMocks();
    process.env = { ...original };
    if (root) {
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^wewe-rss-readiness-/);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function statusAndShell() {
    const status = await fetch(base + '/startup-status');
    expect(status.status).toBe(200);
    expect((await status.json()).writesAllowed).toBe(true);
    const dash = await fetch(base + '/dash');
    expect(dash.status).toBe(200);
    await dash.text();
  }
  async function rss(timeout = 2500) {
    const readsBefore = articleReads.length;
    const result = await fetch(
      base + `/feeds/${feedId}.rss?limit=20&mode=summary`,
      {
        signal: AbortSignal.timeout(timeout),
      },
    );
    expect(result.status).toBe(200);
    const xml = await result.text();
    expect((xml.match(/<item>/g) || []).length).toBe(20);
    expect(xml).not.toContain('synthetic body');
    expect(
      articleReads.slice(readsBefore).map((row) => row.select),
    ).toContainEqual({
      id: true,
      title: true,
      publishTime: true,
      picUrl: true,
      mpId: true,
      sourceUrl: true,
      lastBodyStatus: true,
    });
  }

  it('bootstrap does not await pending catchup and summary RSS returns 20 without upstream or backup', async () => {
    await statusAndShell();
    await rss();
    expect(html).not.toHaveBeenCalled();
    expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });

  it('ready and dash200 cannot conceal an occupied connection; RSS still must pass after it drains', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT 1');
        entered();
        await held;
        await tx.feed.update({
          where: { id: feedId },
          data: { mpIntro: 'completed synthetic work' },
        });
      },
      { timeout: 5000 },
    );
    try {
      await started;
      await statusAndShell();
      await expect(rss(100)).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      release();
      await transaction;
    }
    await rss();
    expect(html).not.toHaveBeenCalled();
    expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
  it('summary RSS and uncached list stay within 2.5s during the real full cache preflight', async () => {
    await prisma.feed.update({
      where: { id: feedId },
      data: { collectionChannel: 'wechat2rss' },
    });
    const inline = 'data:image/png;base64,' + noisePng().toString('base64');
    const body =
      '<div id="js_content">synthetic body' +
      `<img src="${inline}">`.repeat(60) +
      '</div>';
    await prisma.article.deleteMany({ where: { mpId: feedId } });
    const articles: ProviderPage['articles'] = [];
    for (let n = 0; n < 25; n++) {
      const identity = canonicalArticleUrl(
        `https://mp.weixin.qq.com/s?__biz=${Buffer.from(feedId.slice(7)).toString('base64')}&mid=${100 + n}&idx=1`,
      );
      const article = {
        ...identity,
        title: 'Synthetic ' + n,
        picUrl: '',
        publishTime: 1760000000 + n,
        contentHtml: body,
      };
      articles.push(article);
      await prisma.article.create({
        data: {
          id: article.id,
          mpId: feedId,
          title: article.title,
          picUrl: '',
          publishTime: article.publishTime,
          sourceUrl: article.url,
          verifiedSourceUrl: article.url,
          contentHtml: body,
          lastBodyStatus: 'available',
        },
      });
    }
    const backend = new TrpcService(
      prisma,
      new ConfigService({
        platform: { url: '' },
        feed: { updateDelayTime: 0 },
      }),
      {} as any,
      new CollectionService(prisma),
    );
    const page: ProviderPage = {
      articles,
      coverage: 'recent-window',
      upstreamCount: 25,
      bodyMissing: 0,
      imageBlocked: 0,
    };
    const samples: Array<{
      preflightMs: number;
      rssMs: number;
      listMs: number;
    }> = [];
    let enter: (() => void) | undefined;
    prisma.$use(async (params, next) => {
      if (enter && params.action === 'queryRaw') {
        const ready = enter;
        enter = undefined;
        ready();
      }
      return next(params);
    });
    try {
      for (let n = 0; n < 5; n++) {
        const running = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const began = performance.now();
        const background = backend
          .syncCachedWechat2RssPage(feedId, page, false, { fetchMedia: false })
          .then((result) => ({ result, ms: performance.now() - began }));
        await running;
        await new Promise((resolve) => setImmediate(resolve));
        const rssAt = performance.now(),
          listAt = performance.now();
        const [flags, rssMs, list] = await Promise.all([
          background,
          rss().then(() => performance.now() - rssAt),
          findArticleListRows(prisma, {
            take: 20,
            orderBy: [{ publishTime: 'desc' }, { id: 'desc' }],
          }).then((rows) => ({ rows, ms: performance.now() - listAt })),
        ]);
        expect(flags.result).toMatchObject({
          created: 0,
          updated: 0,
          mediaReady: true,
          localMediaPendingArticleCount: 0,
        });
        expect(list.rows).toHaveLength(20);
        expect(list.rows.every((row) => row.bodyCached)).toBe(true);
        expect(rssMs).toBeLessThan(2500);
        expect(list.ms).toBeLessThan(2500);
        samples.push({ preflightMs: flags.ms, rssMs, listMs: list.ms });
      }
      expect(html).not.toHaveBeenCalled();
      expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
      if (process.env.CACHE_PREFLIGHT_MEASURE === '1') {
        const percentile = (
          field: keyof (typeof samples)[number],
          part: number,
        ) =>
          samples.map((row) => row[field]).sort((a, b) => a - b)[
            Math.ceil(samples.length * part) - 1
          ];
        const summary = Object.fromEntries(
          (['preflightMs', 'rssMs', 'listMs'] as const).map((field) => [
            field,
            {
              n: samples.length,
              p50: percentile(field, 0.5),
              p95: percentile(field, 0.95),
            },
          ]),
        );
        const output = path.resolve(
          __dirname,
          '../../../../output/cache-preflight-full-service.private.json',
        );
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(
          output,
          JSON.stringify(
            {
              node: process.version,
              connectionLimit: 1,
              rows: 25,
              imagesPerBody: 60,
              bodyBytes: Buffer.byteLength(body),
              samples,
              summary,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      backend.onModuleDestroy();
    }
  }, 30000);
});

describe('RSS summary projection preserves every output and full-text mode', () => {
  const modes = [
    {
      label: 'explicit summary',
      mode: 'summary',
      configured: 'fulltext',
      fulltext: false,
    },
    {
      label: 'explicit fulltext',
      mode: 'fulltext',
      configured: 'summary',
      fulltext: true,
    },
    {
      label: 'configured summary',
      mode: undefined,
      configured: 'summary',
      fulltext: false,
    },
    {
      label: 'configured fulltext',
      mode: undefined,
      configured: 'fulltext',
      fulltext: true,
    },
  ];
  const cases = ['rss', 'json', 'atom'].flatMap((type) =>
    modes.flatMap((mode) =>
      [true, false].map((single) => ({ type, ...mode, single })),
    ),
  );
  it.each(cases)(
    '$type / $label / single=$single retains identical bytes and query bounds',
    async ({ type, mode, configured, fulltext, single }) => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      try {
        const feed = {
          id: 'MP_WXS_3895431412',
          mpName: 'Synthetic publisher',
          mpIntro: 'Original intro',
          mpCover: '',
          updateTime: 1700000000,
        };
        const article = {
          id: 'saved-article',
          title: 'Preserved title',
          publishTime: 1699999999,
          picUrl: '',
          mpId: feed.id,
          sourceUrl: 'https://mp.weixin.qq.com/s/saved',
          lastBodyStatus: 'ready',
          contentHtml: '<p>retained saved body</p>',
          metrics: '{"read":42}',
          readCount: 42,
        };
        const findMany = jest.fn(async (args) => [
          args.select
            ? Object.fromEntries(
                Object.keys(args.select).map((key) => [key, article[key]]),
              )
            : article,
        ]);
        const prisma = {
          feed: {
            findFirst: jest.fn(async () => feed),
            findMany: jest.fn(async () => [feed]),
          },
          article: { findMany },
        };
        const service = new FeedsService(
          prisma as any,
          {} as any,
          new ConfigService({
            feed: { originUrl: 'http://127.0.0.1', mode: configured },
          }),
        );
        const upstream = jest
          .spyOn(service, 'getHtmlByUrl')
          .mockRejectedValue(Error('NO_UPSTREAM'));
        const feedInfo = single
          ? feed
          : {
              id: 'all',
              mpName: 'WeWe-RSS All',
              mpIntro: 'WeWe-RSS 全部文章',
              mpCover: 'http://127.0.0.1/favicon.ico',
              updateTime: 1700000000,
            };
        const broad = await service.renderFeed({
          feedInfo: feedInfo as any,
          articles: [article],
          type,
          mode,
        });
        const expected =
          type === 'rss'
            ? broad.rss2()
            : type === 'json'
              ? broad.json1()
              : broad.atom1();
        const result = await service.handleGenerateFeed({
          id: single ? feed.id : undefined,
          type,
          mode,
          limit: 20,
          page: 2,
        });
        expect(result.content).toBe(expected);
        expect(findMany).toHaveBeenCalledTimes(1);
        const query = findMany.mock.calls[0][0];
        expect(query.take).toBe(20);
        expect(query.skip).toBe(20);
        expect(query.orderBy).toEqual({ publishTime: 'desc' });
        expect(query.where).toEqual(single ? { mpId: feed.id } : undefined);
        if (fulltext) {
          expect(query.select).toBeUndefined();
          expect(result.content).toContain('retained saved body');
        } else {
          expect(Object.keys(query.select).sort()).toEqual([
            'id',
            'lastBodyStatus',
            'mpId',
            'picUrl',
            'publishTime',
            'sourceUrl',
            'title',
          ]);
          expect(result.content).not.toContain('retained saved body');
        }
        expect(upstream).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
      }
    },
  );
});
