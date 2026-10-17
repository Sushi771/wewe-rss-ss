'use strict';
// Same-file synthetic comparison against the 9967904 list algorithm. No app
// startup, production data, upstream requests, page cache or OS-cache flushing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const server = path.resolve('apps/server');
const ts = require(require.resolve('typescript', { paths: [server] }));
const percentile = (rows, p) =>
  [...rows].sort((a, b) => a - b)[Math.ceil(rows.length * p) - 1];
const stats = (rows) => ({
  p50: percentile(rows, 0.5),
  p95: percentile(rows, 0.95),
});

test(
  'bounded synthetic wide-body list: identical pages, exact scopes, plans and uncached timings',
  { timeout: 180000 },
  async () => {
    const oldLoader = require.extensions['.ts'];
    require.extensions['.ts'] = (m, file) =>
      m._compile(
        ts.transpileModule(fs.readFileSync(file, 'utf8'), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2021,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            esModuleInterop: true,
          },
        }).outputText,
        file,
      );
    const undo = require(
      require.resolve('tsconfig-paths', { paths: [server] }),
    ).register({
      baseUrl: path.resolve('.'),
      paths: {
        '@wewe-rss/shared': ['packages/shared/src/index.ts'],
        '@server/*': ['apps/server/src/*'],
      },
    });
    const { PrismaClient } = require(
      require.resolve('@prisma/client', { paths: [server] }),
    );
    const {
      findArticleListRows,
    } = require('../apps/server/src/article-list-page.ts');
    const {
      articleListOrder,
      articleListWhere,
    } = require('../apps/server/src/article-list-filter.ts');
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-list-performance-'),
    );
    const db = path.join(root, 'synthetic.sqlite');
    const prisma = new PrismaClient({
      datasources: { db: { url: 'file:' + db.replaceAll('\\', '/') } },
      log: [{ emit: 'event', level: 'query' }],
    });
    const queries = [];
    prisma.$on('query', (e) => queries.push(e));
    const count = Number(process.env.ARTICLE_LIST_BENCHMARK_ROWS || 1800);
    const bodyBytes = Number(
      process.env.ARTICLE_LIST_BENCHMARK_BODY_BYTES || 32768,
    );
    const samples = Number(process.env.ARTICLE_LIST_BENCHMARK_SAMPLES || 12);
    assert(Number.isSafeInteger(count) && count >= 60 && count <= 10000);
    assert(
      Number.isSafeInteger(bodyBytes) &&
        bodyBytes >= 1024 &&
        count * bodyBytes <= 128 * 1024 * 1024,
    );
    assert(Number.isSafeInteger(samples) && samples >= 1 && samples <= 30);
    const projection = {
      id: true,
      mpId: true,
      title: true,
      picUrl: true,
      publishTime: true,
      sourceUrl: true,
      lastBodyStatus: true,
      verifiedSourceUrl: true,
      lastBodyRetry: true,
      metrics: true,
      readCount: true,
      likeCount: true,
      feed: true,
    };
    const legacy = (query) =>
      prisma.$transaction(
        async (tx) => {
          const rows = await tx.article.findMany({
            ...query,
            select: projection,
          });
          if (!rows.length) return [];
          const cached = await tx.article.findMany({
            where: {
              id: { in: rows.map((r) => r.id) },
              contentHtml: { not: null },
              NOT: { contentHtml: '' },
            },
            select: { id: true },
          });
          const ids = new Set(cached.map((r) => r.id));
          return rows.map((row) => ({ ...row, bodyCached: ids.has(row.id) }));
        },
        { maxWait: 15000, timeout: 30000 },
      );
    const summarySource = fs.readFileSync(
      path.join(server, 'src/trpc/trpc.router.ts'),
      'utf8',
    );
    const summaryAst = ts.createSourceFile(
      'router.ts',
      summarySource,
      99,
      true,
    );
    let summaryCallback;
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(summaryAst) === 'summary'
      )
        summaryCallback = node.initializer.arguments[0].getText(summaryAst);
      ts.forEachChild(node, visit);
    };
    visit(summaryAst);
    assert(summaryCallback);
    const summaryFunction = new Function(
      'articleListWhere',
      ts.transpileModule('return (' + summaryCallback + ')', {
        compilerOptions: { target: ts.ScriptTarget.ES2021 },
      }).outputText,
    ).call({ prismaService: prisma }, articleListWhere);
    try {
      for (const migration of fs
        .readdirSync(path.join(server, 'prisma/migrations'))
        .filter((n) => /^\d/.test(n))
        .sort())
        for (const sql of fs
          .readFileSync(
            path.join(server, 'prisma/migrations', migration, 'migration.sql'),
            'utf8',
          )
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean))
          await prisma.$executeRawUnsafe(sql);
      await prisma.managementGroup.create({
        data: {
          id: 'group-a',
          name: 'Synthetic A',
          platform: 'wechat',
          order: 0,
        },
      });
      for (let i = 0; i < 6; i++)
        await prisma.feed.create({
          data: {
            id: 'f' + i,
            mpName: 'Publisher ' + i,
            mpCover: '',
            mpIntro: '',
            updateTime: 0,
            groupId: i < 3 ? 'group-a' : null,
          },
        });
      await prisma.$executeRawUnsafe(
        `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1 < ?)
      INSERT INTO articles(id,mp_id,title,pic_url,publish_time,source_url,content_html,read_count,like_count,metrics,created_at)
      SELECT 'article-'||printf('%06d',x),'f'||(x%6),'Synthetic '||x,'',1700000000+CAST(x/3 AS INTEGER),NULL,
      CASE WHEN x%7=0 THEN NULL WHEN x%7=1 THEN '' WHEN x%7=2 THEN ' ' ELSE '<p>'||replace(hex(zeroblob(?)),'00','x')||'</p>' END,
      CASE WHEN x%13=0 THEN NULL ELSE x%99 END,CASE WHEN x%11=0 THEN NULL ELSE x%17 END,'{}',CURRENT_TIMESTAMP FROM n`,
        count,
        Math.floor(bodyBytes),
      );
      const rounds = [];
      const plans = {};
      for (const [stage, cursor] of [
        ['first', undefined],
        ['next', 'article-' + String(count - 22).padStart(6, '0')],
        ['deep', 'article-' + String(Math.floor(count / 2)).padStart(6, '0')],
      ]) {
        const query = {
          orderBy: articleListOrder({}),
          take: 21,
          where: {},
          cursor: cursor ? { id: cursor } : undefined,
        };
        const timings = { legacy: [], candidate: [] },
          database = { legacy: [], candidate: [] },
          queryCounts = {};
        for (let i = 0; i < samples; i++)
          for (const mode of i % 2
            ? ['candidate', 'legacy']
            : ['legacy', 'candidate']) {
            queries.length = 0;
            const start = performance.now();
            const rows = await (mode === 'legacy'
              ? legacy(query)
              : findArticleListRows(prisma, query));
            timings[mode].push(performance.now() - start);
            database[mode].push(queries.reduce((n, q) => n + q.duration, 0));
            queryCounts[mode] = queries.filter((q) =>
              q.query.startsWith('SELECT'),
            ).length;
            if (i === 0) {
              plans[stage + '-' + mode] = [];
              for (const q of [...queries].filter(
                (q) =>
                  q.query.startsWith('SELECT') && q.query.includes('articles'),
              ))
                plans[stage + '-' + mode].push({
                  projection: q.query.split(/\bFROM\b/)[0],
                  plan: await prisma.$queryRawUnsafe(
                    'EXPLAIN QUERY PLAN ' + q.query,
                    ...JSON.parse(q.params),
                  ),
                });
            }
            assert.equal(rows.length, 21);
            assert(rows.every((r) => !('contentHtml' in r)));
            assert.deepEqual(rows, await legacy(query));
          }
        rounds.push({
          stage,
          samples,
          wall: {
            legacy: stats(timings.legacy),
            candidate: stats(timings.candidate),
          },
          database: {
            legacy: stats(database.legacy),
            candidate: stats(database.candidate),
          },
          selects: queryCounts,
        });
      }
      for (const filter of [
        {},
        { mpId: 'f1' },
        { group: 'group-a' },
        { group: 'ungrouped' },
        { search: 'Publisher 2' },
        { search: 'Synthetic 11' },
        { dateStart: '2023-11-15', dateEnd: '2023-11-15' },
      ])
        for (const sort of ['publishTime', 'readCount', 'likeCount'])
          for (const direction of sort === 'publishTime'
            ? ['asc', 'desc']
            : ['desc']) {
            const input = { ...filter, sort, direction },
              where = articleListWhere(input),
              orderBy = articleListOrder(input);
            const expected = (
              await prisma.article.findMany({
                where,
                orderBy,
                select: { id: true },
              })
            ).map((r) => r.id);
            const actual = [];
            let cursor;
            do {
              const rows = await findArticleListRows(prisma, {
                where,
                orderBy,
                take: 128,
                cursor: cursor ? { id: cursor } : undefined,
              });
              const next = rows.length > 127 ? rows.pop().id : undefined;
              actual.push(...rows.map((r) => r.id));
              cursor = next;
            } while (cursor);
            assert.deepEqual(actual, expected, JSON.stringify(input));
            assert.equal(new Set(actual).size, actual.length);
          }
      const summaryRounds = { legacy: [], candidate: [] };
      for (let i = 0; i < samples; i++)
        for (const mode of i % 2
          ? ['candidate', 'legacy']
          : ['legacy', 'candidate']) {
          queries.length = 0;
          const start = performance.now();
          let result;
          if (mode === 'candidate')
            result = await summaryFunction.call(
              { prismaService: prisma },
              { input: {} },
            );
          else {
            const [range, readAvailable, likeAvailable, cachedBodies] =
              await prisma.$transaction([
                prisma.article.aggregate({
                  _count: true,
                  _min: { publishTime: true },
                  _max: { publishTime: true },
                }),
                prisma.article.count({ where: { readCount: { not: null } } }),
                prisma.article.count({ where: { likeCount: { not: null } } }),
                prisma.article.count({ where: { contentHtml: { not: null } } }),
              ]);
            result = {
              articles: range._count,
              readAvailable,
              likeAvailable,
              cachedBodies,
              oldestPublishTime: range._min.publishTime,
              newestPublishTime: range._max.publishTime,
            };
          }
          summaryRounds[mode].push({
            ms: performance.now() - start,
            databaseMs: queries.reduce((n, q) => n + q.duration, 0),
            selects: queries.filter((q) => q.query.startsWith('SELECT')).length,
            result,
          });
        }
      assert.deepEqual(
        summaryRounds.candidate[0].result,
        summaryRounds.legacy[0].result,
      );
      const summary = Object.fromEntries(
        Object.entries(summaryRounds).map(([k, v]) => [
          k,
          {
            wall: stats(v.map((r) => r.ms)),
            database: stats(v.map((r) => r.databaseMs)),
            selects: v[0].selects,
          },
        ]),
      );
      const result = {
        scope:
          'same synthetic SQLite file; 9967904 algorithm vs checkout; no metadata reuse or OS-cache flush; alternating execution order',
        count,
        bodyBytes,
        databaseBytes: fs.statSync(db).size,
        rounds,
        summary,
        plans,
      };
      if (process.env.ARTICLE_LIST_BENCHMARK_OUTPUT) {
        const destination = path.resolve(
          process.env.ARTICLE_LIST_BENCHMARK_OUTPUT,
        );
        assert(destination.startsWith(path.resolve('output') + path.sep));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(
          destination,
          JSON.stringify(
            result,
            (_, v) => (typeof v === 'bigint' ? Number(v) : v),
            2,
          ) + '\n',
        );
      }
      console.log(JSON.stringify({ ...result, plans: undefined }));
    } finally {
      await prisma.$disconnect();
      undo();
      require.extensions['.ts'] = oldLoader;
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert(path.basename(root).startsWith('wewe-list-performance-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
