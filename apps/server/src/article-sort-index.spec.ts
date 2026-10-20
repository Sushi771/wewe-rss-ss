import { PrismaClient, Prisma } from '@prisma/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { findArticleListRows } from './article-list-page';

describe('additive global article sort index, isolated SQLite', () => {
  let prisma: PrismaClient, directory: string, migration: string;
  const events: Array<{ query: string; params: string }> = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'article-sort-index-'));
    const url = 'file:' + join(directory, 'fixture.db').replace(/\\/g, '/');
    const schema = resolve(__dirname, '../prisma/schema.prisma');
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        schema,
      ],
      {
        env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' },
        windowsHide: true,
      },
    );
    migration = await readFile(
      resolve(
        __dirname,
        '../prisma/migrations/20261020100000_article_global_sort_index/migration.sql',
      ),
      'utf8',
    );
    prisma = new PrismaClient({
      datasources: { db: { url } },
      log: [{ emit: 'event', level: 'query' }],
    });
    (prisma as any).$on('query', (e: { query: string; params: string }) =>
      events.push(e),
    );
    for (const id of ['a', 'b'])
      await prisma.feed.create({
        data: { id, mpName: id, mpCover: '', mpIntro: '', updateTime: 1 },
      });
    await prisma.managementGroup.create({
      data: { id: 'group-a', name: 'Synthetic group', platform: 'wechat' },
    });
    await prisma.feed.update({
      where: { id: 'a' },
      data: { groupId: 'group-a' },
    });
    await prisma.$transaction(
      Array.from({ length: 48 }, (_, i) =>
        prisma.article.create({
          data: {
            id: 'id-' + String(i).padStart(3, '0'),
            mpId: i % 2 ? 'a' : 'b',
            title: i % 3 ? 'match' : 'other',
            picUrl: '',
            publishTime: 100 + Math.floor(i / 4),
            contentHtml: i % 4 ? '<p>retained</p>' : null,
            readCount: i % 5,
          },
        }),
      ),
    );
    await prisma.$executeRawUnsafe('DROP INDEX articles_publish_time_id_idx');
  }, 60000);
  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function pages(
    where: Prisma.ArticleWhereInput,
    direction: 'asc' | 'desc',
  ) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const rows = await findArticleListRows(prisma, {
        where,
        orderBy: [{ publishTime: direction }, { id: direction }],
        take: 8,
        cursor: cursor ? { id: cursor } : undefined,
      });
      cursor = rows.length > 7 ? rows.pop()!.id : undefined;
      ids.push(...rows.map((r) => r.id));
    } while (cursor);
    expect(new Set(ids).size).toBe(ids.length);
    return ids;
  }
  it('preserves exact rows, tied ordering, every cursor page and filter membership', async () => {
    const filters: Prisma.ArticleWhereInput[] = [
      {},
      { mpId: 'a' },
      { publishTime: { gte: 103, lt: 109 } },
      { title: { contains: 'match' } },
      { feed: { groupId: 'group-a' } },
      { mpId: 'missing' },
    ];
    const before: string[][] = [];
    for (const direction of ['asc', 'desc'] as const)
      for (const where of filters) before.push(await pages(where, direction));
    const records = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    await prisma.$executeRawUnsafe(migration);
    let i = 0;
    for (const direction of ['asc', 'desc'] as const)
      for (const where of filters)
        expect(await pages(where, direction)).toEqual(before[i++]);
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      records,
    );
    expect(before[0]).toHaveLength(48);
    expect(before[filters.length]).toEqual([...before[0]].reverse());
  });
  it('uses the new covering index for the actual Prisma identity SQL in both directions', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      events.length = 0;
      await findArticleListRows(prisma, {
        take: 21,
        orderBy: [{ publishTime: direction }, { id: direction }],
      });
      const query = events.find(
        (e) => e.query.startsWith('SELECT') && e.query.includes('articles'),
      )!;
      const plan = await prisma.$queryRawUnsafe<Array<{ detail: string }>>(
        'EXPLAIN QUERY PLAN ' + query.query,
        ...JSON.parse(query.params),
      );
      expect(plan.map((p) => p.detail).join(' ')).toContain(
        'COVERING INDEX articles_publish_time_id_idx',
      );
      expect(plan.some((p) => p.detail.includes('TEMP B-TREE'))).toBe(false);
    }
  });
  it('maintains the index across insert, same-time title/body edits and deletion', async () => {
    await prisma.article.create({
      data: {
        id: 'new',
        mpId: 'a',
        title: 'new',
        picUrl: '',
        publishTime: 999,
      },
    });
    expect((await pages({}, 'desc'))[0]).toBe('new');
    await prisma.article.update({
      where: { id: 'new' },
      data: {
        publishTime: 100,
        title: 'edited',
        contentHtml: '<p>changed</p>',
      },
    });
    const expected = await prisma.article.findMany({
      orderBy: [{ publishTime: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(await pages({}, 'asc')).toEqual(expected.map((r) => r.id));
    await prisma.article.delete({ where: { id: 'new' } });
    expect(await pages({}, 'desc')).toHaveLength(48);
    expect(await prisma.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
  });
});
