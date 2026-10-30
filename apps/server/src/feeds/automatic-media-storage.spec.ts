beforeAll(require('../../../../scripts/local-release/writer-self.fixture.test.cjs').prepareWriterSelf);
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcService } from '../trpc/trpc.service';
import { CollectionService } from '../collection/collection.service';
import { canonicalArticleUrl } from '../collection/collection-format';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
import { AutomaticMediaScan } from './automatic-media-scan';
import { AutomaticMediaQueue } from './automatic-media-queue';
import { automaticMediaSources } from '../collection/automatic-media-body';
import {
  hintMediaArticles,
  takeMediaHints,
  cacheSyncState,
} from './cache-sync-state';
import { CacheSyncEngine } from './cache-sync-engine';
import { buildArticleMarkdown } from '../article-export';
import * as startup from '../startup-audit';
jest.mock('../collection/sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest.fn(() => {
    throw Error('BACKUP_FORBIDDEN');
  }),
}));

describe('automatic media discovery through original Prisma/CAS gates (synthetic SQLite)', () => {
  const env = { ...process.env };
  const mpId = 'MP_WXS_1234567890';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  let root: string, prisma: PrismaService, trpc: TrpcService;
  let before: number;
  const identity = (n: number) =>
    canonicalArticleUrl(
      `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${n}&idx=1`,
    );
  let setupPromise: Promise<void> | undefined;
  let schemaRoot: string;
  let schemaPromise: Promise<void> | undefined;
  let fixtureNumber = 0;
  const timing = (stage: string, start: number) =>
    console.info('SYNTHETIC_FIXTURE_TIMING', JSON.stringify({ case: fixtureNumber, stage, elapsedMs: Math.round(performance.now() - start) }));
  beforeAll(() => {
    schemaPromise = (async () => {
      const started = performance.now();
      schemaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'automatic-media-schema-'));
      // Match the migrated application's physical database boundary.
      await fs.writeFile(path.join(schemaRoot, 'schema.db'), '', { flag: 'wx' });
      const savedUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'file:' + path.join(schemaRoot, 'schema.db').replaceAll('\\', '/') + '?connection_limit=1';
      let schemaPrisma: PrismaService | undefined;
      try {
        schemaPrisma = new PrismaService();
        await schemaPrisma.$connect();
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const sql = await fs
        .readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of splitSqliteStatements(sql)
        .map((value) => value.trim())
        .filter(Boolean))
        await schemaPrisma.$executeRawUnsafe(statement);
    }
        await schemaPrisma.$queryRawUnsafe('PRAGMA journal_mode=DELETE');
      } finally {
        try { await schemaPrisma?.$disconnect(); } finally {
          if (savedUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = savedUrl;
        }
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (await fs.stat(path.join(schemaRoot, 'schema.db') + suffix).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; }))
          throw Error('SCHEMA_FIXTURE_HAS_SIDECAR');
      }
      await fs.chmod(path.join(schemaRoot, 'schema.db'), 0o444);
      timing('schema-ready', started);
    })();
    return schemaPromise;
  }, 40000);
  afterAll(async () => {
    await schemaPromise?.catch(() => undefined);
    if (schemaRoot && path.dirname(schemaRoot) === os.tmpdir() && path.basename(schemaRoot).startsWith('automatic-media-schema-')) {
      await fs.chmod(path.join(schemaRoot, 'schema.db'), 0o600).catch(() => undefined);
      await fs.rm(schemaRoot, { recursive: true, force: true });
    }
  }, 40000);
  const setupFixture = async () => {
    fixtureNumber++;
    const overall = performance.now();
    let stage = overall;
    jest.clearAllMocks();
    while (takeMediaHints().length) {
      /* isolate process-local hints */
    }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'automatic-media-sqlite-'));
    Object.assign(process.env, {
      DATABASE_URL:
        'file:' +
        path.join(root, 'data.db').replaceAll('\\', '/') +
        '?connection_limit=1',
      WECHAT2RSS_ENABLED: '1',
      WECHAT2RSS_BASE_URL: 'http://127.0.0.1:18080',
      WECHAT2RSS_TOKEN: 'synthetic',
      WECHAT2RSS_CACHE_MEDIA: '0',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
    });
    delete process.env.WEWE_ACCEPTANCE_MODE;
    jest.spyOn(startup, 'databaseWritesAllowed').mockReturnValue(true);
    await fs.copyFile(path.join(schemaRoot, 'schema.db'), path.join(root, 'data.db'));
    await fs.chmod(path.join(root, 'data.db'), 0o600);
    timing('schema-copy', stage); stage = performance.now();
    prisma = new PrismaService();
    await prisma.$connect();
    timing('connect', stage); stage = performance.now();
    if (await prisma.feed.count() !== 0 || await prisma.article.count() !== 0)
      throw Error('SCHEMA_FIXTURE_NOT_EMPTY');
    await prisma.feed.create({
      data: {
        id: mpId,
        mpName: 'fixture',
        mpIntro: '',
        mpCover: '',
        status: 1,
        collectionChannel: 'wechat2rss',
        syncTime: 17,
        updateTime: 19,
        lastCollectionResult: '{"historical":true}',
      },
    });
    before = Date.now() - 1000;
    for (let n = 1; n <= 25; n++) {
      const item = identity(n);
      await prisma.article.create({
        data: {
          id: item.id,
          mpId,
          sourceUrl: item.url,
          verifiedSourceUrl: item.url,
          title: 'fixture',
          publishTime: 1760000000,
          picUrl: '',
          contentHtml: `<aside>note ${n}</aside><div id="js_content">saved text<img data-src="https://mmbiz.qpic.cn/synthetic-shared.png"></div>`,
          lastBodyStatus: 'images-pending',
          metrics: '{"unchanged":true}',
          readCount: 5,
        },
      });
    }
    timing('seed', stage);
    timing('setup', overall);
    trpc = new TrpcService(
      prisma,
      { get: () => ({ url: '', updateDelayTime: 0 }) } as any,
      {} as any,
      new CollectionService(prisma),
    );
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('REAL_NETWORK_FORBIDDEN'));
  };
  beforeEach(() => {
    setupPromise = setupFixture();
    return setupPromise;
  }, 40000);
  afterEach(async () => {
    // A Jest deadline does not cancel SQLite setup. Join the same work before
    // closing handles/removing files; its original hook failure stays failed.
    await setupPromise?.catch(() => undefined);
    trpc?.onModuleDestroy();
    await prisma?.$disconnect();
    jest.restoreAllMocks();
    process.env = { ...env };
    if (
      root &&
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('automatic-media-sqlite-')
    )
      await fs.rm(root, { recursive: true, force: true });
  }, 40000);
  it('discovers saved IDs beyond the current upstream page with bounded cursor pages and durable replay', async () => {
    const scan = new AutomaticMediaScan(prisma);
    const one = await scan.page('', before, true);
    expect(one.rows).toHaveLength(20);
    expect(one.end).toBe(false);
    const two = await scan.page(one.cursor, before, true);
    expect(two.rows).toHaveLength(5);
    expect(two.end).toBe(true);
    expect(new Set([...one.rows, ...two.rows].map((row) => row.id)).size).toBe(
      25,
    );
    let now = Date.now();
    const fetch = jest
      .fn()
      .mockResolvedValue({ bytes: png, type: 'image/png' });
    const make = () =>
      new AutomaticMediaQueue(path.join(root, 'data.db'), {
        now: () => now,
        scan: (cursor) => scan.page(cursor, before, true),
        load: (id) => scan.load(id),
        fetch,
        commit: (row, images) => trpc.commitAutomaticArticleMedia(row, images),
        stop: async () => {
          throw Error('UNEXPECTED_STOP');
        },
        canFetch: () => true,
        publish: () => undefined,
      });
    const feed = await prisma.feed.findUnique({ where: { id: mpId } });
    for (let n = 0; n < 25; n++) {
      await make().tick();
      now += 2100;
    }
    const rows = await prisma.article.findMany();
    expect(
      rows.every((row) => automaticMediaSources(row.contentHtml!).ready),
    ).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.contentHtml!.includes('note ') &&
          row.metrics === '{"unchanged":true}' &&
          row.readCount === 5,
      ),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
    expect(await prisma.feed.findUnique({ where: { id: mpId } })).toEqual(feed);
    expect(
      await prisma.$queryRaw`SELECT id FROM cache_refresh_commits`,
    ).toEqual([]);
    const imageFetcher = jest
      .fn()
      .mockRejectedValue(Error('CDN_MUST_NOT_REPEAT'));
    const exported = await buildArticleMarkdown(
      rows[0],
      '',
      path.join(root, 'export'),
      imageFetcher,
      'image',
    );
    expect(exported).toMatchObject({
      mediaComplete: true,
      mediaStatus: 'complete',
      missingImageCount: 0,
    });
    const images = await fs.readdir(path.join(root, 'export', 'image'));
    expect(images).toHaveLength(1);
    expect(
      await fs.readFile(path.join(root, 'export', 'image', images[0])),
    ).toEqual(png);
    expect(imageFetcher).not.toHaveBeenCalled();
  });
  it('inspects oversized ready bytes rather than trusting status and clears only the completed limit error', async () => {
    await prisma.article.deleteMany();
    const inline = 'data:image/png;base64,' + png.toString('base64');
    const prefix =
      '<div id="js_content"><p>synthetic large saved body</p>' +
      'x'.repeat(8_100_000);
    const bodies = [
      `${prefix}<img src="${inline}"></div>`,
      `${prefix}<img src="data:image/png;base64,invalid"></div>`,
      `${prefix}<img src="${inline}"><span style="background:url(unknown)"></span></div>`,
    ];
    for (let n = 0; n < bodies.length; n++) {
      const item = identity(n + 1);
      await prisma.article.create({
        data: {
          id: item.id,
          mpId,
          title: 'synthetic size boundary',
          picUrl: '',
          publishTime: 1760000000,
          sourceUrl: item.url,
          verifiedSourceUrl: item.url,
          contentHtml: bodies[n],
          lastBodyStatus: 'available',
        },
      });
    }
    const scan = new AutomaticMediaScan(prisma);
    const first = await scan.page('', before, true);
    expect(first.rows).toEqual([
      expect.objectContaining({
        id: identity(1).id,
        oversized: true,
        mediaReady: true,
        contentHtml: null,
      }),
    ]);
    const second = await scan.page(first.cursor, before, true);
    expect(second.rows).toEqual([
      expect.objectContaining({
        id: identity(2).id,
        mediaReady: false,
        contentHtml: null,
      }),
    ]);
    const third = await scan.page(second.cursor, before, true);
    expect(third.rows).toEqual([
      expect.objectContaining({
        id: identity(3).id,
        mediaReady: false,
        contentHtml: null,
      }),
    ]);
    expect(await scan.load(identity(1).id)).toBeUndefined(); // 8MB automatic writer gate stays intact
    let now = Date.now(),
      ready = false;
    const fetch = jest.fn(),
      commit = jest.fn(),
      publish = jest.fn();
    const worker = new AutomaticMediaQueue(path.join(root, 'data.db'), {
      now: () => now,
      scan: async () => ({
        rows: [{ ...first.rows[0], mediaReady: ready }],
        cursor: '',
        end: true,
      }),
      load: (id) => scan.load(id),
      fetch,
      commit,
      canFetch: () => false,
      stop: async () => undefined,
      publish,
    });
    await worker.tick();
    expect(publish.mock.lastCall[0][0]).toMatchObject({
      failed: 1,
      code: 'MEDIA_BODY_LIMIT',
    });
    ready = true;
    now += 60_001;
    await worker.tick();
    worker.close();
    expect(publish.mock.lastCall[0]).toEqual([]);
    const state = JSON.parse(
      await fs.readFile(
        path.join(root, '.wechat2rss-automatic-media', 'queue.json'),
        'utf8',
      ),
    );
    expect(state.articles).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: identity(1).id },
        })
      ).contentHtml,
    ).toBe(bodies[0]);
    expect(global.fetch).not.toHaveBeenCalled();
  }, 40000);
  it('defaults to future changes; preserves the persisted activation boundary and can explicitly opt into bounded history', async () => {
    const scan = new AutomaticMediaScan(prisma);
    expect((await scan.page('', Date.now() + 10000)).rows).toHaveLength(0);
    hintMediaArticles([identity(1).id]);
    expect((await scan.page('', Date.now() + 10000)).rows).toHaveLength(0); // alternate history cursor prevents hint starvation
    expect(
      (await scan.page('', Date.now() + 10000)).rows.map((row) => row.id),
    ).toEqual([identity(1).id]);
    expect((await scan.page('', Date.now() + 10000, true)).rows).toHaveLength(
      20,
    );
  });
  it('does not transport oversized bodies and never weakens a stale snapshot or disabled-feed write', async () => {
    const scan = new AutomaticMediaScan(prisma),
      id = identity(1).id;
    const before = (await scan.load(id))!;
    await prisma.article.update({
      where: { id },
      data: { contentHtml: before.contentHtml + '<p>new edit</p>' },
    });
    await expect(
      trpc.commitAutomaticArticleMedia(before, new Map()),
    ).rejects.toThrow('SAVED_MEDIA_CONFLICT');
    await prisma.feed.update({ where: { id: mpId }, data: { status: 0 } });
    await expect(
      trpc.commitAutomaticArticleMedia((await scan.load(id))!, new Map()),
    ).rejects.toThrow('CACHE_SYNC_FEED_DISABLED');
    await prisma.feed.update({ where: { id: mpId }, data: { status: 1 } });
    await prisma.article.update({
      where: { id },
      data: { contentHtml: 'x'.repeat(8_000_001) },
    });
    expect(await scan.load(id)).toBeUndefined();
    const page = await scan.page('', Date.now(), true);
    expect(page.rows.find((row) => row.id === id)).toMatchObject({
      contentHtml: null,
      oversized: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
  it('runs the durable lane independently of a slow request and preserves metadata/list progress', async () => {
    let finish!: () => void;
    const worker = {
      tick: jest.fn(
        () =>
          new Promise<void>((done) => {
            finish = done;
          }),
      ),
      close: jest.fn(),
    };
    const sync = jest.fn().mockResolvedValue({
      bodyMissing: 0,
      imageBlocked: 0,
      localMediaPendingArticleCount: 0,
    });
    const item = identity(1);
    const engine = new CacheSyncEngine({
      now: () => Date.parse('2026-10-18T08:00:00Z'),
      durableMedia: worker,
      list: async () => [
        {
          feedId: mpId,
          name: 'fixture',
          feedUrl: '/feed/1234567890.json',
          checkTime: null,
          nextUpdateTime: null,
          paused: false,
        },
      ],
      localFeeds: async () => [{ id: mpId, mpName: 'fixture' }],
      read: async () => ({
        articles: [
          {
            ...item,
            title: 'fixture',
            publishTime: 1760000000,
            contentHtml: '<div id="js_content">text</div>',
            picUrl: '',
          },
        ],
        bodyMissing: 0,
        imageBlocked: 0,
        upstreamCount: 1,
        coverage: 'recent-window',
      }),
      sync,
    });
    await engine.tick();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][2]).toBe(true);
    expect(cacheSyncState.feeds[0].state).toBe('synced-cache');
    expect(worker.tick).toHaveBeenCalledTimes(1);
    finish();
    engine.close();
    expect(worker.close).toHaveBeenCalledTimes(1);
  });
  it('commits normal new text first, then discovers missing media without requiring the transient hint', async () => {
    process.env.WECHAT2RSS_CACHE_SYNC = '1';
    const item = identity(30),
      started = Date.now() - 1;
    const collector = new CollectionService(prisma);
    await collector.collectWechat2RssRecent({
      mpId,
      mpName: 'fixture',
      trigger: 'local-manual',
      cachedPage: {
        articles: [
          {
            ...item,
            title: 'future normal content',
            publishTime: 1760000000,
            picUrl: '',
            contentHtml:
              '<div id="js_content">future saved text<img data-src="https://mmbiz.qpic.cn/new.png"></div>',
          },
        ],
        bodyMissing: 0,
        imageBlocked: 0,
        upstreamCount: 1,
        coverage: 'recent-window',
      },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(takeMediaHints()).toContain(item.id); // model lost post-commit ACK/hint
    const row = await prisma.article.findUnique({ where: { id: item.id } });
    expect(row?.contentHtml).toContain('future saved text');
    expect(row?.contentHtml).not.toContain('data:image/');
    const scan = new AutomaticMediaScan(prisma);
    expect((await scan.page('', started)).rows.map((row) => row.id)).toContain(
      item.id,
    );
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
});
