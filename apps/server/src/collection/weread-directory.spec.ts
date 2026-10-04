import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import {
  parseWereadDirectory,
  prepareWereadDirectoryReplay,
  SavedWereadBody,
  verifyWereadDirectoryBody,
} from './weread-directory';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import axios from 'axios';
jest.mock('axios');
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));

const expected = { mpId: 'MP_WXS_1234567890', name: '测试号' };
const biz = 'MTIzNDU2Nzg5MA==';
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const inline = `data:image/png;base64,${png}`;
const group = (n = 1) => {
  const originalId = String(n).padStart(22, 'a');
  const reviewId = `${expected.mpId}_${originalId}`;
  return {
    createTime: 1790000000, // Different from publication; never use this as fallback.
    subCount: 1,
    subReviews: [
      {
        reviewId,
        review: {
          reviewId,
          type: 16,
          bookId: '',
          belongBookId: expected.mpId,
          mpInfo: {
            originalId,
            title: `文章${n}`,
            mp_name: expected.name,
            time: 1700000100 - n,
          },
        },
      },
    ],
  };
};
const raw = (...groups: ReturnType<typeof group>[]) => ({
  reviews: groups,
  clearAll: 1,
  synckey: 1790000100,
});
const body = (n = 1, image = inline): SavedWereadBody => {
  const candidate = parseWereadDirectory(raw(group(n)), expected).articles[0];
  const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${candidate.originalId}"><h1 id="activity-name">文章${n}</h1><span id="js_name">测试号</span><div id="js_content"><p>完整正文</p><img src="${image}" onload="bad()"><script>bad()</script></div><script>var biz="${biz}";var mid="${n}";var idx="1";var sn="abcd";var ct=${candidate.publishTime};</script>`;
  return {
    reviewId: candidate.reviewId,
    html,
    sha256: hash(html),
    capturedAt: '2026-10-04T00:00:00Z',
    images: [],
  };
};
const mutateBody = (saved: SavedWereadBody, from: string, to: string) => {
  const html = saved.html.replace(from, to);
  return { ...saved, html, sha256: hash(html) };
};

