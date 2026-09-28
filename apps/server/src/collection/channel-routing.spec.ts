import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { resolveCollectionRoute } from './collection-channel';
import { canonicalArticleUrl } from './collection-format';
import { fetchDesktopRecent20 } from './desktop-wechat';
import { fetchPublicAlbums, resolvePublicArticle } from './public-album';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { FeedsService } from '../feeds/feeds.service';

// All writes use the explicit temporary SQLite URL below. These mocks prevent
// desktop/clipboard access, upstream requests and production backup access.
jest.mock('./desktop-wechat', () => ({ fetchDesktopRecent20: jest.fn() }));
jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));
jest.mock('./public-album', () => ({
  fetchPublicAlbums: jest.fn(),
  resolvePublicArticle: jest.fn(),
}));

const mpId = 'MP_WXS_1234567890';
const mpName = '通道路由隔离测试';
const albumIds = ['2527940920407949313'];
const binding = JSON.stringify(albumIds);
const priorResult = JSON.stringify({
  source: 'unavailable',
  status: 'blocked',
  complete: false,
});
const config = {
  get: (key: string) =>
    ({ platform: { url: '' }, feed: { updateDelayTime: 0 } })[key],
} as any;
const desktopArticles = Array.from({ length: 20 }, (_, i) => ({
  ...canonicalArticleUrl(
    `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${100 + i}&idx=1&sn=abcd`,
  ),
  rank: i + 1,
  title: `本机文章${i}`,
  publishTime: 1700000000 - i,
  shortUrl: `https://mp.weixin.qq.com/s/${String(i).padStart(22, 'a')}`,
  contentHtml: `<div id="js_content">正文${i}</div>`,
  lastBodyStatus: 'available',
  picUrl: '',
}));
const albumResult = {
  articles: [
    {
      ...canonicalArticleUrl(
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=900&idx=1&sn=album',
      ),
      title: '仅所选合集内文章',
      publishTime: 1600000000,
      picUrl: '',
    },
  ],
  pages: 1,
  albums: [{ id: albumIds[0], title: '隔离合集', pages: 1, articles: 1 }],
};

describe('persistent collection route selection', () => {
  it.each([
    [
      { collectionChannel: 'desktop-wechat', publicAlbumIds: binding },
      '',
      { channel: 'desktop-wechat', selectedBy: 'saved' },
    ],
    [
      { collectionChannel: 'public-album', publicAlbumIds: binding },
      mpId,
      { channel: 'public-album', selectedBy: 'saved' },
    ],
    [
      { collectionChannel: null, publicAlbumIds: binding },
      `other, ${mpId} , another`,
      { channel: 'desktop-wechat', selectedBy: 'environment' },
    ],
    [
      { collectionChannel: null, publicAlbumIds: binding },
      'other',
      { channel: 'public-album', selectedBy: 'legacy' },
    ],
    [
      { collectionChannel: null, localDirectory: 'C:/must-not-read' },
      '',
      { channel: 'unavailable', selectedBy: 'legacy' },
    ],
    [
      { collectionChannel: null },
      `${mpId}0`,
      { channel: 'cover', selectedBy: 'legacy' },
    ],
    [
      {
        collectionChannel: 'unknown-channel',
        publicAlbumIds: binding,
        localDirectory: 'C:/must-not-read',
      },
      mpId,
      { channel: 'unavailable', selectedBy: 'invalid' },
    ],
    [
      { collectionChannel: '' },
      mpId,
      { channel: 'unavailable', selectedBy: 'invalid' },
    ],
    [
      { collectionChannel: 'public-album', publicAlbumIds: null },
      mpId,
      { channel: 'unavailable', selectedBy: 'invalid' },
    ],
    [
      { collectionChannel: 'public-album', publicAlbumIds: '[]' },
      mpId,
      { channel: 'unavailable', selectedBy: 'invalid' },
    ],
    [
      { collectionChannel: null, publicAlbumIds: '{broken-json' },
      '',
      { channel: 'unavailable', selectedBy: 'invalid' },
    ],
    [
      { collectionChannel: null, publicAlbumIds: '[]' },
      '',
      { channel: 'unavailable', selectedBy: 'invalid' },
    ],
  ])('resolves %j with env %s to %j', (feed, environment, expected) => {
    expect(resolveCollectionRoute({ id: mpId, ...feed }, environment)).toEqual(
      expected,
    );
  });
});

