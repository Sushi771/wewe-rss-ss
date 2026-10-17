import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArticleSchemas, shanghaiDayStart } from '@wewe-rss/shared';
import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';

describe('main article filter compatibility with isolated SQLite', () => {
  let directory: string;
  let prisma: PrismaClient;
  let router: TrpcRouter;
  const start = shanghaiDayStart('2026-01-01')!;
  const config = {
    get: (key: string) =>
      key === 'platform'
        ? { url: 'http://synthetic.invalid' }
        : { updateDelayTime: 60 },
  };
  const input = {
    group: 'group-a',
    dateStart: '2026-01-01',
    dateEnd: '2026-01-01',
  };
  const caller = () =>
    router.appRouter.createCaller({ errorMsg: null, isLocal: true });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wewe-main-filter-'));
    prisma = new PrismaClient({
      datasources: { db: { url: `file:${join(directory, 'fixture.db')}` } },
    });
    await prisma.$executeRawUnsafe(`CREATE TABLE management_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, "order" INTEGER NOT NULL DEFAULT 0)`);
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
    for (const id of ['group-a', 'group-b'])
      await prisma.managementGroup.create({
        data: { id, name: id, platform: 'wechat' },
      });
    for (const [id, groupId] of [
      ['feed-a', 'group-a'],
      ['feed-b', 'group-b'],
      ['feed-u', null],
    ])
      await prisma.feed.create({
        data: {
          id: id!,
          groupId,
          mpName: id!,
          mpCover: '',
          mpIntro: '',
          updateTime: 1,
        },
      });
    for (const [id, mpId, publishTime, readCount] of [
      ['a-before', 'feed-a', start - 1, null],
      ['a-first', 'feed-a', start, 0],
      ['a-tie-b', 'feed-a', start + 60, 2],
      ['a-tie-c', 'feed-a', start + 60, 2],
      ['a-last', 'feed-a', start + 86399, 7],
      ['a-next', 'feed-a', start + 86400, 9],
      ['a-unknown', 'feed-a', 0, null],
      ['b-only', 'feed-b', start + 120, 3],
      ['u-only', 'feed-u', start + 120, 0],
    ] as const)
      await prisma.article.create({
        data: {
          id,
          mpId,
          publishTime,
          readCount,
          likeCount: 0,
          picUrl: '',
          title: id === 'a-last' ? 'needle' : id,
          contentHtml:
            id === 'a-first' ? '<p>synthetic retained body</p>' : null,
        },
      });
    const service = new TrpcService(
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
    router = new TrpcRouter(
      service,
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('retains the deployed group/date/direction keys in the actual shared schema', () => {
    expect(
      ArticleSchemas.list.parse({ ...input, direction: 'asc' }),
    ).toMatchObject({ ...input, direction: 'asc' });
  });
  it('applies Shanghai day bounds and group membership to list and summary', async () => {
    const result = await caller().article.list({
      ...input,
      direction: 'asc',
      limit: 20,
    });
    expect(result.items.map((item) => item.id)).toEqual([
      'a-first',
      'a-tie-b',
      'a-tie-c',
      'a-last',
    ]);
    expect(result.items[0].bodyCached).toBe(true);
    expect(result.items[0]).not.toHaveProperty('contentHtml');
    expect(await caller().article.summary(input)).toMatchObject({
      articles: 4,
      readAvailable: 4,
      likeAvailable: 4,
      cachedBodies: 1,
      oldestPublishTime: start,
      newestPublishTime: start + 86399,
    });
  });
  it.each([
    [{ group: 'ungrouped' }, ['u-only']],
    [{ group: 'group-b' }, ['b-only']],
    [{ ...input, search: 'needle' }, ['a-last']],
    [{ ...input, mpId: 'feed-b' }, []],
    [
      { ...input, search: 'feed-a' },
      ['a-last', 'a-tie-c', 'a-tie-b', 'a-first'],
    ],
  ] as const)(
    'keeps list and summary in the same scope: %j',
    async (scope, expected) => {
      expect(
        (await caller().article.list({ ...scope, limit: 20 })).items.map(
          (item) => item.id,
        ),
      ).toEqual(expected);
      expect((await caller().article.summary(scope)).articles).toBe(
        expected.length,
      );
    },
  );
  it('retains the unseen cursor and stable ID tie break across ascending pages', async () => {
    const first = await caller().article.list({
      ...input,
      direction: 'asc',
      limit: 2,
    });
    expect(first.items.map((item) => item.id)).toEqual(['a-first', 'a-tie-b']);
    expect(first.nextCursor).toBe('a-tie-c');
    const next = await caller().article.list({
      ...input,
      direction: 'asc',
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(next.items.map((item) => item.id)).toEqual(['a-tie-c', 'a-last']);
    expect(next.nextCursor).toBeUndefined();
  });
  it('retains descending metric order even when publication direction is ascending', async () => {
    expect(
      (
        await caller().article.list({
          ...input,
          sort: 'readCount',
          direction: 'asc',
        })
      ).items.map((item) => item.id),
    ).toEqual(['a-last', 'a-tie-c', 'a-tie-b', 'a-first']);
  });
  it('keeps legacy no-filter requests and real zero metrics usable', async () => {
    const rows = (await caller().article.list({})).items;
    expect(rows).toHaveLength(9);
    expect(rows.find((item) => item.id === 'a-first')?.readCount).toBe(0);
    expect(
      (await caller().article.list({ group: 'all' })).items.map(
        (item) => item.id,
      ),
    ).toEqual(rows.map((item) => item.id));
  });
  it.each([
    { dateStart: '2026-02-30' },
    { dateStart: '2026-01-02', dateEnd: '2026-01-01' },
    { group: '' },
    { direction: 'sideways' },
  ])(
    'rejects invalid filters instead of silently widening the request: %j',
    async (scope) => {
      await expect(caller().article.list(scope as any)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    },
  );
  it('keeps authorization and leaves XHS unregistered', async () => {
    await expect(
      router.appRouter
        .createCaller({ errorMsg: 'synthetic unauthorized' })
        .article.list(input),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(Object.keys(router.appRouter._def.record)).not.toContain(
      'xiaohongshu',
    );
    expect(await prisma.article.count()).toBe(9);
    expect(
      (await prisma.article.findUniqueOrThrow({ where: { id: 'a-first' } }))
        .contentHtml,
    ).toBe('<p>synthetic retained body</p>');
  });
});
