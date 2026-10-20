/** Synthetic-only: no input paths, credentials, providers or production settings. */
import { PrismaClient } from '@prisma/client';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { TrpcRouter } from '../src/trpc/trpc.router';
import { TrpcService } from '../src/trpc/trpc.service';
import {
  prepareBodySearch,
  bodySearchCoverage,
} from '../src/article-body-search';
import { splitSqliteStatements } from '../../../scripts/sqlite-statements.cjs';
const summary = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: s[Math.ceil(s.length * 0.5) - 1],
    p95: s[Math.ceil(s.length * 0.95) - 1],
  };
};
async function main() {
  process.env.DATABASE_URL = 'file:synthetic-relative-cache-bypass.db';
  const owned = await mkdtemp(join(tmpdir(), 'wewe-body-search-benchmark-'));
  const results: any[] = [];
  try {
    for (const count of [1809, 60000]) {
      const file = join(owned, count + '.db');
      const p = new PrismaClient({
        datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
      });
      let server: import('node:http').Server | undefined;
      try {
        const migrations = resolve(__dirname, '../prisma/migrations');
        const names = (await readdir(migrations))
          .filter((x) => /^\d/.test(x))
          .sort();
        const additive = names.pop()!;
        if (additive !== '20261020160000_local_body_search')
          throw Error('review benchmark baseline migrations');
        console.error('dataset', count, 'seed');
        for (const name of names)
          for (const sql of splitSqliteStatements(
            await readFile(join(migrations, name, 'migration.sql'), 'utf8'),
          ))
            if (sql.trim()) await p.$executeRawUnsafe(sql);
        for (let i = 0; i < 30; i++)
          await p.feed.create({
            data: {
              id: 'f' + i,
              mpName: '合成来源' + i,
              mpCover: '',
              mpIntro: '',
              updateTime: 0,
            },
          });
        const body =
          '<p>' +
          '合成正文用于评估中文短词和标点匹配，记录完整内容而不包含私人文章。'.repeat(
            20,
          ) +
          '</p><img src="data:image/png;base64,' +
          'A'.repeat(1024) +
          '">';
        await p.$executeRawUnsafe(
          `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1 < ?) INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html,read_count,like_count,created_at) SELECT 'a'||printf('%06d',x),'f'||(x%30),'合成标题'||x,'',1700000000+x,CASE WHEN x%5=0 THEN NULL ELSE ?||CASE WHEN x%29=0 THEN '<p>稀有正文关键词100% one_two</p>' ELSE '' END END,x%100,x%20,CURRENT_TIMESTAMP FROM n`,
          count,
          body,
        );
        const writes: Record<string, any> = {};
        const writeSamples = async (label: string) => {
          const samples: number[] = [];
          for (let n = 0; n < 20; n++) {
            const t = performance.now();
            await p.$transaction(
              Array.from({ length: 10 }, (_, i) =>
                p.article.create({
                  data: {
                    id: 'write-' + n + '-' + i,
                    mpId: 'f0',
                    title: '合成增量写入',
                    picUrl: '',
                    publishTime: 1700000000,
                    contentHtml: body,
                  },
                }),
              ),
            );
            samples.push(performance.now() - t);
          }
          const updates: number[] = [];
          for (let n = 0; n < 20; n++) {
            const t = performance.now();
            await p.$transaction(
              Array.from({ length: 10 }, (_, i) =>
                p.article.update({
                  where: { id: 'write-' + n + '-' + i },
                  data: { contentHtml: body + '<p>更新' + n + '</p>' },
                }),
              ),
            );
            updates.push(performance.now() - t);
          }
          writes[label] = {
            insert10: summary(samples),
            update10: summary(updates),
          };
          await p.article.deleteMany({
            where: { id: { startsWith: 'write-' } },
          });
        };
        await writeSamples('beforeProjection');
        console.error('dataset', count, 'projection');
        await p.$executeRawUnsafe('VACUUM');
        const beforeBytes = (await stat(file)).size;
        for (const sql of splitSqliteStatements(
          await readFile(join(migrations, additive, 'migration.sql'), 'utf8'),
        ))
          if (sql.trim()) await p.$executeRawUnsafe(sql);
        await writeSamples('withInvalidationTriggers');
        let batches = 0;
        const batchTimes: number[] = [];
        const concurrentBodyWrites: number[] = [];
        const t = performance.now();
        for (;;) {
          const bt = performance.now();
          let writing: Promise<void> | undefined;
          if (
            batches % Math.max(1, Math.floor(count / 128 / 30)) === 0 &&
            concurrentBodyWrites.length < 30
          ) {
            const started = performance.now();
            writing = p.article
              .update({
                where: { id: 'a000001' },
                data: {
                  contentHtml: body + '<p>并行合成更新' + batches + '</p>',
                },
              })
              .then(() => {
                concurrentBodyWrites.push(performance.now() - started);
              });
          }
          const status = await prepareBodySearch(p);
          batchTimes.push(performance.now() - bt);
          batches++;
          if (writing) await writing;
          if (
            !status.pending &&
            (!writing || !(await bodySearchCoverage(p)).pending)
          )
            break;
          if (batches > 10000 || performance.now() - t > 600000)
            throw Error('index build exceeded benchmark bound');
        }
        const buildMs = performance.now() - t;
        console.error('dataset', count, 'built', buildMs);
        await p.$executeRawUnsafe('VACUUM');
        const projectionBytes = (await stat(file)).size - beforeBytes;
        const config = {
          get: (key: string) =>
            key === 'platform' ? { url: '' } : { updateDelayTime: 0 },
        } as any;
        const router = new TrpcRouter(
          new TrpcService(p as any, config, {} as any, {} as any),
          p as any,
          config,
          {} as any,
          {} as any,
        ).appRouter;
        const app = express();
        app.use(
          '/trpc',
          (req, res, next) => {
            if (req.headers.authorization !== 'synthetic') {
              res.status(401).end();
              return;
            }
            next();
          },
          createExpressMiddleware({
            router,
            createContext: () => ({ errorMsg: null, isLocal: true }),
          }),
        );
        server = await new Promise<any>((r) => {
          const s = app.listen(0, '127.0.0.1', () => r(s));
        });
        const port = (server!.address() as any).port;
        const queries = [
          { name: 'body-rare', input: { search: '稀有正文关键词', limit: 20 } },
          { name: 'body-common', input: { search: '中文短词', limit: 20 } },
          { name: 'single-character', input: { search: '词', limit: 20 } },
          { name: 'punctuation', input: { search: '100%', limit: 20 } },
          {
            name: 'missing',
            expectEmpty: true,
            input: { search: '不可能存在的合成缺失关键词', limit: 20 },
          },
          {
            name: 'cursor',
            input: { search: '中文短词', cursor: 'a000151', limit: 20 },
          },
          {
            name: 'summary',
            procedure: 'summary',
            input: { search: '中文短词' },
          },
          {
            name: 'filtered',
            input: {
              search: '中文短词',
              mpId: 'f1',
              dateStart: '2023-11-14',
              dateEnd: '2023-11-16',
              limit: 20,
            },
          },
        ];
        const timings: any[] = [];
        let errors = 0;
        for (const q of queries) {
          console.error('dataset', count, q.name);
          const values: number[] = [];
          for (let n = 0; n < 30; n++) {
            const start = performance.now();
            const res = await fetch(
              'http://127.0.0.1:' +
                port +
                '/trpc/article.' +
                (q.procedure || 'list') +
                '?input=' +
                encodeURIComponent(JSON.stringify(q.input)),
              {
                headers: { authorization: 'synthetic' },
                signal: AbortSignal.timeout(15000),
              },
            );
            const value: any = await res.json();
            const data = value.result?.data;
            const valid =
              q.procedure === 'summary'
                ? data?.articles > 0
                : q.expectEmpty
                  ? Array.isArray(data?.items) && data.items.length === 0
                  : data?.items?.length > 0;
            if (!res.ok || !valid) {
              errors++;
              throw Error(
                'search HTTP/result failure ' + JSON.stringify(value),
              );
            }
            values.push(performance.now() - start);
          }
          timings.push({ name: q.name, ...summary(values) });
        }
        results.push({
          count,
          cached: Math.floor((count * 4) / 5),
          scope:
            'authenticated loopback HTTP + real list route + SQLite membership/hydration/snippet; no browser render; warm OS cache, first request included',
          queries: timings,
          errors,
          projectionBytes,
          buildMs,
          batches,
          batch: summary(batchTimes),
          concurrentBodyWrites: summary(concurrentBodyWrites),
          writes,
        });
      } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((r) => server!.close(() => r()));
        }
        await p.$disconnect();
      }
    }
  } finally {
    if (dirname(owned) !== tmpdir())
      throw Error('unexpected benchmark directory');
    await rm(owned, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify(
      {
        scope:
          'synthetic-only, local-body-text projection with literal instr scans',
        results,
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
