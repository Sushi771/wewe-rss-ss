import { splitSqliteStatements } from '../../../scripts/sqlite-statements.cjs';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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
      for (const statement of splitSqliteStatements(sql)
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
          sourceUrl: `https://mp.weixin.qq.com/s/fixture-${i}`,
          metrics:
            i === 1
              ? JSON.stringify({
                  like: {
                    value: 0,
                    display: '0',
                    fileTime: '2026-10-01T00:00:00Z',
                  },
                })
              : null,
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
    const notes = (
      await readdir(join(root, 'zip-one'), { recursive: true })
    ).filter((name) => name.endsWith('.md') && name !== 'README.md');
    expect(notes).toHaveLength(25);
    let metricNotes = 0;
    for (const name of notes) {
      const markdown = await readFile(join(root, 'zip-one', name), 'utf8');
      expect(markdown).toContain('Offline body');
      expect(markdown).toContain('公众号：Test publisher');
      expect(markdown).toContain('原文发布日期（上海时间）：2026-10-11');
      expect(markdown).toContain(
        '原文链接：https://mp.weixin.qq.com/s/fixture-',
      );
      expect(markdown).not.toMatch(/^原文：/m);
      expect(markdown).not.toMatch(/^# match /m);
      expect(markdown).not.toContain('未提供');
      if (basename(name) === 'match 1.md') {
        metricNotes++;
        expect(markdown).toContain('| 点赞 | 0 | 2026-10-01T00:00:00Z |');
      } else expect(markdown).not.toContain('| 指标 |');
    }
    expect(metricNotes).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('uses the same no-placeholder template for single browser and local exports, preserving edited repeats', async () => {
    const browser = await api.article.exportMarkdown('fixture-00');
    expect(browser.markdown).toContain('# match 0');
    expect(browser.markdown).toContain('Offline body');
    expect(browser.markdown).toContain('公众号：Test publisher');
    expect(browser.markdown).not.toContain('指标');
    const first = await api.article.saveToObsidian('fixture-00');
    expect(first.status).toBe('new');
    expect(await readFile(first.path, 'utf8')).not.toContain('指标');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(first.path, '用户笔记\n旧指标表保留');
    const repeated = await api.article.saveToObsidian('fixture-00');
    expect(repeated).toMatchObject({ status: 'skipped', path: first.path });
    expect(await readFile(first.path, 'utf8')).toBe('用户笔记\n旧指标表保留');
    expect(fetch).not.toHaveBeenCalled();
  });
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
