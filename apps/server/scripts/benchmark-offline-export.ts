/** Offline-only benchmark: creates its own SQLite and export tree; no input paths. */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { TrpcRouter } from '../src/trpc/trpc.router';
import { TrpcService } from '../src/trpc/trpc.service';
import * as ts from 'typescript';
import { Module } from 'node:module';

async function main() {
  const mode = process.argv[2];
  if (!mode) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      for (const variant of i % 2 ? ['new', 'old'] : ['old', 'new']) {
        const child = spawnSync(
          process.execPath,
          [...process.execArgv, __filename, variant],
          {
            encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: '' },
            timeout: 120000,
          },
        );
        if (child.status !== 0) throw new Error(child.stderr + child.stdout);
        samples.push(JSON.parse(child.stdout.trim().split('\n').pop()!));
      }
    }
    const percentile = (values: number[], p: number) =>
      values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const summary = Object.fromEntries(
      ['old', 'new'].map((variant) => {
        const rows = samples.filter((x) => x.mode === variant);
        return [
          variant,
          Object.fromEntries(
            [
              'ms',
              'peakRss',
              'peakHeap',
              'temporaryBytes',
              'queries',
              'maxBodyRows',
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
    );
    if (new Set(samples.map((x) => x.contentHash)).size !== 1)
      throw new Error('Export content mismatch');
    console.log(
      JSON.stringify(
        { fixture: { articles: 32, samplesPerVariant: 5 }, summary, samples },
        null,
        2,
      ),
    );
    return;
  }
  const root = await fs.mkdtemp(join(tmpdir(), 'wewe-export-benchmark-'));
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
    for (let i = 0; i < 32; i++)
      await prisma.article.create({
        data: {
          id: 'synthetic-' + i,
          mpId: feedId,
          title: 'Article ' + i,
          picUrl: '',
          publishTime: 1791210060 + i,
          contentHtml:
            '<div id="js_content"><p>' +
            'Synthetic body '.repeat(9363) +
            '</p><img src="data:image/png;base64,' +
            png +
            '"></div>',
          lastBodyStatus: 'available',
        },
      });
    let Router = TrpcRouter;
    if (mode === 'old') {
      const filename = resolve(__dirname, '../src/trpc/trpc.router.ts');
      const source = execFileSync(
        'git',
        [
          'show',
          '33ec7c3ebc20ce55d5f81259a5dd515912b5ca65:apps/server/src/trpc/trpc.router.ts',
        ],
        { encoding: 'utf8', maxBuffer: 4000000 },
      );
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          useDefineForClassFields: false,
        },
      }).outputText;
      const mod = new Module(filename, module) as any;
      mod.filename = filename;
      mod.paths = module.paths;
      mod._compile(compiled, filename);
      Router = mod.exports.TrpcRouter;
    }
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const router = new Router(
      new TrpcService(prisma as any, config, {} as any, {} as any),
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    const folder = join(root, 'archive');
    (global as any).gc?.();
    let peakRss = process.memoryUsage().rss,
      peakHeap = process.memoryUsage().heapUsed;
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      peakRss = Math.max(peakRss, m.rss);
      peakHeap = Math.max(peakHeap, m.heapUsed);
    }, 5);
    const start = performance.now();
    const result = await router.buildOfflineFeedDirectory(feedId, folder);
    const ms = performance.now() - start;
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
    if (result?.complete !== 32) throw new Error('Incomplete synthetic export');
    console.log(
      JSON.stringify({
        mode,
        ms,
        peakRss,
        peakHeap,
        temporaryBytes,
        queries,
        maxBodyRows,
        contentHash: hash.digest('hex'),
      }),
    );
  } finally {
    await prisma.$disconnect();
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
