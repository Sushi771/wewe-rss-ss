import { splitSqliteStatements } from '../../../scripts/sqlite-statements.cjs';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ArticleSchemas,
  articleFilterSchema,
  shanghaiDayStart,
  formatShanghaiPublicationTime,
} from '@wewe-rss/shared';
import { TrpcService } from './trpc/trpc.service';
import { TrpcRouter } from './trpc/trpc.router';
import { articleListWhere } from './article-list-filter';
import { dateSelectionFilter } from '../../web/src/utils/article-date-selection';

jest.mock('./offline-archive', () => ({ archiveDirectory: jest.fn() }));

describe('Shanghai calendar dates, paginated list / summary / CSV (isolated SQLite)', () => {
  let root: string,
    prisma: PrismaClient,
    api: ReturnType<TrpcRouter['appRouter']['createCaller']>;
  const start = Date.parse('2026-10-10T16:00:00Z') / 1000;
  const baseline = async () =>
    prisma.article.findMany({ orderBy: { id: 'asc' } });
  let before: Awaited<ReturnType<typeof baseline>>;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-date-filter-'));
    prisma = new PrismaClient({
      datasources: {
        db: { url: 'file:' + join(root, 'fixture.db').replace(/\\/g, '/') },
      },
    });
    const migrations = resolve(__dirname, '../prisma/migrations');
    for (const entry of (await readdir(migrations, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const sql = await readFile(
        join(migrations, entry.name, 'migration.sql'),
        'utf8',
      );
      for (const statement of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.managementGroup.create({
      data: { id: 'g', name: 'group', platform: 'wechat' },
    });
    for (const [id, groupId] of [
      ['a', 'g'],
      ['b', 'g'],
      ['c', null],
    ])
      await prisma.feed.create({
        data: {
          id: id!,
          groupId,
          mpName: `publisher-${id}`,
          mpCover: '',
          mpIntro: '',
          updateTime: 1,
        },
      });
    const times = [
      start - 1,
      start,
      start + 1,
      start + 1,
      start + 86399,
      start + 86400,
      0,
    ];
    for (let i = 0; i < times.length; i++)
      await prisma.article.create({
        data: {
          id: `a-${i}`,
          mpId: 'a',
          title: i === 2 ? 'other' : 'match',
          picUrl: '',
          publishTime: times[i],
          contentHtml: '<p>preserved body</p>',
        },
      });
    for (const id of ['b', 'c'])
      await prisma.article.create({
        data: {
          id: `${id}-1`,
          mpId: id,
          title: 'match',
          picUrl: '',
          publishTime: start + 1,
        },
      });
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: {},
    });
    const service = new TrpcService(
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    api = new TrpcRouter(
      service,
      prisma as any,
      config,
      {} as any,
      {} as any,
    ).appRouter.createCaller({ errorMsg: null, isLocal: true });
    before = await baseline();
  }, 30000);
  afterAll(async () => {
    if (prisma) {
      expect(await baseline()).toEqual(before);
      await prisma.$disconnect();
    }
    if (root) {
      expect(dirname(root)).toBe(resolve(tmpdir()));
      expect(basename(root)).toMatch(/^wewe-date-filter-/);
      await rm(root, { recursive: true, force: true });
    }
  });
  it('converts Shanghai midnight independently of the process timezone and formats publication date', () => {
    expect(shanghaiDayStart('2026-10-11')).toBe(start);
    expect(formatShanghaiPublicationTime(start - 1)).toBe('2026-10-10 23:59');
    expect(formatShanghaiPublicationTime(start)).toBe('2026-10-11 00:00');
    expect(formatShanghaiPublicationTime(0)).toBe('发布时间未知');
  });
  it('maps a single day to both full-day bounds and keeps range ends independently optional', () => {
    expect(
      dateSelectionFilter({
        mode: 'day',
        start: '2026-10-11',
        end: '2026-10-12',
      }),
    ).toEqual({ dateStart: '2026-10-11', dateEnd: '2026-10-11' });
    expect(
      dateSelectionFilter({ mode: 'range', start: '', end: '2026-10-12' }),
    ).toEqual({ dateStart: undefined, dateEnd: '2026-10-12' });
    expect(dateSelectionFilter({ mode: 'range', start: '', end: '' })).toEqual({
      dateStart: undefined,
      dateEnd: undefined,
    });
  });
  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-1-01',
    'invalid',
    '2026-10-11T00:00:00Z',
  ])('rejects invalid input %s', (dateStart) => {
    expect(ArticleSchemas.list.safeParse({ dateStart }).success).toBe(false);
    expect(articleFilterSchema.safeParse({ dateStart }).success).toBe(false);
  });
  it('rejects reversed ranges through every actual endpoint', async () => {
    const input = { dateStart: '2026-10-12', dateEnd: '2026-10-11' };
    await expect(api.article.list(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api.article.summary(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api.collection.exportMetrics(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(
      articleFilterSchema.safeParse({ dateStart: '2024-02-29' }).success,
    ).toBe(true);
  });
  it.each(['asc', 'desc'] as const)(
    'includes the entire first/last day and pages tied timestamps stably (%s)',
    async (direction) => {
      const filter = {
        mpId: 'a',
        dateStart: '2026-10-11',
        dateEnd: '2026-10-11',
        direction,
        limit: 2,
      };
      const first = await api.article.list(filter);
      const second = await api.article.list({
        ...filter,
        cursor: first.nextCursor,
      });
      const ids = [...first.items, ...second.items].map((a) => a.id);
      expect(ids).toEqual(
        direction === 'asc'
          ? ['a-1', 'a-2', 'a-3', 'a-4']
          : ['a-4', 'a-3', 'a-2', 'a-1'],
      );
      expect(second.nextCursor).toBeUndefined();
      expect(first.items.every((a) => !('contentHtml' in a))).toBe(true);
      expect((await api.article.summary(filter)).articles).toBe(4);
    },
  );
  it('combines publisher/group/keyword/date and keeps CSV in the exact visible scope', async () => {
    const filter = {
      dateStart: '2026-10-11',
      dateEnd: '2026-10-11',
      group: 'g',
      search: 'match',
    };
    const list = await api.article.list(filter);
    expect(list.items.map((a) => a.id)).toEqual(['a-4', 'b-1', 'a-3', 'a-1']);
    expect((await api.article.summary(filter)).articles).toBe(4);
    expect((await api.collection.exportMetrics(filter)).count).toBe(4);
    expect(
      (
        await api.collection.exportMetrics({
          ...filter,
          ids: ['a-1', 'c-1', 'a-5'],
        })
      ).count,
    ).toBe(1);
    expect((await api.article.list({ ...filter, mpId: 'c' })).items).toEqual(
      [],
    );
    expect(
      (await api.article.list({ ...filter, group: 'ungrouped' })).items.map(
        (a) => a.id,
      ),
    ).toEqual(['c-1']);
    expect(
      (
        await api.article.list({ ...filter, mpId: 'b', search: 'publisher-b' })
      ).items.map((a) => a.id),
    ).toEqual(['b-1']);
  });
  it('supports open date bounds and clearing restores original default ordering including unknown dates', async () => {
    expect(
      (
        await api.article.list({ mpId: 'a', dateStart: '2026-10-12' })
      ).items.map((a) => a.id),
    ).toEqual(['a-5']);
    expect(
      (await api.article.list({ mpId: 'a', dateEnd: '2026-10-10' })).items.map(
        (a) => a.id,
      ),
    ).toEqual(['a-0']);
    expect(
      (await api.article.list({ mpId: 'a' })).items.map((a) => a.id),
    ).toEqual(['a-5', 'a-4', 'a-3', 'a-2', 'a-1', 'a-0', 'a-6']);
    expect(articleListWhere({})).toEqual({
      mpId: undefined,
      publishTime: undefined,
    });
  });
});
