/** Synthetic directories only; no database or network access. */
import { promises as fs, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { Module } from 'node:module';
import * as ts from 'typescript';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { LocalArticleStore } from '../src/article-local-save';

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
  const sizes = [16, 64, 128];
  const count = Number(process.argv[3] || sizes[0]);
  if (mode && (!['old', 'new'].includes(mode) || !sizes.includes(count)))
    throw new Error('Unsupported bounded store sample');
  const startedAt = new Date().toISOString();
  if (!mode) {
    const rows = [];
    for (const count of sizes)
      for (let pair = 0; pair < 3; pair++)
        for (const variant of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
          const result = spawnSync(
            process.execPath,
            [...process.execArgv, __filename, variant, String(count)],
            {
              encoding: 'utf8',
              timeout: 240000,
              env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'test' },
            },
          );
          if (result.status !== 0)
            throw new Error(result.stderr + result.stdout);
          rows.push(
            ...JSON.parse(result.stdout.trim()).map((row: object) => ({
              pair,
              ...row,
            })),
          );
        }
    const percentile = (v: number[], p: number) =>
      v.sort((a, b) => a - b)[Math.ceil(v.length * p) - 1];
    const summary = Object.fromEntries(
      sizes.map((count) => [
        count,
        Object.fromEntries(
          ['first', 'all-skipped', 'few-new'].map((phase) => [
            phase,
            Object.fromEntries(
              ['old', 'new'].map((mode) => {
                const items = rows.filter(
                  (row) =>
                    row.count === count &&
                    row.phase === phase &&
                    row.mode === mode,
                );
                return [
                  mode,
                  Object.fromEntries(
                    [
                      'ms',
                      'rootScans',
                      'peakRss',
                      'peakHeap',
                      'stageBytes',
                      'mediaComputations',
                      'peakRssDelta',
                      'peakHeapDelta',
                    ].map((key) => [
                      key,
                      {
                        p50: percentile(
                          items.map((x) => x[key]),
                          0.5,
                        ),
                        p95: percentile(
                          items.map((x) => x[key]),
                          0.95,
                        ),
                      },
                    ]),
                  ),
                ];
              }),
            ),
          ]),
        ),
      ]),
    );
    for (const count of sizes)
      for (const phase of ['first', 'all-skipped', 'few-new'])
        if (
          new Set(
            rows
              .filter((x) => x.count === count && x.phase === phase)
              .map((x) => x.contentHash),
          ).size !== 1
        )
          throw new Error('Content mismatch');
    console.log(
      JSON.stringify(
        {
          baseline,
          startedAt,
          finishedAt: new Date().toISOString(),
          fixture: {
            sizes,
            feeds: 8,
            textBytes: 32768,
            fewNew: 2,
            samplesPerVariant: 3,
            scope: 'store only; no DB or HTTP',
          },
          summary,
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }
  const root = await fs.mkdtemp(join(tmpdir(), 'wewe-incremental-adaptation-'));
  try {
    const deployed = mode === 'old' ? deployedModules() : undefined;
    const Store = deployed
      ? deployed('article-local-save.ts').LocalArticleStore
      : (await import('../src/article-local-save')).LocalArticleStore;
    const prepare = deployed
      ? deployed('cached-article-local-export.ts')
          .prepareCachedArticleLocalExport
      : (await import('../src/cached-article-local-export'))
          .prepareCachedArticleLocalExport;
    const cachedArticleMediaAnalysisStats =
      mode === 'old'
        ? () => ({ computations: 0 })
        : (await import('../src/cached-article-media-analysis'))
            .cachedArticleMediaAnalysisStats;
    const sourceHash =
      mode === 'old'
        ? baseline
        : createHash('sha256')
            .update(
              (
                await Promise.all(
                  [
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
    global.fetch = async () => {
      throw new Error('NO_NETWORK');
    };
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
    const article = (n: number) => ({
      id: 'synthetic-' + n,
      title: 'Article ' + n,
      sourceUrl: null,
      publishTime: 1791210060,
      metrics: null,
      lastBodyStatus: 'available',
      contentHtml:
        `<div id="js_content"><p>${n}:` +
        'x'.repeat(32768) +
        `</p><img src="data:image/png;base64,${png}"></div>`,
    });
    const source = (n: number) => ({
      feedId: 'MP_WXS_' + (1234567890 + (n % 8)),
      feedName: 'Publisher ' + (n % 8),
      groupId: 'g' + (n % 2),
      groupName: 'Group ' + (n % 2),
    });
    const rows = [];
    // Diagnostic CJS helper is intentionally opt-in and outside runtime code.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const profiler = require('./export-stage-profiler.cjs').exportStageProfiler(
      Store,
    );
    const readdir = fs.readdir;
    const opendir = fs.opendir;
    let rootScans = 0;
    // Count top-level discovery separately from receipt/image directory validation.
    (fs as any).readdir = (directory: string, ...args: any[]) => {
      if (directory === root) rootScans++;
      return (readdir as any)(directory, ...args);
    };
    (fs as any).opendir = (directory: string, ...args: any[]) => {
      if (directory === root) rootScans++;
      return (opendir as any)(directory, ...args);
    };
    try {
      const store = new Store(join(root, 'settings.json'), root);
      for (const phase of ['first', 'all-skipped', 'few-new']) {
        if (phase === 'all-skipped')
          for (let n = 0; n < count; n++)
            await store.save(prepare(article(n), source(n)));
        rootScans = 0;
        const before = cachedArticleMediaAnalysisStats();
        (global as any).gc?.();
        const memoryBefore = process.memoryUsage();
        let peakRss = process.memoryUsage().rss,
          peakHeap = process.memoryUsage().heapUsed;
        const timer = setInterval(() => {
          const usage = process.memoryUsage();
          peakRss = Math.max(peakRss, usage.rss);
          peakHeap = Math.max(peakHeap, usage.heapUsed);
        }, 5);
        profiler.start();
        const start = performance.now();
        const statuses: string[] = [];
        const total = phase === 'few-new' ? count + 2 : count;
        const run = async (
          active: LocalArticleStore,
          offset = 0,
          end = total,
        ) => {
          for (let n = offset; n < end; n++)
            statuses.push(
              (await active.save(prepare(article(n), source(n)))).status!,
            );
        };
        // PR71 already has retained batches: the comparison must exercise that
        // actual path, not artificially force its old single-save fallback.
        if (mode === 'old' && baseline.startsWith('8a3141c')) await run(store);
        else
          for (let offset = 0; offset < total; offset += 64) {
            const end = Math.min(offset + 64, total);
            await store.withRetainedBatch(
              Array.from({ length: end - offset }, (_, i) => {
                const n = offset + i;
                return {
                  articleId: 'synthetic-' + n,
                  title: 'Article ' + n,
                  imageCount: 0,
                  exportSource: source(n),
                };
              }),
              root,
              (active: LocalArticleStore) => run(active, offset, end),
            );
          }
        const ms = performance.now() - start;
        const stages = profiler.finish();
        clearInterval(timer);
        const expectedStatuses =
          phase === 'first'
            ? Array(count).fill('new')
            : phase === 'all-skipped'
              ? Array(count).fill('skipped')
              : [...Array(count).fill('skipped'), 'new', 'new'];
        if (JSON.stringify(statuses) !== JSON.stringify(expectedStatuses))
          throw new Error('Unexpected export status: ' + phase);
        const after = cachedArticleMediaAnalysisStats();
        const hash = createHash('sha256');
        let stageBytes = 0;
        async function walk(directory: string) {
          for (const name of (await readdir(directory)).sort()) {
            const file = join(directory, name);
            const stat = await fs.stat(file);
            if (stat.isDirectory()) await walk(file);
            else {
              const bytes = await fs.readFile(file);
              stageBytes += bytes.length;
              if (name.endsWith('.md') || name.endsWith('.png'))
                hash.update(name).update(bytes);
            }
          }
        }
        await walk(root);
        rows.push({
          mode,
          count,
          node: process.version,
          sourceHash,
          baselineRss: memoryBefore.rss,
          baselineHeap: memoryBefore.heapUsed,
          peakRssDelta: Math.max(0, peakRss - memoryBefore.rss),
          peakHeapDelta: Math.max(0, peakHeap - memoryBefore.heapUsed),
          phase,
          ms,
          rootScans,
          stages,
          peakRss,
          peakHeap,
          stageBytes,
          bodyReads: 0,
          mediaComputations:
            mode === 'old' ? null : after.computations - before.computations,
          statuses,
          contentHash: hash.digest('hex'),
        });
      }
      const progress = resolve(__dirname, '../../../output');
      await fs.mkdir(progress, { recursive: true });
      await fs.appendFile(
        join(progress, 'incremental-export-adaptation-progress.private.jsonl'),
        JSON.stringify({ mode, count, at: new Date().toISOString(), rows }) +
          '\n',
      );
      console.log(JSON.stringify(rows));
    } finally {
      (fs as any).readdir = readdir;
      (fs as any).opendir = opendir;
    }
  } finally {
    validTemporaryRoot(root, 'wewe-incremental-adaptation-');
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
