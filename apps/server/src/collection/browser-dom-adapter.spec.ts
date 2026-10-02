import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import {
  BrowserDomEvidence,
  BrowserDomVerificationError,
  prepareBrowserDomReplay,
  verifyBrowserDomArticle,
} from './browser-dom-adapter';
import { ArticleCandidate } from './article-candidate';

jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));

const mpId = 'MP_WXS_3895431412';
const biz = 'Mzg5NTQzMTQxMg==';
const url = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=2247493594&idx=1&sn=f7e88f2d65746ed67a005edc2bbd74ae`;
const title = '819人获奖！2026年化学竞赛上海赛区一二三等奖获奖详细名单来了';
const domPublishTime = 1790749883;
const indexTimestamp = 1790749882; // Search index timestamp differs from real DOM ct

const validHtml = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">${title}</h1><div id="js_content">真实正文内容</div><script>var biz="${biz}";var mid="2247493594";var idx="1";var sn="f7e88f2d65746ed67a005edc2bbd74ae";var ct=${domPublishTime};</script>`;

const candidate: ArticleCandidate = {
  id: 'WX_3895431412_2247493594_1',
  mpId,
  url,
  title,
  indexTimestamp,
  discovery: {
    source: 'owner-web-search',
    capturedAt: '2026-09-30T10:05:09.244Z',
    page: 1,
  },
};

function createEvidence(
  html: string,
  overrides: Partial<BrowserDomEvidence> = {},
): BrowserDomEvidence {
  return {
    source: 'owner-confirmed-browser-dom',
    observationKind: 'owner-confirmed-browser-dom',
    capturedAt: '2026-09-30T11:53:14.269Z',
    sha256: createHash('sha256').update(html).digest('hex'),
    rawUrl: url,
    ...overrides,
  };
}