describe('official Web MP directory and saved body adapter (no network)', () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
    throw new Error('NO_NETWORK');
  });
  afterAll(() => {
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('uses belongBookId with empty bookId and keeps short identities separate from WX IDs', () => {
    const page = parseWereadDirectory(raw(group()), expected);
    expect(page.articles[0]).toMatchObject({
      mpId: expected.mpId,
      publishTime: 1700000099,
    });
    expect(page.articles[0]).not.toHaveProperty('id');
    expect(page).toMatchObject({
      clearAll: 1,
      groupCount: 1,
      synckey: 1790000100,
    });
  });
  it('counts pagination groups before expanding subarticles', () => {
    const g = group();
    g.subReviews.push(group(2).subReviews[0]);
    const page = parseWereadDirectory(raw(g), expected);
    expect(page.groupCount).toBe(1);
    expect(page.articles).toHaveLength(2);
  });
  it.each(['time', 'title', 'mp_name', 'originalId'] as const)(
    'rejects missing %s instead of inferring a value',
    (key) => {
      const g = group();
      delete (g.subReviews[0].review.mpInfo as any)[key];
      expect(() => parseWereadDirectory(raw(g), expected)).toThrow(
        'WEREAD_DIRECTORY_ARTICLE_INVALID',
      );
    },
  );
  it.each(['belongBookId', 'bookId', 'reviewId'] as const)(
    'rejects conflicting %s',
    (key) => {
      const g = group();
      g.subReviews[0].review[key] = 'MP_WXS_9999999999';
      expect(() => parseWereadDirectory(raw(g), expected)).toThrow();
    },
  );
  it('does not turn an access error into an empty successful list', () => {
    expect(() =>
      parseWereadDirectory({ ...raw(), errCode: -2041 }, expected),
    ).toThrow();
  });
  it('deduplicates overlap across pages without changing original order', () => {
    const replay = prepareWereadDirectoryReplay(
      [raw(group(1), group(2)), raw(group(2), group(3))],
      expected,
      [],
      3,
    );
    expect(replay.selected).toHaveLength(3);
    expect(replay.unverified).toHaveLength(3);
    expect(replay.page.articles).toHaveLength(0);
    expect(replay.groupCounts).toEqual([2, 2]);
    expect(replay.latestWindowReady).toBe(false);
  });
  it('rejects conflicting overlapping metadata and unproved latest ordering', () => {
    const changed = group(1);
    changed.subReviews[0].review.mpInfo.time++;
    expect(() =>
      prepareWereadDirectoryReplay([raw(group()), raw(changed)], expected, []),
    ).toThrow('DUPLICATE_CONFLICT');
    expect(() =>
      prepareWereadDirectoryReplay([raw(group(2), group(1))], expected, []),
    ).toThrow('ORDER_UNVERIFIED');
  });
  it('selects ten before checking bodies; it never fills missing latest bodies with older ones', () => {
    const replay = prepareWereadDirectoryReplay(
      [raw(...Array.from({ length: 11 }, (_, i) => group(i + 1)))],
      expected,
      [body(1), body(11)],
    );
    expect(replay.selected).toHaveLength(10);
    expect(replay.page.articles.map((a) => a.id)).toEqual([
      'WX_1234567890_1_1',
    ]);
    expect(replay.unverified).toHaveLength(9);
    expect(replay.complete).toBe(false);
  });
  it('maps ten bodies to stable WX IDs and preserves validated inline images', () => {
    const replay = prepareWereadDirectoryReplay(
      [raw(...Array.from({ length: 10 }, (_, i) => group(i + 1)))],
      expected,
      Array.from({ length: 10 }, (_, i) => body(i + 1)),
    );
    expect(replay.latestWindowReady).toBe(true);
    expect(replay.page.articles).toHaveLength(10);
    expect(replay.page.articles[0].contentHtml).toContain(inline);
    expect(replay.page.articles[0].contentHtml).not.toMatch(/onload|<script/);
    expect(replay.complete).toBe(false);
  });
  it.each([
    ['ct=1700000099', 'ct=1700000098'],
    ['var biz="MTIzNDU2Nzg5MA=="', 'var biz="OTk5OTk5OTk5OQ=="'],
    ['文章1', '别的文章'],
    ['>测试号<', '>另一个号<'],
    ['/s/aaaaaaaaaaaaaaaaaaaaa1', '/s/aaaaaaaaaaaaaaaaaaaaa2'],
  ])('rejects body conflicts: %s', (from, to) => {
    const candidate = parseWereadDirectory(raw(group()), expected).articles[0];
    expect(() =>
      verifyWereadDirectoryBody(candidate, mutateBody(body(), from, to)),
    ).toThrow();
  });
  it('rejects stale hashes, challenge pages, invalid inline bytes, and missing cached remote images', () => {
    const candidate = parseWereadDirectory(raw(group()), expected).articles[0];
    expect(() =>
      verifyWereadDirectoryBody(candidate, {
        ...body(),
        sha256: '0'.repeat(64),
      }),
    ).toThrow('EVIDENCE_INVALID');
    expect(() =>
      verifyWereadDirectoryBody(
        candidate,
        mutateBody(body(), '<p>', '<div id="js_verify"></div><p>'),
      ),
    ).toThrow('ACCESS_CHALLENGE');
    expect(() =>
      verifyWereadDirectoryBody(
        candidate,
        body(1, 'data:image/png;base64,AAAA'),
      ),
    ).toThrow();
    expect(() =>
      verifyWereadDirectoryBody(
        candidate,
        body(1, 'https://mmbiz.qpic.cn/a.png'),
      ),
    ).toThrow('CACHE_MISSING');
  });
  it('accepts only hash-verified cached remote images, without fetching them', () => {
    const candidate = parseWereadDirectory(raw(group()), expected).articles[0];
    const saved = body(1, 'https://mmbiz.qpic.cn/a.png');
    saved.images = [
      {
        url: 'https://mmbiz.qpic.cn/a.png',
        inline,
        sha256: hash(Buffer.from(png, 'base64')),
      },
    ];
    expect(verifyWereadDirectoryBody(candidate, saved).contentHtml).toContain(
      inline,
    );
    saved.images[0].sha256 = '0'.repeat(64);
    expect(() => verifyWereadDirectoryBody(candidate, saved)).toThrow(
      'IMAGE_HASH_INVALID',
    );
  });
});

