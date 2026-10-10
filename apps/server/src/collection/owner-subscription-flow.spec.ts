import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { PrismaService } from '../prisma/prisma.service';
import { ArticleDownloadController } from '../article-download.controller';
import { CollectionService } from './collection.service';
import * as backup from './sqlite-backup';

// Only external transport and its pacing are replaced. Router, binding checks,
// provider parsing, image archiving, SQLite backups/transactions and saver run.
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

describe('two explicitly bound publishers through original refresh/save (synthetic, offline)', () => {
  const publishers = [
    { number: '1234567890', name: '合成甲号', ownerVid: '123', prefix: 'a' },
    { number: '2345678901', name: '合成乙号', ownerVid: '456', prefix: 'b' },
  ].map((p) => ({
    ...p,
    mpId: `MP_WXS_${p.number}`,
    biz: Buffer.from(p.number).toString('base64'),
  }));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
    'base64',
  );
  const originalEnv = { ...process.env };
  let root: string;
  let prisma: PrismaClient;
  let app: INestApplication;
  let caller: ReturnType<TrpcRouter['appRouter']['createCaller']>;
  let router: TrpcRouter;
  let bindings: Record<string, any>;
  let windowStart = 10;
  let now = Date.now();
  let transport: jest.SpyInstance;
  let imageTransport: jest.SpyInstance;
  let backups: jest.SpyInstance;
  const title = (p: (typeof publishers)[number], n: number) =>
    `${p.name}文章${n}`;
  const shortId = (p: (typeof publishers)[number], n: number) =>
    String(n).padStart(22, p.prefix);
  const url = (p: (typeof publishers)[number], n: number) =>
    `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(p.biz)}&mid=${100 + n}&idx=1&sn=abcd`;
  const refresh = async (p: (typeof publishers)[number]) =>
    (await caller.feed.refreshArticles({ mpId: p.mpId }))[0];
  const writeBindings = () =>
    fs.writeFile(
      process.env.OWNER_SEARCH_CONFIG_FILE!,
      JSON.stringify({ feeds: bindings }),
    );
  const save = (articleUrl: string) =>
    request(app.getHttpServer())
      .post('/download/article')
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'synthetic-local-access')
      .send({ url: articleUrl });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-owner-flow-'));
    process.env.DATABASE_URL = `file:${path.join(root, 'fixture.sqlite').replace(/\\/g, '/')}`;
    process.env.OWNER_SEARCH_CONFIG_FILE = path.join(root, 'bindings.json');
    process.env.WECHAT2RSS_ENABLED = '0';
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const folder = path.join(migrations, name);
      if (!(await fs.stat(folder)).isDirectory()) continue;
      const sql = await fs.readFile(path.join(folder, 'migration.sql'), 'utf8');
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    bindings = {};
    for (const p of publishers) {
      const directory = path.join(root, p.number);
      await fs.mkdir(directory);
      bindings[p.mpId] = {
        mpId: p.mpId,
        name: p.name,
        biz: p.biz,
        ownerVid: p.ownerVid,
        sessionFile: path.join(directory, 'session.json'),
        stateFile: path.join(directory, 'search.json'),
        runtimeStopFile: path.join(directory, 'original-runtime.json'),
        originalStopFiles: [path.join(directory, 'original-stop.json')],
        wereadLatestStateFile: path.join(directory, 'latest.json'),
        wereadDirectoryEnabled: true,
      };
      await fs.writeFile(
        bindings[p.mpId].sessionFile,
        JSON.stringify({
          source: 'owner-confirmed-native-web-login',
          capturedAt: new Date().toISOString(),
          ownerVid: p.ownerVid,
          cookies: ['wr_vid', 'wr_skey'].map((name) => ({
            name,
            value:
              name === 'wr_vid' ? p.ownerVid : `synthetic-only-${p.ownerVid}`,
            domain: '.weread.qq.com',
            path: '/',
            secure: true,
            expires: -1,
          })),
        }),
      );
      await fs.writeFile(
        bindings[p.mpId].originalStopFiles[0],
        'retained synthetic original stop',
      );
      // This setup assumes identity/session binding already exists. It does not
      // exercise or claim automatic new-publisher discovery/registration.
      await prisma.feed.create({
        data: {
          id: p.mpId,
          mpName: p.name,
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
          collectionChannel: 'owner-weread-latest',
        },
      });
      await prisma.account.create({
        data: {
          id: p.ownerVid,
          name: p.name,
          token: 'synthetic-unused-legacy-account',
          status: 1,
        },
      });
    }
    await writeBindings();
    const config = new ConfigService({
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
      auth: { code: 'synthetic-local-access' },
    });
    const collection = new CollectionService(prisma as any);
    const service = new TrpcService(
      prisma as any,
      config,
      {} as any,
      collection,
    );
    router = new TrpcRouter(
      service,
      prisma as any,
      config,
      {} as any,
      collection,
    );
    caller = router.appRouter.createCaller({ errorMsg: null, isLocal: true });
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    const destination = path.join(root, 'Obsidian 合成验收');
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, '旧笔记.md'), '旧笔记必须保留');
    await fs.writeFile(
      path.join(root, '.article-download-settings.json'),
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    backups = jest.spyOn(backup, 'createVerifiedSqliteBackup'); // Real Python/SQLite backup.
    imageTransport = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => {
        throw new Error('Unexpected external image request');
      });
    transport = jest
      .spyOn(axios, 'get')
      .mockImplementation(async (rawUrl, options: any) => {
        const endpoint = String(rawUrl);
        const p = publishers.find((candidate) =>
          endpoint.endsWith('/articles')
            ? options.params.bookId === candidate.mpId
            : options.params.reviewId.startsWith(candidate.mpId + '_'),
        );
        if (
          !p ||
          ![
            'https://weread.qq.com/web/mp/articles',
            'https://weread.qq.com/web/mp/content',
          ].includes(endpoint)
        )
          throw new Error('Unexpected external endpoint');
        expect(options.headers.Cookie).toContain(`wr_vid=${p.ownerVid}`);
        expect(options.headers.Cookie).toContain(
          `wr_skey=synthetic-only-${p.ownerVid}`,
        );
        expect(options.headers.Cookie).not.toContain(
          `wr_vid=${publishers.find((other) => other !== p)!.ownerVid}`,
        );
        expect(options.maxRedirects).toBe(0);
        if (endpoint.endsWith('/articles')) {
          expect(options.params.offset).toBe('0');
          return {
            status: 200,
            data: JSON.stringify({
              reviews: Array.from({ length: 10 }, (_, i) => {
                const n = windowStart - i;
                const originalId = shortId(p, n);
                const reviewId = `${p.mpId}_${originalId}`;
                return {
                  subReviews: [
                    {
                      reviewId,
                      review: {
                        reviewId,
                        type: 16,
                        bookId: '',
                        belongBookId: p.mpId,
                        mpInfo: {
                          originalId,
                          title: title(p, n),
                          mp_name: p.name,
                          time: 1700000000 + n,
                        },
                      },
                    },
                  ],
                };
              }),
              clearAll: 1,
              synckey: 1790000000,
            }),
          } as any;
        }
        const n = Number(
          options.params.reviewId
            .split('_')
            .at(-1)
            .replace(/^[ab]+/, ''),
        );
        return {
          status: 200,
          data: `<meta property="og:url" content="https://mp.weixin.qq.com/s/${shortId(p, n)}"><h1 id="activity-name">${title(p, n)}</h1><span id="js_name">${p.name}</span><div id="js_content"><p>完整合成正文-${p.number}-${n}</p><img src="data:image/png;base64,${png.toString('base64')}"></div><script>var biz="${p.biz}";var mid="${100 + n}";var idx="1";var sn="abcd";var ct=${1700000000 + n};</script>`,
        } as any;
      });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-owner-flow-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  it('stops unknown-publisher addition/auth before transport or database mutation', async () => {
    const before = await prisma.feed.findMany();
    await expect(
      caller.feed.addFromArticle({
        articleUrl:
          'https://mp.weixin.qq.com/s?__biz=' +
          encodeURIComponent(Buffer.from('3456789012').toString('base64')) +
          '&mid=111&idx=1&sn=abcd',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const unauthorized = router.appRouter.createCaller({
      errorMsg: '请先登录',
      isLocal: true,
    });
    await expect(
      unauthorized.feed.refreshArticles({ mpId: publishers[1].mpId }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await prisma.feed.findMany()).toEqual(before);
    expect(await prisma.article.count()).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(backups).not.toHaveBeenCalled();
  });

  it('retains native refresh and deduplication while the single tool refuses native cached bodies', async () => {
    expect(await refresh(publishers[0])).toMatchObject({
      source: 'owner-weread-latest',
      status: 'partial',
      complete: false,
      created: 10,
      updated: 0,
    });
    const preserved = await prisma.article.findMany({
      where: { mpId: publishers[0].mpId },
      orderBy: { id: 'asc' },
    });
    expect(await refresh(publishers[1])).toMatchObject({
      created: 10,
      updated: 0,
    });
    expect(await prisma.article.count()).toBe(20);
    const canonicalOldId = `WX_${publishers[1].number}_110_1`;
    const oldId = 'legacy-second-publisher-short-link';
    await prisma.article.update({
      where: { id: canonicalOldId },
      data: {
        id: oldId,
        sourceUrl: `https://mp.weixin.qq.com/s/${shortId(publishers[1], 10)}`,
        readCount: 123,
        likeCount: 7,
        metrics: '{"synthetic":true}',
      },
    });
    const oldArticle = await prisma.article.findUniqueOrThrow({
      where: { id: oldId },
    });
    now += 16 * 60 * 1000; // Advance only the synthetic clock, never clear a stop/cooldown.
    windowStart = 11;
    expect(await refresh(publishers[1])).toMatchObject({
      articles: 10,
      created: 1,
      updated: 0,
      complete: false,
    });
    expect(await prisma.article.count()).toBe(21);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: oldId } }),
    ).toEqual(oldArticle);
    expect(
      await prisma.article.findUnique({ where: { id: canonicalOldId } }),
    ).toBeNull();
    const inserted = await prisma.article.findUniqueOrThrow({
      where: { id: `WX_${publishers[1].number}_111_1` },
    });
    expect(inserted).toMatchObject({
      mpId: publishers[1].mpId,
      title: title(publishers[1], 11),
      publishTime: 1700000011,
      lastBodyStatus: 'available',
    });
    expect(inserted.contentHtml).toContain(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    now += 16 * 60 * 1000;
    expect(await refresh(publishers[1])).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect(await prisma.article.count()).toBe(21);
    expect(
      await prisma.article.findMany({
        where: { mpId: publishers[0].mpId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(preserved);
    // The old SQLite body belongs to the native source. The normal single tool
    // must not reinterpret it as Wechat2RSS provenance or fall back to its page.
    process.env.WECHAT2RSS_ENABLED = '0';
    const beforeDownload = await prisma.article.findMany({
      orderBy: { id: 'asc' },
    });
    const response = await save(url(publishers[1], 11)).expect(409);
    expect(response.body).toMatchObject({
      code: 'WECHAT2RSS_SINGLE_UNCONFIGURED',
    });
    expect((await save(url(publishers[1], 11)).expect(409)).body).toMatchObject(
      { code: 'WECHAT2RSS_SINGLE_UNCONFIGURED' },
    );
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      beforeDownload,
    );
    expect(await fs.readdir(path.join(root, 'Obsidian 合成验收'))).toEqual([
      '旧笔记.md',
    ]);
    expect(
      await fs.readFile(
        path.join(root, 'Obsidian 合成验收', '旧笔记.md'),
        'utf8',
      ),
    ).toBe('旧笔记必须保留');
    expect(transport).toHaveBeenCalledTimes(44);
    expect(imageTransport).not.toHaveBeenCalled();
    expect(backups).toHaveBeenCalledTimes(8);
    for (const result of backups.mock.results)
      expect(await result.value).toMatchObject({ integrityCheck: 'ok' });
  }, 60000);

  it('rejects wrong publisher binding and wrong owner session before HTTP, retaining articles and original stops', async () => {
    const p = publishers[1];
    const before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    const requests = transport.mock.calls.length;
    bindings[p.mpId].biz = publishers[0].biz;
    await writeBindings();
    expect(await refresh(p)).toMatchObject({ status: 'blocked', articles: 0 });
    bindings[p.mpId].biz = p.biz;
    await writeBindings();
    const sessionFile = bindings[p.mpId].sessionFile;
    const session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ ...session, ownerVid: publishers[0].ownerVid }),
    );
    expect(await refresh(p)).toMatchObject({ status: 'blocked', articles: 0 });
    expect(transport).toHaveBeenCalledTimes(requests);
    expect(imageTransport).not.toHaveBeenCalled();
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    for (const publisher of publishers)
      expect(
        await fs.readFile(
          bindings[publisher.mpId].originalStopFiles[0],
          'utf8',
        ),
      ).toBe('retained synthetic original stop');
  }, 60000);
});
