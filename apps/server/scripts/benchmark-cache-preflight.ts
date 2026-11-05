/** Offline only: creates its own temporary SQLite; accepts no database URL/path.
 * Run from apps/server with ts-node/transpile-only + tsconfig-paths/register.
 * Optional PRISMA_QUERY_ENGINE_LIBRARY selects the audited engine for this child.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { FeedsService } from '../src/feeds/feeds.service';
import { FeedsController } from '../src/feeds/feeds.controller';
import { TrpcService } from '../src/trpc/trpc.service';
import { findArticleListRows } from '../src/article-list-page';
import { readCachedBodyMediaFlags } from '../src/feeds/cache-body-media-flags';
import { legacyCachedFlags } from '../test/fixtures/legacy-cache-body-flags';
import { noisePng } from '../test/fixtures/cache-noise-png';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
async function main() {
  Logger.overrideLogger(false);
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cache-contention-benchmark-'),
  );
  const database = path.join(root, 'synthetic.db');
  Object.assign(process.env, {
    DATABASE_URL:
      'file:' + database.replaceAll('\\', '/') + '?connection_limit=1',
    SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
    WECHAT2RSS_ACTIVE_SCHEDULE: '0',
    WECHAT2RSS_DAILY_CATCHUP: '0',
    WECHAT2RSS_CACHE_SYNC: '0',
    ENABLE_SCHEDULED_UPDATES: '0',
    DISABLE_SCHEDULED_UPDATES: '1',
  });
  const prisma = new PrismaService();
  let app: any;
  const originalFetch = global.fetch;
  try {
    await prisma.$connect();
    const migrations = path.resolve(__dirname, '../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const sql = await fs
        .readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of sql
        .split(';')
        .map((line) => line.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    const feedId = 'MP_WXS_1234567890';
    await prisma.feed.create({
      data: {
        id: feedId,
        mpName: 'Synthetic',
        mpIntro: '',
        mpCover: '',
        updateTime: 0,
        collectionChannel: 'wechat2rss',
      },
    });
    const image = 'data:image/png;base64,' + noisePng().toString('base64');
    const body =
      '<div id="js_content">synthetic text' +
      `<img src="${image}">`.repeat(60) +
      '</div>';
    const probeBody = body.replace(
      '<img ',
      '<img data-src="https://mmbiz.qpic.cn/synthetic-stale" ',
    );
    const ids = Array.from(
      { length: 25 },
      (_, n) => 'synthetic-' + String(n).padStart(3, '0'),
    );
    for (let n = 0; n < 35; n++)
      await prisma.article.create({
        data: {
          id: 'synthetic-' + String(n).padStart(3, '0'),
          mpId: feedId,
          title: 'Synthetic ' + n,
          picUrl: '',
          publishTime: 1760000000 + n,
          contentHtml: n === 0 ? probeBody : body,
          lastBodyStatus: 'available',
        },
      });
    const module = await Test.createTestingModule({
      controllers: [FeedsController],
      providers: [
        FeedsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            feed: { originUrl: 'http://127.0.0.1', mode: 'summary' },
          }),
        },
        { provide: TrpcService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const endpoint = 'http://127.0.0.1:' + app.getHttpServer().address().port;
    global.fetch = ((input: any, init: any) => {
      const url = new URL(
        typeof input === 'string' ? input : input.url || String(input),
      );
      if (url.origin !== endpoint) throw Error('NONLOCAL_NETWORK_FORBIDDEN');
      return originalFetch(input, init);
    }) as typeof fetch;
    const results: any[] = [];
    let current: { entered(): void; active: boolean } | undefined;
    prisma.$use(async (params, next) => {
      if (current?.active && params.action === 'queryRaw') {
        current.active = false;
        current.entered();
      }
      return next(params);
    });
    const round = async (kind: 'old' | 'new', index: number) => {
      let entered!: () => void;
      const start = new Promise<void>((resolve) => {
        entered = resolve;
      });
      current = { entered, active: true };
      const began = performance.now();
      const background = Promise.resolve(
        kind === 'old'
          ? legacyCachedFlags(prisma, feedId)
          : readCachedBodyMediaFlags(prisma, feedId, ids),
      ).then((rows) => ({
        ms: performance.now() - began,
        hash: hash(
          rows
            .filter((row) => ids.includes(row.id))
            .map((row) => ({
              id: row.id,
              bodyMissing: Number(row.bodyMissing),
              remoteImages: Number(row.remoteImages),
              mediaPending: Number(row.mediaPending),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      }));
      await start;
      await new Promise((resolve) => setImmediate(resolve));
      const rssStart = performance.now();
      const rss = originalFetch(
        endpoint + `/feeds/${feedId}.rss?limit=20&mode=summary`,
      ).then(async (response) => {
        const xml = await response.text();
        return {
          ms: performance.now() - rssStart,
          http: response.status,
          items: (xml.match(/<item>/g) || []).length,
          bytes: Buffer.byteLength(xml),
        };
      });
      const listStart = performance.now();
      const list = findArticleListRows(prisma, {
        take: 20,
        orderBy: [{ publishTime: 'desc' }, { id: 'desc' }],
      })
        .then((rows) => ({
          ms: performance.now() - listStart,
          items: rows.length,
          hash: hash(rows.map((row) => row.id)),
        }))
        .catch((error) => ({
          ms: performance.now() - listStart,
          error: error.code || error.name,
        }));
      const writeStart = performance.now();
      let callbackAt = 0;
      const write = prisma
        .$transaction(async (tx) => {
          callbackAt = performance.now();
          await tx.feed.update({
            where: { id: feedId },
            data: { mpIntro: kind + index },
          });
        })
        .then(() => ({
          ms: performance.now() - writeStart,
          poolWaitMs: callbackAt - writeStart,
          callbackMs: performance.now() - callbackAt,
        }))
        .catch((error) => ({
          ms: performance.now() - writeStart,
          poolWaitMs: callbackAt ? callbackAt - writeStart : null,
          callbackMs: null,
          error: error.code || error.name,
        }));
      const [flags, rssResult, listResult, writeResult] = await Promise.all([
        background,
        rss,
        list,
        write,
      ]);
      const result = {
        kind,
        index,
        flags,
        rss: rssResult,
        list: listResult,
        write: writeResult,
      };
      results.push(result);
      console.log(JSON.stringify({ event: 'round', ...result }));
    };
    for (let index = 0; index < 5; index++)
      for (const kind of index % 2
        ? (['new', 'old'] as const)
        : (['old', 'new'] as const))
        await round(kind, index);
    const summarize = (kind: string) =>
      Object.fromEntries(
        ['flags', 'rss', 'list', 'write'].map((field) => {
          const values = results
            .filter((row) => row.kind === kind)
            .map((row) => row[field].ms);
          return [
            field,
            {
              n: values.length,
              p50: percentile(values, 0.5),
              p95: percentile(values, 0.95),
              max: Math.max(...values),
            },
          ];
        }),
      );
    const engine = process.env.PRISMA_QUERY_ENGINE_LIBRARY;
    const report = {
      engine: engine
        ? createRequire(__filename)(engine).version().commit
        : 'generated default',
      client: Prisma.prismaVersion,
      node: process.version,
      connectionLimit: 1,
      rows: 35,
      incomingIds: 25,
      imagesPerBody: 60,
      bodyBytes: Buffer.byteLength(body),
      databaseBytes: (await fs.stat(database)).size,
      journal: await prisma.$queryRawUnsafe('PRAGMA journal_mode'),
      order:
        'alternating old/new; same synthetic DB; no SQL/result cache; no production requests',
      old: summarize('old'),
      new: summarize('new'),
      identicalFlags: new Set(results.map((row) => row.flags.hash)).size === 1,
      results,
    };
    if (
      !report.identicalFlags ||
      results
        .filter((row) => row.kind === 'new')
        .some(
          (row) =>
            row.rss.http !== 200 ||
            row.rss.items !== 20 ||
            row.list.items !== 20,
        )
    )
      throw Error('BENCHMARK_SEMANTICS_FAILED');
    const output = path.resolve(
      __dirname,
      '../../../output/cache-preflight-benchmark.private.json',
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({ event: 'summary', ...report, results: undefined }),
    );
  } finally {
    global.fetch = originalFetch;
    await app?.close();
    await prisma.$disconnect();
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('cache-contention-benchmark-')
    )
      throw Error('INVALID_TEMP_ROOT');
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
