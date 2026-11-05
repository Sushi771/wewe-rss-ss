import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { callProcedure } from '@trpc/server';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { load } from 'cheerio';
import { spawnSync } from 'node:child_process';
import { XiaohongshuService, XhsSource } from './xiaohongshu.service';
import { XiaohongshuBatches } from './xiaohongshu-batches';
import * as backup from './sqlite-backup';
import { randomUUID } from 'node:crypto';
import { XhsNormalizedCandidate } from './xiaohongshu-contract';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ArticleDownloadController } from '../article-download.controller';
import * as picker from '../article-folder-picker';

// Existing archiver v8 is ESM and Jest runs CJS. Execute the actual unchanged
// offline-archive source in a normal Node child; do not fake archive output.
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
      {
        encoding: 'utf8',
        windowsHide: true,
        cwd: path.resolve(__dirname, '../..'),
      },
    );
    if (child.status !== 0) throw new Error('ACTUAL_ARCHIVE_CHILD_FAILED');
  },
}));

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const candidate = (noteId = 'synthetic-note'): XhsNormalizedCandidate => ({
  authorId: 'synthetic-author',
  noteId,
  kind: 'image-text',
  publishedAt: 1760000000,
  title: '合成图文',
  text: '完整合成正文\n<script>只是文本</script>',
  textStatus: 'full',
  expectedImageCount: 1,
  images: [{ ordinal: 1, inlineData: 'data:image/png;base64,' + png }],
});
describe('production XHS router/service → additive SQLite and original export (offline)', () => {
  let root: string, prisma: PrismaClient, creatorId: string;
  const originalEnv = { ...process.env };
  let snapshot: unknown;
  const oldRows = async () => {
    const columns = (
      await prisma.$queryRawUnsafe<any[]>('PRAGMA table_info(feeds)')
    )
      .map((column) => column.name)
      .filter((name) => name !== 'group_id');
    return {
      feeds: await prisma.$queryRawUnsafe(
        `SELECT ${columns.map((name) => '"' + name + '"').join(',')} FROM feeds`,
      ),
      articles: await prisma.article.findMany(),
      accounts: await prisma.account.findMany(),
    };
  };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-xhs-integration-'));
    const url = 'file:' + path.join(root, 'fixture.sqlite').replace(/\\/g, '/');
    process.env.DATABASE_URL = url;
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    const all = (await fs.readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const apply = async (name: string) => {
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const statement of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    };
    for (const name of all.filter(
      (n) =>
        n !== '20261009050000_add_xhs_local_archive' &&
        n !== '20261009063000_add_management_groups' &&
        n !== '20261106000000_xhs_refresh_batches' &&
        n !== '20261107000000_unified_bigint_timestamps' &&
        n !== '20261010090000_management_group_order' &&
        n !== '20261009080000_add_xhs_video_cache',
    ))
      await apply(name);
    await prisma.account.create({
      data: {
        id: '123',
        name: '合成旧账号',
        token: 'synthetic-only',
        status: 1,
      },
    });
    await prisma.$executeRawUnsafe(
      'INSERT INTO feeds (id,mp_name,mp_cover,mp_intro,update_time) VALUES (?,?,?,?,?)',
      'MP_WXS_3456789012',
      '合成旧公众号',
      '',
      '',
      1,
    );
    await prisma.article.create({
      data: {
        id: 'old-short-identity',
        mpId: 'MP_WXS_3456789012',
        title: '合成旧正文',
        picUrl: '',
        publishTime: 1700000000,
        contentHtml: 'old-body',
        metrics: 'old-metrics',
      },
    });
    snapshot = await oldRows();
    await apply('20261009050000_add_xhs_local_archive');
    await apply('20261009063000_add_management_groups');
    await apply('20261010090000_management_group_order');
    await apply('20261009080000_add_xhs_video_cache');
    await apply('20261106000000_xhs_refresh_batches');
    // The forward rebuild requires the complete union32, including deferred tables.
    await apply('20261107000000_unified_bigint_timestamps');
    expect(await oldRows()).toEqual(snapshot);
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
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await prisma.$executeRawUnsafe('DELETE FROM xhs_refresh_batch_items');
    await prisma.$executeRawUnsafe('DELETE FROM xhs_refresh_batches');
    await prisma.$executeRawUnsafe('DELETE FROM xhs_refresh_failures');
    await prisma.$executeRawUnsafe('DELETE FROM xhs_refresh_jobs');
    await prisma.xhsNote.deleteMany();
    await prisma.xhsCreator.deleteMany();
    const service = new XiaohongshuService(prisma as any);
    creatorId = (
      await service.add(
        '合成待接入博主',
        'https://www.xiaohongshu.com/synthetic-public-profile',
      )
    ).creator.id;
  });
  afterEach(async () => {
    expect(global.fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(await oldRows()).toEqual(snapshot);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    process.env = originalEnv;
    if (
      root &&
      path.dirname(root) === tmpdir() &&
      path.basename(root).startsWith('wewe-xhs-integration-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  const source = (
    items = [candidate()],
    evidenceVerified = true,
  ): XhsSource => ({
    read: jest.fn().mockResolvedValue({
      authorId: 'synthetic-author',
      evidenceVerified,
      pages: [{ requestCursor: null, nextCursor: null, items }],
    }),
  });
  function caller(
    service = new XiaohongshuService(prisma as any),
    errorMsg: string | null = null,
  ) {
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const router = new TrpcRouter(
      new TrpcService(prisma as any, config, {} as any, {} as any),
      prisma as any,
      config,
      {} as any,
      {} as any,
      service,
    ).appRouter;
    const api = router.createCaller({
      errorMsg,
      isLocal: true,
      isLocalSave: true,
    });
    // Legacy normalized cache seam is tested directly; public refresh now queues metadata only.
    return {
      xiaohongshu: api.xiaohongshu,
      procedures: router._def.procedures,
      legacyRefresh: ({
        id,
        operationId,
      }: {
        id: string;
        operationId?: string;
      }) => service.legacyRefresh(id, operationId),
    };
  }
  it('reorders XHS groups through the protected route without moving creators', async () => {
    const api = caller().xiaohongshu;
    const first = await api.saveGroup({ name: 'First synthetic group' });
    const second = await api.saveGroup({ name: 'Second synthetic group' });
    void second;
    await api.moveCreators({ ids: [creatorId], groupId: first.id });
    const original = (await api.groups()).items.map((group) => group.id);
    const reversed = [...original].reverse();
    await expect(
      caller(undefined, 'not signed in').xiaohongshu.reorderGroups({
        ids: reversed,
        expectedIds: original,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await api.reorderGroups({ ids: reversed, expectedIds: original });
    expect((await api.groups()).items.map((group) => group.id)).toEqual(
      reversed,
    );
    await expect(
      api.reorderGroups({ ids: original, expectedIds: original }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.reorderGroups({ ids: [first.id, first.id], expectedIds: reversed }),
    ).rejects.toBeDefined();
    const foreign = await prisma.managementGroup.create({
      data: {
        id: 'synthetic-wechat-group',
        platform: 'wechat',
        name: 'Other platform',
        order: 0,
      },
    });
    await expect(
      api.reorderGroups({ ids: [first.id, foreign.id], expectedIds: reversed }),
    ).rejects.toBeDefined();
    expect(
      (await prisma.xhsCreator.findUniqueOrThrow({ where: { id: creatorId } }))
        .groupId,
    ).toBe(first.id);
    expect((await api.groups()).items.map((group) => group.id)).toEqual(
      reversed,
    );
  });
  it('uses protected real routes, persists pending creators, refuses unconfigured refresh/download', async () => {
    await expect(
      caller(undefined, '未登录').xiaohongshu.list(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const api = caller();
    expect((await api.xiaohongshu.capability()).canRefresh).toBe(false);
    expect((await api.xiaohongshu.list()).items).toHaveLength(1);
    expect((await api.legacyRefresh({ id: creatorId })).status).toBe(
      'unconfigured',
    );
    await expect(api.xiaohongshu.export({ creatorId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    const repeated = await api.xiaohongshu.add({
      displayName: '重复备注',
      profileUrl: 'https://www.xiaohongshu.com/synthetic-public-profile',
    });
    expect(repeated.created).toBe(false);
    expect(repeated.subscribed).toBe(false);
    await api.xiaohongshu.edit({ id: creatorId, enabled: false });
    expect((await api.legacyRefresh({ id: creatorId })).status).toBe('paused');
    await api.xiaohongshu.remove({ id: creatorId });
    expect((await api.xiaohongshu.list()).items).toHaveLength(0);
  });
  it('removes only the deleted creator avatar and ignores orphaned old-version records', async () => {
    const service = new XiaohongshuService(prisma as any);
    const other = await service.add(
      'Other',
      'https://www.xiaohongshu.com/synthetic-other-profile',
    );
    const doc = JSON.stringify({
      avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/synthetic.jpg',
    });
    await prisma.$executeRaw`INSERT INTO xhs_metric_snapshots(owner_kind,owner_id,document) VALUES ('creator-avatar',${creatorId},${doc}),('creator-avatar',${other.creator.id},${doc}),('creator-avatar','orphaned-old',${doc})`;
    await service.remove(creatorId);
    const rows = await prisma.$queryRaw<
      Array<{ owner_id: string }>
    >`SELECT owner_id FROM xhs_metric_snapshots WHERE owner_kind='creator-avatar' ORDER BY owner_id`;
    expect(rows.map((row) => row.owner_id)).toEqual(
      [other.creator.id, 'orphaned-old'].sort(),
    );
    const listed = await service.list();
    expect(listed.items.map((item) => item.id)).toEqual([other.creator.id]);
    expect(listed.items[0].avatarUrl).toBe(
      'https://sns-avatar-qc.xhscdn.com/avatar/synthetic.jpg',
    );
  });
  it('removes the platform reader route and service method without reading cached body data', async () => {
    const read = jest.spyOn(prisma.xhsNote, 'findFirst');
    expect('body' in XiaohongshuService.prototype).toBe(false);
    await expect(async () =>
      callProcedure({
        procedures: caller().procedures,
        path: 'xiaohongshu.body',
        type: 'query',
        ctx: { errorMsg: null, isLocal: true },
        rawInput: { creatorId, noteId: 'synthetic' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
  it.each([
    'http://127.0.0.1/private',
    'https://www.xiaohongshu.com/profile?token=synthetic',
    'https://secret@www.xiaohongshu.com/profile',
    'https://example.com/profile',
  ])(
    'rejects unsafe or authentication-bearing pending links: %s',
    async (url) => {
      await expect(
        caller().xiaohongshu.add({ displayName: '合成', profileUrl: url }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await prisma.xhsCreator.count()).toBe(1);
    },
  );
  it('internal normalized source integrates body/images, dedup and cached ZIP without trusting public candidates', async () => {
    const normalized = source([
      candidate(),
      { ...candidate('synthetic-video'), kind: 'video' },
    ]);
    const api = caller(new XiaohongshuService(prisma as any, normalized));
    expect((await api.legacyRefresh({ id: creatorId })).added).toBe(1);
    const list = await api.xiaohongshu.notes({ creatorId });
    expect(list.items).toHaveLength(2);
    const note = list.items.find((n) => n.status === 'complete')!;
    const cached = await prisma.xhsNote.findFirstOrThrow({
      where: { creatorId, id: note.id },
    });
    const $ = load(cached.contentHtml!);
    expect(
      $('#js_content')
        .find('p')
        .toArray()
        .map((p) => $(p).text())
        .join('\n'),
    ).toBe(candidate().text);
    expect(
      $('#js_content')
        .find('img')
        .toArray()
        .map((img) => $(img).attr('src')),
    ).toEqual(['data:image/png;base64,' + png]);
    const before = await prisma.xhsNote.findMany();
    expect((await api.legacyRefresh({ id: creatorId })).added).toBe(0);
    expect(await prisma.xhsNote.findMany()).toEqual(before);
    await expect(
      api.xiaohongshu.remove({ id: creatorId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const exported = await api.xiaohongshu.export({ creatorId });
    expect(exported.notes).toBe(1);
    await expect(
      api.xiaohongshu.export({ creatorId, search: 'synthetic-no-match' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      api.xiaohongshu.export({ creatorId, dateStart: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const zip = path.join(root, 'offline.zip');
    await fs.writeFile(zip, Buffer.from(exported.base64, 'base64'));
    // Inspect actual ZIP bytes and relative media paths with standard Python;
    // no browser/network, no production article data or archive is used.
    const inspection = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [
        '-c',
        "import zipfile,sys,hashlib,json; z=zipfile.ZipFile(sys.argv[1]); md=[n for n in z.namelist() if n.endswith('.md')]; imgs=[n for n in z.namelist() if n.endswith('.png')]; print(json.dumps({'md':len(md),'images':len(imgs),'relative':'attachments/' in z.read(md[0]).decode(),'sha':hashlib.sha256(z.read(imgs[0])).hexdigest()}))",
        zip,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(inspection.status).toBe(0);
    const result = JSON.parse(inspection.stdout);
    expect(result).toMatchObject({ md: 1, images: 1, relative: true });
    const { createHash } = await import('node:crypto');
    expect(result.sha).toBe(
      createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'),
    );
  });
  it('shares literal visible-body/creator search across global, group and creator lists and real ZIP export', async () => {
    const group = await prisma.managementGroup.create({
      data: {
        id: 'synthetic-search-group',
        name: 'Synthetic search group',
        platform: 'xiaohongshu',
      },
    });
    const foreign = await prisma.managementGroup.create({
      data: {
        id: 'synthetic-search-wechat',
        name: 'Synthetic other platform',
        platform: 'wechat',
      },
    });
    await prisma.xhsCreator.update({
      where: { id: creatorId },
      data: { displayName: 'AlphaAuthor', groupId: null },
    });
    const second = await prisma.xhsCreator.create({
      data: {
        id: 'synthetic-search-second',
        displayName: 'BlueAuthor',
        profileUrl:
          'https://www.xiaohongshu.com/user/profile/synthetic-search-second',
        groupId: group.id,
      },
    });
    const firstId = JSON.stringify(['xiaohongshu', 'note', 'search-first']),
      secondId = JSON.stringify(['xiaohongshu', 'note', 'search-second']);
    await prisma.xhsNote.create({
      data: {
        id: firstId,
        creatorId,
        title: 'Literal Entry',
        publishTime: 1760000000,
        status: 'complete',
        kind: 'image-text',
        contentHtml:
          '<div id="js_content"><p>Visible A&amp;B 100%_</p><script>script-only-secret</script><span hidden>hidden-only-secret</span><span style="display:none">style-only-secret</span><img alt="attribute-only-secret" src="data:image/png;base64,' +
          png +
          '"></div>',
      },
    });
    await prisma.xhsNote.create({
      data: {
        id: secondId,
        creatorId: second.id,
        title: 'Second Entry',
        publishTime: 1760000001,
        status: 'complete',
        kind: 'image-text',
        contentHtml: '<div id="js_content"><p>Other visible words</p></div>',
      },
    });
    const api = caller().xiaohongshu;
    expect((await api.notes({})).items.map((n) => n.creatorId)).toEqual([
      second.id,
      creatorId,
    ]);
    expect((await api.notes({ search: 'a&b' })).items.map((n) => n.id)).toEqual(
      [firstId],
    );
    expect(
      (await api.notes({ search: '100%_' })).items.map((n) => n.id),
    ).toEqual([firstId]);
    expect((await api.notes({ search: 'BLUEAUTHOR' })).items).toMatchObject([
      {
        id: secondId,
        creatorId: second.id,
        creatorName: 'BlueAuthor',
        groupId: group.id,
      },
    ]);
    expect(
      (await api.notes({ search: 'entry', groupId: null })).items.map(
        (n) => n.id,
      ),
    ).toEqual([firstId]);
    expect(
      (await api.notes({ search: 'visible', groupId: group.id })).items.map(
        (n) => n.id,
      ),
    ).toEqual([secondId]);
    expect((await api.notes({ creatorId, groupId: group.id })).items).toEqual(
      [],
    );
    for (const term of [
      'script-only-secret',
      'hidden-only-secret',
      'style-only-secret',
      'attribute-only-secret',
      'image/png',
      'iVBORw0KGgo',
      '<p>',
    ]) {
      expect((await api.notes({ search: term })).items).toHaveLength(0);
      await expect(api.export({ search: term })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }
    await expect(api.notes({ groupId: foreign.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await api.export({ search: 'visible' })).notes).toBe(2);
    expect(
      (await api.export({ search: 'BLUEAUTHOR', groupId: group.id })).notes,
    ).toBe(1);
    expect((await api.export({ search: '100%_', groupId: null })).notes).toBe(
      1,
    );
    await expect(
      api.export({ groupId: group.id, noteIds: [firstId] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      JSON.stringify((await api.notes({ search: 'visible' })).items),
    ).not.toContain('contentHtml');
  }, 30000);
  it.each(['unverified', 'summary', 'author', 'media', 'cursor'])(
    'rejects failed %s evidence before writing trusted notes',
    async (kind) => {
      const input = candidate();
      if (kind === 'summary') input.textStatus = 'summary';
      if (kind === 'author') input.authorId = 'another-synthetic-author';
      if (kind === 'media') input.expectedImageCount = 2;
      const normalized = source([input], kind !== 'unverified');
      if (kind === 'cursor')
        (normalized.read as jest.Mock).mockResolvedValue({
          authorId: 'synthetic-author',
          evidenceVerified: true,
          pages: [
            { requestCursor: null, nextCursor: 'repeat', items: [input] },
            { requestCursor: 'repeat', nextCursor: 'repeat', items: [input] },
          ],
        });
      const call = caller(
        new XiaohongshuService(prisma as any, normalized),
      ).xiaohongshu.legacyRefresh({ id: creatorId });
      if (kind === 'summary' || kind === 'media')
        await expect(call).resolves.toMatchObject({
          status: 'partial',
          failureScope: 'article',
          failedCount: 1,
        });
      else
        await expect(call).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
      expect(await prisma.xhsNote.count()).toBe(0);
      expect(
        (
          await prisma.xhsCreator.findUniqueOrThrow({
            where: { id: creatorId },
          })
        ).externalAuthorId,
      ).toBe(
        kind === 'summary' || kind === 'media' ? 'synthetic-author' : null,
      );
    },
  );
  it('keeps old full content when a later normalized response is incomplete', async () => {
    const api = caller(new XiaohongshuService(prisma as any, source()));
    await api.legacyRefresh({ id: creatorId });
    const old = await prisma.xhsNote.findMany();
    await expect(
      caller(
        new XiaohongshuService(
          prisma as any,
          source([
            { ...candidate(), text: '', textStatus: 'unknown', images: [] },
          ]),
        ),
      ).xiaohongshu.legacyRefresh({ id: creatorId }),
    ).resolves.toMatchObject({
      status: 'partial',
      failureScope: 'article',
      failedCount: 1,
    });
    expect(await prisma.xhsNote.findMany()).toEqual(old);
  });
  it('saves actual cached bytes through the original protected local saver, with date folders and no ZIP', async () => {
    const service = new XiaohongshuService(prisma as any, source());
    await service.refresh(creatorId);
    const note = await prisma.xhsNote.findFirstOrThrow();
    const destination = path.join(root, 'direct-save');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(
      path.join(root, '.xiaohongshu-download-settings.json'),
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [
        { provide: XiaohongshuService, useValue: service },
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: 'fixture-access' } }),
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    const post = (
      endpoint = '/download/article/xiaohongshu/' +
        encodeURIComponent(note.id) +
        '/save',
      payload: object = { creatorId },
    ) =>
      request(app.getHttpServer())
        .post(endpoint)
        .set('host', '127.0.0.1')
        .set('origin', 'http://127.0.0.1')
        .set('authorization', 'fixture-access')
        .send(payload);
    try {
      expect((await post().unset('authorization')).status).toBe(401);
      expect(
        (await post().set('origin', 'https://www.xiaohongshu.com')).status,
      ).toBe(403);
      expect(
        (
          await post(undefined, {
            creatorId,
            directory: destination,
            contentHtml: note.contentHtml,
          })
        ).status,
      ).toBe(400);
      expect(
        (await post(undefined, { creatorId: 'wrong-creator' })).status,
      ).toBe(422);
      expect(await fs.readdir(destination)).toEqual([]);
      const first = await post();
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        saved: true,
        contentSource: 'saved-xiaohongshu',
        imageCount: 1,
        alreadySaved: false,
      });
      expect(path.basename(first.body.markdownPath)).toBe(note.title + '.md');
      expect(path.relative(destination, first.body.directory)).toMatch(
        /^\d{4}-\d{2}-\d{2}_未分组[\\/]/,
      );
      const md = await fs.readFile(first.body.markdownPath, 'utf8');
      expect(md).toContain('完整合成正文');
      expect(md).toContain('image/image_');
      const images = await fs.readdir(path.join(first.body.directory, 'image'));
      expect(
        await fs.readFile(path.join(first.body.directory, 'image', images[0])),
      ).toEqual(Buffer.from(png, 'base64'));
      await fs.writeFile(first.body.markdownPath, md + '\n用户本地笔记');
      expect((await post()).body).toMatchObject({
        saved: true,
        alreadySaved: true,
        markdownPath: first.body.markdownPath,
      });
      expect(await fs.readFile(first.body.markdownPath, 'utf8')).toContain(
        '用户本地笔记',
      );
      await post('/download/article/settings?target=xiaohongshu', {
        askEveryTime: true,
      });
      expect((await post()).status).toBe(409);
      jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValue(null);
      expect(
        (await post('/download/article/directory?target=xiaohongshu', {})).body
          .cancelled,
      ).toBe(true);
      expect((await post()).status).toBe(409);
      jest.mocked(picker.pickArticleDirectory).mockResolvedValue(destination);
      const picked = await post(
        '/download/article/directory?target=xiaohongshu',
        {},
      );
      expect(
        (await post(undefined, { creatorId, pickToken: picked.body.pickToken }))
          .status,
      ).toBe(200);
      expect(
        (await post(undefined, { creatorId, pickToken: picked.body.pickToken }))
          .status,
      ).toBe(409);
      await post('/download/article/settings?target=xiaohongshu', {
        askEveryTime: false,
      });
      process.env.WEWE_ACCEPTANCE_MODE = '1';
      expect((await post()).status).toBe(409);
      delete process.env.WEWE_ACCEPTANCE_MODE;
      const before = await fs.readdir(destination);
      await prisma.xhsNote.update({
        where: { id: note.id },
        data: {
          contentHtml:
            '<div id="js_content"><img src="https://example.com/remote.png"></div>',
        },
      });
      expect((await post()).status).toBe(422);
      expect(await fs.readdir(destination)).toEqual(before);
    } finally {
      await app.close();
    }
  }, 30000);
  it('serializes one creator while source is in flight and releases lock after failure', async () => {
    let reject!: (e: Error) => void;
    const pending = new Promise<never>((_, r) => (reject = r));
    const normalized: XhsSource = { read: jest.fn().mockReturnValue(pending) };
    const api = caller(new XiaohongshuService(prisma as any, normalized));
    const first = api.legacyRefresh({ id: creatorId });
    while (!(normalized.read as jest.Mock).mock.calls.length)
      await new Promise((r) => setTimeout(r, 1));
    await expect(api.legacyRefresh({ id: creatorId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      api.xiaohongshu.edit({ id: creatorId, enabled: false }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.xiaohongshu.remove({ id: creatorId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    reject(new Error('synthetic failure'));
    await expect(first).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    (normalized.read as jest.Mock).mockResolvedValue({
      authorId: 'synthetic-author',
      evidenceVerified: true,
      pages: [{ requestCursor: null, nextCursor: null, items: [candidate()] }],
    });
    await expect(
      api.xiaohongshu.legacyRefresh({ id: creatorId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it('records isolated note failure and commits later verified note with receipt', async () => {
    const bad = { ...candidate('bad'), textStatus: 'summary' as const };
    const svc = new XiaohongshuService(
      prisma as any,
      source([bad, candidate('later')]),
    );
    const result = await svc.refresh(creatorId);
    expect(result).toMatchObject({
      status: 'partial',
      failureScope: 'article',
      failedCount: 1,
      added: 1,
    });
    expect(await prisma.xhsNote.count({ where: { creatorId } })).toBe(1);
    const jobs = await prisma.$queryRawUnsafe<any[]>(
      'SELECT state,outcome FROM xhs_refresh_jobs WHERE creator_id=?',
      creatorId,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('complete');
    expect(JSON.parse(jobs[0].outcome)).toMatchObject({
      added: 1,
      failedCount: 1,
    });
    expect(
      await prisma.$queryRawUnsafe<any[]>(
        'SELECT code FROM xhs_refresh_failures WHERE creator_id=?',
        creatorId,
      ),
    ).toEqual([{ code: 'NOTE_BODY_OR_MEDIA_INVALID' }]);
  });
  it('records a bad video and continues the later verified note', async () => {
    const badVideo = {
      ...candidate('bad-video'),
      kind: 'video' as const,
      video: {
        complete: true,
        mimeType: 'video/mp4' as const,
        bytes: Buffer.from('bad'),
        expectedBytes: 3,
        sha256: '0'.repeat(64),
      },
    };
    const normalized: XhsSource = {
      read: jest.fn().mockResolvedValue({
        authorId: 'synthetic-author',
        evidenceVerified: true,
        pages: [
          {
            requestCursor: null,
            nextCursor: null,
            items: [badVideo, candidate('later')],
          },
        ],
      }),
    };
    const result = await new XiaohongshuService(
      prisma as any,
      normalized,
    ).refresh(creatorId);
    expect(result).toMatchObject({
      status: 'partial',
      failureScope: 'article',
      failedCount: 1,
      added: 1,
    });
    expect(await prisma.xhsNote.count({ where: { creatorId } })).toBe(1);
  });
  it('persists stop during a synthetic in-flight read and blocks commit and replay', async () => {
    let resolve!: (value: Awaited<ReturnType<XhsSource['read']>>) => void;
    const pending = new Promise<Awaited<ReturnType<XhsSource['read']>>>((r) => {
      resolve = r;
    });
    const normalized: XhsSource = { read: jest.fn().mockReturnValue(pending) };
    const first = new XiaohongshuService(prisma as any, normalized);
    const run = first.refresh(creatorId);
    while (!(normalized.read as jest.Mock).mock.calls.length)
      await new Promise((r) => setTimeout(r, 1));
    const other = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    try {
      expect(
        await new XiaohongshuService(other as any, normalized).stopRefresh(
          creatorId,
        ),
      ).toEqual({ stopped: true });
    } finally {
      await other.$disconnect();
    }
    resolve({
      authorId: 'synthetic-author',
      evidenceVerified: true,
      pages: [{ requestCursor: null, nextCursor: null, items: [candidate()] }],
    });
    await expect(run).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await prisma.xhsNote.count({ where: { creatorId } })).toBe(0);
    await expect(
      new XiaohongshuService(prisma as any, normalized).refresh(creatorId),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(normalized.read).toHaveBeenCalledTimes(1);
  });
  it('replays a committed receipt without a second source read', async () => {
    const normalized = source();
    const op = '38b83974-277d-4a49-88aa-492f7d22f777';
    const svc = new XiaohongshuService(prisma as any, normalized);
    const result = await svc.refresh(creatorId, op);
    const other = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    try {
      expect(
        await new XiaohongshuService(other as any, normalized).refreshStatus(
          creatorId,
          op,
        ),
      ).toEqual({ state: 'complete', outcome: result });
      expect(
        await new XiaohongshuService(other as any, normalized).refresh(
          creatorId,
          op,
        ),
      ).toEqual(result);
    } finally {
      await other.$disconnect();
    }
    expect(normalized.read).toHaveBeenCalledTimes(1);
  });
  it('keeps an unknown source outcome closed across creators', async () => {
    const normalized: XhsSource = {
      read: jest.fn().mockRejectedValue(new Error('synthetic unknown')),
    };
    const second = (
      await new XiaohongshuService(prisma as any).add(
        'second',
        'https://www.xiaohongshu.com/second-fixture',
      )
    ).creator.id;
    await expect(
      new XiaohongshuService(prisma as any, normalized).refresh(creatorId),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      new XiaohongshuService(prisma as any, normalized).refresh(second),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(normalized.read).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent different owners before another creator reads the source', async () => {
    let resolve!: (value: Awaited<ReturnType<XhsSource['read']>>) => void;
    const normalized: XhsSource = {
      read: jest.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    };
    const second = (
      await new XiaohongshuService(prisma as any).add(
        'second',
        'https://www.xiaohongshu.com/second-fixture',
      )
    ).creator.id;
    const run = new XiaohongshuService(prisma as any, normalized).refresh(
      creatorId,
      '38b83974-277d-4a49-88aa-492f7d22f777',
    );
    while (!(normalized.read as jest.Mock).mock.calls.length)
      await new Promise((r) => setTimeout(r, 1));
    const other = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    try {
      await expect(
        new XiaohongshuService(other as any, normalized).refresh(
          second,
          '38b83974-277d-4a49-88aa-492f7d22f778',
        ),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    } finally {
      await other.$disconnect();
    }
    resolve({
      authorId: 'synthetic-author',
      evidenceVerified: true,
      pages: [{ requestCursor: null, nextCursor: null, items: [candidate()] }],
    });
    expect((await run).added).toBe(1);
    expect(normalized.read).toHaveBeenCalledTimes(1);
  });
  it('does not classify unfinished pagination as an isolated note failure', async () => {
    const normalized: XhsSource = {
      read: jest.fn().mockResolvedValue({
        authorId: 'synthetic-author',
        evidenceVerified: true,
        pages: [
          {
            requestCursor: null,
            nextCursor: 'synthetic-next',
            items: [
              { ...candidate('bad'), textStatus: 'summary' },
              candidate('later'),
            ],
          },
        ],
      }),
    };
    const result = await new XiaohongshuService(
      prisma as any,
      normalized,
    ).refresh(creatorId);
    expect(result).toMatchObject({ status: 'partial', added: 1 });
    expect(result).not.toHaveProperty('failureScope');
  });
  it('records stop before claim and rejects a late request with that operation id', async () => {
    const normalized = source();
    const op = '38b83974-277d-4a49-88aa-492f7d22f777';
    const service = new XiaohongshuService(prisma as any, normalized);
    expect(await service.stopRefresh(creatorId, op)).toEqual({ stopped: true });
    await expect(service.refresh(creatorId, op)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(normalized.read).not.toHaveBeenCalled();
    expect(await service.refreshStatus(creatorId, op)).toEqual({
      state: 'stopped',
    });
    await expect(service.remove(creatorId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
  it('rolls back earlier note writes and receipt when a later identity conflicts', async () => {
    const other = (
      await new XiaohongshuService(prisma as any).add(
        'other',
        'https://www.xiaohongshu.com/other-fixture',
      )
    ).creator.id;
    const oldId = JSON.stringify(['xiaohongshu', 'note', 'taken']);
    await prisma.xhsNote.create({
      data: {
        id: oldId,
        creatorId: other,
        title: 'old',
        publishTime: 1700000000,
        status: 'complete',
        contentHtml: 'old',
      },
    });
    const normalized = source([
      { ...candidate('bad'), textStatus: 'summary' },
      candidate('earlier'),
      candidate('taken'),
    ]);
    const op = '38b83974-277d-4a49-88aa-492f7d22f777';
    const service = new XiaohongshuService(prisma as any, normalized);
    await expect(service.refresh(creatorId, op)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await prisma.xhsNote.findMany({ where: { creatorId } })).toEqual([]);
    expect(
      (await prisma.xhsNote.findUniqueOrThrow({ where: { id: oldId } }))
        .contentHtml,
    ).toBe('old');
    expect(await service.refreshStatus(creatorId, op)).toEqual({
      state: 'running',
    });
    expect(
      await prisma.$queryRawUnsafe(
        'SELECT * FROM xhs_refresh_failures WHERE creator_id=?',
        creatorId,
      ),
    ).toEqual([]);
  });
  it('persistent batch combines real XHS service partial and next creator without network', async () => {
    jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockResolvedValue({} as any);
    const second = (
      await new XiaohongshuService(prisma as any).add(
        'second',
        'https://www.xiaohongshu.com/fixture-two',
      )
    ).creator.id;
    const normalized: XhsSource = {
      read: jest.fn(async (creator) => ({
        authorId:
          creator.id === creatorId
            ? 'synthetic-author'
            : 'synthetic-author-two',
        evidenceVerified: true,
        pages: [
          {
            requestCursor: null,
            nextCursor: null,
            items:
              creator.id === creatorId
                ? [
                    { ...candidate('bad'), textStatus: 'summary' as const },
                    candidate('later'),
                  ]
                : [
                    {
                      ...candidate('second'),
                      authorId: 'synthetic-author-two',
                    },
                  ],
          },
        ],
      })),
    };
    const service = new XiaohongshuService(prisma as any, normalized);
    const batch = new XiaohongshuBatches(prisma, service);
    const id = randomUUID();
    await batch.create(id, [creatorId, second]);
    expect((await batch.advance(id)).items[0].state).toBe('partial');
    const reopened = new XiaohongshuBatches(prisma, service);
    expect((await reopened.advance(id)).state).toBe('complete');
    expect(normalized.read).toHaveBeenCalledTimes(2);
    expect(
      (await prisma.xhsNote.findMany({ where: { creatorId } })).map(
        (n) => n.id,
      ),
    ).toContain(JSON.stringify(['xiaohongshu', 'note', 'later']));
    expect(await prisma.xhsNote.count({ where: { creatorId: second } })).toBe(
      1,
    );
    expect(
      await prisma.$queryRawUnsafe('SELECT * FROM xhs_refresh_failures'),
    ).toHaveLength(1);
  });
});

describe('legacy refresh compatibility', () => {
  it('delegates the original arguments and promise without bypassing legacy guards', () => {
    const service = Object.create(
      XiaohongshuService.prototype,
    ) as XiaohongshuService;
    const result = Promise.resolve({
      status: 'paused' as const,
      added: 0,
      message: 'paused',
    });
    const guarded = jest
      .spyOn(service, 'legacyRefresh')
      .mockReturnValue(result);
    expect(service.refresh('synthetic-creator', 'synthetic-operation')).toBe(
      result,
    );
    expect(guarded).toHaveBeenCalledWith(
      'synthetic-creator',
      'synthetic-operation',
    );
  });
});
