import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { TrpcService } from '../trpc/trpc.service';
import { XiaohongshuService } from './xiaohongshu.service';
import { canonicalArticleUrl } from './collection-format';
import * as registry from './provider-registry';
import {
  readOwnerSearchConfig,
  fetchLiveOwnerArticles,
} from './owner-search-update';
import { fetchOwnerWereadLatest } from './owner-weread-latest';
import { continueVerifiedWereadCandidate } from './weread-publisher-validation';
import { fetchMp2RssRecent20 } from './mp2rss';
import { fetchArticleBody } from './article-body-retry';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { ProviderPage } from './subscription-provider';

jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));
jest.mock('./owner-search-update', () => ({
  ...jest.requireActual('./owner-search-update'),
  readOwnerSearchConfig: jest.fn(),
  fetchLiveOwnerArticles: jest.fn(),
}));
jest.mock('./owner-weread-latest', () => ({
  fetchOwnerWereadLatest: jest.fn(),
}));
jest.mock('./weread-publisher-validation', () => ({
  continueVerifiedWereadCandidate: jest.fn(),
}));
jest.mock('./mp2rss', () => ({ fetchMp2RssRecent20: jest.fn() }));
jest.mock('./article-body-retry', () => ({
  ...jest.requireActual('./article-body-retry'),
  fetchArticleBody: jest.fn(),
}));

