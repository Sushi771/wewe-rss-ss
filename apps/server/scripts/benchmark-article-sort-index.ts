/** Synthetic-only benchmark: accepts no database/directory input. */
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { findArticleListRows } from '../src/article-list-page';

async function main() {
  const owned = await mkdtemp(join(tmpdir(), 'article-index-benchmark-'));
  const migration = await readFile(
    resolve(
      __dirname,
      '../prisma/migrations/20261020100000_article_global_sort_index/migration.sql',
    ),
    'utf8',
  );
  const results = [];
  for (const count of [1809, 60000]) {
    const database = join(owned, 'synthetic-' + count + '.db');
    const url = 'file:' + database.replace(/\\/g, '/');
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        resolve(__dirname, '../prisma/schema.prisma'),
      ],
      {
        env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' },
        windowsHide: true,
        stdio: 'pipe',
      },
    );
    const prisma = new PrismaClient({
      datasources: { db: { url } },
      log: [{ emit: 'event', level: 'query' }],
    });
    let last: { query: string; params: string } | undefined;
    (prisma as any).$on('query', (e: { query: string; params: string }) => {
      if (
        e.query.startsWith('SELECT') &&
        e.query.includes('articles') &&
        !e.query.includes('content_html')
      )
        last = e;
    });
    try {
      for (let i = 0; i < 300; i++)
        await prisma.feed.create({
          data: {
            id: 'f' + i,
            mpName: 'Synthetic ' + i,
            mpCover: '',
            mpIntro: '',
            updateTime: 1,
          },
        });
      for (let offset = 0; offset < count; offset += 500) {
        const values = Array.from(
          { length: Math.min(500, count - offset) },
          (_, i) => {
            const n = offset + i;
            return `('a${String(n).padStart(8, '0')}','f${n % 300}','Title ${n} term${n % 100}','','${1790000000 + Math.floor(n / 4)}','<p>${'x'.repeat(1024)}</p>',1767225600000)`;
          },
        );
        await prisma.$executeRawUnsafe(
          'INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html,created_at) VALUES ' +
            values.join(','),
        );
      }
      await prisma.$executeRawUnsafe('DROP INDEX articles_publish_time_id_idx');
      const firstQuery = {
        take: 21,
        orderBy: [{ publishTime: 'desc' as const }, { id: 'desc' as const }],
      };
      const expected = await findArticleListRows(prisma, firstQuery);
      // Record the actual Prisma identity SQL, not a hand-written cursor approximation.
      let identityEvent: { query: string; params: string } | undefined;
      (prisma as any).$on('query', (e: { query: string; params: string }) => {
        if (
          e.query.startsWith('SELECT') &&
          e.query.includes('articles') &&
          e.query.includes('ORDER BY')
        )
          identityEvent = e;
      });
      await findArticleListRows(prisma, firstQuery);
      const sql = identityEvent!;
      const planBefore = await prisma.$queryRawUnsafe(
        'EXPLAIN QUERY PLAN ' + sql.query,
        ...JSON.parse(sql.params),
      );
      const samples = [];
      for (let sample = 0; sample < 5; sample++) {
        for (const indexed of sample % 2 ? [true, false] : [false, true]) {
          await prisma.$executeRawUnsafe(
            'DROP INDEX IF EXISTS articles_publish_time_id_idx',
          );
          const buildStart = performance.now();
          if (indexed) await prisma.$executeRawUnsafe(migration);
          const migrationMs = indexed
            ? performance.now() - buildStart
            : undefined;
          const pageStart = performance.now();
          const page = await findArticleListRows(prisma, firstQuery);
          const pageMs = performance.now() - pageStart;
          if (JSON.stringify(page) !== JSON.stringify(expected))
            throw Error('SORT_RESULT_CHANGED');
          const deepStart = performance.now();
          await findArticleListRows(prisma, {
            ...firstQuery,
            cursor: {
              id: 'a' + String(Math.floor(count / 2)).padStart(8, '0'),
            },
          });
          const cursorMs = performance.now() - deepStart;
          const writeStart = performance.now();
          await prisma.$transaction(async (tx) => {
            for (let i = 0; i < 100; i++)
              await tx.article.create({
                data: {
                  id: `w${sample}-${indexed}-${i}`,
                  mpId: 'f0',
                  title: 'write',
                  picUrl: '',
                  publishTime: 1790000000,
                  contentHtml: 'synthetic',
                },
              });
          });
          const write100Ms = performance.now() - writeStart;
          await prisma.article.deleteMany({
            where: { id: { startsWith: `w${sample}-${indexed}-` } },
          });
          samples.push({ indexed, pageMs, cursorMs, write100Ms, migrationMs });
        }
      }
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS articles_publish_time_id_idx ON articles(publish_time,id)',
      );
      const planAfter = await prisma.$queryRawUnsafe(
        'EXPLAIN QUERY PLAN ' + sql.query,
        ...JSON.parse(sql.params),
      );
      const indexPages = await prisma
        .$queryRawUnsafe(
          'SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name=?',
          'articles_publish_time_id_idx',
        )
        .catch(() => null);
      const summarize = (
        indexed: boolean,
        key: 'pageMs' | 'cursorMs' | 'write100Ms' | 'migrationMs',
      ) => {
        const a = samples
          .filter((s) => s.indexed === indexed)
          .map((s) => s[key])
          .filter((n): n is number => typeof n === 'number')
          .sort((a, b) => a - b);
        return { median: a[Math.floor(a.length / 2)], max: a[a.length - 1] };
      };
      results.push({
        articles: count,
        feeds: 300,
        bodyTextBytes: 1024,
        planBefore,
        planAfter,
        indexPages,
        databaseBytes: (await stat(database)).size,
        samples,
        summary: {
          before: {
            page: summarize(false, 'pageMs'),
            cursor: summarize(false, 'cursorMs'),
            write100: summarize(false, 'write100Ms'),
          },
          after: {
            page: summarize(true, 'pageMs'),
            cursor: summarize(true, 'cursorMs'),
            write100: summarize(true, 'write100Ms'),
            migration: summarize(true, 'migrationMs'),
          },
        },
      });
      void last;
    } finally {
      await prisma.$disconnect();
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        sqliteAndPrisma: 'lockfile versions; actual Prisma queries',
        boundaries:
          'No server/HTTP/browser. Warm process; fixture/import/connection excluded; page includes transaction, identity selection, metadata hydration and body presence. Five alternating samples. Files retained; synthetic databases only.',
        results,
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  );
}
void main();