describe('signed content canonical mapping', () => {
  it('keeps validated inline bytes when the response also retains an old CDN data-src', () => {
    const candidate = parseWereadDirectory(raw(group()), expected).articles[0];
    const saved = mutateBody(
      body(),
      '<img src=',
      '<img data-src="https://mmbiz.qpic.cn/old.png" src=',
    );
    const article = verifyWereadDirectoryBody(candidate, saved);
    expect(article.contentHtml).toContain(inline);
    expect(article.contentHtml).not.toContain('qpic.cn');
  });
  it('requires agreement with body biz/mid/idx/sn and the recorded reviewId', () => {
    const candidate = parseWereadDirectory(raw(group()), expected).articles[0];
    const signed = `https://mp.weixin.qq.com/s?__biz=${biz}&amp;mid=1&amp;idx=1&amp;sn=abcd&amp;chksm=extra#rd`;
    const saved = mutateBody(
      body(),
      `https://mp.weixin.qq.com/s/${candidate.originalId}`,
      signed,
    );
    expect(verifyWereadDirectoryBody(candidate, saved).id).toBe(
      'WX_1234567890_1_1',
    );
    expect(() =>
      verifyWereadDirectoryBody(
        candidate,
        mutateBody(saved, 'mid=1&amp;', 'mid=2&amp;'),
      ),
    ).toThrow('IDENTITY_CONFLICT');
    expect(() =>
      verifyWereadDirectoryBody(candidate, { ...saved, reviewId: 'different' }),
    ).toThrow('EVIDENCE_INVALID');
  });
});