describe('collection channel migration and routing in isolated SQLite', () => {
  let root: string;
  let databaseUrl: string;
  let prisma: PrismaClient;
  let collection: CollectionService;
  let trpc: TrpcService;
  let oldFeedBefore: Record<string, unknown>;
  let oldFeedAfter: Record<string, unknown>;
  let oldArticlesBefore: Record<string, unknown>[];
  let oldArticlesAfter: unknown[];
  const oldIds = process.env.WECHAT_DESKTOP_MP_IDS;
  const oldScheduled = process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED;

  const createFeed = (data: Partial<Prisma.FeedCreateInput> = {}) =>
    prisma.feed.create({
      data: {
        id: mpId,
        mpName,
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
        lastCollectionResult: priorResult,
        ...data,
      },
    });
  const readFeed = () => prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
  const readArticles = () =>
    prisma.article.findMany({ orderBy: { id: 'asc' } });
  const rebuildServices = () => {
    collection = new CollectionService(prisma as any);
    trpc = new TrpcService(prisma as any, config, {} as any, collection);
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-channel-test-'));
    databaseUrl = `file:${path.join(root, 'test.db').replace(/\\/g, '/')}`;
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      if (name === '20260927110000_collection_channel') {
        // Insert a real pre-migration row without asking the new Prisma client
        // to select its not-yet-existing collection_channel column.
        await prisma.$executeRawUnsafe(
          `INSERT INTO feeds (id, mp_name, mp_cover, mp_intro, status,
           sync_time, update_time, local_directory, public_album_ids,
           last_collection_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          mpId,
          mpName,
          'old-cover',
          'old-intro',
          0,
          19,
          1500000000,
          'C:/legacy-do-not-read',
          binding,
          priorResult,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO articles (id, mp_id, title, pic_url, publish_time,
           source_url, content_html, metrics, read_count, like_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          'legacy-preserved-id',
          mpId,
          '旧文章',
          'https://mmbiz.qpic.cn/old.jpg',
          1500000000,
          'https://mp.weixin.qq.com/s/legacy-public-link',
          '<p>旧正文与图片</p>',
          '{"read":{"value":8}}',
          8,
          0,
        );
        [oldFeedBefore] = await prisma.$queryRawUnsafe<
          Record<string, unknown>[]
        >('SELECT * FROM feeds');
        oldArticlesBefore = await prisma.$queryRawUnsafe(
          'SELECT * FROM articles',
        );
        expect(oldFeedBefore).not.toHaveProperty('collection_channel');
      }
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    // Use a fresh statement after ALTER TABLE, without cached pre-migration
    // column metadata from the earlier SELECT *.
    [oldFeedAfter] = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT feeds.* FROM feeds',
    );
    oldArticlesAfter = await prisma.$queryRawUnsafe(
      'SELECT articles.* FROM articles',
    );
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    delete process.env.WECHAT_DESKTOP_MP_IDS;
    delete process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED;
    (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
      integrityCheck: 'ok',
    });
    (fetchDesktopRecent20 as jest.Mock).mockRejectedValue(
      new Error('UNEXPECTED_DESKTOP_REQUEST'),
    );
    (fetchPublicAlbums as jest.Mock).mockRejectedValue(
      new Error('UNEXPECTED_ALBUM_REQUEST'),
    );
    (resolvePublicArticle as jest.Mock).mockRejectedValue(
      new Error('UNEXPECTED_ORIGINAL_REQUEST'),
    );
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    rebuildServices();
  });

  afterAll(async () => {
    if (oldIds === undefined) delete process.env.WECHAT_DESKTOP_MP_IDS;
    else process.env.WECHAT_DESKTOP_MP_IDS = oldIds;
    if (oldScheduled === undefined)
      delete process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED;
    else process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED = oldScheduled;
    await prisma?.$disconnect();
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-channel-test-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });

  it('adds a nullable choice without changing any old feed or article field', () => {
    expect(oldFeedBefore).toBeDefined();
    expect(oldFeedAfter).toEqual({
      ...oldFeedBefore,
      collection_channel: null,
    });
    expect(oldArticlesAfter).toEqual(
      oldArticlesBefore.map((row: Record<string, unknown>) => ({
        ...row,
        last_body_status: null,
        verified_source_url: null,
        last_body_retry: null,
      })),
    );
  });

  it('persists desktop choice across a new client and services for ordinary and cron updates', async () => {
    await createFeed({
      publicAlbumIds: binding,
      localDirectory: 'C:/never-read',
    });
    process.env.WECHAT_DESKTOP_MP_IDS = mpId;
    (fetchDesktopRecent20 as jest.Mock).mockResolvedValue(desktopArticles);
    expect(await trpc.collectDesktopRecent20(mpId)).toMatchObject({
      source: 'desktop-wechat',
      created: 20,
      complete: false,
    });
    expect(fetchDesktopRecent20).toHaveBeenLastCalledWith(mpId, mpName, {
      resumeAfterUserConsent: true,
    });
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'desktop-wechat',
      publicAlbumIds: binding,
    });
    delete process.env.WECHAT_DESKTOP_MP_IDS;
    await prisma.$disconnect();
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    rebuildServices();
    expect(
      await trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual'),
    ).toMatchObject({ source: 'desktop-wechat', created: 0, complete: false });
    expect(fetchDesktopRecent20).toHaveBeenLastCalledWith(mpId, mpName, {
      resumeAfterUserConsent: undefined,
    });
    process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED = '1';
    await new FeedsService(prisma as any, trpc, config).handleUpdateFeedsCron();
    expect(fetchDesktopRecent20).toHaveBeenCalledTimes(3);
    expect(fetchDesktopRecent20).toHaveBeenLastCalledWith(mpId, mpName, {
      resumeAfterUserConsent: undefined,
    });
    expect(fetchPublicAlbums).not.toHaveBeenCalled();
    expect(await prisma.article.count()).toBe(20);
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'desktop-wechat',
    });
    expect(JSON.parse((await readFeed()).lastCollectionResult!)).toMatchObject({
      source: 'desktop-wechat',
      status: 'partial',
      complete: false,
    });
  });

  it('keeps a disabled subscription disabled after successful desktop collection', async () => {
    await createFeed({ status: 0 });
    (fetchDesktopRecent20 as jest.Mock).mockResolvedValue(desktopArticles);
    await trpc.collectDesktopRecent20(mpId);
    expect(await readFeed()).toMatchObject({
      status: 0,
      collectionChannel: 'desktop-wechat',
    });
    process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED = '1';
    await new FeedsService(prisma as any, trpc, config).handleUpdateFeedsCron();
    expect(fetchDesktopRecent20).toHaveBeenCalledTimes(1);
  });

  it.each(['public', 'scheduled'] as const)(
    'rejects %s desktop refresh before backup, state writes or helper invocation',
    async (trigger) => {
      const before = await createFeed({
        collectionChannel: 'desktop-wechat',
        publicAlbumIds: binding,
      });
      await expect(
        trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, trigger),
      ).rejects.toThrow(
        trigger === 'public' ? '公开订阅请求不会操作桌面' : '尚未启用',
      );
      expect(await readFeed()).toEqual(before);
      expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
      expect(fetchDesktopRecent20).not.toHaveBeenCalled();
      expect(fetchPublicAlbums).not.toHaveBeenCalled();
      expect(await prisma.article.count()).toBe(0);
    },
  );

  it.each(['local-manual', 'scheduled'] as const)(
    '%s does not resume a paused desktop helper and records failure without losing the choice',
    async (trigger) => {
      await createFeed({ collectionChannel: 'desktop-wechat', status: 0 });
      process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED = '1';
      (fetchDesktopRecent20 as jest.Mock).mockRejectedValue(
        new Error('USER_PAUSED'),
      );
      await expect(
        trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, trigger),
      ).rejects.toThrow('USER_PAUSED');
      expect(fetchDesktopRecent20).toHaveBeenCalledWith(mpId, mpName, {
        resumeAfterUserConsent: undefined,
      });
      const feed = await readFeed();
      expect(feed).toMatchObject({
        collectionChannel: 'desktop-wechat',
        status: 0,
      });
      expect(JSON.parse(feed.lastCollectionResult!)).toMatchObject({
        source: 'error',
        status: 'failed',
        complete: false,
        coverage: 'none',
      });
      expect(fetchPublicAlbums).not.toHaveBeenCalled();
      expect(await prisma.article.count()).toBe(0);
    },
  );

  it('retains a saved album choice when explicit desktop collection fails', async () => {
    await createFeed({
      collectionChannel: 'public-album',
      publicAlbumIds: binding,
    });
    (fetchDesktopRecent20 as jest.Mock).mockRejectedValueOnce(
      new Error('USER_CANCELLED'),
    );
    await expect(trpc.collectDesktopRecent20(mpId)).rejects.toThrow(
      'USER_CANCELLED',
    );
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'public-album',
      publicAlbumIds: binding,
    });
    expect(JSON.parse((await readFeed()).lastCollectionResult!)).toMatchObject({
      status: 'failed',
      complete: false,
    });
    expect(await prisma.article.count()).toBe(0);
  });

  it('rolls back articles and channel together when the final feed write fails', async () => {
    const before = await createFeed({
      collectionChannel: 'public-album',
      publicAlbumIds: binding,
      status: 0,
    });
    // Real SQLite failure after the preceding article inserts; no mocked tx.
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_channel_change BEFORE UPDATE OF collection_channel
       ON feeds WHEN NEW.collection_channel = 'desktop-wechat'
       BEGIN SELECT RAISE(ABORT, 'TEST_CHANNEL_WRITE_REJECTED'); END`,
    );
    try {
      (fetchDesktopRecent20 as jest.Mock).mockResolvedValue(desktopArticles);
      await expect(
        collection.collectDesktopRecent20({ mpId, mpName }),
      ).rejects.toThrow();
      expect(await readFeed()).toEqual(before);
      expect(await prisma.article.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_channel_change');
    }
    // The operation lock is released even when the transaction aborts.
    await expect(
      collection.collectDesktopRecent20({ mpId, mpName }),
    ).resolves.toMatchObject({ created: 20, complete: false });
  });

  it('explicit album success replaces the desktop choice and wins over the environment', async () => {
    await createFeed({ collectionChannel: 'desktop-wechat', status: 0 });
    process.env.WECHAT_DESKTOP_MP_IDS = mpId;
    (fetchPublicAlbums as jest.Mock).mockResolvedValue(albumResult);
    expect(await trpc.collectPublicAlbums({ mpId, albumIds })).toMatchObject({
      source: 'public-album',
      complete: false,
    });
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'public-album',
      publicAlbumIds: binding,
      status: 0,
    });
    rebuildServices();
    expect(await trpc.refreshMpArticlesAndUpdateFeed(mpId)).toMatchObject({
      source: 'public-album',
      created: 0,
      complete: false,
    });
    expect(fetchDesktopRecent20).not.toHaveBeenCalled();
    expect(await prisma.article.count()).toBe(1);
  });

  it('failed explicit album selection preserves the prior desktop route and old article data', async () => {
    await createFeed({
      collectionChannel: 'desktop-wechat',
      publicAlbumIds: binding,
      status: 0,
    });
    await prisma.article.create({
      data: {
        id: 'outside-the-latest-window',
        mpId,
        title: '保留的旧文章',
        publishTime: 1400000000,
        picUrl: 'https://mmbiz.qpic.cn/old.jpg',
        contentHtml: '<p>旧正文</p>',
        readCount: 8,
        likeCount: 0,
      },
    });
    const before = await readArticles();
    (fetchPublicAlbums as jest.Mock).mockRejectedValueOnce(
      new Error('ALBUM_UNAVAILABLE'),
    );
    await expect(
      trpc.collectPublicAlbums({ mpId, albumIds: ['9999999999999'] }),
    ).rejects.toThrow('ALBUM_UNAVAILABLE');
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'desktop-wechat',
      publicAlbumIds: binding,
      status: 0,
    });
    expect(await readArticles()).toEqual(before);
    expect(JSON.parse((await readFeed()).lastCollectionResult!)).toMatchObject({
      status: 'failed',
      complete: false,
    });
  });

  it('legacy album binding still refreshes and becomes an explicit saved choice', async () => {
    await createFeed({ collectionChannel: null, publicAlbumIds: binding });
    (fetchPublicAlbums as jest.Mock).mockResolvedValue(albumResult);
    expect(await trpc.refreshMpArticlesAndUpdateFeed(mpId)).toMatchObject({
      source: 'public-album',
      complete: false,
    });
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'public-album',
    });
    expect(fetchDesktopRecent20).not.toHaveBeenCalled();
  });

  it.each([null, '', '[]', '{broken-json', '["invalid-id"]'])(
    'blocks saved album route with invalid binding %s without source fallback',
    async (publicAlbumIds) => {
      await createFeed({ collectionChannel: 'public-album', publicAlbumIds });
      process.env.WECHAT_DESKTOP_MP_IDS = mpId;
      const caller = new TrpcRouter(
        trpc,
        prisma as any,
        config,
        {} as any,
        collection,
      ).appRouter.createCaller({ errorMsg: null, isLocal: true } as any);
      expect(await caller.feed.byId(mpId)).toMatchObject({
        collectionChannel: 'public-album',
        collectionRoute: { channel: 'unavailable', selectedBy: 'invalid' },
      });
      expect(await trpc.refreshMpArticlesAndUpdateFeed(mpId)).toMatchObject({
        source: 'unavailable',
        status: 'blocked',
        complete: false,
        coverage: 'none',
      });
      expect(await trpc.getHistoryMpArticles(mpId)).toMatchObject({
        status: 'blocked',
        complete: false,
      });
      expect(await readFeed()).toMatchObject({
        collectionChannel: 'public-album',
        publicAlbumIds,
      });
      expect(fetchDesktopRecent20).not.toHaveBeenCalled();
      expect(fetchPublicAlbums).not.toHaveBeenCalled();
      expect(await prisma.article.count()).toBe(0);
    },
  );

  it('blocks an unknown saved route without falling back to an album, env or cover', async () => {
    await createFeed({
      collectionChannel: 'unrecognized',
      publicAlbumIds: binding,
    });
    process.env.WECHAT_DESKTOP_MP_IDS = mpId;
    expect(await trpc.refreshMpArticlesAndUpdateFeed(mpId)).toMatchObject({
      source: 'unavailable',
      status: 'blocked',
      complete: false,
    });
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'unrecognized',
    });
    expect(fetchDesktopRecent20).not.toHaveBeenCalled();
    expect(fetchPublicAlbums).not.toHaveBeenCalled();
  });

  it('never falls back to stale albums for desktop history or a non-first page', async () => {
    await createFeed({
      collectionChannel: 'desktop-wechat',
      publicAlbumIds: binding,
    });
    expect(await trpc.getHistoryMpArticles(mpId)).toMatchObject({
      source: 'unavailable',
      status: 'blocked',
      complete: false,
      coverage: 'none',
    });
    expect(
      await trpc.refreshMpArticlesAndUpdateFeed(mpId, 2, 'local-manual'),
    ).toMatchObject({
      source: 'unavailable',
      status: 'blocked',
      complete: false,
    });
    expect(fetchPublicAlbums).not.toHaveBeenCalled();
    expect(fetchDesktopRecent20).not.toHaveBeenCalled();
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'desktop-wechat',
    });
  });

  it('one-time import preserves a saved route, disabled subscription and prior attempt status', async () => {
    await createFeed({
      collectionChannel: 'desktop-wechat',
      publicAlbumIds: binding,
      status: 0,
      syncTime: 19,
    });
    const directory = path.join(root, 'import');
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, 'articles.csv'),
      'title,url,time\n一次性导入,https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=500&idx=1&sn=abc,2024-12-06 08:35:06\n',
    );
    expect(await collection.importDirectory({ directory, mpId })).toMatchObject(
      {
        source: 'local',
        complete: false,
        created: 1,
      },
    );
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'desktop-wechat',
      publicAlbumIds: binding,
      status: 0,
      syncTime: 19,
      lastCollectionResult: priorResult,
    });
    expect(fetchDesktopRecent20).not.toHaveBeenCalled();
    expect(fetchPublicAlbums).not.toHaveBeenCalled();
  });

  it('rejects concurrent public refresh without overwriting an in-flight channel switch', async () => {
    await createFeed({
      collectionChannel: 'public-album',
      publicAlbumIds: binding,
    });
    let release!: (value: typeof desktopArticles) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    (fetchDesktopRecent20 as jest.Mock).mockImplementationOnce(() => {
      markStarted();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = trpc.collectDesktopRecent20(mpId);
    await started;
    try {
      const running = await readFeed();
      expect(JSON.parse(running.lastCollectionResult!)).toMatchObject({
        status: 'running',
        complete: false,
      });
      await expect(trpc.refreshMpArticlesAndUpdateFeed(mpId)).rejects.toThrow(
        '正在采集',
      );
      expect(await readFeed()).toEqual(running);
      expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
      expect(fetchPublicAlbums).not.toHaveBeenCalled();
    } finally {
      release(desktopArticles);
      await pending;
    }
    expect(await readFeed()).toMatchObject({
      collectionChannel: 'desktop-wechat',
    });
    const completed = await readFeed();
    await expect(trpc.refreshMpArticlesAndUpdateFeed(mpId)).rejects.toThrow(
      '公开订阅请求不会操作桌面',
    );
    expect(await readFeed()).toEqual(completed);
    expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(fetchDesktopRecent20).toHaveBeenCalledTimes(1);
  });
});
