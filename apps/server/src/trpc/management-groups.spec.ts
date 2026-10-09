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
    return {
      service,
      xhs,
      api: new TrpcRouter(
        service,
        prisma as any,
        config,
        {} as any,
        {} as any,
        xhs,
      ).appRouter.createCaller({ errorMsg, isLocal: true }),
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
      if (entry.name !== migration) await apply(entry.name);
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
  it('retains all rows when backup fails and releases both the group and creator locks', async () => {
    const { api } = caller();
    const group = await api.xiaohongshu.saveGroup({ name: 'before' });
    const gate = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(new Error('backup failed'));
    await expect(
      api.xiaohongshu.moveCreators({ ids: ['creator-a'], groupId: group.id }),
    ).rejects.toThrow('backup failed');
    await expect(api.feed.saveGroup({ name: 'unwritten' })).rejects.toThrow(
      'backup failed',
    );
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
    const { api } = caller();
    let release!: () => void;
    const gate = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            release = () => resolve({});
          }),
      );
    const moving = api.xiaohongshu.moveCreators({
      ids: ['creator-a'],
      groupId: null,
    });
    while (!release) await new Promise((r) => setTimeout(r, 1));
    await expect(
      api.feed.saveGroup({ name: 'during move' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.xiaohongshu.edit({ id: 'creator-a', enabled: false }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    release();
    await moving;
    gate.mockRestore();
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
