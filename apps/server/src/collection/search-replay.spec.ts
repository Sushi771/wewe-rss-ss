import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { prepareSearchReplay } from './search-replay';
import { searchArticleCandidates } from './article-candidate';
import { createVerifiedSqliteBackup } from './sqlite-backup';
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));
import {
  fetchLiveOwnerArticles,
  readOwnerSearchConfig,
  OwnerUpdateStopped,
} from './owner-search-update';
jest.mock('./owner-search-update', () => ({
  ...jest.requireActual('./owner-search-update'),
  fetchLiveOwnerArticles: jest.fn(),
  readOwnerSearchConfig: jest.fn(),
}));
const mpId = 'MP_WXS_1234567890',
  biz = 'MTIzNDU2Nzg5MA==';
const url = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=100&idx=1&sn=abcd`;
const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">测试文章</h1><div id="js_content">正文</div><script>var biz="${biz}";var mid="100";var idx="1";var sn="abcd";var ct=1700000000;</script>`;
const candidates = searchArticleCandidates(
  [
    {
      doc_url: url,
      title: '测试文章',
      timestamp: 1700000033,
      source: { title: '测试号' },
    },
  ],
  { name: '测试号', biz },
  { source: 'owner-web-search', capturedAt: '2026-09-30T08:00:00Z', page: 1 },
);
const cache = {
  html,
  images: [],
  evidence: {
    source: 'official-public-original' as const,
    requestedUrl: url,
    capturedAt: '2026-09-30T07:00:00Z',
    sha256: createHash('sha256').update(html).digest('hex'),
    transport: 'verified-cache' as const,
  },
};
describe('verified search SQLite rehearsal protection (no HTTP)', () => {
  let dir: string,
    dbPath: string,
    prisma: PrismaClient,
    collection: CollectionService;
  const previous = process.env.DATABASE_URL;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-search-replay-'));
    dbPath = path.join(dir, 'copy.db');
    process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      const file = path.join(migrations, name, 'migration.sql');
      for (const sql of (await fs.readFile(file, 'utf8'))
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(sql);
    }
    const source = path.join(dir, 'source.db');
    await fs.writeFile(source, 'isolated test source marker');
    await fs.writeFile(
      dbPath + '.search-replay.json',
      JSON.stringify({ mode: 'real-response-replay', sourceDatabase: source }),
    );
    collection = new CollectionService(prisma as any);
  });
  beforeEach(async () => {
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: '测试号',
        mpCover: '',
        mpIntro: '',
        updateTime: 1700000000,
      },
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const replay = () => prepareSearchReplay(candidates, mpId, async () => cache);
  it('saves only ct time, leaves subscription binding/success time untouched, and deduplicates after reconstruction', async () => {
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    expect(
      await collection.replayVerifiedSearch(mpId, await replay()),
    ).toMatchObject({ created: 1, productionSourceEnabled: false });
    const saved = await prisma.article.findFirstOrThrow();
    expect(saved.publishTime).toBe(1700000000);
    expect(
      await new CollectionService(prisma as any).replayVerifiedSearch(
        mpId,
        await replay(),
      ),
    ).toMatchObject({ created: 0, updated: 0 });
    expect(await prisma.article.findFirstOrThrow()).toEqual(saved);
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(feed);
    expect(createVerifiedSqliteBackup).toHaveBeenCalled();
  });
  it('normal update persists live verified results through the same protected transaction and deduplicates', async () => {
    const prepared = await replay();
    (readOwnerSearchConfig as jest.Mock).mockResolvedValue({ mpId });
    (fetchLiveOwnerArticles as jest.Mock).mockResolvedValue(prepared.page);
    expect(await collection.collectOwnerSearch(mpId)).toMatchObject({
      source: 'owner-web-search',
      created: 1,
      status: 'partial',
    });
    expect(await collection.collectOwnerSearch(mpId)).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect((await prisma.article.findFirstOrThrow()).publishTime).toBe(
      1700000000,
    );
  });
  it('a stopped live update writes no articles or success time and never invokes replay', async () => {
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    (readOwnerSearchConfig as jest.Mock).mockResolvedValue({ mpId });
    (fetchLiveOwnerArticles as jest.Mock).mockRejectedValue(
      new OwnerUpdateStopped('正文验证限制'),
    );
    expect(await collection.collectOwnerSearch(mpId)).toMatchObject({
      status: 'blocked',
      articles: 0,
    });
    expect(await prisma.article.count()).toBe(0);
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(feed);
  });
  it('preserves a proven legacy ID, nonempty body, zero metrics and null metrics', async () => {
    await prisma.article.create({
      data: {
        id: 'a'.repeat(22),
        mpId,
        title: '测试文章',
        publishTime: 1700000000,
        picUrl: 'old-cover',
        sourceUrl: url,
        verifiedSourceUrl: url,
        contentHtml: '<div id="js_content">旧正文</div>',
        readCount: 0,
        likeCount: null,
        metrics: '{"read":{"value":0}}',
      },
    });
    const old = await prisma.article.findFirstOrThrow();
    expect(
      await collection.replayVerifiedSearch(mpId, await replay()),
    ).toMatchObject({ created: 0, updated: 0 });
    expect(await prisma.article.findFirstOrThrow()).toEqual(old);
  });
  it.each([
    [1700000033, url, 'METADATA'],
    [1700000000, url.replace('abcd', 'dcba'), 'SIGNATURE'],
  ])(
    'does not apply album tolerance or ignore saved signatures',
    async (time, sourceUrl, conflict) => {
      await prisma.article.create({
        data: {
          id: candidates[0].id,
          mpId,
          title: '测试文章',
          publishTime: time,
          picUrl: '',
          sourceUrl,
          verifiedSourceUrl: sourceUrl,
          readCount: 0,
        },
      });
      const old = await prisma.article.findFirstOrThrow();
      await expect(
        collection.replayVerifiedSearch(mpId, await replay()),
      ).rejects.toThrow('SEARCH_REPLAY_SAVED_' + conflict + '_CONFLICT');
      expect(await prisma.article.findFirstOrThrow()).toEqual(old);
    },
  );
  it('rejects source database as the rehearsal target before saving', async () => {
    await fs.writeFile(
      dbPath + '.search-replay.json',
      JSON.stringify({ mode: 'real-response-replay', sourceDatabase: dbPath }),
    );
    try {
      await expect(
        collection.replayVerifiedSearch(mpId, await replay()),
      ).rejects.toThrow('ISOLATED_SQLITE');
      expect(await prisma.article.count()).toBe(0);
    } finally {
      await fs.writeFile(
        dbPath + '.search-replay.json',
        JSON.stringify({
          mode: 'real-response-replay',
          sourceDatabase: path.join(dir, 'source.db'),
        }),
      );
    }
  });
  it('keeps missing originals unverified and rejects altered body evidence', async () => {
    const missing = await prepareSearchReplay(
      candidates,
      mpId,
      async () => null,
    );
    expect(missing.page.articles).toHaveLength(0);
    expect(missing.unverified).toHaveLength(1);
    await expect(
      prepareSearchReplay(candidates, mpId, async () => ({
        ...cache,
        html: html + ' ',
      })),
    ).rejects.toThrow('cache_hash_mismatch');
  });
});
