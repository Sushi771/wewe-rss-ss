import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { findArticleListRows } from './article-list-page';
import { PrismaService } from './prisma/prisma.service';
import { sqliteWrites } from './collection/sqlite-write-coordinator';
import { withArticleListReadTiming } from './article-list-read-timing';

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((done) => (release = done));
  return { promise, release };
}

describe('finite private article read timings on actual single-connection Prisma', () => {
  let prisma: PrismaService, directory: string, databaseUrl: string;
  const originalUrl = process.env.DATABASE_URL;
  const originalTiming = process.env.ARTICLE_LIST_READ_TIMING;
  const records: any[] = [];
  let output: jest.SpyInstance;
  const query = { take: 21, orderBy: { publishTime: 'desc' as const } };
  const read = () => findArticleListRows(prisma, query, { databaseUrl });
  const sample = () => records.filter((r) => r.event === 'read').at(-1);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wewe-read-timing-'));
    databaseUrl = 'file:' + join(directory, 'fixture.db').replace(/\\/g, '/');
    process.env.DATABASE_URL = databaseUrl + '?connection_limit=1';
    process.env.ARTICLE_LIST_READ_TIMING = '1';
    output = jest.spyOn(console, 'info').mockImplementation((line: string) => {
      records.push(
        JSON.parse(line.slice('[ARTICLE_LIST_READ_TIMING] '.length)),
      );
    });
    prisma = new PrismaService();
    await prisma.onModuleInit();
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
    await prisma.feed.create({
      data: {
        id: 'private-feed-never-log',
        mpName: 'private-publisher-never-log',
        mpCover: '',
        mpIntro: '',
        updateTime: 1,
      },
    });
    await prisma.article.create({
      data: {
        id: 'private-article-never-log',
        mpId: 'private-feed-never-log',
        title: 'private-title-never-log',
        picUrl: '',
        publishTime: 100,
        contentHtml: '<p>private-body-never-log</p>',
      },
    });
  }, 30000);
  beforeEach(() => {
    records.length = 0;
    process.env.ARTICLE_LIST_READ_TIMING = '1';
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    output?.mockRestore();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalTiming === undefined)
      delete process.env.ARTICLE_LIST_READ_TIMING;
    else process.env.ARTICLE_LIST_READ_TIMING = originalTiming;
    if (directory) {
      expect(dirname(directory)).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('wewe-read-timing-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps disabled reads silent and preserves DTOs', async () => {
    process.env.ARTICLE_LIST_READ_TIMING = '0';
    const rows = await read();
    expect(rows).toHaveLength(1);
    expect(rows[0].bodyCached).toBe(true);
    expect(records).toEqual([]);
  });
  it('records both file revision phases on a real miss and avoids claiming a pool wait on a hit', async () => {
    await prisma.article.update({
      where: { id: 'private-article-never-log' },
      data: { publishTime: 101 },
    });
    const first = await read();
    const miss = sample();
    expect(miss).toMatchObject({ ok: true, cache: 'miss' });
    expect(miss.phasesMs.revisionBefore).toBeGreaterThanOrEqual(0);
    expect(miss.phasesMs.revisionAfter).toBeGreaterThanOrEqual(0);
    expect(miss.coordinatorWaitMs).toBeGreaterThanOrEqual(0);
    expect(miss.connectionBeginWaitMs).toBeGreaterThanOrEqual(0);
    expect(miss.callbackMs).toBeGreaterThanOrEqual(0);
    expect(miss.commitReturnMs).toBeGreaterThanOrEqual(0);
    const native = records.filter((r) => r.event === 'native-query-window');
    expect(native.some((r) => r.operation === 'SELECT')).toBe(true);
    expect(native.every((r) => r.read === null)).toBe(true);
    expect(native.every((r) => !('query' in r) && !('params' in r))).toBe(true);
    expect(JSON.stringify(records)).not.toContain('private-');
    records.length = 0;
    expect(await read()).toEqual(first);
    expect(sample()).toMatchObject({
      cache: 'hit',
      coordinatorWaitMs: null,
      connectionBeginWaitMs: null,
      callbackMs: null,
    });
    expect(records.some((r) => r.event === 'native-query-window')).toBe(false);
  });
  it('separates a held coordinator from engine admission without requesting a backup', async () => {
    const held = latch(),
      release = latch();
    const holder = sqliteWrites.snapshot(async () => {
      held.release();
      await release.promise;
    });
    await held.promise;
    const pending = findArticleListRows(prisma, query);
    try {
      await wait(60);
    } finally {
      release.release();
    }
    await holder;
    await pending;
    expect(sample().coordinatorWaitMs).toBeGreaterThanOrEqual(30);
    expect(sample().callbackMs).toBeLessThan(sample().coordinatorWaitMs);
  });
  it('separates a held single connection from the coordinator and leaves background events unbound', async () => {
    const held = latch(),
      release = latch();
    const holder = prisma.$transaction(async (tx) => {
      await tx.article.count();
      held.release();
      await release.promise;
    });
    await held.promise;
    const pending = findArticleListRows(prisma, query);
    try {
      await wait(60);
    } finally {
      release.release();
    }
    await holder;
    await pending;
    const row = sample();
    expect(row.connectionBeginWaitMs).toBeGreaterThanOrEqual(30);
    expect(row.coordinatorWaitMs).toBeLessThan(row.connectionBeginWaitMs);
    expect(
      records.some(
        (r) =>
          r.event === 'transaction' &&
          r.read === null &&
          r.phase === 'wrapperReturn',
      ),
    ).toBe(true);
  });
  it('propagates the original failed read without logging its private error or retrying it', async () => {
    let calls = 0;
    const failure = new Error('private-credential-never-log');
    await expect(
      findArticleListRows(
        {
          $transaction: () => {
            calls++;
            return Promise.reject(failure);
          },
        } as any,
        query,
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(sample()).toMatchObject({ ok: false, cache: 'bypass' });
    expect(JSON.stringify(records)).not.toContain('private-');
  });
  it('never fails a successful read when the private diagnostic sink throws', async () => {
    output.mockImplementationOnce(() => {
      throw new Error('log sink unavailable');
    });
    await expect(findArticleListRows(prisma, query)).resolves.toHaveLength(1);
  });
  it('preserves enabled batch transactions and rollback of a failed non-list writer', async () => {
    await expect(
      prisma.$transaction([prisma.article.count()]),
    ).resolves.toEqual([1]);
    const failure = new Error('private-writer-error-never-log');
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.article.update({
          where: { id: 'private-article-never-log' },
          data: { title: 'uncommitted title' },
        });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      (
        await prisma.article.findUniqueOrThrow({
          where: { id: 'private-article-never-log' },
        })
      ).title,
    ).toBe('private-title-never-log');
    expect(records).toEqual([]);
  });
  it('stops creating samples at its finite process budget without blocking later reads', async () => {
    for (let i = 0; i < 100; i++)
      expect(await withArticleListReadTiming(async () => 42)).toBe(42);
    const sampled = records.filter((r) => r.event === 'read');
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled.length).toBeLessThanOrEqual(32);
    records.length = 0;
    await expect(findArticleListRows(prisma, query)).resolves.toHaveLength(1);
    expect(records).toEqual([]);
  });
});
