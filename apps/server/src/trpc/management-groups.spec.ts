import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import axios from 'axios';
import {
  XiaohongshuService,
  XhsSource,
} from '../collection/xiaohongshu.service';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import * as backup from '../collection/sqlite-backup';

// Run the original ESM archive implementation in Node, preserving real ZIP bytes.
jest.mock('../offline-archive', () => ({
  archiveDirectory: async (folder: string, destination: string) => {
    const source = path.resolve(__dirname, '../offline-archive.ts');
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        "const fs=require('fs'),ts=require('typescript'),M=require('module'),path=require('path');const file=process.argv[3];const m=new M(file);m.paths=M._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,file);m.exports.archiveDirectory(process.argv[1],process.argv[2]).catch(()=>process.exit(1));",
        folder,
        destination,
        source,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (child.status !== 0) throw new Error('ACTUAL_ARCHIVE_CHILD_FAILED');
  },
}));

jest.setTimeout(60000);

describe('single-level platform-scoped management groups (real offline SQLite)', () => {
  let root: string, prisma: PrismaClient, originalRows: unknown;
  const originalEnv = { ...process.env };
  const migration = '20261009063000_add_management_groups';
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
  const rows = async () => {
    const result: Record<string, unknown> = {};
    for (const table of [
      'accounts',
      'feeds',
      'articles',
      'xhs_creators',
      'xhs_notes',
    ]) {
      const columns = (
        await prisma.$queryRawUnsafe<any[]>(`PRAGMA table_info(${table})`)
      )
        .map((column) => column.name)
        .filter((name) => name !== 'group_id');
      result[table] = await prisma.$queryRawUnsafe(
        `SELECT ${columns.map((name) => '"' + name + '"').join(',')} FROM ${table} ORDER BY id`,
      );
    }
    return result;
  };
  const caller = (
    errorMsg: string | null = null,
    source?: XhsSource,
    collection: any = {},
  ) => {
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const service = new TrpcService(
      prisma as any,
      config,
      {} as any,
      collection,
    );
    const xhs = new XiaohongshuService(prisma as any, source);
    const router = new TrpcRouter(
      service,
      prisma as any,
      config,
      {} as any,
      {} as any,
      xhs,
    ).appRouter;
    return {
      service,
      xhs,
      api: router.createCaller({ errorMsg, isLocal: true }),
      openWindow: () => router.createCaller({ errorMsg, isLocal: true }),
    };
  };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-management-groups-'));
    const url = 'file:' + path.join(root, 'fixture.sqlite').replace(/\\/g, '/');
    process.env.DATABASE_URL = url;
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    const apply = async (name: string) => {
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    };
    for (const entry of (await fs.readdir(migrations, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name)))
      if (
        entry.name !== migration &&
        entry.name !== '20261010090000_management_group_order'
      )
        await apply(entry.name);
    await prisma.$executeRawUnsafe(
      'INSERT INTO accounts (id,token,name) VALUES (?,?,?)',
      'account',
      'synthetic-only',
      'old account',
    );
    for (const id of ['feed-a', 'feed-b'])
      await prisma.$executeRawUnsafe(
        'INSERT INTO feeds (id,mp_name,mp_cover,mp_intro,update_time,local_directory,collection_channel) VALUES (?,?,?,?,?,?,?)',
        id,
        id,
        '',
        '',
        123,
        'unchanged-local-path',
        'wechat2rss',
      );
    await prisma.article.create({
      data: {
        id: 'article',
        mpId: 'feed-a',
        title: 'old article',
        picUrl: '',
        publishTime: 1700000000,
        contentHtml: 'old-body',
        metrics: 'old-metrics',
        readCount: 7,
        likeCount: 2,
      },
    });
    for (const id of ['creator-a', 'creator-b'])
      await prisma.$executeRawUnsafe(
        'INSERT INTO xhs_creators (id,profile_url,display_name) VALUES (?,?,?)',
        id,
        'https://www.xiaohongshu.com/' + id,
        id,
      );
    for (const [id, creatorId, status] of [
      ['note-a', 'creator-a', 'complete'],
      ['note-b', 'creator-a', 'complete'],
      ['note-other', 'creator-b', 'complete'],
      ['note-video', 'creator-a', 'video-skipped'],
    ])
      await prisma.xhsNote.create({
        data: {
          id,
          creatorId,
          title: id,
          publishTime: 1760000000,
          status,
          contentHtml:
            status === 'complete'
              ? '<div id="js_content"><p>' +
                id +
                '</p><img src="data:image/png;base64,' +
                png +
                '"></div>'
              : null,
        },
      });
    originalRows = await rows();
    const oldColumns = await prisma.$queryRawUnsafe<any[]>(
      'PRAGMA table_info(feeds)',
    );
    await apply(migration);
    await apply('20261010090000_management_group_order');
    expect(await rows()).toEqual(originalRows);
    expect(
      (await prisma.$queryRawUnsafe<any[]>('PRAGMA table_info(feeds)')).slice(
        0,
        oldColumns.length,
      ),
    ).toEqual(oldColumns);
    expect(
      (await prisma.feed.findMany()).every((f) => f.groupId === null),
    ).toBe(true);
    expect(
      (await prisma.xhsCreator.findMany()).every((c) => c.groupId === null),
    ).toBe(true);
    expect(await prisma.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual(
      [],
    );
  }, 60000);
  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      DATABASE_URL:
        'file:' + path.join(root, 'fixture.sqlite').replace(/\\/g, '/'),
    };
    delete process.env.WEWE_ACCEPTANCE_MODE;
    delete process.env.PRIVATE_ONLINE_MODE;
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await prisma.$executeRawUnsafe('UPDATE feeds SET group_id = NULL');
    await prisma.xhsCreator.updateMany({ data: { groupId: null } });
    await prisma.managementGroup.deleteMany();
  });
  const ordinaryRoutes: [string, (api: any) => Promise<unknown>][] = [
    ['wechat create', (api) => api.feed.saveGroup({ name: 'new folder' })],
    [
      'xiaohongshu create',
      (api) => api.xiaohongshu.saveGroup({ name: 'new folder' }),
    ],
    [
      'wechat rename',
      (api) => api.feed.saveGroup({ id: 'ordinary-wx-a', name: 'renamed' }),
    ],
    [
      'xiaohongshu rename',
      (api) =>
        api.xiaohongshu.saveGroup({ id: 'ordinary-xhs-a', name: 'renamed' }),
    ],
    [
      'group reorder',
      (api) =>
        api.feed.reorderGroups({
          ids: ['ordinary-wx-b', 'ordinary-wx-a'],
          expectedIds: ['ordinary-wx-a', 'ordinary-wx-b'],
        }),
    ],
    [
      'feed reorder',
      (api) =>
        api.feed.updateOrder([
          { id: 'feed-a', order: 1, expectedOrder: 0, expectedGroupId: null },
          { id: 'feed-b', order: 0, expectedOrder: 0, expectedGroupId: null },
        ]),
    ],
    [
      'wechat single move',
      (api) =>
        api.feed.moveFeeds({ ids: ['feed-a'], groupId: 'ordinary-wx-a' }),
    ],
    [
      'wechat batch add',
      (api) =>
        api.feed.moveFeeds({
          ids: ['feed-a', 'feed-a', 'feed-b'],
          groupId: 'ordinary-wx-a',
        }),
    ],
    [
      'xiaohongshu single move',
      (api) =>
        api.xiaohongshu.moveCreators({
          ids: ['creator-a'],
          groupId: 'ordinary-xhs-a',
        }),
    ],
    [
      'xiaohongshu batch add',
      (api) =>
        api.xiaohongshu.moveCreators({
          ids: ['creator-a', 'creator-a', 'creator-b'],
          groupId: 'ordinary-xhs-a',
        }),
    ],
  ];
  const seedOrdinary = async () => {
    for (const platform of ['wechat', 'xiaohongshu'])
      for (const [order, suffix] of ['a', 'b'].entries()) {
        const id = `ordinary-${platform === 'wechat' ? 'wx' : 'xhs'}-${suffix}`;
        await prisma.managementGroup.create({
          data: { id, platform, name: id, order },
        });
      }
  };
  const classifications = async (db = prisma) => ({
    groups: await db.managementGroup.findMany({ orderBy: { id: 'asc' } }),
    feeds: await db.feed.findMany({
      select: { id: true, groupId: true, order: true },
      orderBy: { id: 'asc' },
    }),
    creators: await db.xhsCreator.findMany({
      select: { id: true, groupId: true },
      orderBy: { id: 'asc' },
    }),
  });
  it.each(ordinaryRoutes)(
    'zero-snapshot ordinary %s persists through a fresh client',
    async (_label, operation) => {
      await seedOrdinary();
      const snapshots = jest
        .spyOn(backup, 'createVerifiedSqliteBackup')
        .mockRejectedValue(new Error('UNEXPECTED_FULL_BACKUP'));
      try {
        await operation(caller().api);
        expect(snapshots).not.toHaveBeenCalled();
        const fresh = new PrismaClient();
        try {
          expect(await classifications(fresh)).toEqual(await classifications());
        } finally {
          await fresh.$disconnect();
        }
      } finally {
        await prisma.$executeRawUnsafe('UPDATE feeds SET "order"=0');
      }
    },
  );
  it.each(ordinaryRoutes)(
    'ordinary %s rolls back a late commit fault and releases its locks without a snapshot',
    async (_label, operation) => {
      await seedOrdinary();
      const before = await classifications();
      const snapshots = jest
        .spyOn(backup, 'createVerifiedSqliteBackup')
        .mockRejectedValue(new Error('UNEXPECTED_FULL_BACKUP'));
      const transaction = prisma.$transaction.bind(prisma);
      const broken = jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(((action: any) =>
          transaction(async (tx) => {
            await action(tx);
            throw new Error('LATE_ORDINARY_COMMIT_FAILURE');
          })) as any);
      try {
        await expect(operation(caller().api)).rejects.toThrow(
          'LATE_ORDINARY_COMMIT_FAILURE',
        );
        expect(await classifications()).toEqual(before);
        broken.mockRestore();
        await operation(caller().api);
        expect(snapshots).not.toHaveBeenCalled();
      } finally {
        broken.mockRestore();
        await prisma.$executeRawUnsafe('UPDATE feeds SET "order"=0');
      }
    },
  );
  it.each(ordinaryRoutes)(
    'ordinary %s fails closed on physical space and actual connection durability',
    async (_label, operation) => {
      await seedOrdinary();
      const before = await classifications();
      const snapshots = jest
        .spyOn(backup, 'createVerifiedSqliteBackup')
        .mockRejectedValue(new Error('UNEXPECTED_FULL_BACKUP'));
      await prisma.$executeRawUnsafe('PRAGMA synchronous=OFF');
      try {
        await expect(operation(caller().api)).rejects.toThrow(
          'INCREMENTAL_DURABILITY_MODE_UNPROVED',
        );
      } finally {
        await prisma.$executeRawUnsafe('PRAGMA synchronous=FULL');
      }
      const volume = await fs.statfs(root, { bigint: true });
      const disk = jest
        .spyOn(fs, 'statfs')
        .mockResolvedValue({ ...volume, bavail: 0n } as any);
      try {
        await expect(operation(caller().api)).rejects.toThrow(
          'INCREMENTAL_DISK_SPACE_INSUFFICIENT',
        );
      } finally {
        disk.mockRestore();
      }
      expect(await classifications()).toEqual(before);
      expect(snapshots).not.toHaveBeenCalled();
    },
  );
  afterEach(async () => {
    expect(await rows()).toEqual(originalRows);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual(
      [],
    );
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    process.env = originalEnv;
    if (
      root &&
      path.dirname(root) === tmpdir() &&
      path.basename(root).startsWith('wewe-management-groups-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('protects every new route and rejects nesting, control characters, and oversized batches', async () => {
    const { api } = caller('not logged in');
    for (const method of [
      () => api.feed.groups(),
      () => api.feed.reorderGroups({ ids: ['x'], expectedIds: ['x'] }),
      () => api.feed.updateOrder([{ id: 'feed-a', order: 0 }]),
      () => api.feed.saveGroup({ name: 'group' }),
      () => api.feed.removeGroup({ id: 'x' }),
      () => api.feed.moveFeeds({ ids: ['feed-a'], groupId: null }),
      () => api.xiaohongshu.groups(),
      () => api.xiaohongshu.saveGroup({ name: 'group' }),
      () => api.xiaohongshu.removeGroup({ id: 'x' }),
      () => api.xiaohongshu.moveCreators({ ids: ['creator-a'], groupId: null }),
    ])
      await expect(method()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const signedIn = caller().api;
    for (const input of [
      { name: ' ' },
      { name: 'a'.repeat(81) },
      { name: 'abc\nxyz' },
      { name: 'g', parentId: 'x' },
    ])
      await expect(signedIn.feed.saveGroup(input as any)).rejects.toMatchObject(
        { code: 'BAD_REQUEST' },
      );
    await expect(
      signedIn.xiaohongshu.moveCreators({
        ids: Array(101).fill('creator-a'),
        groupId: null,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await prisma.managementGroup.count()).toBe(0);
  });
  it('persists group order, appends new groups and rejects duplicates, stale lists and foreign IDs atomically', async () => {
    const { api } = caller();
    const a = await api.feed.saveGroup({ name: 'same' });
    const b = await api.feed.saveGroup({ name: 'same' });
    const foreign = await api.xiaohongshu.saveGroup({ name: 'same' });
    const expectedIds = [a.id, b.id];
    expect((await api.feed.groups()).items.map((g) => g.id)).toEqual(
      expectedIds,
    );
    for (const ids of [[a.id, a.id], [a.id, foreign.id], [a.id]])
      await expect(
        api.feed.reorderGroups({ ids, expectedIds }),
      ).rejects.toBeDefined();
    await api.feed.reorderGroups({ ids: [b.id, a.id], expectedIds });
    expect((await caller().api.feed.groups()).items.map((g) => g.id)).toEqual([
      b.id,
      a.id,
    ]);
    await expect(
      api.feed.reorderGroups({ ids: [a.id, b.id], expectedIds }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const c = await api.feed.saveGroup({ name: 'empty' });
    expect((await api.feed.groups()).items.map((g) => g.id)).toEqual([
      b.id,
      a.id,
      c.id,
    ]);
    expect((await api.xiaohongshu.groups()).items.map((g) => g.id)).toEqual([
      foreign.id,
    ]);
  });
  it('sorts only complete same-group membership and leaves other groups and all article fields intact', async () => {
    const { api } = caller();
    const g = await api.feed.saveGroup({ name: 'g' });
    await api.feed.moveFeeds({ ids: ['feed-b'], groupId: g.id });
    await expect(
      api.feed.updateOrder([{ id: 'feed-b', order: 1, expectedGroupId: null }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const input of [
      [],
      [{ id: 'feed-a', order: -1 }],
      [
        { id: 'feed-a', order: 0 },
        { id: 'feed-a', order: 1 },
      ],
      [
        { id: 'feed-a', order: 0 },
        { id: 'feed-b', order: 1 },
      ],
    ])
      await expect(api.feed.updateOrder(input)).rejects.toBeDefined();
    await api.feed.updateOrder([{ id: 'feed-a', order: 9 }]);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: 'feed-b' } })).order,
    ).toBe(0);
    expect(
      (await prisma.article.findUniqueOrThrow({ where: { id: 'article' } }))
        .contentHtml,
    ).toBe('old-body');
    await api.feed.moveFeeds({ ids: ['feed-b'], groupId: null });
    await expect(
      api.feed.updateOrder([{ id: 'feed-a', order: 1 }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await api.feed.updateOrder([
      { id: 'feed-b', order: 0 },
      { id: 'feed-a', order: 1 },
    ]);
    expect((await api.feed.list({})).items.map((f) => f.id)).toEqual([
      'feed-b',
      'feed-a',
    ]);
    await expect(
      api.feed.updateOrder([
        { id: 'feed-b', order: 1, expectedOrder: 0 },
        { id: 'feed-a', order: 0, expectedOrder: 0 },
      ]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // This suite's afterEach compares every preexisting non-classification field.
    await prisma.$executeRawUnsafe('UPDATE feeds SET "order" = 0');
  });
  it('renames and deletes empty groups, rejects nonempty groups, and atomically moves/deduplicates both platforms', async () => {
    const { api } = caller();
    const wx = await api.feed.saveGroup({ name: '  ../工作  ' });
    const xhs = await api.xiaohongshu.saveGroup({ name: '阅读' });
    expect(wx.name).toBe('../工作'); // A label only; no filesystem construction.
    expect((await api.feed.groups()).items).toEqual([wx]);
    expect((await api.xiaohongshu.groups()).items).toEqual([xhs]);
    expect(
      await api.feed.moveFeeds({
        ids: ['feed-a', 'feed-a', 'feed-b'],
        groupId: wx.id,
      }),
    ).toEqual({ moved: 2, ids: ['feed-a', 'feed-b'], groupId: wx.id });
    expect(
      await api.xiaohongshu.moveCreators({
        ids: ['creator-a', 'creator-b'],
        groupId: xhs.id,
      }),
    ).toMatchObject({ moved: 2 });
    expect(
      (await api.feed.list({ limit: 100 })).items.every(
        (feed) => feed.groupId === wx.id,
      ),
    ).toBe(true);
    expect(
      (await api.xiaohongshu.list({ groupId: xhs.id })).items,
    ).toHaveLength(2);
    expect((await api.xiaohongshu.list({ groupId: null })).items).toEqual([]);
    await expect(api.feed.removeGroup({ id: wx.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      api.xiaohongshu.removeGroup({ id: xhs.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await api.feed.saveGroup({ id: wx.id, name: '改名' })).id).toBe(
      wx.id,
    );
    await api.feed.moveFeeds({ ids: ['feed-a', 'feed-b'], groupId: null });
    await api.xiaohongshu.moveCreators({
      ids: ['creator-a', 'creator-b'],
      groupId: null,
    });
    expect((await api.xiaohongshu.list({ groupId: null })).items).toHaveLength(
      2,
    );
    expect(await api.feed.removeGroup({ id: wx.id })).toEqual({
      removed: true,
    });
    expect(await api.xiaohongshu.removeGroup({ id: xhs.id })).toEqual({
      removed: true,
    });
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: 'feed-a' } }))
        .localDirectory,
    ).toBe('unchanged-local-path');
  });
  it('ordinary renames commit without snapshots, retain same-name IDs and survive a fresh client', async () => {
    const { api } = caller();
    for (const id of ['rename-a', 'rename-b'])
      await prisma.managementGroup.create({
        data: { id, name: 'same', platform: 'wechat', order: 7 },
      });
    const snapshots = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('BACKUP_QUOTA_FULL'));
    expect(
      await api.feed.saveGroup({ id: 'rename-a', name: '  changed  ' }),
    ).toMatchObject({
      id: 'rename-a',
      name: 'changed',
      platform: 'wechat',
      order: 7,
    });
    await api.feed.saveGroup({ id: 'rename-a', name: 'same' });
    const fresh = new PrismaClient();
    try {
      expect(
        await fresh.managementGroup.findMany({ where: { platform: 'wechat' } }),
      ).toHaveLength(2);
      expect(
        (
          await fresh.managementGroup.findUniqueOrThrow({
            where: { id: 'rename-a' },
          })
        ).name,
      ).toBe('same');
    } finally {
      await fresh.$disconnect();
    }
    expect(snapshots).not.toHaveBeenCalled();
    await expect(api.feed.saveGroup({ name: 'new' })).resolves.toMatchObject({
      name: 'new',
    });
    expect(snapshots).not.toHaveBeenCalled();
  });
  it('ordinary rename rejects unsafe durability, insufficient disk, foreign IDs and a late SQL failure without changing rows', async () => {
    const { api } = caller();
    await prisma.managementGroup.create({
      data: { id: 'rename-safe', name: 'old', platform: 'wechat' },
    });
    const snapshots = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('UNEXPECTED_SNAPSHOT'));
    await expect(
      api.xiaohongshu.saveGroup({ id: 'rename-safe', name: 'cross' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await prisma.$executeRawUnsafe('PRAGMA synchronous=OFF');
    try {
      await expect(
        api.feed.saveGroup({ id: 'rename-safe', name: 'unsafe' }),
      ).rejects.toThrow('INCREMENTAL_DURABILITY_MODE_UNPROVED');
    } finally {
      await prisma.$executeRawUnsafe('PRAGMA synchronous=FULL');
    }
    const volume = await fs.statfs(root, { bigint: true });
    const disk = jest
      .spyOn(fs, 'statfs')
      .mockResolvedValue({ ...volume, bavail: 0n } as any);
    try {
      await expect(
        api.feed.saveGroup({ id: 'rename-safe', name: 'disk full' }),
      ).rejects.toThrow('INCREMENTAL_DISK_SPACE_INSUFFICIENT');
    } finally {
      disk.mockRestore();
    }
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER rename_abort AFTER UPDATE ON management_groups BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END",
    );
    try {
      await expect(
        api.feed.saveGroup({ id: 'rename-safe', name: 'rejected' }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER rename_abort');
    }
    expect(
      (
        await prisma.managementGroup.findUniqueOrThrow({
          where: { id: 'rename-safe' },
        })
      ).name,
    ).toBe('old');
    expect(snapshots).not.toHaveBeenCalled();
    await expect(
      api.feed.saveGroup({ id: 'rename-safe', name: 'ok after failures' }),
    ).resolves.toMatchObject({ name: 'ok after failures' });
  });
  it('persists a full 100-member batch across a fresh client, makes repeat adds idempotent, and rolls back a failed commit', async () => {
    const { api } = caller();
    const snapshots = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('UNEXPECTED_FULL_BACKUP'));
    const group = await api.feed.saveGroup({ name: 'batch target' });
    const ids = Array.from({ length: 100 }, (_, i) => `batch-feed-${i}`);
    try {
      await prisma.$transaction(
        ids.map((id) =>
          prisma.feed.create({
            data: {
              id,
              mpName: id,
              mpCover: '',
              mpIntro: '',
              updateTime: 123,
            },
          }),
        ),
      );
      const transaction = prisma.$transaction.bind(prisma);
      const broken = jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(((operation: any) =>
          transaction(async (tx) => {
            await operation(tx);
            throw new Error('synthetic commit failure');
          })) as any);
      await expect(
        api.feed.moveFeeds({ ids, groupId: group.id }),
      ).rejects.toThrow('synthetic commit failure');
      broken.mockRestore();
      expect(
        await prisma.feed.count({ where: { id: { in: ids }, groupId: null } }),
      ).toBe(100);
      await api.feed.moveFeeds({ ids, groupId: group.id });
      await api.feed.moveFeeds({ ids, groupId: group.id });
      const fresh = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        expect(
          await fresh.feed.count({
            where: { id: { in: ids }, groupId: group.id },
          }),
        ).toBe(100);
        expect(await fresh.feed.count({ where: { id: { in: ids } } })).toBe(
          100,
        );
      } finally {
        await fresh.$disconnect();
      }
      await expect(
        api.feed.moveFeeds({
          ids: [...ids.slice(0, 99), 'missing'],
          groupId: null,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(
        await prisma.feed.count({
          where: { id: { in: ids }, groupId: group.id },
        }),
      ).toBe(100);
      expect(snapshots).not.toHaveBeenCalled();
    } finally {
      await prisma.feed.deleteMany({ where: { id: { in: ids } } });
    }
  });
  it('rejects foreign platform groups, foreign or missing IDs without moving any member', async () => {
    const { api } = caller();
    const wx = await api.feed.saveGroup({ name: 'wx' });
    const xhs = await api.xiaohongshu.saveGroup({ name: 'xhs' });
    for (const action of [
      () => api.feed.moveFeeds({ ids: ['feed-a'], groupId: xhs.id }),
      () =>
        api.xiaohongshu.moveCreators({ ids: ['creator-a'], groupId: wx.id }),
      () =>
        api.feed.moveFeeds({ ids: ['feed-a', 'creator-a'], groupId: wx.id }),
      () =>
        api.xiaohongshu.moveCreators({
          ids: ['creator-a', 'missing'],
          groupId: xhs.id,
        }),
      () => api.feed.saveGroup({ id: xhs.id, name: 'wrong' }),
      () => api.xiaohongshu.removeGroup({ id: wx.id }),
      () => api.xiaohongshu.list({ groupId: wx.id }),
    ])
      await expect(action()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await prisma.feed.findMany()).every((f) => f.groupId === null),
    ).toBe(true);
    expect(
      (await prisma.xhsCreator.findMany()).every((c) => c.groupId === null),
    ).toBe(true);
  });
  it('retains protected group deletion and unrelated creator edit gates when backup fails', async () => {
    const { api } = caller();
    const group = await api.xiaohongshu.saveGroup({ name: 'before' });
    const gate = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('backup failed'));
    await expect(api.xiaohongshu.removeGroup({ id: group.id })).rejects.toThrow(
      'backup failed',
    );
    await expect(
      api.xiaohongshu.edit({ id: 'creator-a', enabled: false }),
    ).rejects.toThrow('backup failed');
    expect(
      await prisma.managementGroup.findUnique({ where: { id: group.id } }),
    ).not.toBeNull();
    await expect(
      api.feed.saveGroup({ name: 'ordinary still available' }),
    ).resolves.toMatchObject({ name: 'ordinary still available' });
    expect(
      (
        await prisma.xhsCreator.findUniqueOrThrow({
          where: { id: 'creator-a' },
        })
      ).groupId,
    ).toBeNull();
    gate.mockRestore();
    expect(
      (
        await api.xiaohongshu.moveCreators({
          ids: ['creator-a'],
          groupId: group.id,
        })
      ).moved,
    ).toBe(1);
  });
  it('serializes concurrent group mutation across namespaces and creator assignment against refresh', async () => {
    const backend = caller();
    const { api } = backend;
    const otherWindow = backend.openWindow();
    let release!: () => void;
    const transaction = prisma.$transaction.bind(prisma);
    const gate = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((
      action: any,
    ) =>
      transaction(async (tx) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return action(tx);
      })) as any);
    const moving = api.xiaohongshu.moveCreators({
      ids: ['creator-a'],
      groupId: null,
    });
    while (!release) await new Promise((r) => setTimeout(r, 1));
    try {
      await expect(
        otherWindow.feed.saveGroup({ name: 'during move' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        otherWindow.xiaohongshu.edit({ id: 'creator-a', enabled: false }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      release();
      await moving;
      gate.mockRestore();
    }
    let reject!: (error: Error) => void;
    const read = jest.fn(
      () =>
        new Promise<never>((_, r) => {
          reject = r;
        }),
    );
    const refreshApi = caller(null, { read }).api;
    const refresh = refreshApi.xiaohongshu.refresh({ id: 'creator-a' });
    while (!reject) await new Promise((r) => setTimeout(r, 1));
    await expect(
      refreshApi.xiaohongshu.moveCreators({
        ids: ['creator-a', 'creator-b'],
        groupId: null,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    reject(new Error('offline failure'));
    await expect(refresh).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(
      (
        await refreshApi.xiaohongshu.moveCreators({
          ids: ['creator-a'],
          groupId: null,
        })
      ).moved,
    ).toBe(1);
  });

  it('two window callers reject stale group and feed order without snapshots or lost assignments', async () => {
    await seedOrdinary();
    const snapshots = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('UNEXPECTED_FULL_BACKUP'));
    const backend = caller();
    const firstWindow = backend.api,
      secondWindow = backend.openWindow();
    const firstView = (await firstWindow.feed.groups()).items.map((g) => g.id);
    const secondView = (await secondWindow.feed.groups()).items.map(
      (g) => g.id,
    );
    await firstWindow.feed.reorderGroups({
      ids: [...firstView].reverse(),
      expectedIds: firstView,
    });
    const confirmed = await classifications();
    await expect(
      secondWindow.feed.reorderGroups({
        ids: secondView,
        expectedIds: secondView,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await classifications()).toEqual(confirmed);
    await firstWindow.feed.moveFeeds({
      ids: ['feed-a'],
      groupId: 'ordinary-wx-a',
    });
    await expect(
      secondWindow.feed.updateOrder([
        { id: 'feed-a', order: 1, expectedOrder: 0, expectedGroupId: null },
      ]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: 'feed-a' } }))
        .groupId,
    ).toBe('ordinary-wx-a');
    await secondWindow.feed.moveFeeds({
      ids: ['feed-b'],
      groupId: 'ordinary-wx-a',
    });
    expect(
      await prisma.feed.count({ where: { groupId: 'ordinary-wx-a' } }),
    ).toBe(2);
    expect(snapshots).not.toHaveBeenCalled();
  });
  it('respects the existing feed body-retry lock and releases a batch after failure', async () => {
    let finish!: () => void;
    const retryArticleBody = jest.fn(
      () =>
        new Promise<any>((resolve) => {
          finish = () => resolve({});
        }),
    );
    const { api, service } = caller(null, undefined, { retryArticleBody });
    const retry = service.retryArticleBody('article');
    while (!finish) await new Promise((r) => setTimeout(r, 1));
    await expect(
      api.feed.moveFeeds({ ids: ['feed-a', 'feed-b'], groupId: null }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    finish();
    await retry;
    expect(
      (await api.feed.moveFeeds({ ids: ['feed-a', 'feed-b'], groupId: null }))
        .moved,
    ).toBe(2);
  });
  it('exports only selected complete same-creator notes in an actual ZIP, rejecting foreign and incomplete selections', async () => {
    const { api } = caller();
    for (const noteIds of [
      ['note-a', 'note-other'],
      ['note-video'],
      ['missing'],
      [],
    ])
      await expect(
        api.xiaohongshu.export({ creatorId: 'creator-a', noteIds }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const result = await api.xiaohongshu.export({
      creatorId: 'creator-a',
      noteIds: ['note-a', 'note-a'],
    });
    expect(result.notes).toBe(1);
    const zip = path.join(root, 'selected.zip');
    await fs.writeFile(zip, Buffer.from(result.base64, 'base64'));
    const inspected = spawnSync(
      'python',
      [
        '-c',
        'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode("utf8") for n in z.namelist() if n.endswith(".md")}))',
        zip,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(inspected.status).toBe(0);
    const markdown = Object.values(JSON.parse(inspected.stdout)) as string[];
    expect(markdown).toHaveLength(1);
    expect(markdown[0]).toContain('note-a');
    expect(markdown[0]).not.toContain('note-b');
    expect(
      (await api.xiaohongshu.export({ creatorId: 'creator-a' })).notes,
    ).toBe(2);
  });
});