describe('directory replay through protected SQLite persistence', () => {
  let dir: string,
    database: string,
    prisma: PrismaClient,
    collection: CollectionService;
  const previous = process.env.DATABASE_URL;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-directory-test-'));
    database = path.join(dir, 'copy.db');
    process.env.DATABASE_URL = `file:${database.replace(/\\/g, '/')}`;
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of (
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
      )
        .split(';')
        .map((v) => v.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(sql);
    }
    const source = path.join(dir, 'source.db');
    await fs.writeFile(source, 'source marker');
    await fs.writeFile(
      database + '.weread-directory-replay.json',
      JSON.stringify({
        mode: 'saved-weread-directory',
        sourceDatabase: source,
      }),
    );
    collection = new CollectionService(prisma as any);
  });
  beforeEach(async () => {
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    await prisma.feed.create({
      data: {
        id: expected.mpId,
        mpName: expected.name,
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
  const replay = () =>
    prepareWereadDirectoryReplay([raw(group())], expected, [body()]);
  it('the existing refresh collector inserts ten, deduplicates a later manual refresh and discovers a new article', async () => {
    const oldConfig = process.env.OWNER_SEARCH_CONFIG_FILE;
    const config = {
      ...expected,
      biz,
      ownerVid: '123',
      sessionFile: path.join(dir, 'session.json'),
      stateFile: path.join(dir, 'search.json'),
      runtimeStopFile: path.join(dir, 'original.json'),
      originalStopFiles: [path.join(dir, 'historical-original-stop.json')],
      wereadLatestStateFile: path.join(dir, 'latest.json'),
      wereadDirectoryEnabled: true,
    };
    process.env.OWNER_SEARCH_CONFIG_FILE = path.join(dir, 'binding.json');
    await fs.writeFile(
      process.env.OWNER_SEARCH_CONFIG_FILE,
      JSON.stringify({ feeds: { [expected.mpId]: config } }),
    );
    await fs.writeFile(
      config.sessionFile,
      JSON.stringify({
        source: 'owner-confirmed-native-web-login',
        capturedAt: '2026-10-04T00:00:00Z',
        ownerVid: '123',
        cookies: ['wr_vid', 'wr_skey'].map((name) => ({
          name,
          value: name === 'wr_vid' ? '123' : 'mock-secret',
          domain: '.weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        })),
      }),
    );
    let newArticle = false;
    (axios.get as jest.Mock).mockImplementation(async (url, options) => {
      if (url.endsWith('/articles')) {
        const groups = Array.from({ length: 10 }, (_, index) =>
          group(index + 1),
        );
        if (newArticle) {
          const latest = group(11);
          latest.subReviews[0].review.mpInfo.time = 1700000101;
          groups.pop();
          groups.unshift(latest);
        }
        return { status: 200, data: JSON.stringify(raw(...groups)) };
      }
      const n = Number(
        options.params.reviewId.split('_').at(-1).replace(/^a+/, ''),
      );
      return {
        status: 200,
        data:
          n === 11
            ? body(n).html.replace('ct=1700000089', 'ct=1700000101')
            : body(n).html,
      };
    });
    const expireCooldown = async () => {
      const state = JSON.parse(
        await fs.readFile(config.wereadLatestStateFile, 'utf8'),
      );
      state.lastAttemptAt = Date.now() - 16 * 60 * 1000;
      await fs.writeFile(config.wereadLatestStateFile, JSON.stringify(state));
    };
    try {
      expect(
        await collection.collectOwnerWereadLatest(expected.mpId),
      ).toMatchObject({ articles: 10, created: 10, updated: 0 });
      const originals = await prisma.article.findMany({
        orderBy: { id: 'asc' },
      });
      await expireCooldown();
      expect(
        await collection.collectOwnerWereadLatest(expected.mpId),
      ).toMatchObject({ articles: 10, created: 0, updated: 0 });
      expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
        originals,
      );
      newArticle = true;
      await expireCooldown();
      expect(
        await collection.collectOwnerWereadLatest(expected.mpId),
      ).toMatchObject({ articles: 10, created: 1, updated: 0 });
      expect(await prisma.article.count()).toBe(11);
      for (const old of originals)
        expect(
          await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
        ).toEqual(old);
    } finally {
      if (oldConfig === undefined) delete process.env.OWNER_SEARCH_CONFIG_FILE;
      else process.env.OWNER_SEARCH_CONFIG_FILE = oldConfig;
    }
  });
  it('inserts once, survives reconstruction, and never treats clearAll as deleting old rows', async () => {
    await prisma.article.create({
      data: {
        id: 'WX_1234567890_99_1',
        mpId: expected.mpId,
        title: '旧正文',
        publishTime: 1699999999,
        contentHtml: '保留旧正文',
        picUrl: '旧封面',
        readCount: 50,
        likeCount: 4,
      },
    });
    const old = await prisma.article.findUniqueOrThrow({
      where: { id: 'WX_1234567890_99_1' },
    });
    const feed = await prisma.feed.findUniqueOrThrow({
      where: { id: expected.mpId },
    });
    expect(
      await collection.replayWereadDirectory(expected.mpId, replay()),
    ).toMatchObject({ created: 1, updated: 0 });
    const saved = await prisma.article.findUniqueOrThrow({
      where: { id: 'WX_1234567890_1_1' },
    });
    expect(
      await new CollectionService(prisma as any).replayWereadDirectory(
        expected.mpId,
        replay(),
      ),
    ).toMatchObject({ created: 0, updated: 0, productionSourceEnabled: false });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toEqual(saved);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: expected.mpId } }),
    ).toEqual(feed);
    expect(createVerifiedSqliteBackup).toHaveBeenCalled();
  });
  it('preserves old full body, cover and metrics when optional directory fields are missing', async () => {
    const prepared = replay();
    const article = prepared.page.articles[0];
    await prisma.article.create({
      data: {
        id: article.id,
        mpId: article.mpId,
        title: article.title,
        publishTime: article.publishTime,
        contentHtml: '旧完整正文',
        sourceUrl: article.url,
        verifiedSourceUrl: article.url,
        picUrl: '旧封面',
        readCount: 99,
        likeCount: 8,
      },
    });
    const old = await prisma.article.findUniqueOrThrow({
      where: { id: article.id },
    });
    expect(
      await collection.replayWereadDirectory(expected.mpId, prepared),
    ).toMatchObject({ created: 0, updated: 0 });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: article.id } }),
    ).toEqual(old);
  });
  it('rolls back the whole batch when an existing stable identity has conflicting trusted time', async () => {
    const prepared = prepareWereadDirectoryReplay(
      [raw(group(1), group(2))],
      expected,
      [body(1), body(2)],
    );
    const article = prepared.page.articles[1];
    await prisma.article.create({
      data: {
        id: article.id,
        mpId: article.mpId,
        title: article.title,
        publishTime: article.publishTime - 1,
        contentHtml: '旧正文',
        picUrl: '',
      },
    });
    await expect(
      collection.replayWereadDirectory(expected.mpId, prepared),
    ).rejects.toThrow('SAVED_METADATA_CONFLICT');
    expect(await prisma.article.count()).toBe(1);
    expect(
      await prisma.article.findUnique({
        where: { id: prepared.page.articles[0].id },
      }),
    ).toBeNull();
  });
  it('links a body-proved short legacy ID without replacing the old ID or duplicating the article', async () => {
    const prepared = replay();
    const article = prepared.page.articles[0];
    const oldId = article.shortUrl!.split('/').at(-1)!;
    await prisma.article.create({
      data: {
        id: oldId,
        mpId: article.mpId,
        title: article.title,
        publishTime: article.publishTime,
        picUrl: '旧封面',
        sourceUrl: article.shortUrl,
        contentHtml: '旧完整正文',
        readCount: 88,
      },
    });
    expect(
      await collection.replayWereadDirectory(expected.mpId, prepared),
    ).toMatchObject({ created: 0, updated: 1 });
    const saved = await prisma.article.findUniqueOrThrow({
      where: { id: oldId },
    });
    expect(saved).toMatchObject({
      contentHtml: '旧完整正文',
      sourceUrl: article.shortUrl,
      verifiedSourceUrl: article.url,
      readCount: 88,
    });
    expect(
      await prisma.article.findUnique({ where: { id: article.id } }),
    ).toBeNull();
    expect(
      await collection.replayWereadDirectory(expected.mpId, prepared),
    ).toMatchObject({ created: 0, updated: 0 });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: oldId } }),
    ).toEqual(saved);
  });
  it('writes nothing when the required consistent backup fails', async () => {
    (createVerifiedSqliteBackup as jest.Mock).mockRejectedValueOnce(
      new Error('BACKUP_FAILED'),
    );
    await expect(
      collection.replayWereadDirectory(expected.mpId, replay()),
    ).rejects.toThrow('BACKUP_FAILED');
    expect(await prisma.article.count()).toBe(0);
  });
  it('requires an isolated database marker, rejecting the source database itself', async () => {
    const marker = database + '.weread-directory-replay.json';
    const original = await fs.readFile(marker);
    try {
      await fs.writeFile(
        marker,
        JSON.stringify({
          mode: 'saved-weread-directory',
          sourceDatabase: database,
        }),
      );
      await expect(
        collection.replayWereadDirectory(expected.mpId, replay()),
      ).rejects.toThrow('REQUIRES_ISOLATED_SQLITE');
      expect(await prisma.article.count()).toBe(0);
    } finally {
      await fs.writeFile(marker, original);
    }
  });
});
