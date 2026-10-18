/** Synthetic directories only; no database or network access. */
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { Module } from 'node:module';
import * as ts from 'typescript';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { LocalArticleStore } from '../src/article-local-save';
import { prepareCachedArticleLocalExport } from '../src/cached-article-local-export';
import { cachedArticleMediaAnalysisStats } from '../src/cached-article-media-analysis';

function legacy(file: string) {
  const filename = resolve(__dirname, '../src', file);
  const source = execFileSync(
    'git',
    [
      'show',
      `33ec7c3ebc20ce55d5f81259a5dd515912b5ca65:apps/server/src/${file}`,
    ],
    { encoding: 'utf8', maxBuffer: 4000000 },
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
  }).outputText;
  const mod = new Module(filename, module) as any;
  mod.filename = filename;
  mod.paths = module.paths;
  mod._compile(compiled, filename);
  return mod.exports;
}
async function main() {
  const mode = process.argv[2];
  const scale = process.env.EXPORT_BENCHMARK_SCALE === '200' ? 200 : 4;
  const samples = scale === 200 ? 3 : 5;
  const startedAt = new Date().toISOString();
  if (!mode) {
    const rows = [];
    // Isolate process peaks/cache state between implementations, alternate order by run.
    for (let pair = 0; pair < samples; pair++)
      for (const variant of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
        const result = spawnSync(
          process.execPath,
          [...process.execArgv, __filename, variant],
          { encoding: 'utf8', timeout: scale === 200 ? 180000 : 120000 },
        );
        if (result.status !== 0) throw new Error(result.stderr + result.stdout);
        rows.push(
          ...JSON.parse(result.stdout.trim()).map((row: object) => ({
            pair,
            ...row,
          })),
        );
      }
    const percentile = (values: number[], p: number) =>
      values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const summary = Object.fromEntries(
      ['first', 'all-skipped', 'few-new'].map((phase) => [
        phase,
        Object.fromEntries(
          ['old', 'new'].map((variant) => {
            const items = rows.filter(
              (row) => row.phase === phase && row.mode === variant,
            );
            return [
              variant,
              Object.fromEntries(
                [
                  'ms',
                  'rootScans',
                  'peakRss',
                  'peakHeap',
                  'stageBytes',
                  'mediaComputations',
                ].map((key) => [
                  key,
                  {
                    p50: percentile(
                      items.map((row) => row[key]),
                      0.5,
                    ),
                    p95: percentile(
                      items.map((row) => row[key]),
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
    for (const phase of ['first', 'all-skipped', 'few-new'])
      if (
        new Set(
          rows
            .filter((row) => row.phase === phase)
            .map((row) => row.contentHash),
        ).size !== 1
      )
        throw new Error('Content mismatch: ' + phase);
    console.log(
      JSON.stringify(
        {
          startedAt,
          finishedAt: new Date().toISOString(),
          fixture: {
            feeds: scale,
            articles: 12,
            textBytesPerArticle: 32768,
            fewNew: 2,
            samplesPerVariant: samples,
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
  const root = await fs.mkdtemp(join(tmpdir(), 'wewe-incremental-benchmark-'));
  const Store =
    mode === 'old'
      ? legacy('article-local-save.ts').LocalArticleStore
      : LocalArticleStore;
  const prepare =
    mode === 'old'
      ? legacy('cached-article-local-export.ts').prepareCachedArticleLocalExport
      : prepareCachedArticleLocalExport;
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
      'Synthetic '.repeat(3277) +
      `</p><img src="data:image/png;base64,${png}"></div>`,
  });
  const source = (n: number) => ({
    feedId: 'MP_WXS_' + (1234567890 + (n % 4)),
    feedName: 'Publisher ' + (n % 4),
    groupId: 'g' + (n % 2),
    groupName: 'Group ' + (n % 2),
  });
  const rows = [];
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
    if (scale === 200) {
      const group = join(root, 'Empty publishers');
      await fs.mkdir(group);
      await fs.writeFile(
        join(group, '.wewe-source.json'),
        JSON.stringify({ identity: 'empty-group' }),
      );
      for (let i = 0; i < 196; i++) {
        const directory = join(group, 'Publisher ' + i);
        await fs.mkdir(directory);
        await fs.writeFile(
          join(directory, '.wewe-source.json'),
          JSON.stringify({ identity: 'MP_WXS_' + (9000000000 + i) }),
        );
      }
    }
    const store = new Store(join(root, 'settings.json'), root);
    for (const phase of ['first', 'all-skipped', 'few-new']) {
      if (phase === 'all-skipped')
        for (let n = 0; n < 12; n++)
          await store.save(prepare(article(n), source(n)));
      rootScans = 0;
      const before = cachedArticleMediaAnalysisStats();
      (global as any).gc?.();
      let peakRss = process.memoryUsage().rss,
        peakHeap = process.memoryUsage().heapUsed;
      const timer = setInterval(() => {
        const usage = process.memoryUsage();
        peakRss = Math.max(peakRss, usage.rss);
        peakHeap = Math.max(peakHeap, usage.heapUsed);
      }, 5);
      const start = performance.now();
      const statuses: string[] = [];
      const count = phase === 'few-new' ? 14 : 12;
      const run = async (active: LocalArticleStore) => {
        for (let n = 0; n < count; n++)
          statuses.push(
            (await active.save(prepare(article(n), source(n)))).status!,
          );
      };
      if (mode === 'old') await run(store);
      else
        await store.withRetainedBatch(
          Array.from({ length: count }, (_, n) => ({
            articleId: 'synthetic-' + n,
            title: 'Article ' + n,
            imageCount: 0,
            exportSource: source(n),
          })),
          root,
          run,
        );
      const ms = performance.now() - start;
      clearInterval(timer);
      const expectedStatuses =
        phase === 'first'
          ? Array(12).fill('new')
          : phase === 'all-skipped'
            ? Array(12).fill('skipped')
            : [...Array(12).fill('skipped'), 'new', 'new'];
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
        phase,
        ms,
        rootScans,
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
      join(progress, 'incremental-export-scoped-progress.private.jsonl'),
      JSON.stringify({ mode, scale, at: new Date().toISOString(), rows }) +
        '\n',
    );
    console.log(JSON.stringify(rows));
  } finally {
    (fs as any).readdir = readdir;
    (fs as any).opendir = opendir;
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
