import { canonicalArticleUrl } from './collection-format';
import {
  persistArticleFailures,
  snapshotFailureId,
} from './article-failure-ledger';
import { parseWechat2RssJsonFeed } from './provider-article';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// @types/node in this project predates the runtime's built-in SQLite module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

describe('article failure evidence', () => {
  const feedId = 'MP_WXS_1234567890';
  const makeArticle = (mid: number, contentHtml: string | null) => ({
    ...canonicalArticleUrl(
      `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=${mid}&idx=1&sn=abcdef`,
    ),
    title: `synthetic-${mid}`,
    publishTime: 1700000000,
    contentHtml,
    picUrl: '',
  });
  it('records a verified missing body in the actual migration and keeps the next article', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(
        join(
          __dirname,
          '../../prisma/migrations/20261013000000_article_failure_events/migration.sql',
        ),
        'utf8',
      ),
    );
    db.exec(
      readFileSync(
        join(
          __dirname,
          '../../prisma/migrations/20261104000000_article_failure_missing/migration.sql',
        ),
        'utf8',
      ),
    );
    const tx = {
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
        db.prepare(sql).all(...(values as any[])) as T,
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
        Number(db.prepare(sql).run(...(values as any[])).changes),
    };
    const item = (mid: number, content_html: string) => ({
      url: `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=${mid}&idx=1&sn=abcdef`,
      title: `synthetic-${mid}`,
      date_published: '2024-01-01T00:00:00Z',
      content_html,
    });
    try {
      const page = parseWechat2RssJsonFeed(
        { items: [item(1, ''), item(2, '<p>later</p>')] },
        feedId,
      );
      await persistArticleFailures(
        tx,
        'synthetic',
        feedId,
        page,
        page,
        false,
        1700000000000,
      );
      expect(
        db
          .prepare('SELECT article_id, stage, code FROM article_failure_events')
          .all(),
      ).toEqual([
        expect.objectContaining({
          article_id: 'WX_1234567890_1_1',
          stage: 'body',
          code: 'BODY_MISSING',
        }),
      ]);
      expect(page.articles[1].contentHtml).toContain('later');
    } finally {
      db.close();
    }
  });
  it('writes failures transactionally, deduplicates, and refuses conflicting identity or time', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE articles(id TEXT PRIMARY KEY); CREATE TABLE article_failure_events(attempt_id TEXT,feed_id TEXT,article_id TEXT,stage TEXT,code TEXT,observed_at BIGINT,PRIMARY KEY(attempt_id,article_id,stage))',
    );
    const tx = {
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
        db.prepare(sql).all(...(values as any[])) as T,
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
        Number(db.prepare(sql).run(...(values as any[])).changes),
    };
    const body = makeArticle(99, null);
    const media = makeArticle(98, '<div>body</div>');
    const input = {
      articles: [body, media],
      coverage: 'recent-window' as const,
      upstreamCount: 2,
      bodyMissing: 1,
      imageBlocked: 0,
      bodyFailures: [{ id: body.id, code: 'BODY_PARSE_FAILED' as const }],
    };
    const archived = {
      ...input,
      articles: [
        body,
        {
          ...media,
          contentHtml: '<div data-wewe-image-pending="1">body</div>',
        },
      ],
    };
    try {
      db.exec('BEGIN');
      db.prepare('INSERT INTO articles VALUES (?)').run(body.id);
      await persistArticleFailures(
        tx,
        'attempt',
        feedId,
        input,
        archived,
        false,
        1700000000000,
      );
      db.exec('COMMIT');
      await persistArticleFailures(
        tx,
        'attempt',
        feedId,
        input,
        archived,
        false,
        1700000000000,
      );
      expect(
        db.prepare('SELECT count(*) n FROM article_failure_events').get(),
      ).toMatchObject({ n: 2 });
      await expect(
        persistArticleFailures(
          tx,
          'attempt',
          feedId,
          input,
          archived,
          false,
          1700000000001,
        ),
      ).rejects.toThrow('FAILURE_LEDGER_CONFLICT');
      await expect(
        persistArticleFailures(
          tx,
          'other',
          'MP_WXS_9999999999',
          input,
          archived,
          false,
          1700000000000,
        ),
      ).rejects.toThrow('FAILURE_LEDGER_IDENTITY_INVALID');
      const snapshot = snapshotFailureId(feedId, 'media', input, archived);
      expect(snapshotFailureId(feedId, 'media', input, archived)).toBe(
        snapshot,
      );
      expect(snapshotFailureId(feedId, 'list', input, archived)).not.toBe(
        snapshot,
      );
      expect(
        snapshotFailureId(
          feedId,
          'media',
          { ...input, articles: [body, { ...media, title: 'changed' }] },
          archived,
        ),
      ).not.toBe(snapshot);
      await persistArticleFailures(
        tx,
        snapshot,
        feedId,
        input,
        archived,
        false,
        1700000000000,
        [],
        true,
      );
      await persistArticleFailures(
        tx,
        snapshot,
        feedId,
        input,
        archived,
        false,
        1700000001234,
        [],
        true,
      );
      const first = db
        .prepare(
          "SELECT CAST(observed_at AS TEXT) AS observed_at FROM article_failure_events WHERE attempt_id=? AND stage='body'",
        )
        .get(snapshot);
      expect(first).toMatchObject({ observed_at: '1700000000000' });
      db.exec('BEGIN');
      db.prepare('INSERT INTO articles VALUES (?)').run(media.id);
      await persistArticleFailures(
        tx,
        'rollback',
        feedId,
        input,
        archived,
        false,
        1700000000000,
      );
      db.exec('ROLLBACK');
      expect(db.prepare('SELECT count(*) n FROM articles').get()).toMatchObject(
        { n: 1 },
      );
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM article_failure_events WHERE attempt_id='rollback'",
          )
          .get(),
      ).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('does not invent a media failure when a protected text-only body is suppressed', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE article_failure_events(attempt_id TEXT,feed_id TEXT,article_id TEXT,stage TEXT,code TEXT,observed_at BIGINT,PRIMARY KEY(attempt_id,article_id,stage))',
    );
    const tx = {
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
        db.prepare(sql).all(...(values as any[])) as T,
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
        Number(db.prepare(sql).run(...(values as any[])).changes),
    };
    const article = makeArticle(103, '<div><p>text only</p></div>');
    const original = {
      articles: [article],
      coverage: 'recent-window' as const,
      upstreamCount: 1,
      bodyMissing: 0,
      imageBlocked: 0,
    };
    try {
      await persistArticleFailures(
        tx,
        'text-only',
        feedId,
        original,
        { ...original, articles: [{ ...article, contentHtml: null }] },
        false,
        1700000000000,
      );
      expect(
        db.prepare('SELECT count(*) n FROM article_failure_events').get(),
      ).toMatchObject({ n: 0 });
      const withImage = {
        ...article,
        contentHtml: '<div><img src="https://mmbiz.qpic.cn/x.png"></div>',
      };
      await persistArticleFailures(
        tx,
        'image',
        feedId,
        { ...original, articles: [withImage] },
        { ...original, articles: [{ ...withImage, contentHtml: null }] },
        false,
        1700000000000,
      );
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM article_failure_events WHERE code='MEDIA_PENDING'",
          )
          .get(),
      ).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });
});
