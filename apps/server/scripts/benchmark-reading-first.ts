/** Own synthetic SQLite only. Actual protected routes, PrismaService and pool=1. */
import { Prisma, PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { promises as fs, readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';
import { articleFilterSchema } from '@wewe-rss/shared';
import { articleListWhere } from '../src/article-list-filter';
import express from 'express';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { PrismaService } from '../src/prisma/prisma.service';
import { TrpcService } from '../src/trpc/trpc.service';
import { TrpcRouter } from '../src/trpc/trpc.router';

const baseline = '7a99f2c6e003b1ecf029e61f0d2031b05c05afaa';
/** Reproduce the rejected summary prototype and verify the final no-SQL-change
 * decision against its exact old callback, with the same auth/filter/client/DB. */
function oldSummary(endpoint: TrpcRouter) {
  const file = 'apps/server/src/trpc/trpc.router.ts';
  const source = execFileSync('git', ['show', `${baseline}:${file}`], {
    encoding: 'utf8',
    maxBuffer: 4000000,
  });
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(ts.isClassDeclaration)!;
  const member = declaration.members.find(
    (node) => node.name?.getText(ast) === 'articleRouter',
  ) as ts.PropertyDeclaration;
  const record = (member.initializer as ts.CallExpression)
    .arguments[0] as ts.ObjectLiteralExpression;
  const currentSource = readFileSync(
    resolve(__dirname, '../src/trpc/trpc.router.ts'),
    'utf8',
  );
  const currentAst = ts.createSourceFile(
    file,
    currentSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const currentClass = currentAst.statements.find(ts.isClassDeclaration)!;
  const currentMember = currentClass.members.find(
    (node) => node.name?.getText(currentAst) === 'articleRouter',
  ) as ts.PropertyDeclaration;
  const currentRecord = (currentMember.initializer as ts.CallExpression)
    .arguments[0] as ts.ObjectLiteralExpression;
  const printer = ts.createPrinter({ removeComments: true });
  for (const name of ['list', 'byId']) {
    const oldNode = record.properties.find(
      (node) => node.name?.getText(ast) === name,
    )!;
    const newNode = currentRecord.properties.find(
      (node) => node.name?.getText(currentAst) === name,
    )!;
    if (
      printer.printNode(ts.EmitHint.Unspecified, oldNode, ast) !==
      printer.printNode(ts.EmitHint.Unspecified, newNode, currentAst)
    )
      throw new Error('BASELINE_LIST_OR_BODY_CHANGED_EXTEND_BENCHMARK');
  }
  const summary = record.properties.find(
    (node) => node.name?.getText(ast) === 'summary',
  ) as ts.PropertyAssignment;
  const callback = (summary.initializer as ts.CallExpression).arguments[0];
  if (!ts.isArrowFunction(callback))
    throw new Error('BASELINE_RESOLVER_CHANGED');
  const create = new Function(
    'articleListWhere',
    ts.transpile(`return (${callback.getText(ast)});`, {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    }),
  );
  return create.call(endpoint, articleListWhere);
}

async function main() {
  const root = await fs.mkdtemp(join(tmpdir(), 'wewe-reading-first-'));
  let seed: PrismaClient | undefined, prisma: PrismaService | undefined;
  let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  const info = console.info;
  const observations: unknown[] = [];
  console.info = (message: string, ...args: unknown[]) => {
    if (
      typeof message === 'string' &&
      message.startsWith('[ARTICLE_LIST_READ_TIMING] ')
    )
      observations.push(
        JSON.parse(message.slice('[ARTICLE_LIST_READ_TIMING] '.length)),
      );
    else info(message, ...args);
  };
  try {
    process.env.DATABASE_URL =
      'file:' +
      join(root, 'synthetic.db').replace(/\\/g, '/') +
      '?connection_limit=1';
    process.env.ARTICLE_LIST_READ_TIMING = '1';
    seed = new PrismaClient();
    for (const name of (
      await fs.readdir(resolve(__dirname, '../prisma/migrations'))
    ).sort()) {
      const sql = await fs
        .readFile(
          resolve(__dirname, '../prisma/migrations', name, 'migration.sql'),
          'utf8',
        )
        .catch(() => '');
      for (const statement of sql
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean))
        await seed.$executeRawUnsafe(statement);
    }
    for (let i = 0; i < 200; i++)
      await seed.feed.create({
        data: {
          id: 'f' + i,
          mpName: 'Synthetic ' + i,
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
        },
      });
    await seed.$executeRawUnsafe(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1<6000)
      INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html,read_count,like_count,created_at)
      SELECT 'article-'||printf('%06d',x),'f'||(x%200),'Synthetic '||x,'',1700000000+x,
      CASE WHEN x%7=0 THEN NULL WHEN x%7=1 THEN '' ELSE '<div id="js_content"><p>'||replace(hex(zeroblob(32768)),'00','x')||'</p></div>' END,
      CASE WHEN x%3=0 THEN NULL ELSE x%99 END,CASE WHEN x%5=0 THEN NULL ELSE x%17 END,CURRENT_TIMESTAMP FROM n`);
    const plans: Record<string, unknown> = {};
    for (const [label, sql] of Object.entries({
      valueCount: 'EXPLAIN SELECT COUNT(read_count) FROM articles',
      nullPredicate:
        'EXPLAIN SELECT COUNT(*) FROM articles WHERE read_count IS NOT NULL',
    })) {
      const plan = await seed.$queryRawUnsafe<any[]>(sql);
      plans[label] = plan
        .filter((op) => op.opcode === 'Column')
        .map((op) => ({ column: Number(op.p2), flags: Number(op.p5) }));
    }
    await seed.$disconnect();
    seed = undefined;
    prisma = new PrismaService();
    await prisma.$connect();
    const queries: { action: string; ms: number; bodySelected: boolean }[] = [];
    prisma.$use(async (params, next) => {
      const start = performance.now();
      try {
        return await next(params);
      } finally {
        queries.push({
          action: params.action,
          ms: performance.now() - start,
          bodySelected:
            params.action === 'findUnique' ||
            Boolean(params.args?.select?.contentHtml),
        });
      }
    });
    const native: { operation: string; duration: number }[] = [];
    (prisma as any).$on('query', (event: { query: string; duration: number }) =>
      native.push({
        operation: /^\s*(\w+)/.exec(event.query)?.[1] || 'OTHER',
        duration: event.duration,
      }),
    );
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const service = new TrpcService(prisma, config, {} as any, {} as any);
    const endpoint = new TrpcRouter(
      service,
      prisma,
      config,
      {} as any,
      {} as any,
    );
    const routers = {
      candidate: endpoint.appRouter,
      baseline: service.router({
        article: service.router({
          list: endpoint.articleRouter.list,
          byId: endpoint.articleRouter.byId,
          summary: service.protectedProcedure
            .input(articleFilterSchema)
            .query(oldSummary(endpoint)),
        }),
      }),
    };
    const application = express();
    const requests: {
      serverMs: number;
      queryStart: number;
      queryEnd: number;
    }[] = [];
    for (const mode of ['baseline', 'candidate'] as const)
      application.use(
        `/${mode}/trpc`,
        (req, res, next) => {
          const start = performance.now(),
            queryStart = queries.length;
          res.once('finish', () =>
            requests.push({
              serverMs: performance.now() - start,
              queryStart,
              queryEnd: queries.length,
            }),
          );
          next();
        },
        createExpressMiddleware({
          router: routers[mode],
          createContext: ({ req }) =>
            ({
              isLocal: true,
              errorMsg:
                req.headers.authorization === 'fixture'
                  ? undefined
                  : 'UNAUTHORIZED',
            }) as any,
        }),
      );
    server = await new Promise((done) => {
      const current = application.listen(0, '127.0.0.1', () => done(current));
    });
    const address = server!.address() as { port: number };
    const rows: object[] = [];
    const hashes = new Map<string, string>();
    const list = { limit: 20, sort: 'publishTime', direction: 'desc' };
    for (let round = 0; round < 5; round++) {
      for (const mode of round % 2
        ? ['candidate', 'baseline']
        : ['baseline', 'candidate']) {
        for (const phase of [
          'list-miss',
          'list-hit',
          'summary',
          'byId',
          'batch',
        ]) {
          // Each miss has identical membership with a different lower date bound,
          // well before all fixture publication dates. OS pages are already warm.
          const input = {
            ...list,
            dateStart: `2020-01-${String(round * 2 + (mode === 'baseline' ? 1 : 2)).padStart(2, '0')}`,
          };
          const route = phase.startsWith('list')
            ? 'article.list'
            : phase === 'summary'
              ? 'article.summary'
              : phase === 'byId'
                ? 'article.byId'
                : 'article.summary,article.list';
          const value = phase.startsWith('list')
            ? input
            : phase === 'summary'
              ? {}
              : phase === 'byId'
                ? 'article-005998'
                : { '0': {}, '1': input };
          const q0 = queries.length,
            n0 = native.length,
            o0 = observations.length;
          const start = performance.now();
          const response = await fetch(
            `http://127.0.0.1:${address.port}/${mode}/trpc/${route}?${phase === 'batch' ? 'batch=1&' : ''}input=${encodeURIComponent(JSON.stringify(value))}`,
            { headers: { Authorization: 'fixture' } },
          );
          const headersMs = performance.now() - start;
          const text = await response.text(),
            receivedMs = performance.now() - start;
          const parseStart = performance.now(),
            data = JSON.parse(text),
            parseMs = performance.now() - parseStart;
          if (
            response.status !== 200 ||
            (Array.isArray(data) ? data : [data]).some((x) => x.error)
          )
            throw new Error('SYNTHETIC_READ_FAILED');
          const results = (Array.isArray(data) ? data : [data]).map(
            (x) => x.result.data,
          );
          if (phase.startsWith('list') && results[0].items.length !== 20)
            throw new Error('SYNTHETIC_MEMBERSHIP_CHANGED');
          if (phase === 'batch' && results[1].items.length !== 20)
            throw new Error('SYNTHETIC_BATCH_MEMBERSHIP_CHANGED');
          if (
            phase === 'byId' &&
            Buffer.byteLength(results[0].contentHtml || '') < 32768
          )
            throw new Error('SYNTHETIC_BODY_NOT_CACHED');
          await new Promise<void>((done) => setImmediate(done));
          const responseHash = createHash('sha256').update(text).digest('hex');
          if (
            queries
              .slice(q0)
              .some(
                (query) =>
                  !['findMany', 'findUnique', 'count', 'aggregate'].includes(
                    query.action,
                  ),
              ) ||
            native
              .slice(n0)
              .some(
                (query) =>
                  !['SELECT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'PRAGMA'].includes(
                    query.operation.toUpperCase(),
                  ),
              )
          )
            throw new Error('READ_INITIATED_WRITE');
          if (hashes.has(phase) && hashes.get(phase) !== responseHash)
            throw new Error('READ_RESPONSE_CHANGED');
          hashes.set(phase, responseHash);
          rows.push({
            mode,
            round,
            phase,
            headersMs,
            receivedMs,
            parseMs,
            bytes: Buffer.byteLength(text),
            server: requests.at(-1),
            queries: queries.slice(q0),
            native: native.slice(n0),
            observations: observations.slice(o0),
            responseHash,
          });
        }
      }
    }
    console.log(
      JSON.stringify({
        fixture: {
          baseline,
          node: process.version,
          engine: Prisma.prismaVersion.engine,
          articles: 6000,
          feeds: 200,
          bodyBytes: 32768,
          pool: 1,
          prismaService: true,
          physical: 'warm after seed; no production occupancy',
        },
        plans,
        databaseBytes: (await fs.stat(join(root, 'synthetic.db'))).size,
        rows,
      }),
    );
  } finally {
    console.info = info;
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    await prisma?.$disconnect();
    await seed?.$disconnect();
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('wewe-reading-first-')
    )
      throw new Error('UNSAFE_FIXTURE_CLEANUP');
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
