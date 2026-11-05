import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { findArticleListRows } from './article-list-page';
import { ConfigService } from '@nestjs/config';
import { TrpcService } from './trpc/trpc.service';
import { TrpcRouter } from './trpc/trpc.router';

jest.mock('./offline-archive', () => ({ archiveDirectory: jest.fn() }));

describe('article list metadata with real isolated SQLite, no body transfer', () => {
  let prisma: PrismaClient, directory: string;
  const queries: string[] = [];
  let delayNextReadMs = 0;
  let failNextRead = false;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wewe-list-regression-'));
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + join(directory, 'fixture.db').replace(/\\/g, '/'),
        },
      },
      log: [{ emit: 'event', level: 'query' }],
    });
    (prisma as any).$on('query', (event: { query: string }) =>
      queries.push(event.query),
    );
    prisma.$use(async (params, next) => {
      if (
        params.model === 'Article' &&
        params.action === 'findMany' &&
        failNextRead
      ) {
        failNextRead = false;
        throw new Error('isolated read failure');
      }
      if (
        params.model === 'Article' &&
        params.action === 'findMany' &&
        delayNextReadMs
      ) {
        const delay = delayNextReadMs;
        delayNextReadMs = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return next(params);
    });
    await prisma.$executeRawUnsafe(`CREATE TABLE feeds (
      id TEXT PRIMARY KEY, mp_name TEXT NOT NULL, mp_cover TEXT NOT NULL, mp_intro TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 1, sync_time INTEGER NOT NULL DEFAULT 0, update_time INTEGER NOT NULL,
      created_at DATETIME NOT NULL, updated_at DATETIME, has_history INTEGER DEFAULT 1, "order" INTEGER DEFAULT 0,
      local_directory TEXT, public_album_ids TEXT, last_collection_result TEXT, collection_channel TEXT,
      provider_refresh_attempt_time INTEGER NOT NULL DEFAULT 0, group_id TEXT)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE articles (
      id TEXT PRIMARY KEY, mp_id TEXT NOT NULL, title TEXT NOT NULL, pic_url TEXT NOT NULL, publish_time INTEGER NOT NULL,
      source_url TEXT UNIQUE, content_html TEXT, last_body_status TEXT, verified_source_url TEXT, last_body_retry TEXT,
      metrics TEXT, read_count INTEGER, like_count INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME)`);
    for (const id of ['publisher-a', 'publisher-b'])
      await prisma.feed.create({
        data: { id, mpName: id, mpCover: '', mpIntro: '', updateTime: 1 },
      });
    const bodies = [null, '', ' ', '<p>' + 'synthetic'.repeat(10000) + '</p>'];
    for (let i = 0; i < 8; i++)
      await prisma.article.create({
        data: {
          id: 'article-' + i,
          mpId: i < 4 ? 'publisher-a' : 'publisher-b',
          title: i % 2 ? 'match' : 'other',
          picUrl: '',
          publishTime: 100 + i,
          contentHtml: bodies[i % 4],
          readCount: i,
          likeCount: 0,
          lastBodyStatus: i % 4 === 3 ? 'unavailable' : null,
        },
      });
  }, 30000);
  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) {
      expect(dirname(directory)).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('wewe-list-regression-')).toBe(
        true,
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('selects the ordered page identities before reading wide metadata only for that page', async () => {
    queries.length = 0;
    await findArticleListRows(prisma, {
      take: 3,
      orderBy: [{ publishTime: 'desc' }, { id: 'desc' }],
    });
    const selects = queries.filter(
      (sql) => sql.startsWith('SELECT') && sql.includes('articles'),
    );
    expect(selects[0].split(/\bFROM\b/)[0]).not.toContain('last_body_status');
    expect(selects[0].split(/\bFROM\b/)[0]).not.toContain('metrics');
    const metadata = selects.find((sql) => sql.includes('last_body_status'));
    expect(metadata).toMatch(/\bIN\s*\(/);
    expect(metadata).not.toMatch(/ORDER BY/);
  });
  it('keeps exact summary counts and date boundaries without COUNT materializing archived body values', async () => {
    const config = new ConfigService({
      auth: { code: 'synthetic' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const service = new TrpcService(
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    const api = new TrpcRouter(
      service,
      prisma as any,
      config,
      {} as any,
      {} as any,
    ).appRouter.createCaller({ errorMsg: null, isLocal: true });
    queries.length = 0;
    expect(await api.article.summary({ mpId: 'publisher-a' })).toEqual({
      articles: 4,
      readAvailable: 4,
      likeAvailable: 4,
      cachedBodies: 3,
      oldestPublishTime: 100,
      newestPublishTime: 103,
    });
    expect(queries.filter((sql) => sql.startsWith('SELECT'))).toHaveLength(4);
    expect(queries.some((sql) => /COUNT\([^)]*content_html/i.test(sql))).toBe(
      false,
    );
  });
  it('matches old metadata/Boolean semantics for null, empty, whitespace and large retained bodies', async () => {
    const query = {
      where: { mpId: 'publisher-a' },
      orderBy: { publishTime: 'desc' as const },
      take: 4,
    };
    const old = await prisma.article.findMany({
      ...query,
      include: { feed: true },
    });
    queries.length = 0;
    const rows = await findArticleListRows(prisma, query);
    expect(
      rows.map((r) => ({
        id: r.id,
        bodyCached: r.bodyCached,
        feed: r.feed,
        status: r.lastBodyStatus,
      })),
    ).toEqual(
      old.map((r) => ({
        id: r.id,
        bodyCached: Boolean(r.contentHtml),
        feed: r.feed,
        status: r.lastBodyStatus,
      })),
    );
    expect(rows.every((r) => !('contentHtml' in r))).toBe(true);
    for (const sql of queries.filter((q) => q.startsWith('SELECT')))
      expect(sql.split(/\bFROM\b/)[0]).not.toContain('content_html');
    expect(queries.some((q) => q.startsWith('BEGIN'))).toBe(true);
  });
  it('preserves search, sort and cursor and does not cross the selected publisher', async () => {
    const query = {
      where: { mpId: 'publisher-b', title: { contains: 'match' } },
      orderBy: [{ readCount: 'desc' as const }, { id: 'desc' as const }],
      take: 2,
      cursor: { id: 'article-7' },
    };
    const before = await prisma.article.findMany(query);
    const after = await findArticleListRows(prisma, query);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.every((r) => r.mpId === 'publisher-b')).toBe(true);
    expect(
      await findArticleListRows(prisma, { where: { mpId: 'missing' } }),
    ).toEqual([]);
  });
  it('observes a subsequent body update without caching or changing article/detail data', async () => {
    const query = { where: { id: 'article-0' } };
    expect((await findArticleListRows(prisma, query))[0].bodyCached).toBe(
      false,
    );
    await prisma.article.update({
      where: { id: 'article-0' },
      data: { contentHtml: '<p>new synthetic body</p>' },
    });
    expect((await findArticleListRows(prisma, query))[0].bodyCached).toBe(true);
    expect(
      (await prisma.article.findUniqueOrThrow({ where: { id: 'article-0' } }))
        .contentHtml,
    ).toBe('<p>new synthetic body</p>');
  });
  it('keeps a real snapshot readable beyond the default five-second deadline without transferring bodies or replaying queries', async () => {
    const query = {
      where: { mpId: 'publisher-b' },
      take: 4,
      orderBy: { publishTime: 'desc' as const },
    };
    const expected = await findArticleListRows(prisma, query);
    queries.length = 0;
    delayNextReadMs = 5500;
    const started = Date.now();
    expect(await findArticleListRows(prisma, query)).toEqual(expected);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5500);
    expect(queries.filter((q) => q.startsWith('BEGIN'))).toHaveLength(1);
    expect(
      queries.filter((q) => q.startsWith('SELECT') && q.includes('articles')),
    ).toHaveLength(3);
    expect(
      queries
        .filter((q) => q.startsWith('SELECT'))
        .every((q) => !q.split(/\bFROM\b/)[0].includes('content_html')),
    ).toBe(true);
    expect(expected.every((row) => !('contentHtml' in row))).toBe(true);
    await expect(prisma.article.count()).resolves.toBe(8);
  }, 15000);
  it('reuses identical lightweight pages and deduplicates concurrent loads, then invalidates on committed article and category changes', async () => {
    const options = {
      databaseUrl: 'file:' + join(directory, 'fixture.db').replace(/\\/g, '/'),
    };
    const query = {
      where: { mpId: 'publisher-a' },
      take: 4,
      orderBy: { publishTime: 'desc' as const },
    };
    queries.length = 0;
    delayNextReadMs = 50;
    const [first, concurrent] = await Promise.all([
      findArticleListRows(prisma, query, options),
      findArticleListRows(prisma, query, options),
    ]);
    expect(concurrent).toEqual(first);
    expect(queries.filter((q) => q.startsWith('BEGIN'))).toHaveLength(1);
    queries.length = 0;
    const repeated = await findArticleListRows(prisma, query, options);
    expect(repeated).toEqual(first);
    expect(repeated).not.toBe(first);
    expect(queries).toHaveLength(0);
    await prisma.article.update({
      where: { id: 'article-0' },
      data: { contentHtml: null },
    });
    expect(
      (await findArticleListRows(prisma, query, options)).find(
        (row) => row.id === 'article-0',
      )?.bodyCached,
    ).toBe(false);
    await prisma.feed.update({
      where: { id: 'publisher-a' },
      data: { groupId: 'changed-category' },
    });
    expect(
      (await findArticleListRows(prisma, query, options))[0].feed.groupId,
    ).toBe('changed-category');
    const filtered = await findArticleListRows(
      prisma,
      { ...query, where: { mpId: 'publisher-b' } },
      options,
    );
    expect(filtered.every((row) => row.mpId === 'publisher-b')).toBe(true);
  });
  it('does not hide a fresh read failure with an invalidated old page', async () => {
    const options = {
      databaseUrl: 'file:' + join(directory, 'fixture.db').replace(/\\/g, '/'),
    };
    const query = { where: { id: 'article-0' } };
    await findArticleListRows(prisma, query, options);
    await prisma.article.update({
      where: { id: 'article-0' },
      data: { title: 'Changed after cached page' },
    });
    failNextRead = true;
    await expect(findArticleListRows(prisma, query, options)).rejects.toThrow(
      'isolated read failure',
    );
    expect((await findArticleListRows(prisma, query, options))[0].title).toBe(
      'Changed after cached page',
    );
  });
  it('expires reuse and bypasses it in WAL mode instead of trusting a stale main-file counter', async () => {
    const options = {
      databaseUrl: 'file:' + join(directory, 'fixture.db').replace(/\\/g, '/'),
    };
    const query = { where: { id: 'article-1' } };
    await findArticleListRows(prisma, query, options);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31000);
    try {
      queries.length = 0;
      await findArticleListRows(prisma, query, options);
      expect(queries.some((sql) => sql.startsWith('BEGIN'))).toBe(true);
    } finally {
      clock.mockRestore();
    }
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    try {
      queries.length = 0;
      await findArticleListRows(prisma, query, options);
      await findArticleListRows(prisma, query, options);
      expect(queries.filter((sql) => sql.startsWith('BEGIN'))).toHaveLength(2);
    } finally {
      await prisma.$queryRawUnsafe('PRAGMA journal_mode=DELETE');
    }
  });
});
