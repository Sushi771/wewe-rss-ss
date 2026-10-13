import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TrpcService } from './trpc/trpc.service';
import { TrpcRouter } from './trpc/trpc.router';
import { OfflineExportController } from './offline-export.controller';
jest.mock('./offline-archive', () => ({ archiveDirectory: jest.fn() }));

describe('full filter export scope on an isolated SQLite database; no external requests', () => {
  let root: string, prisma: PrismaClient, router: TrpcRouter;
  let api: ReturnType<TrpcRouter['appRouter']['createCaller']>;
  const start = Date.parse('2026-10-10T16:00:00Z') / 1000;
  const filter = {
    mpId: 'MP_WXS_1234567890',
    group: 'g',
    search: 'match',
    dateStart: '2026-10-11',
    dateEnd: '2026-10-11',
  };
  let baseline: unknown;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-export-scope-'));
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
      for (const statement of sql
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.managementGroup.create({
      data: { id: 'g', name: 'Fixture', platform: 'wechat' },
    });
    await prisma.feed.create({
      data: {
        id: filter.mpId,
        groupId: 'g',
        mpName: 'Test publisher',
        mpCover: '',
        mpIntro: '',
        updateTime: 1,
      },
    });
    for (let i = 0; i < 29; i++)
      await prisma.article.create({
        data: {
          id: 'fixture-' + String(i).padStart(2, '0'),
          mpId: filter.mpId,
          title: i === 28 ? 'other' : 'match ' + i,
          picUrl: '',
          publishTime:
            i === 25
              ? start - 1
              : i === 26
                ? start + 86400
                : i === 27
                  ? 0
                  : i === 24
                    ? start + 86399
                    : start,
          contentHtml: '<div id="js_content"><p>Offline body</p></div>',
          lastBodyStatus: 'available',
        },
      });
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { obsidianPath: join(root, 'vault') },
    });
    router = new TrpcRouter(
      new TrpcService(prisma as any, config, {} as any, {} as any),
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    api = router.appRouter.createCaller({ errorMsg: null, isLocal: true });
    baseline = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_NETWORK'));
  }, 30000);
  afterAll(async () => {
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      baseline,
    );
    await prisma.$disconnect();
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  it('freezes more than 20 IDs with exact Shanghai boundaries and preserves other filters, no missing or duplicate pages', async () => {
    const ids = await api.article.exportIds(filter);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    const page1 = await api.article.list({
      ...filter,
      limit: 20,
      sort: 'publishTime',
      direction: 'desc',
    });
    const page2 = await api.article.list({
      ...filter,
      limit: 20,
      sort: 'publishTime',
      direction: 'desc',
      cursor: page1.nextCursor,
    });
    expect(new Set([...page1.items, ...page2.items].map((x) => x.id))).toEqual(
      new Set(ids),
    );
    expect(page1.items.length + page2.items.length).toBe(25);
    expect(
      await api.article.exportIds({ ...filter, group: 'ungrouped' }),
    ).toEqual([]);
    expect(await api.article.exportIds({ ...filter, search: 'other' })).toEqual(
      ['fixture-28'],
    );
    await expect(
      api.article.exportIds({ ...filter, dateStart: '2026-10-12' }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('stages the entire filtered snapshot twice independently, with accurate full-account scope and media counts', async () => {
    const first = await router.buildOfflineFeedDirectory(
      filter.mpId,
      join(root, 'zip-one'),
      filter,
    );
    const second = await router.buildOfflineFeedDirectory(
      filter.mpId,
      join(root, 'zip-two'),
      filter,
    );
    const all = await router.buildOfflineFeedDirectory(
      filter.mpId,
      join(root, 'zip-all'),
    );
    expect(first).toMatchObject({ articles: 25, complete: 25, incomplete: [] });
    expect(second).toMatchObject({
      articles: 25,
      complete: 25,
      incomplete: [],
    });
    expect(all).toMatchObject({ articles: 29, complete: 29, incomplete: [] });
    expect(
      await readFile(join(root, 'zip-one', 'README.md'), 'utf8'),
    ).toContain('2026-10-11 至 2026-10-11');
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('invalid ZIP ranges return 400 before staging; cancellation stops subsequent articles', async () => {
    const controller = new OfflineExportController(router);
    const response: any = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const spy = jest.spyOn(router, 'buildOfflineFeedDirectory');
    await controller.feedZip(filter.mpId, response, {
      scope: 'filtered',
      dateStart: '2026-10-12',
      dateEnd: '2026-10-11',
    });
    expect(response.status).toHaveBeenCalledWith(400);
    expect(spy).not.toHaveBeenCalled();
    await controller.feedZip(filter.mpId, response, {
      scope: 'all',
      dateStart: '2026-10-11',
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await expect(
      router.buildOfflineFeedDirectory(
        filter.mpId,
        join(root, 'cancelled'),
        filter,
        () => true,
      ),
    ).rejects.toThrow('取消');
  });
});
