import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { spawnSync } from 'node:child_process';
import { XiaohongshuService, XhsSource } from './xiaohongshu.service';
import { XhsNormalizedCandidate } from './xiaohongshu-contract';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';

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
      { encoding: 'utf8', windowsHide: true },
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
  const oldRows = async () => ({
    feeds: await prisma.feed.findMany(),
    articles: await prisma.article.findMany(),
    accounts: await prisma.account.findMany(),
  });
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
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    };
    for (const name of all.filter(
      (n) => n !== '20261009050000_add_xhs_local_archive',
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
    await prisma.feed.create({
      data: {
        id: 'MP_WXS_3456789012',
        mpName: '合成旧公众号',
        mpCover: '',
        mpIntro: '',
        updateTime: 1,
      },
    });
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
    return new TrpcRouter(
      new TrpcService(prisma as any, config, {} as any, {} as any),
      prisma as any,
      config,
      {} as any,
      {} as any,
      service,
    ).appRouter.createCaller({ errorMsg, isLocal: true });
  }
  it('uses protected real routes, persists pending creators, refuses unconfigured refresh/download', async () => {
    await expect(
      caller(undefined, '未登录').xiaohongshu.list(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const api = caller();
    expect((await api.xiaohongshu.capability()).canRefresh).toBe(false);
    expect((await api.xiaohongshu.list()).items).toHaveLength(1);
    expect((await api.xiaohongshu.refresh({ id: creatorId })).status).toBe(
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
    expect((await api.xiaohongshu.refresh({ id: creatorId })).status).toBe(
      'paused',
    );
    await api.xiaohongshu.remove({ id: creatorId });
    expect((await api.xiaohongshu.list()).items).toHaveLength(0);
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
    expect((await api.xiaohongshu.refresh({ id: creatorId })).added).toBe(1);
    const list = await api.xiaohongshu.notes({ creatorId });
    expect(list.items).toHaveLength(2);
    const note = list.items.find((n) => n.status === 'complete')!;
    const body = await api.xiaohongshu.body({ creatorId, noteId: note.id });
    expect(body.text).toBe(candidate().text);
    expect(body.images).toEqual(['data:image/png;base64,' + png]);
    const before = await prisma.xhsNote.findMany();
    expect((await api.xiaohongshu.refresh({ id: creatorId })).added).toBe(0);
    expect(await prisma.xhsNote.findMany()).toEqual(before);
    await expect(
      api.xiaohongshu.remove({ id: creatorId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const exported = await api.xiaohongshu.export({ creatorId });
    expect(exported.notes).toBe(1);
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
      await expect(
        caller(
          new XiaohongshuService(prisma as any, normalized),
        ).xiaohongshu.refresh({ id: creatorId }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await prisma.xhsNote.count()).toBe(0);
      expect(
        (
          await prisma.xhsCreator.findUniqueOrThrow({
            where: { id: creatorId },
          })
        ).externalAuthorId,
      ).toBe(null);
    },
  );
  it('keeps old full content when a later normalized response is incomplete', async () => {
    const api = caller(new XiaohongshuService(prisma as any, source()));
    await api.xiaohongshu.refresh({ id: creatorId });
    const old = await prisma.xhsNote.findMany();
    await expect(
      caller(
        new XiaohongshuService(
          prisma as any,
          source([
            { ...candidate(), text: '', textStatus: 'unknown', images: [] },
          ]),
        ),
      ).xiaohongshu.refresh({ id: creatorId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await prisma.xhsNote.findMany()).toEqual(old);
  });
  it('serializes one creator while source is in flight and releases lock after failure', async () => {
    let reject!: (e: Error) => void;
    const pending = new Promise<never>((_, r) => (reject = r));
    const normalized: XhsSource = { read: jest.fn().mockReturnValue(pending) };
    const api = caller(new XiaohongshuService(prisma as any, normalized));
    const first = api.xiaohongshu.refresh({ id: creatorId });
    while (!(normalized.read as jest.Mock).mock.calls.length)
      await new Promise((r) => setTimeout(r, 1));
    await expect(
      api.xiaohongshu.refresh({ id: creatorId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
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
    expect((await api.xiaohongshu.refresh({ id: creatorId })).added).toBe(1);
  });
});
