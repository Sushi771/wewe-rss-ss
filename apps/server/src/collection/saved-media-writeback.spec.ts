import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { CollectionService } from './collection.service';
import { canonicalArticleUrl } from './collection-format';
import { sqliteWrites } from './sqlite-write-coordinator';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import {
  inspectSavedMedia,
  readSavedMediaManifest,
} from './saved-media-writeback';
import * as startup from '../startup-audit';
import { archiveProviderImages } from './archive-provider-images';
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest.fn(() => {
    throw Error('FULL_BACKUP_FORBIDDEN');
  }),
}));

describe('protected exact saved-media writeback on synthetic SQLite', () => {
  const env = { ...process.env };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  const inline = 'data:image/png;base64,' + png.toString('base64');
  const hash = (v: string | Buffer) =>
    createHash('sha256').update(v).digest('hex');
  const mpId = 'MP_WXS_1234567890';
  let root: string,
    resources: string,
    prisma: PrismaService,
    service: TrpcService,
    collector: CollectionService,
    router: TrpcRouter;
  let manifest: any,
    before: any[],
    feedBefore: any,
    forceCasFailure: boolean,
    conditionalWrites: number;
  const source = (n: number) => `https://mmbiz.qpic.cn/synthetic-${n}.png`;
  const config = { get: () => ({ url: '', updateDelayTime: 0 }) } as any;
  const ids = () => manifest.articles.map((row: any) => row.id) as string[];
  const writeManifest = async () => {
    const bytes = JSON.stringify(manifest);
    await fs.writeFile(path.join(resources, 'manifest.json'), bytes);
    process.env.WEWE_SAVED_MEDIA_MANIFEST_SHA256 = hash(bytes);
  };
  const call = (
    input: any = { ids: ids() },
    ctx: any = { isLocal: true, errorMsg: null },
  ) => router.appRouter.createCaller(ctx).article.supplementSavedMedia(input);
  beforeEach(async () => {
    jest.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'exact-media-synthetic-'));
    resources = path.join(root, 'assets');
    await fs.mkdir(resources);
    Object.assign(process.env, {
      DATABASE_URL:
        'file:' +
        path.join(root, 'data.db').replaceAll('\\', '/') +
        '?connection_limit=1',
      WECHAT2RSS_ENABLED: '1',
      WECHAT2RSS_BASE_URL: 'http://127.0.0.1:18080/',
      WECHAT2RSS_TOKEN: 'synthetic',
      WECHAT2RSS_CACHE_MEDIA: '0',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
      WEWE_SAVED_MEDIA_ROOT: resources,
    });
    delete process.env.WEWE_ACCEPTANCE_MODE;
    prisma = new PrismaService();
    await prisma.$connect();
    forceCasFailure = false;
    conditionalWrites = 0;
    prisma.$use(async (params, next) =>
      forceCasFailure &&
      params.model === 'Article' &&
      params.action === 'updateMany' &&
      ++conditionalWrites === 2
        ? { count: 0 }
        : next(params),
    );
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const sql = await fs
        .readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: 'synthetic',
        mpIntro: '',
        mpCover: '',
        collectionChannel: 'wechat2rss',
        syncTime: 17,
        updateTime: 31,
        hasHistory: 1,
        lastCollectionResult: '{"status":"succeeded","historical":true}',
      },
    });
    manifest = { version: 1, mpId, articles: [] };
    for (let n = 1; n <= 5; n++) {
      const identity = canonicalArticleUrl(
        `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${1000 + n}&idx=1`,
      );
      const id = n === 5 ? 'opaque-local-legacy-id' : identity.id;
      const savedUrl = new URL(identity.url);
      if (n === 5) savedUrl.searchParams.sort();
      const body = `<div class="rich_media_content" data-wewe-image-retryable="true" data-wewe-image-pending="1"><p>local annotation ${n}</p><img src="${inline}"><img src="${source(n)}"></div><aside>outside user note ${n}</aside>`;
      await prisma.article.create({
        data: {
          id,
          mpId,
          sourceUrl: savedUrl.toString(),
          verifiedSourceUrl: savedUrl.toString(),
          title: 'local title ' + n,
          picUrl: '',
          publishTime: 1760000000 + n,
          contentHtml: body,
          lastBodyStatus: 'images-pending',
          metrics: '{"kept":13}',
          readCount: 19,
          likeCount: 7,
          lastBodyRetry: '{"historical":true}',
        },
      });
      await fs.writeFile(path.join(resources, `image-${n}.png`), png);
      manifest.articles.push({
        id,
        sourceUrl: identity.url,
        bodySha256: hash(body),
        assets: [
          {
            sourceUrl: source(n),
            file: `image-${n}.png`,
            bytes: png.length,
            sha256: hash(png),
            decodedSha256: hash(png),
            type: 'image/png',
          },
        ],
      });
    }
    await prisma.article.create({
      data: {
        id: 'unselected',
        mpId,
        title: 'not selected',
        picUrl: '',
        publishTime: 1760000000,
        contentHtml: '<div class="rich_media_content">kept</div>',
      },
    });
    await prisma.$executeRaw`INSERT INTO cache_refresh_commits(id,mp_id,result_json,committed_at_ms) VALUES('historical',${mpId},'{}',1)`;
    await writeManifest();
    collector = new CollectionService(prisma);
    service = new TrpcService(prisma, config, {} as any, collector);
    router = new TrpcRouter(service, prisma, config, {} as any, {} as any);
    before = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    feedBefore = await prisma.feed.findUnique({ where: { id: mpId } });
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NETWORK_FORBIDDEN'));
  });
  afterEach(async () => {
    service?.onModuleDestroy();
    await prisma?.$disconnect();
    jest.restoreAllMocks();
    process.env = { ...env };
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('exact-media-synthetic-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('updates only five existing bodies, including a legacy ID, through coordinator with zero network/backup and no historical feed/receipt changes', async () => {
    const marker = path.join(root, '.wechat2rss-media-blocked.json');
    await fs.writeFile(marker, 'synthetic existing media stop');
    const coordination = jest.spyOn(sqliteWrites, 'write');
    expect(await call()).toMatchObject({
      updated: 5,
      created: 0,
      mediaReady: true,
    });
    const after = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    for (const old of before) {
      const row = after.find((item) => item.id === old.id)!;
      if (old.id === 'unselected') expect(row).toEqual(old);
      else {
        expect(row.contentHtml).toContain('local annotation');
        expect(row.contentHtml).toContain('outside user note');
        expect(row.contentHtml).not.toContain('synthetic-');
        expect(row.lastBodyStatus).toBe('available');
        expect({
          ...row,
          contentHtml: old.contentHtml,
          lastBodyStatus: old.lastBodyStatus,
          updatedAt: old.updatedAt,
        }).toEqual(old);
      }
    }
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toEqual(
      feedBefore,
    );
    expect(await prisma.$queryRaw`SELECT * FROM cache_refresh_commits`).toEqual(
      [
        {
          id: 'historical',
          mp_id: mpId,
          result_json: '{}',
          committed_at_ms: 1n,
        },
      ],
    );
    expect(coordination).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    const stable = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    expect(await call()).toMatchObject({ updated: 0, mediaReady: true });
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      stable,
    );
    expect(process.env.WECHAT2RSS_CACHE_MEDIA).toBe('0');
    expect(await fs.readFile(marker, 'utf8')).toBe(
      'synthetic existing media stop',
    );
  });
  it('preserves unknown empty/CSS/srcset/non-image slots and unmapped sources instead of claiming complete', async () => {
    const id = ids()[0];
    const body = before
      .find((row) => row.id === id)
      .contentHtml.replace(
        '</div>',
        '<img><img src="https://mmbiz.qpic.cn/not-bound.png"><span style="background:url(https://mmbiz.qpic.cn/background.png)"></span><img srcset="x 1x"><video></video></div>',
      );
    await prisma.article.update({ where: { id }, data: { contentHtml: body } });
    manifest.articles[0].bodySha256 = hash(body);
    await writeManifest();
    const result = await call({ ids: [id] });
    expect(result).toMatchObject({
      updated: 1,
      mediaReady: false,
      articles: [{ id, status: 'unconfirmed', ready: false }],
    });
    const saved = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(saved.lastBodyStatus).toBe('images-pending');
    expect(saved.contentHtml).toContain('not-bound.png');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['hash', 'length', 'decode', 'file', 'source'])(
    'rejects invalid bound asset %s without any article write',
    async (kind) => {
      const asset = manifest.articles[0].assets[0];
      if (kind === 'hash') asset.sha256 = 'a'.repeat(64);
      if (kind === 'length') asset.bytes++;
      if (kind === 'decode') {
        await fs.writeFile(path.join(resources, asset.file), 'not an image');
        asset.bytes = 12;
        asset.sha256 = hash('not an image');
        asset.decodedSha256 = asset.sha256;
      }
      if (kind === 'file') asset.file = '../outside.png';
      if (kind === 'source') asset.sourceUrl = 'file:///outside.png';
      await writeManifest();
      await expect(call()).rejects.toBeDefined();
      expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
        before,
      );
      expect(global.fetch).not.toHaveBeenCalled();
      expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    },
  );
  it('rejects a changed manifest and reads no asset if server binding is not configured', async () => {
    await fs.appendFile(path.join(resources, 'manifest.json'), ' ');
    await expect(call()).rejects.toThrow('SAVED_MEDIA_MANIFEST_CHANGED');
    delete process.env.WEWE_SAVED_MEDIA_MANIFEST_SHA256;
    await expect(call()).rejects.toThrow('SAVED_MEDIA_NOT_CONFIGURED');
  });
  it('rejects concurrent body edits before commit and leaves every other target untouched', async () => {
    const original = collector.collectWechat2RssRecent.bind(collector),
      id = ids()[0];
    jest
      .spyOn(collector, 'collectWechat2RssRecent')
      .mockImplementationOnce(async (input) => {
        await prisma.article.update({
          where: { id },
          data: {
            contentHtml:
              '<div class="rich_media_content">concurrent edit</div>',
          },
        });
        return original(input);
      });
    await expect(call()).rejects.toThrow('SAVED_MEDIA_CONFLICT');
    const after = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    expect(after.find((row) => row.id === id)?.contentHtml).toContain(
      'concurrent edit',
    );
    expect(after.filter((row) => row.id !== id)).toEqual(
      before.filter((row) => row.id !== id),
    );
  });
  it('treats a failed conditional update as a conflict and releases the feed gate', async () => {
    forceCasFailure = true;
    await expect(call()).rejects.toThrow('SAVED_MEDIA_CONFLICT');
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    forceCasFailure = false;
    expect(await call()).toMatchObject({ updated: 5 });
  });
  it('retains the live main-service active collection gate', async () => {
    (service as any).activeCollections.add(mpId);
    await expect(call()).rejects.toThrow('CACHE_SYNC_BUSY');
    (service as any).activeCollections.clear();
    (collector as any).publicCollections.add(mpId);
    await expect(call()).rejects.toThrow('正在更新');
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
  });
  it.each([
    [{ ids: ['not-bound'] }, { isLocal: true, errorMsg: null }],
    [
      { ids: ['x'], path: '/anything' },
      { isLocal: true, errorMsg: null },
    ],
    [{ ids: ['x'] }, { isLocal: false, errorMsg: null }],
    [{ ids: ['x'] }, { isLocal: true, errorMsg: 'unauthorized' }],
    [{ ids: ['x', 'x'] }, { isLocal: true, errorMsg: null }],
  ])(
    'refuses unbound/extra/remote/unauthorized/duplicate input',
    async (input, ctx) => {
      await expect(call(input, ctx)).rejects.toBeDefined();
      expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
        before,
      );
    },
  );
  it('retains the existing startup mutation gate', async () => {
    jest.spyOn(startup, 'databaseWritesAllowed').mockReturnValue(false);
    await expect(call()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
  it('does not certify unsupported bodies or invalid inline bytes', async () => {
    expect(
      inspectSavedMedia(
        '<div class="rich_media_content"><img src="data:image/png;base64,eA=="></div>',
      ).ready,
    ).toBe(false);
    expect(inspectSavedMedia('<div>missing provider root</div>').ready).toBe(
      false,
    );
    expect((await readSavedMediaManifest()).manifest.articles).toHaveLength(5);
  });
});

describe('verified local archive cache budget', () => {
  it('counts shared local bytes against each article without making HTTP requests', async () => {
    const inline =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    try {
      const item = {
        id: 'a',
        mpId: 'MP_WXS_1234567890',
        url: '',
        title: 'synthetic',
        publishTime: 1760000000,
        picUrl: '',
      };
      const page = await archiveProviderImages(
        {
          articles: [
            {
              ...item,
              contentHtml:
                '<div class="rich_media_content">one<img src="https://mmbiz.qpic.cn/a.png"></div>',
            },
            {
              ...item,
              id: 'b',
              contentHtml:
                '<div class="rich_media_content">two<img src="https://mmbiz.qpic.cn/a.png"><img src="https://mmbiz.qpic.cn/b.png"></div>',
            },
          ],
          coverage: 'stored-history-window',
          upstreamCount: 2,
          bodyMissing: 0,
          imageBlocked: 0,
        },
        {
          verifiedImages: new Map([
            ['https://mmbiz.qpic.cn/a.png', inline],
            ['https://mmbiz.qpic.cn/b.png', inline],
          ]),
          preserveTextOnImageFailure: true,
          maxArticleImageBytes: 100,
        },
      );
      expect(page.imageBlocked).toBe(1);
      expect(page.articles[0].contentHtml).not.toContain('pending');
      expect(page.articles[1].contentHtml).toContain(
        'data-wewe-image-pending="1"',
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
