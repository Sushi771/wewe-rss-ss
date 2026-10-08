import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import axios from 'axios';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import { CollectionService } from '../collection/collection.service';
import { saveNativeAccountSession } from '../collection/owner-weread-binding';
import { readOwnerSearchConfig } from '../collection/owner-search-update';
import { createNativeSubscriptionDiscovery } from '../collection/subscription-native-adapter';
import { resolveWereadPublisherOriginal } from '../collection/weread-public-original';
import { articleIdentity } from '../collection/article-page';
import {
  parseWereadDirectory,
  prepareWereadDirectoryReplay,
} from '../collection/weread-directory';
import { decodeInlineImage } from '../collection/image-fetch';
import * as backups from '../collection/sqlite-backup';
import {
  DiscoveryOutcome,
  SubscriptionDiscoveryValidator,
  SubscriptionRegistrationError,
} from '../collection/subscription-add';

jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

// The injected adapter below is synthetic transport, NOT an actual native adapter.
// Router, coordinator, public identity/catalog/body parsers, image archiver,
// original persistence and consistent SQLite backups all execute normally.
describe('new-publisher discovery through original add entry (offline SQLite)', () => {
  const env = { ...process.env };
  const number = '3456789012';
  const mpId = `MP_WXS_${number}`;
  const name = '合成新公众号';
  const biz = Buffer.from(number).toString('base64');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
    'base64',
  );
  const url = (n = 10) =>
    `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${100 + n}&idx=1&sn=abcd`;
  const shortId = (n: number) => String(n).padStart(22, 'a');
  const html = (n: number) =>
    `<meta property="og:url" content="${url(n)}"><h1 id="activity-name">合成文章${n}</h1><span id="js_name">${name}</span><div id="js_content"><p>合成完整正文${n}</p><img src="data:image/png;base64,${png.toString('base64')}"></div><script>var biz="${biz}";var mid="${100 + n}";var idx="1";var sn="abcd";var ct=${1700000000 + n};</script>`;
  const page = (windowEnd = 10) => ({
    reviews: Array.from({ length: 10 }, (_, i) => {
      const n = windowEnd - i,
        originalId = shortId(n),
        reviewId = `${mpId}_${originalId}`;
      return {
        subReviews: [
          {
            reviewId,
            review: {
              reviewId,
              bookId: '',
              belongBookId: mpId,
              type: 16,
              mpInfo: {
                originalId,
                title: `合成文章${n}`,
                mp_name: name,
                time: 1700000000 + n,
              },
            },
          },
        ],
      };
    }),
    clearAll: 1,
    synckey: 1700000010,
  });
  type Mode =
    | 'success'
    | 'unresolved'
    | 'challenge'
    | 'http401'
    | 'empty'
    | 'identity-conflict'
    | 'binding-write'
    | 'body-challenge'
    | 'concurrent-edit';
  let root: string,
    attemptDir: string,
    prisma: PrismaClient,
    collection: CollectionService;
  let externalGet: jest.SpyInstance, backup: jest.SpyInstance;
  let sequence = 0;
  const config = new ConfigService({
    platform: { url: '' },
    feed: { updateDelayTime: 0 },
    auth: { code: 'synthetic-local-access' },
  });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-subscription-add-'));
    const database = path.join(root, 'fixture.sqlite');
    process.env.DATABASE_URL = `file:${database.replace(/\\/g, '/')}`;
    process.env.WECHAT2RSS_ENABLED = '0';
    delete process.env.WEWE_ACCEPTANCE_MODE;
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.OWNER_SEARCH_CONFIG_FILE;
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const dir of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, dir))).isDirectory()) continue;
      const sql = await fs.readFile(
        path.join(migrations, dir, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$disconnect();
    const source = path.join(root, 'empty-source.sqlite');
    await fs.copyFile(database, source);
    await fs.writeFile(
      database + '.weread-directory-replay.json',
      JSON.stringify({
        mode: 'saved-weread-directory',
        sourceDatabase: source,
      }),
    );
    collection = new CollectionService(prisma as any);
    externalGet = jest
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('LIVE TRANSPORT FORBIDDEN'));
    backup = jest.spyOn(backups, 'createVerifiedSqliteBackup');
  }, 60000);
  beforeEach(async () => {
    delete process.env.OWNER_SEARCH_CONFIG_FILE;
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    await prisma.account.deleteMany();
    await prisma.account.create({
      data: {
        id: '123',
        name: '合成正常账号',
        status: 1,
        token: 'synthetic-unused',
      },
    });
    attemptDir = path.join(root, `attempt-${++sequence}`);
    await fs.mkdir(attemptDir);
    jest.clearAllMocks();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    jest.restoreAllMocks();
    process.env = { ...env };
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-subscription-add-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  function fixture(mode: Mode = 'success') {
    const directoryRead = jest.fn(async () => page());
    const bodyRead = jest.fn(async (n: number) => html(n));
    const events: string[] = [];
    const failures: unknown[] = [];
    const stopFile = path.join(attemptDir, 'stop.json');
    const bindingFile = path.join(attemptDir, 'validated-binding.json');
    const validator: SubscriptionDiscoveryValidator = {
      discover: async (input, stageFeed) => {
        expect(input).toMatchObject({
          accountId: '123',
          trigger: 'local-manual-add',
        });
        // Private normal-account resolution is the owner's adapter responsibility;
        // this fixture supplies one synthetic normal account, without credentials.
        try {
          const stopped = JSON.parse(await fs.readFile(stopFile, 'utf8'));
          return { ...stopped, status: 'blocked', code: 'ATTEMPT_STOPPED' };
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
        await fs.writeFile(
          path.join(attemptDir, 'candidate.json'),
          JSON.stringify({
            articleUrl: input.articleUrl,
            accountId: input.accountId,
            status: 'pending',
          }),
        );
        if (mode === 'unresolved')
          return {
            status: 'needs-verification',
            stage: 'identity',
            code: 'IDENTITY_UNRESOLVED',
          };
        const identity = articleIdentity(html(10));
        const publisher = {
          mpId: identity.mpId,
          name: load(html(10))('#js_name').text(),
        };
        const evidenceRevision = createHash('sha256')
          .update(html(10))
          .digest('hex');
        try {
          const existing = JSON.parse(await fs.readFile(bindingFile, 'utf8'));
          expect(existing).toEqual({ ...publisher, evidenceRevision });
          const receipt = await stageFeed({ ...publisher, evidenceRevision });
          await receipt.activate();
          return {
            status: 'already-subscribed',
            stage: 'binding',
            code: 'ALREADY_SUBSCRIBED',
          };
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
        const raw = await directoryRead();
        if (mode === 'challenge' || mode === 'http401') {
          const refusal: DiscoveryOutcome = {
            status: 'blocked',
            stage: 'directory',
            code: 'DIRECTORY_REFUSED',
            httpStatus: mode === 'http401' ? 401 : 200,
            ...(mode === 'challenge' ? { businessCode: -2041 } : {}),
          };
          await fs.writeFile(stopFile, JSON.stringify(refusal), { flag: 'wx' });
          return refusal;
        }
        if (mode === 'empty') raw.reviews = [];
        if (mode === 'identity-conflict')
          raw.reviews[0].subReviews[0].review.belongBookId =
            'MP_WXS_9999999999';
        let directory: ReturnType<typeof parseWereadDirectory>;
        try {
          directory = parseWereadDirectory(raw, publisher);
        } catch {
          return {
            status: 'blocked',
            stage: 'directory',
            code: 'IDENTITY_CONFLICT',
          };
        }
        if (!directory.articles.length)
          return {
            status: 'needs-verification',
            stage: 'directory',
            code: 'DIRECTORY_EMPTY',
          };
        let receipt: Awaited<ReturnType<typeof stageFeed>> | undefined;
        try {
          receipt = await stageFeed({ ...publisher, evidenceRevision });
          events.push('stage');
          const row = await prisma.feed.findUniqueOrThrow({
            where: { id: mpId },
          });
          if (receipt.created)
            expect(row).toMatchObject({
              status: 0,
              collectionChannel: 'unavailable',
            });
          if (mode === 'binding-write')
            throw new Error('synthetic binding write failure');
          if (mode === 'concurrent-edit')
            await prisma.feed.update({
              where: { id: mpId },
              data: { mpIntro: '保留用户编辑' },
            });
          await fs.writeFile(
            bindingFile,
            JSON.stringify({ ...publisher, evidenceRevision }),
            { flag: 'wx' },
          );
          events.push('publish');
          await receipt.activate();
          events.push('activate');
        } catch (error) {
          await fs.unlink(bindingFile).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
          await receipt?.rollback();
          return {
            status: 'failed',
            stage: 'binding',
            code:
              error instanceof SubscriptionRegistrationError
                ? error.code
                : 'BINDING_FAILED',
          };
        }
        if (mode === 'body-challenge') {
          const refusal: DiscoveryOutcome = {
            status: 'blocked',
            stage: 'bodies',
            code: 'BODY_FAILED',
            httpStatus: 200,
            businessCode: -2041,
          };
          await fs.writeFile(stopFile, JSON.stringify(refusal), { flag: 'wx' });
          return refusal;
        }
        const bodies = await Promise.all(
          directory.articles.map(async (a) => {
            const n = Number(a.originalId.replace(/^a+/, ''));
            const body = await bodyRead(n);
            return {
              reviewId: a.reviewId,
              html: body,
              sha256: createHash('sha256').update(body).digest('hex'),
              capturedAt: new Date().toISOString(),
              images: [],
            };
          }),
        );
        // Continue from raw already returned above. No second directory read.
        const replay = prepareWereadDirectoryReplay([raw], publisher, bodies);
        const saved = await collection
          .replayWereadDirectory(mpId, replay)
          .catch((e) => {
            failures.push(e);
            throw e;
          });
        events.push('save');
        return {
          status: 'updated',
          stage: 'save',
          code: 'UPDATED',
          update: {
            articles: saved.articles,
            created: saved.created,
            updated: saved.updated,
            bodyMissing: 0,
            imageBlocked: 0,
            saved: true,
          },
        };
      },
    };
    const run = validator.discover;
    validator.discover = async (...args) => {
      try {
        return await run(...args);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    };
    return {
      validator,
      directoryRead,
      bodyRead,
      events,
      failures,
      stopFile,
      bindingFile,
    };
  }
  function setup(validator?: SubscriptionDiscoveryValidator, db: any = prisma) {
    const service = new TrpcService(
      db,
      config,
      {} as any,
      collection,
      validator,
    );
    const router = new TrpcRouter(service, db, config, {} as any, collection);
    return {
      service,
      router,
      caller: router.appRouter.createCaller({ errorMsg: null, isLocal: true }),
    };
  }
  const add = (
    caller: ReturnType<typeof setup>['caller'],
    articleUrl = url(),
  ) => caller.feed.addFromArticle({ articleUrl, accountId: '123' });

  async function actualNative(
    mode: 'success' | 'challenge' | 'empty' | 'public302' = 'success',
    options: {
      db?: any;
      usePublicResolver?: boolean;
      resolveOriginal?: (articleUrl: string) => Promise<{
        requestedUrl: string;
        html: string;
      }>;
    } = {},
  ) {
    let windowEnd = 10;
    const configFile = path.join(attemptDir, 'native-config.json');
    await fs.writeFile(configFile, JSON.stringify({ feeds: {} }));
    const session = {
      source: 'owner-confirmed-native-web-login' as const,
      ownerVid: '123',
      capturedAt: new Date().toISOString(),
      cookies: ['wr_vid', 'wr_skey'].map((cookie) => ({
        name: cookie,
        value: cookie === 'wr_vid' ? '123' : 'synthetic-normal-key',
        domain: '.weread.qq.com',
        path: '/',
        secure: true,
        expires: -1,
      })),
    };
    await saveNativeAccountSession(configFile, session);
    await prisma.account.update({
      where: { id: '123' },
      data: {
        token: JSON.stringify({
          wr_vid: '123',
          wr_skey: 'synthetic-normal-key',
        }),
      },
    });
    externalGet.mockImplementation(async (target: string, options: any) => {
      if (target.startsWith('https://mp.weixin.qq.com/'))
        return mode === 'public302'
          ? {
              status: 302,
              data: Buffer.from('synthetic redirect'),
              headers: {
                'content-type': 'text/html',
                location: 'https://mp.weixin.qq.com/mp/verify?action=check',
              },
            }
          : {
              status: 200,
              data: Buffer.from(html(10)),
              headers: { 'content-type': 'text/html' },
            };
      if (target === 'https://weread.qq.com/web/mp/articles') {
        expect(options.params).toEqual({ bookId: mpId, offset: '0' });
        return {
          status: 200,
          data: JSON.stringify(
            mode === 'challenge'
              ? { errCode: -2041 }
              : mode === 'empty'
                ? { reviews: [] }
                : page(windowEnd),
          ),
          headers: {},
        };
      }
      expect(target).toBe('https://weread.qq.com/web/mp/content');
      const n = Number(
        options.params.reviewId.split('_').at(-1).replace(/^a+/, ''),
      );
      return { status: 200, data: html(n), headers: {} };
    });
    const resolver = jest.fn(
      options.resolveOriginal ||
        (async (articleUrl: string) => ({
          requestedUrl: articleUrl,
          html: html(10),
        })),
    );
    const validator = createNativeSubscriptionDiscovery({
      prisma,
      collection,
      configFile,
      resolveOriginal: options.usePublicResolver
        ? (articleUrl, account) =>
            resolveWereadPublisherOriginal({
              url: articleUrl,
              account,
              configFile,
              trigger: 'local-manual',
            })
        : resolver,
    });
    const { router, caller } = setup(validator, options.db || prisma);
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    await router.applyMiddleware(app as any);
    const httpAdd = () =>
      request(app)
        .post('/trpc/feed.addFromArticle')
        .set('authorization', 'synthetic-local-access')
        .set('origin', 'http://127.0.0.1')
        .send({ articleUrl: url(), accountId: '123' });
    return {
      caller,
      app,
      configFile,
      httpAdd,
      resolver,
      setWindowEnd: (n: number) => {
        windowEnd = n;
      },
    };
  }

  it('accepts only a URL and selected account through HTTP, resolves fresh server original and saves ten without prebinding', async () => {
    const n = await actualNative('success', { usePublicResolver: true });
    const response = await n.httpAdd().expect(200);
    expect(response.body.result.data).toMatchObject({
      status: 'updated',
      accepted: true,
      update: { articles: 10, created: 10, saved: true },
    });
    expect(
      externalGet.mock.calls.filter(([target]) =>
        String(target).startsWith('https://mp.weixin.qq.com/'),
      ),
    ).toHaveLength(1);
    expect(
      externalGet.mock.calls.filter(([target]) =>
        String(target).endsWith('/web/mp/articles'),
      ),
    ).toHaveLength(1);
    expect(
      externalGet.mock.calls.filter(([target]) =>
        String(target).endsWith('/web/mp/content'),
      ),
    ).toHaveLength(10);
    expect(JSON.stringify(response.body)).not.toMatch(
      /synthetic-normal-key|native-session|<script>|sessionFile/,
    );
    expect(await prisma.article.count({ where: { mpId } })).toBe(10);
  });

  it('keeps an observed public302 pending with a safe official verification link and zero directory/body/database writes', async () => {
    const n = await actualNative('public302', { usePublicResolver: true });
    const response = await n.httpAdd().expect(200);
    expect(response.body.result.data).toMatchObject({
      status: 'needs-verification',
      accepted: false,
      code: 'PUBLIC_ORIGINAL_VERIFICATION_REQUIRED',
      httpStatus: 302,
      officialVerification: {
        status: 'available',
        url: 'https://mp.weixin.qq.com/mp/verify?action=check',
      },
    });
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toBeNull();
    expect(await prisma.article.count({ where: { mpId } })).toBe(0);
    await n.httpAdd().expect(200);
    expect(externalGet).toHaveBeenCalledTimes(1);
  });

  it('integrates owner native validator, complete private binding and original ten-body saver through local HTTP', async () => {
    const n = await actualNative();
    await request(n.app)
      .post('/trpc/feed.addFromArticle')
      .send({ articleUrl: url(), accountId: '123' })
      .expect(401);
    await request(n.app)
      .post('/trpc/feed.addFromArticle')
      .set('authorization', 'synthetic-local-access')
      .set('origin', 'https://untrusted.invalid')
      .send({ articleUrl: url(), accountId: '123' })
      .expect(403);
    expect(externalGet).not.toHaveBeenCalled();
    const response = await n.httpAdd().expect(200);
    expect(response.body.result.data).toMatchObject({
      status: 'updated',
      created: true,
      accepted: true,
      update: { articles: 10, created: 10, saved: true },
    });
    const stored = JSON.parse(await fs.readFile(n.configFile, 'utf8')).feeds[
      mpId
    ];
    expect(stored).toMatchObject({
      mpId,
      name,
      biz,
      ownerVid: '123',
      wereadDirectoryEnabled: true,
      bindingEvidence: {
        source: 'normal-native-candidate-directory',
        requests: 1,
        bodyVerified: false,
      },
    });
    process.env.OWNER_SEARCH_CONFIG_FILE = n.configFile;
    expect(await readOwnerSearchConfig(mpId)).toMatchObject({
      mpId,
      name,
      wereadDirectoryEnabled: true,
    });
    expect(stored.sourcePolicy).toBe('native-directory-only');
    expect(stored.originalStopFiles).toEqual([]);
    const articles = await prisma.article.findMany({ where: { mpId } });
    expect(articles).toHaveLength(10);
    for (const article of articles)
      expect(
        decodeInlineImage(load(article.contentHtml!)('img').attr('src')!).bytes,
      ).toEqual(png);
    expect(
      externalGet.mock.calls.filter(([target]) =>
        String(target).endsWith('/web/mp/articles'),
      ),
    ).toHaveLength(1);
    expect(
      externalGet.mock.calls.filter(([target]) =>
        String(target).endsWith('/web/mp/content'),
      ),
    ).toHaveLength(10);
    const feed = await prisma.feed.findUnique({ where: { id: mpId } });
    const repeat = await n.httpAdd().expect(200);
    expect(repeat.body.result.data).toMatchObject({
      status: 'already-subscribed',
      created: false,
    });
    expect(externalGet).toHaveBeenCalledTimes(11);
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toEqual(feed);
    // A later explicit original refresh discovers a new fixture publication;
    // advance only this test clock, never clear a stop or fake a real publication.
    n.setWindowEnd(11);
    const oldRows = await prisma.article.findMany({
      where: { mpId },
      orderBy: { id: 'asc' },
    });
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      const refresh = await n.caller.feed.refreshArticles({ mpId });
      expect(refresh[0]).toMatchObject({
        source: 'owner-weread-latest',
        articles: 10,
        created: 1,
        updated: 0,
      });
    } finally {
      clock.mockRestore();
    }
    expect(await prisma.article.count({ where: { mpId } })).toBe(11);
    for (const oldRow of oldRows)
      expect(
        await prisma.article.findUnique({ where: { id: oldRow.id } }),
      ).toEqual(oldRow);
    expect(externalGet).toHaveBeenCalledTimes(22);
  });
  it.each(['challenge', 'empty'] as const)(
    'integrates actual native %s without Feed/config publication or replay',
    async (mode) => {
      const n = await actualNative(mode);
      const before = await fs.readFile(n.configFile, 'utf8');
      const first = await n.httpAdd().expect(200);
      expect(first.body.result.data).toMatchObject({
        accepted: false,
        feed: null,
        code: mode === 'challenge' ? 'DIRECTORY_REFUSED' : 'DIRECTORY_EMPTY',
      });
      if (mode === 'challenge')
        expect(first.body.result.data.businessCode).toBe(-2041);
      const second = await n.httpAdd().expect(200);
      expect(second.body.result.data).toMatchObject({
        accepted: false,
        code: 'ATTEMPT_STOPPED',
      });
      expect(externalGet).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(n.configFile, 'utf8')).toBe(before);
      expect(await prisma.feed.count()).toBe(0);
    },
  );
  it('compensates actual private config publication failure before activating a new Feed', async () => {
    const n = await actualNative();
    const before = await fs.readFile(n.configFile, 'utf8');
    const rename = fs.rename.bind(fs);
    const failed = jest
      .spyOn(fs, 'rename')
      .mockImplementation(async (from, to) => {
        if (
          String(to) === n.configFile &&
          String(from).includes('.subscription-')
        )
          throw new Error('synthetic config publication failure');
        return rename(from, to);
      });
    let response: Awaited<ReturnType<typeof n.httpAdd>>;
    try {
      response = await n.httpAdd().expect(200);
    } finally {
      failed.mockRestore();
    }
    expect(response!.body.result.data).toMatchObject({
      accepted: false,
      code: 'BINDING_FAILED',
    });
    expect(await fs.readFile(n.configFile, 'utf8')).toBe(before);
    expect(await prisma.feed.count()).toBe(0);
    expect(externalGet).toHaveBeenCalledTimes(1);
  });

  it('restores the private binding and removes only the staged row when actual activation fails', async () => {
    const db = {
      account: prisma.account,
      feed: prisma.feed,
      article: prisma.article,
      $transaction: (action: any) =>
        prisma.$transaction((tx) =>
          action({
            ...tx,
            feed: {
              findUnique: tx.feed.findUnique.bind(tx.feed),
              create: tx.feed.create.bind(tx.feed),
              delete: tx.feed.delete.bind(tx.feed),
              update: () => {
                throw new Error('synthetic activation write failure');
              },
            },
          }),
        ),
    };
    const n = await actualNative('success', { db });
    const before = await fs.readFile(n.configFile, 'utf8');
    const response = await n.httpAdd().expect(200);
    expect(response.body.result.data).toMatchObject({
      accepted: false,
      code: 'BINDING_FAILED',
    });
    expect(await fs.readFile(n.configFile, 'utf8')).toBe(before);
    expect(await prisma.feed.count()).toBe(0);
    expect(externalGet).toHaveBeenCalledTimes(1);
    const retained = (await fs.readdir(attemptDir)).filter((file) =>
      /^candidate-directory-[a-f0-9]{24}\.json$/.test(file),
    );
    expect(retained.length).toBeGreaterThan(0);
  });

  it.each(['request-mismatch', 'canonical-mismatch'] as const)(
    'rejects substituted original provenance (%s) before directory transport',
    async (kind) => {
      const n = await actualNative('success', {
        resolveOriginal: async (articleUrl) => ({
          requestedUrl: kind === 'request-mismatch' ? url(9) : articleUrl,
          html: html(9),
        }),
      });
      const before = await fs.readFile(n.configFile, 'utf8');
      const response = await n.httpAdd().expect(200);
      expect(response.body.result.data).toMatchObject({
        accepted: false,
        stage: 'identity',
        code:
          kind === 'request-mismatch'
            ? 'IDENTITY_UNRESOLVED'
            : 'FEED_IDENTITY_CONFLICT',
      });
      expect(externalGet).not.toHaveBeenCalled();
      expect(await fs.readFile(n.configFile, 'utf8')).toBe(before);
      expect(await prisma.feed.count()).toBe(0);
    },
  );

  it('adds a completely new publisher after real fixture parsing, saves ten bodies/image bytes, and never duplicates directory or old data', async () => {
    expect(process.env.OWNER_SEARCH_CONFIG_FILE).toBeUndefined();
    const old = await prisma.feed.create({
      data: {
        id: 'MP_WXS_1234567890',
        mpName: '合成旧号',
        mpCover: '旧封面',
        mpIntro: '旧说明',
        updateTime: 42,
      },
    });
    const f = fixture(),
      { caller } = setup(f.validator);
    expect(await caller.feed.addCapability()).toMatchObject({
      available: true,
      requiresAccount: true,
    });
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toBeNull();
    const result = await add(caller);
    expect(f.failures).toEqual([]);
    expect(result).toMatchObject({
      status: 'updated',
      accepted: true,
      created: true,
      directoryValidated: true,
      update: { articles: 10, created: 10, saved: true },
      feed: { id: mpId, mpName: name },
    });
    expect(f.events).toEqual(['stage', 'publish', 'activate', 'save']);
    expect(f.directoryRead).toHaveBeenCalledTimes(1);
    expect(f.bodyRead).toHaveBeenCalledTimes(10);
    const articles = await prisma.article.findMany({
      where: { mpId },
      orderBy: { id: 'asc' },
    });
    expect(articles).toHaveLength(10);
    for (const article of articles) {
      expect(article.publishTime).toBeGreaterThan(1700000000);
      const src = load(article.contentHtml!)('img').attr('src')!;
      expect(decodeInlineImage(src).bytes).toEqual(png);
    }
    expect(await prisma.feed.findUnique({ where: { id: old.id } })).toEqual(
      old,
    );
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    expect(await add(caller)).toMatchObject({
      status: 'already-subscribed',
      created: false,
      pending: false,
    });
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toEqual(feed);
    expect(
      await prisma.article.findMany({
        where: { mpId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(articles);
    expect(f.directoryRead).toHaveBeenCalledTimes(1);
    expect(externalGet).not.toHaveBeenCalled();
    for (const call of backup.mock.results)
      expect(await call.value).toMatchObject({ integrityCheck: 'ok' });
  });
  it.each([
    'unresolved',
    'empty',
    'identity-conflict',
    'challenge',
    'http401',
  ] as Mode[])(
    'keeps %s as a candidate/refusal without a successful Feed',
    async (mode) => {
      const f = fixture(mode),
        { caller } = setup(f.validator);
      const result = await add(
        caller,
        mode === 'unresolved' ? 'https://mp.weixin.qq.com/s/unknown' : url(),
      );
      expect(result).toMatchObject({
        accepted: false,
        directoryValidated: false,
        feed: null,
      });
      expect(await prisma.feed.count()).toBe(0);
      expect(await prisma.article.count()).toBe(0);
      expect(backup).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          await fs.readFile(path.join(attemptDir, 'candidate.json'), 'utf8'),
        ).status,
      ).toBe('pending');
      if (mode === 'challenge')
        expect(result).toMatchObject({ httpStatus: 200, businessCode: -2041 });
      if (mode === 'http401') expect(result).toMatchObject({ httpStatus: 401 });
    },
  );
  it('never clears or replays a refused target on another click', async () => {
    const f = fixture('challenge'),
      { caller } = setup(f.validator);
    await add(caller);
    const stopped = await fs.readFile(f.stopFile, 'utf8');
    expect(await add(caller)).toMatchObject({
      accepted: false,
      code: 'ATTEMPT_STOPPED',
      businessCode: -2041,
    });
    expect(f.directoryRead).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(f.stopFile, 'utf8')).toBe(stopped);
  });
  it('does not change an existing conflicting identity or its old articles', async () => {
    const old = await prisma.feed.create({
      data: {
        id: mpId,
        mpName: '不同号名',
        mpCover: '保留',
        mpIntro: '保留',
        updateTime: 99,
      },
    });
    const f = fixture(),
      { caller } = setup(f.validator);
    expect(await add(caller)).toMatchObject({
      accepted: false,
      code: 'FEED_IDENTITY_CONFLICT',
    });
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toEqual(old);
    expect(backup).not.toHaveBeenCalled();
  });
  it('rolls back a staged new Feed when private binding publication fails', async () => {
    const f = fixture('binding-write'),
      { caller } = setup(f.validator);
    expect(await add(caller)).toMatchObject({
      accepted: false,
      code: 'BINDING_FAILED',
    });
    expect(f.events).toEqual(['stage']);
    expect(await prisma.feed.count()).toBe(0);
    await expect(fs.readFile(f.bindingFile)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('fails a DB write without publishing a binding or claiming directory success', async () => {
    const f = fixture();
    const db = {
      feed: prisma.feed,
      article: prisma.article,
      account: prisma.account,
      $transaction: jest
        .fn()
        .mockRejectedValue(new Error('synthetic SQLite write failure')),
    };
    expect(await add(setup(f.validator, db).caller)).toMatchObject({
      accepted: false,
      code: 'BINDING_FAILED',
    });
    expect(await prisma.feed.count()).toBe(0);
    await expect(fs.readFile(f.bindingFile)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('preserves concurrent user edits in an inactive recovery row instead of deleting them', async () => {
    const f = fixture('concurrent-edit'),
      { caller } = setup(f.validator);
    expect(await add(caller)).toMatchObject({
      accepted: false,
      code: 'FEED_CHANGED',
    });
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toMatchObject(
      {
        mpIntro: '保留用户编辑',
        status: 0,
        collectionChannel: 'unavailable',
      },
    );
    await expect(fs.readFile(f.bindingFile)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('distinguishes directory-confirmed subscription from a later body challenge', async () => {
    const f = fixture('body-challenge'),
      { caller } = setup(f.validator);
    expect(await add(caller)).toMatchObject({
      status: 'blocked',
      stage: 'bodies',
      accepted: true,
      directoryValidated: true,
      pending: true,
      businessCode: -2041,
    });
    expect(await prisma.article.count()).toBe(0);
    expect(f.bodyRead).not.toHaveBeenCalled();
  });
  it('rejects anonymous/remote/disabled-account attempts before discovery; never reads account tokens', async () => {
    const discover = jest.fn();
    const { router, caller } = setup({ discover });
    await expect(
      add(
        router.appRouter.createCaller({ errorMsg: '请先登录', isLocal: true }),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      add(router.appRouter.createCaller({ errorMsg: null, isLocal: false })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await prisma.account.update({ where: { id: '123' }, data: { status: 0 } });
    const select = jest.spyOn(prisma.account, 'findUnique');
    expect(await add(caller)).toMatchObject({
      accepted: false,
      code: 'ACCOUNT_UNAVAILABLE',
    });
    expect(select).toHaveBeenLastCalledWith({
      where: { id: '123' },
      select: { id: true, status: true },
    });
    select.mockRestore();
    expect(discover).not.toHaveBeenCalled();
  });
});