describe('browser-DOM evidence adapter and isolated replay', () => {
  describe('verifyBrowserDomArticle', () => {
    it('verifies genuine owner-confirmed browser DOM with strict identity and exact DOM publishTime', () => {
      const evidence = createEvidence(validHtml);
      const verified = verifyBrowserDomArticle(candidate, validHtml, evidence);

      expect(verified.article.id).toBe(candidate.id);
      expect(verified.article.mpId).toBe(mpId);
      expect(verified.article.url).toBe(candidate.url);
      expect(verified.article.title).toBe(title);
      // publishTime must come strictly from the article DOM (1790749883), not the candidate index timestamp (1790749882)
      expect(verified.article.publishTime).toBe(domPublishTime);
      expect(verified.article.publishTime).not.toBe(candidate.indexTimestamp);
      expect(verified.article.contentHtml).toContain('真实正文内容');
      expect(verified.evidence.source).toBe('owner-confirmed-browser-dom');
    });

    it('rejects mislabeled evidence that reuses official-public-original or non-browser types', () => {
      const evidence = createEvidence(validHtml, {
        source: 'official-public-original' as any,
      });
      expect(() =>
        verifyBrowserDomArticle(candidate, validHtml, evidence),
      ).toThrow(BrowserDomVerificationError);
      expect(() =>
        verifyBrowserDomArticle(candidate, validHtml, evidence),
      ).toThrow('invalid_dom_evidence');
    });

    it('rejects SHA-256 hash mismatch between DOM HTML and evidence', () => {
      const evidence = createEvidence(validHtml, {
        sha256: '0'.repeat(64),
      });
      expect(() =>
        verifyBrowserDomArticle(candidate, validHtml, evidence),
      ).toThrow('dom_hash_mismatch');
    });

    it('rejects challenge or captcha verification DOM', () => {
      const challengeHtml = validHtml.replace(
        '<h1 id="activity-name">',
        '<title>安全验证</title><h1 id="activity-name">',
      );
      const evidence = createEvidence(challengeHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, challengeHtml, evidence),
      ).toThrow('access_challenge');
    });

    it('rejects identity conflict when candidate ID or publisher does not match DOM', () => {
      const wrongCandidate: ArticleCandidate = {
        ...candidate,
        id: 'WX_3895431412_9999999999_1',
      };
      const evidence = createEvidence(validHtml);
      expect(() =>
        verifyBrowserDomArticle(wrongCandidate, validHtml, evidence),
      ).toThrow('identity_conflict');
    });

    it('rejects title conflict when DOM title deviates from discovered candidate title', () => {
      const alteredHtml = validHtml.replace(title, '篡改的标题');
      const evidence = createEvidence(alteredHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, alteredHtml, evidence),
      ).toThrow('identity_conflict');
    });

    it('rejects DOM lacking valid publishTime and does not fall back to search index timestamp', () => {
      const noTimeHtml = validHtml.replace(`var ct=${domPublishTime};`, '');
      const evidence = createEvidence(noTimeHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, noTimeHtml, evidence),
      ).toThrow('invalid_article_dom');
    });

    it('rejects DOM lacking contentHtml', () => {
      const noContentHtml = validHtml.replace(
        '<div id="js_content">真实正文内容</div>',
        '<div id="js_content"></div>',
      );
      const evidence = createEvidence(noContentHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, noContentHtml, evidence),
      ).toThrow('invalid_article_dom');
    });
  });

  describe('prepareBrowserDomReplay', () => {
    it('constructs a ProviderPage with 0 network requests and search-results coverage', () => {
      const evidence = createEvidence(validHtml);
      const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);

      expect(replay.discovery).toBe('owner-confirmed-browser-dom');
      expect(replay.networkRequests).toBe(0);
      expect(replay.complete).toBe(false);
      expect(replay.page.articles).toHaveLength(1);
      expect(replay.page.articles[0].id).toBe(candidate.id);
    });
    it('marks remote body images as unarchived in the copy-only replay', () => {
      const withImage = validHtml.replace(
        '真实正文内容',
        '真实正文内容<img src="https://mmbiz.qpic.cn/example" />',
      );
      const replay = prepareBrowserDomReplay(
        candidate,
        withImage,
        createEvidence(withImage),
      );
      expect(replay.unarchivedImages).toBe(1);
      expect(replay.page.imageBlocked).toBe(1);
      expect(replay.networkRequests).toBe(0);
    });
  });

  describe('CollectionService.replayBrowserDomUpdate (SQLite Copy Rehearsal)', () => {
    let dir: string,
      dbPath: string,
      sourcePath: string,
      prisma: PrismaClient,
      collection: CollectionService;
    const previous = process.env.DATABASE_URL;

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-browser-replay-'));
      dbPath = path.join(dir, 'copy.db');
      sourcePath = path.join(dir, 'source.db');
      await fs.writeFile(sourcePath, 'source marker');

      process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
      prisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });

      const migrations = path.resolve(__dirname, '../../prisma/migrations');
      for (const name of (await fs.readdir(migrations)).sort()) {
        if (!(await fs.stat(path.join(migrations, name))).isDirectory())
          continue;
        const file = path.join(migrations, name, 'migration.sql');
        for (const sql of (await fs.readFile(file, 'utf8'))
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)) {
          await prisma.$executeRawUnsafe(sql);
        }
      }

      await fs.writeFile(
        dbPath + '.browser-dom-replay.json',
        JSON.stringify({
          mode: 'owner-confirmed-browser-dom',
          sourceDatabase: sourcePath,
        }),
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
          syncTime: 1700000000,
        },
      });
    });

    afterAll(async () => {
      await prisma.$disconnect();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('inserts genuine article into SQLite copy and repeats update idempotently with old rows unchanged', async () => {
      const feedBefore = await prisma.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      const evidence = createEvidence(validHtml);
      const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);

      // Pass 1: Insert genuine article
      const firstResult = await collection.replayBrowserDomUpdate(mpId, replay);
      expect(firstResult).toMatchObject({
        mode: 'owner-confirmed-browser-dom',
        created: 1,
        updated: 0,
        articles: 1,
        productionSourceEnabled: false,
      });

      const savedArticle = await prisma.article.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      expect(savedArticle.publishTime).toBe(domPublishTime);
      expect(savedArticle.title).toBe(title);
      expect(savedArticle.contentHtml).toContain('真实正文内容');
      expect(savedArticle.lastBodyStatus).toBe('available');

      // Feed remains unchanged in offline rehearsal
      const feedAfterFirst = await prisma.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      expect(feedAfterFirst).toEqual(feedBefore);

      // Pass 2: Repeat update idempotently
      const secondResult = await collection.replayBrowserDomUpdate(
        mpId,
        replay,
      );
      expect(secondResult).toMatchObject({
        mode: 'owner-confirmed-browser-dom',
        created: 0,
        updated: 0,
        articles: 1,
      });

      // Verify all rows and fields unchanged after repeat
      const articleAfterSecond = await prisma.article.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      expect(articleAfterSecond).toEqual(savedArticle);

      const feedAfterSecond = await prisma.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      expect(feedAfterSecond).toEqual(feedBefore);
    });

    it('rejects target database if identical to source database', async () => {
      await fs.writeFile(
        dbPath + '.browser-dom-replay.json',
        JSON.stringify({
          mode: 'owner-confirmed-browser-dom',
          sourceDatabase: dbPath,
        }),
      );
      try {
        const evidence = createEvidence(validHtml);
        const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);
        await expect(
          collection.replayBrowserDomUpdate(mpId, replay),
        ).rejects.toThrow('ISOLATED_SQLITE');
      } finally {
        await fs.writeFile(
          dbPath + '.browser-dom-replay.json',
          JSON.stringify({
            mode: 'owner-confirmed-browser-dom',
            sourceDatabase: sourcePath,
          }),
        );
      }
    });

    it('rejects replay if provenance is invalid', async () => {
      const evidence = createEvidence(validHtml);
      const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);
      const alteredReplay = {
        ...replay,
        networkRequests: 1 as any,
      };
      await expect(
        collection.replayBrowserDomUpdate(mpId, alteredReplay),
      ).rejects.toThrow('PROVENANCE_INVALID');
    });
  });
});
