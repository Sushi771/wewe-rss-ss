import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as providerRegistry from '../collection/provider-registry';
import * as localCache from '../collection/local-cache-reader';
import { Wechat2RssSubscriptionBatches } from '../collection/wechat2rss-subscription-batches';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from '../collection/collection.service';
import { TrpcService } from '../trpc/trpc.service';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
import { cacheRevision } from './cache-sync-state';
import { ProviderPage } from '../collection/subscription-provider';
import { canonicalArticleUrl } from '../collection/collection-format';
jest.mock('../collection/sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));
describe('cache delta through original SQLite merge', () => {
  let root: string, prisma: PrismaClient, trpc: TrpcService;
  let articleReads = 0;
  const mpId = 'MP_WXS_1234567890';
  const url = 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=9&idx=1';
  const identity = canonicalArticleUrl(url);
  const page = (body: string | null, blocked = 0): ProviderPage => ({
    articles: [
      {
        ...identity,
        title: 'fixture',
        publishTime: 1760000000,
        contentHtml: body,
        picUrl: '',
      },
    ],
    upstreamCount: 1,
    bodyMissing: body ? 0 : 1,
    imageBlocked: blocked,
    coverage: 'recent-window',
  });
  const oldEnv = {
    enabled: process.env.WECHAT2RSS_ENABLED,
    base: process.env.WECHAT2RSS_BASE_URL,
    token: process.env.WECHAT2RSS_TOKEN,
    database: process.env.DATABASE_URL,
  };
  beforeAll(async () => {
    process.env.WECHAT2RSS_ENABLED = '1';
    process.env.WECHAT2RSS_BASE_URL = 'http://127.0.0.1:18080/';
    process.env.WECHAT2RSS_TOKEN = 'offline-fixture-token';
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-cache-storage-'));
    process.env.DATABASE_URL =
      'file:' + path.join(root, 'test.db').replace(/\\/g, '/');
    prisma = new PrismaClient({
      datasources: {
        db: { url: 'file:' + path.join(root, 'test.db').replace(/\\/g, '/') },
      },
    });
    prisma.$use(async (params, next) => {
      if (params.model === 'Article' && params.action === 'findMany')
        articleReads++;
      return next(params);
    });
    const directory = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name, 'migration.sql');
      const sql = await fs.readFile(file, 'utf8').catch(() => '');
      for (const statement of sql
        .split(';')
        .map((row) => row.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: 'fixture',
        mpIntro: '',
        mpCover: '',
        collectionChannel: 'wechat2rss',
        status: 1,
        updateTime: 0,
      },
    });
    trpc = new TrpcService(
      prisma as any,
      { get: () => ({ url: '', updateDelayTime: 0 }) } as any,
      {} as any,
      new CollectionService(prisma as any),
    );
  });
  afterAll(async () => {
    trpc?.onModuleDestroy();
    await prisma?.$disconnect();
    for (const [name, value] of Object.entries(oldEnv)) {
      const key = {
        enabled: 'WECHAT2RSS_ENABLED',
        base: 'WECHAT2RSS_BASE_URL',
        token: 'WECHAT2RSS_TOKEN',
        database: 'DATABASE_URL',
      }[name]!;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (
      root &&
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('saves real list identity, later fills body with original time, preserves metrics; no unchanged backup/revision', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    try {
      const initial = cacheRevision().revision;
      expect(
        await trpc.syncCachedWechat2RssPage(mpId, page(null), true),
      ).toMatchObject({ created: 1 });
      expect(cacheRevision().revision).not.toBe(initial);
      await prisma.article.update({
        where: { id: identity.id },
        data: { metrics: '{"read":7}', readCount: 7 },
      });
      const version = cacheRevision().revision;
      const backupCount = (createVerifiedSqliteBackup as jest.Mock).mock.calls
        .length;
      await trpc.syncCachedWechat2RssPage(mpId, page(null), true);
      expect(cacheRevision().revision).toBe(version);
      expect((createVerifiedSqliteBackup as jest.Mock).mock.calls).toHaveLength(
        backupCount,
      );
      const pending =
        '<div class="rich_media_content" id="js_content" data-wewe-image-pending="1"><p>body</p><img data-wewe-image-unconfirmed="true"></div>';
      expect(
        await trpc.syncCachedWechat2RssPage(mpId, page(pending, 1), false),
      ).toMatchObject({ updated: 1 });
      const saved = await prisma.article.findUniqueOrThrow({
        where: { id: identity.id },
      });
      expect(saved).toMatchObject({
        publishTime: 1760000000,
        metrics: '{"read":7}',
        readCount: 7,
        lastBodyStatus: 'images-pending',
      });
      expect(saved.contentHtml).toContain('body');
      expect(cacheRevision().revision).not.toBe(version);
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
  it('reads cached candidates in bounded chunks and preserves ambiguous legacy rows', async () => {
    const articles = Array.from({ length: 81 }, (_, index) => ({
      ...canonicalArticleUrl(
        `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${100 + index}&idx=1`,
      ),
      title: `batch-${index}`,
      publishTime: 1760000000 + index,
      contentHtml: null,
      picUrl: '',
    }));
    await prisma.article.create({
      data: {
        id: 'opaque-legacy',
        mpId,
        title: articles[80].title,
        publishTime: articles[80].publishTime,
        picUrl: '',
        contentHtml: '<p>old body and note</p>',
        metrics: '{"read":19}',
        readCount: 19,
      },
    });
    const old = await prisma.article.findUniqueOrThrow({
      where: { id: 'opaque-legacy' },
    });
    articleReads = 0;
    const result = await trpc.syncCachedWechat2RssPage(
      mpId,
      {
        articles,
        upstreamCount: articles.length,
        bodyMissing: articles.length,
        imageBlocked: 0,
        coverage: 'recent-window',
      },
      true,
    );
    expect(result).toMatchObject({
      created: 80,
      updated: 0,
      identitySkipped: 1,
    });
    // One preflight plus three bounded same-feed and three cross-feed identity reads.
    expect(articleReads).toBe(7);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
    expect(await prisma.article.count({ where: { id: articles[80].id } })).toBe(
      0,
    );
    const backups = (createVerifiedSqliteBackup as jest.Mock).mock.calls.length;
    const revision = cacheRevision().revision;
    const repeated = await trpc.syncCachedWechat2RssPage(
      mpId,
      {
        articles,
        upstreamCount: articles.length,
        bodyMissing: articles.length,
        imageBlocked: 0,
        coverage: 'recent-window',
      },
      true,
    );
    expect(repeated).toMatchObject({
      created: 0,
      updated: 0,
      identitySkipped: 1,
    });
    expect((createVerifiedSqliteBackup as jest.Mock).mock.calls).toHaveLength(
      backups,
    );
    expect(cacheRevision().revision).toBe(revision);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
  });
  it('rejects two saved identities and rolls the whole cache batch back', async () => {
    const item = {
      ...canonicalArticleUrl(
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=900&idx=1',
      ),
      title: 'collision',
      publishTime: 1760001000,
      contentHtml: '<p>new</p>',
      picUrl: '',
    };
    for (const [index, suffix] of ['&sn=a', '&sn=b'].entries()) {
      await prisma.article.create({
        data: {
          id: `collision-legacy-${index}`,
          mpId,
          title: 'collision',
          publishTime: item.publishTime,
          picUrl: '',
          sourceUrl: item.url + suffix,
          contentHtml: '<p>protected old</p>',
          metrics: '{"read":31}',
        },
      });
    }
    const before = await prisma.article.findMany({
      where: { id: { startsWith: 'collision-legacy-' } },
    });
    const revision = cacheRevision().revision;
    await expect(
      trpc.syncCachedWechat2RssPage(
        mpId,
        {
          articles: [item],
          upstreamCount: 1,
          bodyMissing: 0,
          imageBlocked: 0,
          coverage: 'recent-window',
        },
        false,
      ),
    ).rejects.toThrow();
    expect(
      await prisma.article.findMany({
        where: { id: { startsWith: 'collision-legacy-' } },
      }),
    ).toEqual(before);
    expect(cacheRevision().revision).toBe(revision);
  });

  it('preserves an intentionally cleared body and reports the remaining local gap without a write', async () => {
    const identity = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=797&idx=1',
    );
    await prisma.article.create({
      data: {
        id: identity.id,
        mpId,
        title: 'edited-empty',
        publishTime: 1760000000,
        sourceUrl: identity.url,
        verifiedSourceUrl: identity.url,
        contentHtml: '',
        picUrl: '',
        lastBodyStatus: 'unavailable',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        metrics: '{"note":"keep"}',
      },
    });
    const incoming: ProviderPage = {
      articles: [
        {
          ...identity,
          title: 'edited-empty',
          publishTime: 1760000000,
          contentHtml:
            '<div class="rich_media_content"><p>upstream body</p></div>',
          picUrl: '',
        },
      ],
      coverage: 'recent-window',
      upstreamCount: 1,
      bodyMissing: 0,
      imageBlocked: 0,
    };
    const before = await prisma.article.findUniqueOrThrow({
      where: { id: identity.id },
    });
    const backups = (createVerifiedSqliteBackup as jest.Mock).mock.calls.length;
    expect(
      await trpc.syncCachedWechat2RssPage(mpId, incoming, false, {
        fetchMedia: false,
      }),
    ).toMatchObject({ created: 0, updated: 0, bodyMissing: 1 });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: identity.id } }),
    ).toEqual(before);
    expect((createVerifiedSqliteBackup as jest.Mock).mock.calls.length).toBe(
      backups,
    );
    const added = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=798&idx=1',
    );
    const mixed = {
      ...incoming,
      articles: [
        ...incoming.articles,
        {
          ...added,
          title: 'safe-new-peer',
          publishTime: 1760000000,
          contentHtml: '<div class="rich_media_content"><p>new</p></div>',
          picUrl: '',
        },
      ],
      upstreamCount: 2,
    } as ProviderPage;
    expect(
      await trpc.syncCachedWechat2RssPage(mpId, mixed, false, {
        fetchMedia: false,
      }),
    ).toMatchObject({ created: 1, updated: 0, bodyMissing: 1 });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: identity.id } }),
    ).toEqual(before);
  });
  it('runs all 14 through the actual automatic cache entry; unchanged 21 are no-op, local failure isolates, media stays offline and replay is idempotent', async () => {
    const ids = Array.from(
      { length: 14 },
      (_, i) => `MP_WXS_${4234567800 + i}`,
    );
    const pages = new Map<string, ProviderPage>();
    for (const [i, id] of ids.entries()) {
      await prisma.feed.create({
        data: {
          id,
          mpName: `automatic-${i}`,
          mpIntro: '',
          mpCover: '',
          collectionChannel: 'wechat2rss',
          status: 1,
          updateTime: 0,
        },
      });
      const articles = Array.from({ length: i === 0 ? 21 : 1 }, (_, j) => ({
        ...canonicalArticleUrl(
          `https://mp.weixin.qq.com/s?__biz=${Buffer.from(id.slice(7)).toString('base64')}&mid=${800 + j}&idx=1`,
        ),
        title: `automatic-${i}-${j}`,
        publishTime: 1760000000,
        contentHtml: '<div class="rich_media_content"><p>cached body</p></div>',
        picUrl: '',
      }));
      pages.set(id, {
        articles,
        coverage: 'recent-window',
        upstreamCount: articles.length,
        bodyMissing: 0,
        imageBlocked: 0,
      });
      if (i === 0)
        for (const article of articles)
          await prisma.article.create({
            data: {
              id: article.id,
              mpId: id,
              title: article.title,
              publishTime: article.publishTime,
              sourceUrl: article.url,
              verifiedSourceUrl: article.url,
              picUrl: '',
              contentHtml: article.contentHtml,
              lastBodyStatus: 'available',
              metrics: '{"personal":true}',
            },
          });
      if (i === 1) {
        const article = articles[0];
        const time = new Date('2026-01-01');
        await prisma.article.create({
          data: {
            id: article.id,
            mpId: id,
            title: article.title,
            publishTime: article.publishTime,
            sourceUrl: article.url,
            verifiedSourceUrl: article.url,
            contentHtml: null,
            picUrl: '',
            lastBodyStatus: 'unavailable',
            createdAt: time,
            updatedAt: time,
          },
        });
        article.contentHtml =
          '<div class="rich_media_content"><p>safe missing fill</p><img src="https://mmbiz.qpic.cn/safe.png"></div>';
      }
    }
    const originalRows = await prisma.article.findMany({
      where: { mpId: ids[0] },
    });
    const network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    const provider = {
      fetchArticles: jest.fn((id: string) => Promise.resolve(pages.get(id)!)),
    };
    const providerSpy = jest
      .spyOn(providerRegistry, 'wechat2RssProvider')
      .mockReturnValue(provider as any);
    const localCacheSpy = jest
      .spyOn(localCache, 'readLocalWechat2RssCache')
      .mockImplementation(async (id) => pages.get(id)!);
    const oldSaver = jest.spyOn(trpc as any, 'refreshMpArticlesAndUpdateFeed');
    const protectedSaver = jest.spyOn(trpc as any, 'recordCollectionResult');
    const originalSync = trpc.syncCachedWechat2RssPage.bind(trpc);
    let failSave = true;
    const sync = jest
      .spyOn(trpc, 'syncCachedWechat2RssPage')
      .mockImplementation(async (id, page, listOnly, options) => {
        if (id === ids[2] && failSave)
          throw new Error('synthetic local save failure');
        return originalSync(id, page, listOnly, options);
      });
    let now = new Date('2026-10-12T01:15:00Z').getTime();
    const manager = new Wechat2RssSubscriptionBatches(
      () => path.join(root, 'test.db'),
      () => 'automatic-entry-fixture',
      jest.fn(),
      async () => null,
      async () => null,
      () => now,
    );
    const stages: Array<[string, string]> = [];
    manager.attachRefresh(async (id, stage, _automatic, options) => {
      stages.push([id, stage]);
      if (stage === 'submit')
        return {
          state: 'waiting',
          accepted: true,
          message: 'offline accepted fixture',
        };
      return (trpc as any).runManualRefresh(
        id,
        stage,
        !options?.cacheOnly,
        options,
      );
    });
    try {
      const batch = await manager.enqueueRefresh(ids, 'e'.repeat(64));
      const before = protectedSaver.mock.calls.length;
      // This is the production runManualRefresh automatic cache branch.
      expect(
        await (trpc as any).runManualRefresh(ids[0], 'cache', true),
      ).toMatchObject({ state: 'succeeded' });
      expect(protectedSaver.mock.calls.length).toBe(before);
      for (let i = 0; i < 35; i++) {
        await manager.runDue();
        now += 30000;
      }
      const done = (await manager.list()).find(
        (b) => b.batchId === batch.batchId,
      )!;
      expect(done.state).toBe('running');
      expect(done.items.filter((i) => i.state === 'waiting')).toHaveLength(1);
      expect(done.items[2]).toMatchObject({
        accepted: true,
        cacheOnly: true,
        stopBatch: false,
        failurePoint: 'cache-save',
        failureReason: 'CACHE_UNKNOWN_ERROR',
      });
      expect(done.items.filter((i) => i.state === 'succeeded')).toHaveLength(
        13,
      );
      // Release only the synthetic storage failure. Recovery must use local
      // cache and the real SQLite merge, without fetching or submitting again.
      failSave = false;
      now = done.items[2].refreshAfter!;
      const readsBeforeRecovery = provider.fetchArticles.mock.calls.length;
      await manager.runDue();
      const recovered = (await manager.list()).find(
        (b) => b.batchId === batch.batchId,
      )!;
      expect(recovered.state).toBe('completed');
      expect(recovered.items.every((i) => i.state === 'succeeded')).toBe(true);
      expect(localCacheSpy).toHaveBeenCalledWith(ids[2], 'automatic-2');
      expect(provider.fetchArticles.mock.calls).toHaveLength(
        readsBeforeRecovery,
      );
      expect(stages.filter(([, stage]) => stage === 'submit')).toHaveLength(14);
      expect(
        new Set(
          stages.filter(([, stage]) => stage === 'cache').map(([id]) => id),
        ).size,
      ).toBe(14);
      expect(
        await prisma.article.findMany({ where: { mpId: ids[0] } }),
      ).toEqual(originalRows);
      expect(
        (
          await prisma.article.findUniqueOrThrow({
            where: { id: pages.get(ids[1])!.articles[0].id },
          })
        ).contentHtml,
      ).toContain('safe missing fill');
      const count = await prisma.article.count();
      const backups = (createVerifiedSqliteBackup as jest.Mock).mock.calls
        .length;
      for (const id of ids.filter((id) => id !== ids[2]))
        await (trpc as any).runManualRefresh(id, 'cache', true);
      expect(await prisma.article.count()).toBe(count);
      expect((createVerifiedSqliteBackup as jest.Mock).mock.calls.length).toBe(
        backups,
      );
      expect(oldSaver).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      manager.close();
      sync.mockRestore();
      providerSpy.mockRestore();
      localCacheSpy.mockRestore();
      network.mockRestore();
      oldSaver.mockRestore();
      protectedSaver.mockRestore();
    }
  }, 60000);
  it('background media supplements only missing bytes, resumes partial progress and preserves edits', async () => {
    const id = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=880&idx=1',
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const inline = 'data:image/png;base64,' + png.toString('base64');
    const saved =
      '<div class="rich_media_content" style="color:red"><p>personal note</p><img src="' +
      inline +
      '"><img src="https://mmbiz.qpic.cn/b.jpg"><img src="https://mmbiz.qpic.cn/c.jpg"></div>';
    await prisma.article.create({
      data: {
        id: id.id,
        mpId: id.mpId,
        title: 'media-fixture',
        publishTime: 1760000000,
        picUrl: '',
        sourceUrl: id.url,
        verifiedSourceUrl: id.url,
        contentHtml: saved,
        metrics: '{"note":"keep"}',
        lastBodyStatus: 'available',
      },
    });
    const incoming: ProviderPage = {
      ...page(null),
      bodyMissing: 0,
      articles: [
        {
          ...id,
          title: 'media-fixture',
          publishTime: 1760000000,
          picUrl: '',
          contentHtml:
            '<div class="rich_media_content"><p>provider text</p><img src="https://mmbiz.qpic.cn/a.jpg"><img src="https://mmbiz.qpic.cn/b.jpg"><img src="https://mmbiz.qpic.cn/c.jpg"></div>',
        },
      ],
    };
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-12T04:00:00Z'));
    const request = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => {
        if (String(url).endsWith('c.jpg')) throw Error('OFFLINE_SINGLE_IMAGE');
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      });
    try {
      const partial = await trpc.syncCachedWechat2RssPage(
        mpId,
        incoming,
        false,
      );
      expect(partial.localMediaPendingArticleCount).toBe(1);
      expect(request).toHaveBeenCalledTimes(2);
      let stored = await prisma.article.findUniqueOrThrow({
        where: { id: id.id },
      });
      expect(stored.contentHtml).toContain('personal note');
      expect(stored.contentHtml).toContain('color:red');
      expect(stored.metrics).toBe('{"note":"keep"}');
      expect(stored.contentHtml?.match(/data:image/g)).toHaveLength(2);
      request.mockClear();
      request.mockImplementation(
        async () =>
          new Response(png, { headers: { 'Content-Type': 'image/png' } }),
      );
      await trpc.syncCachedWechat2RssPage(mpId, incoming, false);
      expect(request).toHaveBeenCalledTimes(1);
      expect(String(request.mock.calls[0][0])).toContain('c.jpg');
      stored = await prisma.article.findUniqueOrThrow({ where: { id: id.id } });
      expect(stored.contentHtml?.match(/data:image/g)).toHaveLength(3);
      expect(stored.contentHtml).toContain('personal note');
      request.mockClear();
      const noOp = await trpc.syncCachedWechat2RssPage(mpId, incoming, false);
      expect(noOp.mediaReady).toBe(true);
      expect(noOp.updated).toBe(0);
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      clock.mockRestore();
    }
  });
  it('unchanged upstream requeues an actual SQLite media gap without rewriting the list or notes', async () => {
    const { CacheSyncEngine } = await import('./cache-sync-engine');
    const id = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=881&idx=1',
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const body =
      '<div class="rich_media_content"><p>saved edit</p><img data-src="https://mmbiz.qpic.cn/reconcile"></div>';
    const snapshot: ProviderPage = {
      ...page(body),
      articles: [
        {
          ...id,
          title: 'reconcile',
          publishTime: 1760000000,
          picUrl: '',
          contentHtml: body,
        },
      ],
    };
    await prisma.article.create({
      data: {
        id: id.id,
        mpId: id.mpId,
        picUrl: '',
        title: 'reconcile',
        publishTime: 1760000000,
        sourceUrl: id.url,
        verifiedSourceUrl: id.url,
        contentHtml: body,
        metrics: '{"note":"keep"}',
      },
    });
    let now = Date.parse('2026-10-12T04:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const network = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(png, { headers: { 'Content-Type': 'image/png' } }),
      );
    const metadata = {
      feedId: mpId,
      name: 'fixture',
      feedUrl: '/feed/1234567890.json',
      checkTime: null,
      nextUpdateTime: null,
      paused: false,
    };
    const sync = jest.fn((id: string, p: ProviderPage, listOnly: boolean) =>
      trpc.syncCachedWechat2RssPage(id, p, listOnly),
    );
    const syncText = jest.fn((id: string, p: ProviderPage) =>
      trpc.syncCachedWechat2RssPage(id, p, false, { fetchMedia: false }),
    );
    let mediaEnabled = true;
    const queries = jest.spyOn(prisma, '$queryRaw');
    const flagQueries = () =>
      queries.mock.calls.filter((args) =>
        String((args[0] as any).sql || args[0]).includes(
          'cache_body_media_flags',
        ),
      );
    const engine = new CacheSyncEngine({
      now: () => now,
      list: async () => [metadata],
      localFeeds: async () => [{ id: mpId, mpName: 'fixture' }],
      read: async () => snapshot,
      sync,
      syncText,
      mediaEnabled: () => mediaEnabled,
    });
    const settle = async () => {
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (!(engine as any).mediaBusy) break;
      }
    };
    try {
      await engine.tick();
      await settle();
      expect(network).toHaveBeenCalledTimes(1);
      await prisma.article.update({
        where: { id: id.id },
        data: { contentHtml: body },
      });
      network.mockClear();
      syncText.mockClear();
      queries.mockClear();
      mediaEnabled = false;
      now += 60000;
      await engine.tick();
      await settle();
      expect(syncText).toHaveBeenCalledTimes(1);
      expect(flagQueries()).toHaveLength(1);
      expect(network).not.toHaveBeenCalled();
      mediaEnabled = true;
      await engine.tick();
      await settle();
      expect(network).toHaveBeenCalledTimes(1);
      expect(sync.mock.calls.filter((args) => args[2])).toHaveLength(1);
      const stored = await prisma.article.findUniqueOrThrow({
        where: { id: id.id },
      });
      expect(stored.contentHtml).toContain('saved edit');
      expect(stored.contentHtml).toContain('data:image/png');
      expect(stored.metrics).toBe('{"note":"keep"}');
      now += 60000;
      network.mockClear();
      syncText.mockClear();
      queries.mockClear();
      await engine.tick();
      await settle();
      expect(network).not.toHaveBeenCalled();
      expect(syncText).toHaveBeenCalledTimes(1);
      expect(flagQueries()).toHaveLength(1);
    } finally {
      engine.close();
      network.mockRestore();
      clock.mockRestore();
      queries.mockRestore();
    }
  });
  it('a bounded internal night permit downloads once; ordinary night and operational pause remain closed', async () => {
    const id = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=882&idx=1',
    );
    const body =
      '<div class="rich_media_content"><p>saved night edit</p><img src="https://mmbiz.qpic.cn/night-permit"></div>';
    const snapshot: ProviderPage = {
      ...page(body),
      articles: [
        {
          ...id,
          title: 'night',
          publishTime: 1760000000,
          picUrl: '',
          contentHtml: body,
        },
      ],
    };
    await prisma.article.create({
      data: {
        id: id.id,
        mpId: id.mpId,
        picUrl: '',
        title: 'night',
        publishTime: 1760000000,
        sourceUrl: id.url,
        verifiedSourceUrl: id.url,
        contentHtml: body,
      },
    });
    const now = Date.parse('2026-10-12T17:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const network = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(png, { headers: { 'Content-Type': 'image/png' } }),
      );
    const old = process.env.WECHAT2RSS_CACHE_MEDIA;
    try {
      await trpc.syncCachedWechat2RssPage(mpId, snapshot, false);
      expect(network).not.toHaveBeenCalled();
      process.env.WECHAT2RSS_CACHE_MEDIA = '0';
      await trpc.syncCachedWechat2RssPage(mpId, snapshot, false, {
        nightMediaUntil: now + 60000,
      });
      expect(network).not.toHaveBeenCalled();
      delete process.env.WECHAT2RSS_CACHE_MEDIA;
      await trpc.syncCachedWechat2RssPage(mpId, snapshot, false, {
        nightMediaUntil: now + 60000,
      });
      expect(network).toHaveBeenCalledTimes(1);
      const stored = await prisma.article.findUniqueOrThrow({
        where: { id: id.id },
      });
      expect(stored.contentHtml).toContain('saved night edit');
      await expect(
        trpc.syncCachedWechat2RssPage(mpId, snapshot, false, {
          nightMediaUntil: now + 31 * 60000,
        }),
      ).rejects.toThrow('MEDIA_NIGHT_PERMIT_INVALID');
      await expect(
        trpc.syncCachedWechat2RssPage(mpId, snapshot, false, {
          nightMediaUntil: now,
        }),
      ).rejects.toThrow('MEDIA_NIGHT_PERMIT_INVALID');
    } finally {
      if (old === undefined) delete process.env.WECHAT2RSS_CACHE_MEDIA;
      else process.env.WECHAT2RSS_CACHE_MEDIA = old;
      network.mockRestore();
      clock.mockRestore();
    }
  });
  it('CDN restriction persists before a failed SQLite transaction; retry preserves edited body and starts no request', async () => {
    const { MediaSafetyStop } = await import('./media-safety-stop');
    const id = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=883&idx=1',
    );
    const body =
      '<div class="rich_media_content"><p>edited transaction note</p><img src="https://mmbiz.qpic.cn/risk-before-transaction"></div>';
    const snapshot: ProviderPage = {
      ...page(body),
      articles: [
        {
          ...id,
          title: 'risk',
          publishTime: 1760000000,
          picUrl: '',
          contentHtml: body,
        },
      ],
    };
    await prisma.article.create({
      data: {
        id: id.id,
        mpId: id.mpId,
        picUrl: '',
        title: 'risk',
        publishTime: 1760000000,
        sourceUrl: id.url,
        verifiedSourceUrl: id.url,
        contentHtml: body,
        metrics: '{"note":"protected"}',
      },
    });
    const before = await prisma.article.findUniqueOrThrow({
      where: { id: id.id },
    });
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-12T04:00:00Z'));
    const network = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 403 }));
    const transaction = jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(Error('SYNTHETIC_TRANSACTION_FAILURE'));
    try {
      await expect(
        trpc.syncCachedWechat2RssPage(mpId, snapshot, false),
      ).rejects.toThrow('SYNTHETIC_TRANSACTION_FAILURE');
      expect(network).toHaveBeenCalledTimes(1);
      const restarted = new MediaSafetyStop();
      await restarted.initialize(process.env.DATABASE_URL!);
      expect(restarted.isBlocked()).toBe(true);
      expect(
        await prisma.article.findUniqueOrThrow({ where: { id: id.id } }),
      ).toEqual(before);
      network.mockClear();
      transaction.mockRestore();
      const retry = await trpc.syncCachedWechat2RssPage(mpId, snapshot, false);
      expect(retry.mediaReady).toBe(false);
      expect(network).not.toHaveBeenCalled();
      const after = await prisma.article.findUniqueOrThrow({
        where: { id: id.id },
      });
      expect(after.contentHtml).toContain('edited transaction note');
      expect(after.metrics).toBe(before.metrics);
    } finally {
      transaction.mockRestore();
      network.mockRestore();
      clock.mockRestore();
    }
  });
});
