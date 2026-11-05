/** Offline-only benchmark: creates its own SQLite and export tree; no input paths. */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { promises as fs, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as ts from 'typescript';
import { Module } from 'node:module';

const baseline =
  process.env.EXPORT_BENCHMARK_BASELINE ||
  '8a3141c43b1b09e92ebd75780f26c58939557906';
if (
  ![
    '8a3141c43b1b09e92ebd75780f26c58939557906',
    '4862fd3a7d7a11a20e783454c7ecd317d7060237',
  ].includes(baseline)
)
  throw new Error('Unsupported reviewed baseline');
/** Pin the full local import graph, including ArticleDownloadError, to deployed source. */
function deployedModules() {
  const cache = new Map<string, any>();
  const root = resolve(__dirname, '../../..');
  const load = (filename: string): any => {
    if (cache.has(filename)) return cache.get(filename).exports;
    const repositoryPath = relative(root, filename).replace(/\\/g, '/');
    const source = execFileSync(
      'git',
      ['show', `${baseline}:${repositoryPath}`],
      {
        encoding: 'utf8',
        maxBuffer: 4000000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const mod = new Module(filename, module) as any;
    cache.set(filename, mod);
    mod.filename = filename;
    mod.paths = (Module as any)._nodeModulePaths(dirname(filename));
    const native = mod.require.bind(mod);
    mod.require = (request: string) => {
      const target = request.startsWith('@server/')
        ? resolve(root, 'apps/server/src', request.slice(8))
        : request.startsWith('.')
          ? resolve(dirname(filename), request)
          : undefined;
      if (
        target &&
        relative(resolve(root, 'apps/server/src'), target).split(sep)[0] !==
          '..'
      ) {
        const candidate = [
          target,
          target + '.ts',
          target + '.js',
          target + '.json',
          join(target, 'index.ts'),
        ].find((file) => existsSync(file) && !statSync(file).isDirectory());
        if (!candidate)
          throw new Error('Missing deployed local module: ' + request);
        return load(candidate);
      }
      return native(request);
    };
    if (filename.endsWith('.json')) mod.exports = JSON.parse(source);
    else
      mod._compile(
        ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            useDefineForClassFields: false,
          },
        }).outputText,
        filename,
      );
    return mod.exports;
  };
  return (file: string) => load(resolve(__dirname, '../src', file));
}
function validTemporaryRoot(root: string, prefix: string) {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith(prefix)
  )
    throw new Error('Refusing cleanup outside owned temporary root');
}
async function main() {
  const mode = process.argv[2];
  const sizes = [32, 128, 512];
  const count = Number(process.argv[3] || sizes[0]);
  if (mode && (!['old', 'new'].includes(mode) || !sizes.includes(count)))
    throw new Error('Unsupported bounded sample');
  if (!mode) {
    const samples = [];
    const startedAt = new Date().toISOString();
    for (const count of sizes)
      for (let pair = 0; pair < 3; pair++)
        for (const variant of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
          const child = spawnSync(
            process.execPath,
            [...process.execArgv, __filename, variant, String(count)],
            {
              encoding: 'utf8',
              env: { ...process.env, DATABASE_URL: '' },
              timeout: 240000,
            },
          );
          if (child.status !== 0) throw new Error(child.stderr + child.stdout);
          samples.push({
            pair,
            ...JSON.parse(child.stdout.trim().split('\n').pop()!),
          });
        }
    const percentile = (values: number[], p: number) =>
      values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const summary = Object.fromEntries(
      sizes.map((count) => [
        count,
        Object.fromEntries(
          ['old', 'new'].map((variant) => {
            const rows = samples.filter(
              (x) => x.mode === variant && x.count === count,
            );
            return [
              variant,
              Object.fromEntries(
                [
                  'ms',
                  'peakRss',
                  'peakHeap',
                  'temporaryBytes',
                  'databaseBytes',
                  'queries',
                  'maxBodyRows',
                  'peakRssDelta',
                  'peakHeapDelta',
                ].map((key) => [
                  key,
                  {
                    p50: percentile(
                      rows.map((x) => x[key]),
                      0.5,
                    ),
                    p95: percentile(
                      rows.map((x) => x[key]),
                      0.95,
                    ),
                  },
                ]),
              ),
            ];
          }),
        ),
      ]),
    );
    for (const count of sizes)
      if (
        new Set(
          samples.filter((x) => x.count === count).map((x) => x.contentHash),
        ).size !== 1
      )
        throw new Error('Content mismatch at ' + count);
    console.log(
      JSON.stringify(
        {
          baseline,
          startedAt,
          finishedAt: new Date().toISOString(),
          fixture: {
            sizes,
            textBytes: 32768,
            samplesPerVariant: 3,
            scope: 'directory staging only; no ZIP/HTTP',
          },
          summary,
          samples,
        },
        null,
        2,
      ),
    );
    return;
  }
  const root = await fs.mkdtemp(join(tmpdir(), 'wewe-export-adaptation-'));
  try {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL:
        'file:' +
        join(root, 'synthetic.db').replace(/\\/g, '/') +
        '?connection_limit=1',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
      WECHAT2RSS_CACHE_SYNC: '0',
      WECHAT2RSS_ACTIVE_SCHEDULE: '0',
      DISABLE_SCHEDULED_UPDATES: '1',
    });
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' +
            join(root, 'synthetic.db').replace(/\\/g, '/') +
            '?connection_limit=1',
        },
      },
    });
    global.fetch = async () => {
      throw new Error('NO_NETWORK');
    };
    let queries = 0,
      maxBodyRows = 0;
    prisma.$use(async (params, next) => {
      const result = await next(params);
      if (params.model === 'Article' && params.action === 'findMany') {
        queries++;
        if (params.args.select.contentHtml)
          maxBodyRows = Math.max(maxBodyRows, result.length);
      }
      return result;
    });
    try {
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
          await prisma.$executeRawUnsafe(statement);
      }
      const feedId = 'MP_WXS_1234567890';
      await prisma.feed.create({
        data: {
          id: feedId,
          mpName: 'Synthetic',
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
        },
      });
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
      for (let i = 0; i < count; i++)
        await prisma.article.create({
          data: {
            id: 'synthetic-' + i,
            mpId: feedId,
            title: 'Article ' + i,
            picUrl: '',
            publishTime: 1791210060 + i,
            contentHtml:
              '<div id="js_content"><p>' +
              'x'.repeat(32768) +
              '</p><img src="data:image/png;base64,' +
              png +
              '"></div>',
            lastBodyStatus: 'available',
          },
        });
      const deployed = mode === 'old' ? deployedModules() : undefined;
      const Router = deployed
        ? deployed('trpc/trpc.router.ts').TrpcRouter
        : (await import('../src/trpc/trpc.router')).TrpcRouter;
      const Service = deployed
        ? deployed('trpc/trpc.service.ts').TrpcService
        : (await import('../src/trpc/trpc.service')).TrpcService;
      const config = new ConfigService({
        auth: { code: 'fixture' },
        platform: { url: '' },
        feed: { updateDelayTime: 0 },
      });
      const router = new Router(
        new Service(prisma as any, config, {} as any, {} as any),
        prisma as any,
        config,
        {} as any,
        {} as any,
      );
      const CurrentStore =
        process.env.EXPORT_STAGE_PROFILE === '1'
          ? (await import('../src/article-local-save')).LocalArticleStore
          : undefined;
      // Diagnostic CJS helper is intentionally opt-in and outside runtime code.
      const profiler =
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./export-stage-profiler.cjs').exportStageProfiler(
          CurrentStore,
        );
      const folder = join(root, 'archive');
      const sourceHash =
        mode === 'old'
          ? baseline
          : createHash('sha256')
              .update(
                (
                  await Promise.all(
                    [
                      'trpc/trpc.router.ts',
                      'article-local-save.ts',
                      'cached-article-local-export.ts',
                      'cached-article-media-analysis.ts',
                    ].map((file) =>
                      fs.readFile(resolve(__dirname, '../src', file)),
                    ),
                  )
                )
                  .map((bytes) => bytes.toString('utf8'))
                  .join('\0'),
              )
              .digest('hex');
      (global as any).gc?.();
      const memoryBefore = process.memoryUsage();
      let peakRss = process.memoryUsage().rss,
        peakHeap = process.memoryUsage().heapUsed;
      const timer = setInterval(() => {
        const m = process.memoryUsage();
        peakRss = Math.max(peakRss, m.rss);
        peakHeap = Math.max(peakHeap, m.heapUsed);
      }, 5);
      profiler.start();
      const start = performance.now();
      const result = await router.buildOfflineFeedDirectory(feedId, folder);
      const ms = performance.now() - start;
      const stages = profiler.finish();
      clearInterval(timer);
      const hash = createHash('sha256');
      let temporaryBytes = 0;
      async function walk(directory: string) {
        for (const name of (await fs.readdir(directory)).sort()) {
          const file = join(directory, name),
            stat = await fs.stat(file);
          if (stat.isDirectory()) await walk(file);
          else {
            const data = await fs.readFile(file);
            temporaryBytes += data.length;
            if (name.endsWith('.md') || name.endsWith('.png'))
              hash.update(name).update(data);
          }
        }
      }
      await walk(folder);
      if (result?.complete !== count)
        throw new Error('Incomplete synthetic export');
      const sample = {
        mode,
        count,
        node: process.version,
        sourceHash,
        baselineRss: memoryBefore.rss,
        baselineHeap: memoryBefore.heapUsed,
        peakRssDelta: Math.max(0, peakRss - memoryBefore.rss),
        peakHeapDelta: Math.max(0, peakHeap - memoryBefore.heapUsed),
        databaseBytes: (await fs.stat(join(root, 'synthetic.db'))).size,
        ms,
        peakRss,
        peakHeap,
        temporaryBytes,
        queries,
        maxBodyRows,
        stages,
        contentHash: hash.digest('hex'),
      };
      const progress = resolve(__dirname, '../../../output');
      await fs.mkdir(progress, { recursive: true });
      await fs.appendFile(
        join(progress, 'zip-export-adaptation-progress.private.jsonl'),
        JSON.stringify(sample) + '\n',
      );
      console.log(JSON.stringify(sample));
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    validTemporaryRoot(root, 'wewe-export-adaptation-');
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
