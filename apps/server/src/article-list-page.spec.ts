import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { findArticleListRows } from './article-list-page';

describe('article list metadata with real isolated SQLite, no body transfer', () => {
  let prisma: PrismaClient, directory: string;
  const queries: string[] = [];
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
    await prisma.$executeRawUnsafe(`CREATE TABLE feeds (
      id TEXT PRIMARY KEY, mp_name TEXT NOT NULL, mp_cover TEXT NOT NULL, mp_intro TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 1, sync_time INTEGER NOT NULL DEFAULT 0, update_time INTEGER NOT NULL,
      created_at DATETIME NOT NULL, updated_at DATETIME, has_history INTEGER DEFAULT 1, "order" INTEGER DEFAULT 0,
      local_directory TEXT, public_album_ids TEXT, last_collection_result TEXT, collection_channel TEXT,
      provider_refresh_attempt_time INTEGER NOT NULL DEFAULT 0)`);
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
});