// Every transport is injected above. These fixtures never contain real rows,
// credentials, exported files or database copies, and never contact a platform.
describe('ordinary collection boundaries on synthetic SQLite', () => {
  const env = { ...process.env };
  const mpId = 'MP_WXS_1234567890';
  let root: string,
    database: string,
    db: PrismaClient,
    collection: CollectionService,
    trpc: TrpcService;
  let page: ProviderPage;
  const backup = createVerifiedSqliteBackup as jest.Mock;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-collection-'));
    database = path.join(root, 'synthetic.db');
    db = new PrismaClient({ datasources: { db: { url: 'file:' + database } } });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const sql = await fs
        .readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await db.$executeRawUnsafe(statement);
    }
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = {
      ...env,
      DATABASE_URL: 'file:' + database,
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
    };
    backup.mockRejectedValue(Error('SYNTHETIC_FULL_BACKUP_QUOTA'));
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_feed_commit');
    await db.article.deleteMany();
    await db.feed.deleteMany();
    await db.xhsNote.deleteMany();
    await db.xhsCreator.deleteMany();
    await db.$executeRawUnsafe('DELETE FROM cache_refresh_commits');
    await db.feed.create({
      data: {
        id: mpId,
        mpName: 'fixture',
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
        collectionChannel: 'owner-web-search',
      },
    });
    page = {
      coverage: 'recent-window',
      bodyMissing: 0,
      imageBlocked: 0,
      upstreamCount: 2,
      articles: [1, 2].map((n) => ({
        ...canonicalArticleUrl(
          `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${n}&idx=1`,
        ),
        title: 'fixture ' + n,
        publishTime: 1700000000 + n,
        picUrl: '',
        contentHtml: '<div id="js_content"><p>synthetic body</p></div>',
      })),
    };
    (readOwnerSearchConfig as jest.Mock).mockResolvedValue({});
    for (const fn of [
      fetchLiveOwnerArticles,
      fetchOwnerWereadLatest,
      continueVerifiedWereadCandidate,
    ])
      (fn as jest.Mock).mockResolvedValue(page);
    (fetchMp2RssRecent20 as jest.Mock).mockResolvedValue(page.articles);
    collection = new CollectionService(db as any);
    trpc = new TrpcService(
      db as any,
      { get: () => ({ url: '', updateDelayTime: 0 }) } as any,
      {} as any,
      collection,
    );
  });
  afterEach(async () => {
    trpc.onModuleDestroy();
    jest.restoreAllMocks();
    process.env = { ...env };
  });
  afterAll(async () => {
    await db.$disconnect();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const receipts = () =>
    db.$queryRawUnsafe<any[]>('SELECT * FROM cache_refresh_commits');
  const integrity = async () => {
    expect(await db.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  };

  it.each(['owner-web-search', 'owner-weread-latest'])(
    'ordinary %s outer + inner entry uses zero snapshots and deduplicates',
    async (channel) => {
      await db.feed.update({
        where: { id: mpId },
        data: { collectionChannel: channel },
      });
      await trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual');
      await trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual');
      expect(backup).not.toHaveBeenCalled();
      expect(await db.article.count()).toBe(2);
      expect(await receipts()).toHaveLength(1);
      expect(
        JSON.parse(
          (await db.feed.findUniqueOrThrow({ where: { id: mpId } }))
            .lastCollectionResult!,
        ),
      ).toMatchObject({ status: 'partial' });
      await integrity();
    },
  );

  it('verified new-publisher continuation uses the same transaction and receipt table', async () => {
    await db.feed.update({
      where: { id: mpId },
      data: { collectionChannel: 'owner-weread-latest' },
    });
    await collection.collectVerifiedWereadCandidate({
      candidate: { mpId, name: 'fixture' },
    } as any);
    expect(backup).not.toHaveBeenCalled();
    expect(await receipts()).toHaveLength(1);
  });

  it('late SQL failure rolls back articles, feed time and commit receipt together', async () => {
    const before = await db.feed.findUniqueOrThrow({ where: { id: mpId } });
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fail_feed_commit BEFORE UPDATE ON feeds BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END`,
    );
    await expect(collection.collectOwnerSearch(mpId)).rejects.toThrow();
    expect(await db.article.count()).toBe(0);
    expect(await receipts()).toHaveLength(0);
    expect(await db.feed.findUniqueOrThrow({ where: { id: mpId } })).toEqual(
      before,
    );
    expect(backup).not.toHaveBeenCalled();
    await integrity();
  });

  it('lost SQL acknowledgement retains the committed receipt; a later local cache save cannot duplicate rows', async () => {
    const transaction = db.$transaction.bind(db);
    jest
      .spyOn(db, '$transaction')
      .mockImplementationOnce(async (...args: any[]) => {
        await (transaction as any)(...args);
        throw Error('SYNTHETIC_ACK_LOST');
      });
    await expect(collection.collectOwnerSearch(mpId)).rejects.toThrow(
      'SYNTHETIC_ACK_LOST',
    );
    expect(await db.article.count()).toBe(2);
    expect(await receipts()).toHaveLength(1);
    await collection.collectOwnerSearch(mpId);
    expect(await db.article.count()).toBe(2);
    expect(await receipts()).toHaveLength(1);
    await integrity();
  });

  it('two clients serialize local saves without duplicate identities', async () => {
    const other = new PrismaClient({
      datasources: { db: { url: 'file:' + database } },
    });
    try {
      await Promise.all([
        collection.collectOwnerSearch(mpId),
        new CollectionService(other as any).collectOwnerSearch(mpId),
      ]);
    } finally {
      await other.$disconnect();
    }
    expect(await db.article.count()).toBe(2);
    expect(await receipts()).toHaveLength(1);
    await integrity();
  });

  it('outer failure receipt cannot overwrite a committed owner result after acknowledgement loss', async () => {
    const transaction = db.$transaction.bind(db);
    let calls = 0;
    jest
      .spyOn(db, '$transaction')
      .mockImplementation(async (...args: any[]) => {
        const result = await (transaction as any)(...args);
        if (++calls === 2) throw Error('SYNTHETIC_ACK_LOST');
        return result;
      });
    await expect(
      trpc.refreshMpArticlesAndUpdateFeed(mpId, 1, 'local-manual'),
    ).rejects.toThrow('SYNTHETIC_ACK_LOST');
    const saved = await db.feed.findUniqueOrThrow({ where: { id: mpId } });
    expect(JSON.parse(saved.lastCollectionResult!)).toMatchObject({
      status: 'partial',
      created: 2,
    });
    expect(await db.article.count()).toBe(2);
    expect(await receipts()).toHaveLength(1);
    expect(fetchLiveOwnerArticles).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
  });

  it('low disk stops a body retry before transport and leaves old data unchanged', async () => {
    const item = page.articles[0];
    await db.article.create({
      data: {
        id: item.id,
        mpId,
        title: item.title,
        picUrl: '',
        publishTime: item.publishTime,
        sourceUrl: item.url,
        verifiedSourceUrl: item.url,
      },
    });
    const before = await db.article.findMany();
    jest
      .spyOn(fs, 'statfs')
      .mockResolvedValue({ bavail: 0n, bsize: 4096n } as any);
    await expect(collection.retryArticleBody(item.id)).rejects.toThrow(
      'INCREMENTAL_DISK_SPACE_INSUFFICIENT',
    );
    expect(fetchArticleBody).not.toHaveBeenCalled();
    expect(await db.article.findMany()).toEqual(before);
    expect(backup).not.toHaveBeenCalled();
  });

  it('a body SQL acknowledgement failure is propagated without a second failure transaction or fetch', async () => {
    const item = page.articles[0];
    await db.article.create({
      data: {
        id: item.id,
        mpId,
        title: item.title,
        picUrl: '',
        publishTime: item.publishTime,
        sourceUrl: item.url,
        verifiedSourceUrl: item.url,
      },
    });
    (fetchArticleBody as jest.Mock).mockResolvedValue({
      contentHtml: item.contentHtml,
      verifiedSourceUrl: item.url,
      originalPublishTime: item.publishTime,
    });
    const transaction = db.$transaction.bind(db);
    let calls = 0;
    jest
      .spyOn(db, '$transaction')
      .mockImplementation(async (...args: any[]) => {
        const result = await (transaction as any)(...args);
        if (++calls === 2) throw Error('SYNTHETIC_ACK_LOST');
        return result;
      });
    await expect(collection.retryArticleBody(item.id)).rejects.toThrow(
      'SYNTHETIC_ACK_LOST',
    );
    expect(calls).toBe(2);
    expect(fetchArticleBody).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        (await db.article.findUniqueOrThrow({ where: { id: item.id } }))
          .lastBodyRetry!,
      ),
    ).toMatchObject({ status: 'available' });
  });

  it('bound Mp2RSS is zero snapshot; explicit source change keeps one independent gate', async () => {
    await db.feed.update({
      where: { id: mpId },
      data: { collectionChannel: 'mp2rss' },
    });
    await collection.collectMp2RssRecent20({ mpId, mpName: 'fixture' });
    expect(backup).not.toHaveBeenCalled();
    await db.feed.update({
      where: { id: mpId },
      data: { collectionChannel: 'owner-web-search' },
    });
    await expect(
      collection.collectMp2RssRecent20({ mpId, mpName: 'fixture' }),
    ).rejects.toThrow('SYNTHETIC_FULL_BACKUP_QUOTA');
    expect(backup).toHaveBeenCalledTimes(1);
    backup.mockResolvedValue({});
    await collection.collectMp2RssRecent20({ mpId, mpName: 'fixture' });
    expect(backup).toHaveBeenCalledTimes(2);
    await integrity();
  });

  it('bound public albums use zero snapshots; changing the album set needs exactly one gate', async () => {
    const ids = ['2527940920407949313'];
    await db.feed.update({
      where: { id: mpId },
      data: {
        collectionChannel: 'public-album',
        publicAlbumIds: JSON.stringify(ids),
      },
    });
    jest.spyOn(registry, 'publicAlbumProvider').mockReturnValue({
      fetchArticles: jest
        .fn()
        .mockResolvedValue({ ...page, albums: [], pages: 1 }),
    } as any);
    (fetchArticleBody as jest.Mock).mockImplementation(async (item) => ({
      contentHtml: page.articles[0].contentHtml,
      originalPublishTime: item.publishTime,
      verifiedSourceUrl: item.sourceUrl,
    }));
    // Existing complete canonical bodies need no new originals or media.
    for (const item of page.articles)
      await db.article.create({
        data: {
          id: item.id,
          mpId,
          title: item.title,
          picUrl: '',
          publishTime: item.publishTime,
          sourceUrl: item.url,
          verifiedSourceUrl: item.url,
          contentHtml: item.contentHtml,
        },
      });
    await collection.collectPublicAlbums({ mpId, albumIds: ids });
    expect(backup).not.toHaveBeenCalled();
    backup.mockResolvedValue({});
    await collection.collectPublicAlbums({
      mpId,
      albumIds: [...ids, '2527940920407949314'],
    });
    expect(backup).toHaveBeenCalledTimes(1);
    await integrity();
  });

  it('XHS add/pause/read persists once with zero snapshots and no platform transport', async () => {
    const source = {
      read: jest.fn().mockResolvedValue({
        authorId: 'synthetic-author',
        evidenceVerified: true,
        pages: [
          {
            requestCursor: null,
            items: [
              {
                authorId: 'synthetic-author',
                noteId: 'synthetic-note',
                kind: 'video',
                publishedAt: 1700000000,
                title: 'synthetic',
                text: '',
                textStatus: 'full',
                expectedImageCount: 0,
                images: [],
              },
            ],
            nextCursor: null,
            supplierReportedEnd: true,
          },
        ],
      }),
    };
    const xhs = new XiaohongshuService(db as any, source as any);
    const added = await xhs.add(
      'fixture',
      'https://www.xiaohongshu.com/user/profile/synthetic',
    );
    await xhs.edit(added.creator.id, false);
    expect((await xhs.refresh(added.creator.id)).status).toBe('paused');
    await xhs.edit(added.creator.id, true);
    await xhs.refresh(added.creator.id);
    await xhs.refresh(added.creator.id);
    expect(await db.xhsNote.count()).toBe(1);
    expect(backup).not.toHaveBeenCalled();
    await integrity();
  });
});
