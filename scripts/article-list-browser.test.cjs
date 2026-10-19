'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');
const server = path.resolve('apps/server');
const ts = require(require.resolve('typescript', { paths: [server] }));
const epoch = () => performance.timeOrigin + performance.now();
test(
  'actual list/provider over local HTTP: summary cannot hold rows, pagination is fenced and failures stay visible',
  { skip: !browser, timeout: 240000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-article-http-'));
    const url =
      'file:' + path.join(root, 'synthetic.sqlite').replaceAll('\\', '/');
    const previousUrl = process.env.DATABASE_URL;
    // Relative URL deliberately bypasses lightweight page reuse for every request.
    process.env.DATABASE_URL = url;
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
        '@server/*': ['apps/server/src/*'],
        '@wewe-rss/shared': ['packages/shared/src/index.ts'],
      },
    });
    let prisma, release;
    try {
      const { PrismaClient } = require(
        require.resolve('@prisma/client', { paths: [server] }),
      );
      const { ConfigService } = require(
        require.resolve('@nestjs/config', { paths: [server] }),
      );
      const {
        TrpcService,
      } = require('../apps/server/src/trpc/trpc.service.ts');
      const { TrpcRouter } = require('../apps/server/src/trpc/trpc.router.ts');
      const { createExpressMiddleware } = require(
        require.resolve('@trpc/server/adapters/express', { paths: [server] }),
      );
      const express = require(require.resolve('express', { paths: [server] }));
      prisma = new PrismaClient({
        datasources: { db: { url } },
        log: [{ emit: 'event', level: 'query' }],
      });
      process.env.DATABASE_URL = 'file:synthetic-relative-cache-bypass.sqlite';
      const sql = [];
      prisma.$on('query', (e) =>
        sql.push({ sql: e.query, duration: e.duration }),
      );
      for (const migration of fs
        .readdirSync(path.join(server, 'prisma/migrations'))
        .filter((n) => /^\d/.test(n))
        .sort())
        for (const statement of fs
          .readFileSync(
            path.join(server, 'prisma/migrations', migration, 'migration.sql'),
            'utf8',
          )
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean))
          await prisma.$executeRawUnsafe(statement);
      await prisma.managementGroup.create({
        data: { id: 'group-a', name: 'Synthetic folder', platform: 'wechat' },
      });
      const feedCount = Number(process.env.ARTICLE_LIST_BENCHMARK_FEEDS || 6);
      assert(
        Number.isSafeInteger(feedCount) && feedCount >= 6 && feedCount <= 300,
      );
      for (let i = 0; i < feedCount; i++)
        await prisma.feed.create({
          data: {
            id: 'f' + i,
            mpName: 'Publisher ' + i,
            mpCover: '',
            mpIntro: '',
            updateTime: 0,
            groupId: i < feedCount / 2 ? 'group-a' : null,
          },
        });
      const count = Number(process.env.ARTICLE_LIST_BENCHMARK_ROWS || 1800);
      assert(Number.isSafeInteger(count) && count >= 120 && count <= 12000);
      await prisma.$executeRawUnsafe(
        `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1 < ?)
   INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html,read_count,like_count,created_at)
   SELECT 'article-'||printf('%06d',x),'f'||(x%?),'Synthetic '||x,'',1700000000+CAST(x/3 AS INTEGER),
   CASE WHEN x%7=0 THEN NULL WHEN x%7=1 THEN '' WHEN x%7=2 THEN ' ' ELSE '<p>'||replace(hex(zeroblob(32768)),'00','x')||'</p>' END,x%99,x%17,CURRENT_TIMESTAMP FROM n`,
        count,
        feedCount,
      );
      const config = new ConfigService({
        auth: { code: 'synthetic' },
        platform: { url: '' },
        feed: { updateDelayTime: 0 },
      });
      const service = new TrpcService(prisma, config, {}, {});
      const router = new TrpcRouter(service, prisma, config, {}, {}).appRouter;
      const application = express();
      const requests = [];
      let phase = 'summary-held',
        failNext = false,
        holdNext = 0;
      let held = false;
      const latch = new Promise((resolve) => {
        release = resolve;
      });
      const summaryMiddlewares =
        router._def.procedures['article.summary']._def.middlewares;
      summaryMiddlewares.splice(
        summaryMiddlewares.length - 1,
        0,
        async ({ next }) => {
          if (!held) {
            held = true;
            await latch;
          }
          return next();
        },
      );
      application.use(
        '/trpc',
        (req, res, next) => {
          const record = {
            phase,
            procedures: req.url.split('?')[0],
            start: epoch(),
            sqlStart: sql.length,
          };
          requests.push(record);
          assert.equal(req.method, 'GET');
          assert.equal(req.headers.authorization, 'synthetic');
          res.once('finish', () => {
            record.ms = epoch() - record.start;
            record.status = res.statusCode;
            record.databaseMs = sql
              .slice(record.sqlStart)
              .reduce((s, e) => s + e.duration, 0);
          });
          if (req.url.includes('article.list') && failNext) {
            failNext = false;
            res
              .status(503)
              .json({ error: { message: 'Synthetic list unavailable' } });
            return;
          }
          if (req.url.includes('article.list') && holdNext) {
            const delay = holdNext;
            holdNext = 0;
            setTimeout(next, delay);
          } else next();
        },
        createExpressMiddleware({
          router,
          createContext: () => ({ errorMsg: null, isLocal: true }),
        }),
      );
      const env = path.join(root, 'env.ts');
      fs.writeFileSync(
        env,
        "export const serverOriginUrl=window.location.origin;export const enabledAuthCode=true;export const privateOnlineMode=false;export const acceptanceMode=false;export const appVersion='synthetic';export const isProd=false;",
      );
      let listFile = path.join(web, 'src/pages/feeds/list.tsx');
      let providerFile = path.join(web, 'src/provider/trpc.tsx');
      const baseline = process.env.READING_BASELINE_SHA;
      if (baseline) {
        assert(/^[a-f0-9]{40}$/.test(baseline));
        const { execFileSync } = require('node:child_process');
        listFile = path.join(root, 'baseline-list.tsx');
        providerFile = path.join(root, 'baseline-provider.tsx');
        for (const [target, file] of [
          [listFile, 'apps/web/src/pages/feeds/list.tsx'],
          [providerFile, 'apps/web/src/provider/trpc.tsx'],
        ])
          fs.writeFileSync(
            target,
            execFileSync('git', ['show', baseline + ':' + file]),
          );
      }
      const source = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route,useNavigate} from 'react-router-dom';
import {TrpcProvider} from ${modulePath(providerFile)};
import {useQueryClient} from '@tanstack/react-query';
import {trpc} from ${modulePath(path.join(web, 'src/utils/trpc.ts'))};
import ArticleList from ${modulePath(listFile)};
import ${modulePath(path.join(web, 'src/index.css'))};
localStorage.setItem('authCode','synthetic');
document.addEventListener('load',(e)=>{if(e.target instanceof HTMLIFrameElement && e.target.src.startsWith('blob:'))window.readerLoaded=performance.now()},true);
function App(){const [filter,setFilter]=useState({}),[search,setSearch]=useState(''),[sort,setSort]=useState('publishTime'),[direction,setDirection]=useState('desc'),[selected,setSelected]=useState(new Set());const utils=trpc.useUtils();const queryClient=useQueryClient();const navigate=useNavigate();
window.fixture={pending:()=>queryClient.isFetching({queryKey:[['article','list']]}),setFilter,setSearch,setDirection,navigate,selected:()=>[...selected],refresh:()=>{window.dispatchEvent(new Event('wewe-articles-refresh'));return utils.article.list.invalidate();},fresh:()=>utils.article.list.reset()};
return <div className="app-shell"><div className="app-route"><div className="feed-workspace"><div className="mac-content feed-content !min-w-0 !overflow-y-auto"><header className="shrink-0 p-4">文章列表</header><div className="feed-article-scroll flex-1 overflow-hidden"><ArticleList search={search} articleFilter={filter} sort={sort} onSortChange={setSort} direction={direction} onDirectionChange={setDirection} selectedIds={selected} onSelectionChange={setSelected}/></div></div></div></div></div>}
createRoot(document.getElementById('root')).render(<BrowserRouter><TrpcProvider><Routes><Route path='/*' element={<App/>}/></Routes></TrpcProvider></BrowserRouter>);`;
      const measurements = [];
      await withFixture(
        source,
        async ({ evaluate, send, pause }) => {
          await send('Performance.enable');
          const rows = () =>
            evaluate(
              "Array.from(document.querySelectorAll('[data-article-id]'),e=>e.dataset.articleId)",
            );
          const until = async (condition, message, limit = 5000) => {
            for (let t = 0; t < limit; t += 25) {
              if (await condition()) return;
              await pause(25);
            }
            assert.fail(message);
          };
          const measurementOnly =
            process.env.ARTICLE_LIST_MEASUREMENT_ONLY === 'true';
          const clickMore = (times = 1) =>
            evaluate(
              `(()=>{const button=Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='加载更多');for(let i=0;i<${times};i++)button.click()})()`,
            );
          if (measurementOnly) {
            release();
            await until(
              async () =>
                (await rows()).length === 20 && requests.every((r) => r.status),
              'baseline initial request settled',
            );
          }
          if (!measurementOnly) {
            try {
              await until(() => held, 'summary request arrived');
              await until(
                async () => (await rows()).length === 20,
                'first rows must render while summary remains held',
                2500,
              );
            } finally {
              release();
            }
            assert(
              requests.some(
                (r) =>
                  r.procedures.includes('article.list') && r.status === 200,
              ),
            );
            assert(
              !requests.some(
                (r) =>
                  r.procedures.includes('article.list') &&
                  r.procedures.includes('summary'),
              ),
            );
            await until(
              () => requests.every((r) => r.status),
              'summary acknowledgement',
            );
            const initial = await rows();
            assert.equal(new Set(initial).size, 20);
            await evaluate(
              'document.querySelector(\'[aria-label^="选择文章："]\').click()',
            );
            const selected = await evaluate('window.fixture.selected()');
            assert.equal(selected.length, 1);
            phase = 'rapid-next';
            holdNext = 150;
            const before = requests.length;
            await clickMore(2);
            await until(
              async () => (await rows()).length === 40,
              'one next page',
            );
            assert.equal(
              requests
                .slice(before)
                .filter((r) => r.procedures.includes('article.list')).length,
              1,
            );
            assert.deepEqual((await rows()).slice(0, 20), initial);
            assert.equal(new Set(await rows()).size, 40);
            assert.deepEqual(
              await evaluate('window.fixture.selected()'),
              selected,
            );
            phase = 'reload-two-pages';
            await send('Page.reload');
            await until(
              async () => (await rows()).length === 40,
              'restore exactly two pages',
            );
            assert.equal(new Set(await rows()).size, 40);
            phase = 'refresh-two-pages';
            const first = await rows();
            await evaluate('window.fixture.refresh()');
            assert.deepEqual(await rows(), first);
            // Use the reading pane's real flex/scroll classes, including narrow
            // and short screens; button geometry must be inside the viewport.
            const footer = () =>
              evaluate(
                `(() => {const b=Array.from(document.querySelectorAll('button')).find(e=>/^(加载更多|重试加载|正在加载)/.test(e.textContent.trim()));if(!b)return null;const r=b.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:b.textContent.trim(),disabled:b.disabled,top:r.top,bottom:r.bottom,height:innerHeight,visible:r.width>0&&r.top>=0&&r.bottom<=innerHeight,hit:hit?.closest('button')===b}})()`,
              );
            const bottom = async () => {
              // Scrolling is user intent. The real pane cancels a pending
              // refresh-position restoration on wheel; a bare scrollTop write
              // can otherwise be overwritten by its already scheduled frame.
              await evaluate(
                "(()=>{const e=document.querySelector('.compact-list').parentElement;e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:e.scrollHeight}));e.scrollTop=e.scrollHeight})()",
              );
              await evaluate(
                'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
              );
              const f = await footer();
              assert(
                f?.visible && f?.hit,
                'pagination footer is reachable: ' + JSON.stringify(f),
              );
            };
            phase = 'third-page';
            for (const [width, height] of [
              [1366, 768],
              [390, 844],
              [740, 360],
            ]) {
              await send('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: 1,
                mobile: false,
              });
              await bottom();
            }
            holdNext = 600;
            await clickMore();
            await until(
              async () => (await footer())?.text === '正在加载…',
              'next-page loading is explicit',
            );
            await until(
              async () => (await rows()).length === 60,
              'at least three complete pages',
            );
            const expected = await prisma.article.findMany({
              take: 60,
              orderBy: [{ publishTime: 'desc' }, { id: 'desc' }],
              select: { id: true },
            });
            assert.deepEqual(
              await rows(),
              expected.map((row) => row.id),
              'unseen 21st cursor is included, with no missing/duplicate row',
            );
            phase = 'next-page-failure';
            failNext = true;
            await bottom();
            await clickMore();
            await until(
              async () => (await footer())?.text === '重试加载',
              'failed next page keeps a bottom retry',
            );
            await bottom();
            assert.equal((await rows()).length, 60);
            assert.equal(
              requests.filter(
                (r) =>
                  r.phase === 'next-page-failure' &&
                  r.procedures.includes('article.list'),
              ).length,
              1,
            );
            phase = 'retry-next-page';
            await evaluate(
              "Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='重试加载').click()",
            );
            await until(
              async () => (await rows()).length === 80,
              'retry only the missing page',
            );
            assert.equal(new Set(await rows()).size, 80);
            assert.deepEqual(
              (await rows()).slice(0, 60),
              expected.map((row) => row.id),
            );
            phase = 'folder';
            await evaluate("window.fixture.setFilter({group:'group-a'})");
            await until(
              async () => (await rows()).length === 20,
              'folder page',
            );
            const ids = await rows();
            for (const id of ids) assert(Number(id.slice(8)) % 6 < 3);
            phase = 'ascending-folder';
            await evaluate(
              "(()=>{const e=document.querySelector('[aria-label=\"发布时间顺序\"]');e.value='asc';e.dispatchEvent(new Event('change',{bubbles:true}))})()",
            );
            await until(async () => {
              const page = await rows();
              return page.length === 20 && Number(page[0].slice(8)) < 10;
            }, 'sort change resets to the first page');
            for (const [width, height] of [
              [1366, 768],
              [390, 844],
            ]) {
              await send('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: 1,
                mobile: false,
              });
              await bottom();
            }
            await evaluate("window.fixture.setDirection('desc')");
            phase = 'search';
            await evaluate("window.fixture.setSearch('Synthetic 11')");
            await until(async () => {
              const found = await rows();
              return (
                found.length === 20 &&
                found.every((id) =>
                  Number(id.slice(8)).toString().startsWith('11'),
                )
              );
            }, 'search scope');
            phase = 'date-empty';
            await evaluate(
              "window.fixture.setFilter({dateStart:'2020-01-01',dateEnd:'2020-01-02'})",
            );
            await until(
              async () =>
                requests.some(
                  (r) =>
                    r.phase === 'date-empty' &&
                    r.procedures.includes('article.list') &&
                    r.status === 200,
                ) && (await rows()).length === 0,
              'empty date range',
            );
            phase = 'exhausted-range';
            await evaluate(
              "window.fixture.setFilter({});window.fixture.setSearch('Synthetic 0')",
            );
            await until(
              async () =>
                (await rows()).length === 1 &&
                (await evaluate(
                  "document.body.innerText.includes('已显示当前筛选的全部 1 篇文章')",
                )),
              'only a successful cursor-less range reaches the end',
            );
            assert.equal(
              await evaluate(
                "Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='加载更多')",
              ),
              false,
            );
            phase = 'return-all';
            await evaluate(
              "window.fixture.setFilter({});window.fixture.setSearch('')",
            );
            await until(
              async () =>
                (await rows()).length === 80 && requests.every((r) => r.status),
              'return restores the four previously loaded pages before fault injection',
            );
            await evaluate(
              'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
            );
            await until(
              async () =>
                (await evaluate('window.fixture.pending()')) === 0 &&
                requests.every((r) => r.status),
              'return revalidation settles before failure injection',
            );
            phase = 'read-failure';
            failNext = true;
            await evaluate('void window.fixture.fresh()');
            await until(
              () =>
                evaluate(
                  "Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('文章列表读取失败'))",
                ),
              'explicit list error',
            );
            assert.equal(
              requests.filter(
                (r) =>
                  r.phase === 'read-failure' &&
                  r.procedures.includes('article.list'),
              ).length,
              1,
              'failed reads are not silently replayed',
            );
            phase = 'retry';
            await evaluate(
              "Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='重试').click()",
            );
            await until(
              async () => (await rows()).length === 20,
              'manual retry recovers',
            );
          }
          const samples = Number(process.env.ARTICLE_LIST_BROWSER_SAMPLES || 6);
          assert(
            Number.isSafeInteger(samples) && samples >= 1 && samples <= 30,
          );
          for (let i = 0; i < samples; i++)
            for (const stage of [
              'first',
              'next',
              'return',
              'reader',
              'refresh',
            ]) {
              phase = stage + '-' + i;
              if (stage === 'first') {
                const { identifier } = await send(
                  'Page.addScriptToEvaluateOnNewDocument',
                  { source: 'sessionStorage.clear()' },
                );
                const start = epoch();
                await send('Page.reload');
                await send('Page.removeScriptToEvaluateOnNewDocument', {
                  identifier,
                });
                await until(
                  async () => (await rows()).length === 20,
                  'fresh first page',
                );
                measurements.push({ stage, ms: epoch() - start });
              } else if (stage === 'next') {
                const start = epoch();
                await clickMore();
                await until(
                  async () => (await rows()).length === 40,
                  'next page sample',
                );
                measurements.push({ stage, ms: epoch() - start });
              } else if (stage === 'return') {
                await until(
                  () => requests.every((r) => r.status),
                  'settled before view switch',
                );
                await evaluate("window.fixture.setFilter({group:'group-a'})");
                await until(
                  async () =>
                    (await rows()).length === 20 &&
                    requests.every((r) => r.status),
                  'other filter',
                );
                const before = requests.length;
                const start = epoch();
                await evaluate('window.fixture.setFilter({})');
                await until(
                  async () => (await rows()).length === 40,
                  'return to two cached/restored pages',
                );
                const metrics = await send('Performance.getMetrics');
                measurements.push({
                  stage,
                  ms: epoch() - start,
                  requests: requests
                    .slice(before)
                    .filter((r) => r.procedures.includes('article.list'))
                    .length,
                  heapBytes: metrics.metrics.find(
                    (m) => m.name === 'JSHeapUsedSize',
                  )?.value,
                });
                await evaluate(
                  'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
                );
                await until(
                  async () =>
                    (await evaluate('window.fixture.pending()===0')) &&
                    requests.every((r) => r.status),
                  'return revalidation settles',
                );
                measurements[measurements.length - 1].revalidatedMs =
                  epoch() - start;
                measurements[measurements.length - 1].totalListRequests =
                  requests
                    .slice(before)
                    .filter((r) =>
                      r.procedures.includes('article.list'),
                    ).length;
                await send('HeapProfiler.collectGarbage');
                const retained = await send('Performance.getMetrics');
                measurements[measurements.length - 1].retainedHeapBytes =
                  retained.metrics.find(
                    (m) => m.name === 'JSHeapUsedSize',
                  )?.value;
                measurements[measurements.length - 1].storageBytes =
                  await evaluate(
                    'JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).length*2',
                  );
              } else if (stage === 'reader') {
                for (const warmth of ['first-read', 'warm-read']) {
                  const start = epoch();
                  await evaluate(
                    "window.readerLoaded=0;Array.from(document.querySelectorAll('[data-article-id]')).find(e=>Number(e.dataset.articleId.slice(8))%7>=3).querySelector('a.compact-title').click()",
                  );
                  await until(
                    () => evaluate('Boolean(window.readerLoaded)'),
                    'saved HTML iframe loaded',
                  );
                  measurements.push({ stage: warmth, ms: epoch() - start });
                  await evaluate(
                    `document.querySelector('button[aria-label="Close"]').click()`,
                  );
                  await until(
                    () => evaluate('!document.querySelector("iframe[title]")'),
                    'reader closes',
                  );
                }
              } else {
                const start = epoch();
                await evaluate('window.fixture.refresh()');
                measurements.push({
                  stage,
                  ms: epoch() - start,
                  rows: (await rows()).length,
                });
              }
            }
        },
        {
          '../utils/trpc': path.join(web, 'src/utils/trpc.ts'),
          '../utils/auth': path.join(web, 'src/utils/auth.ts'),
          '../utils/startup-status': path.join(
            web,
            'src/utils/startup-status.ts',
          ),
          '../utils/reading-query-cache': path.join(
            web,
            'src/utils/reading-query-cache.ts',
          ),
          '@trpc/client': path.join(web, 'node_modules/@trpc/client'),
          '@nextui-org/react': path.join(web, 'node_modules/@nextui-org/react'),
          sonner: path.join(web, 'node_modules/sonner'),
          dayjs: path.join(web, 'node_modules/dayjs'),
          'react-router-dom': path.join(web, 'node_modules/react-router-dom'),
          '../utils/env': env,
          '@web/utils/env': env,
          '@web': path.join(web, 'src'),
          '@wewe-rss/shared': path.resolve('packages/shared/src/index.ts'),
        },
        {
          productionStyles: true,
          cleanupOwnedFixture: true,
          handleRequest: (req, res) => {
            if (req.url.startsWith('/trpc/')) {
              application(req, res);
              return true;
            }
            return false;
          },
        },
      );
      assert(
        requests
          .filter((r) => r.procedures.includes('summary'))
          .every((r) => r.status === 200),
        'statistics must succeed, not be replaced by an error',
      );
      const result = {
        scope:
          'actual ArticleList and TrpcProvider; original protected HTTP routes; synthetic 32KiB bodies; no page reuse',
        count,
        feedCount,
        baseline: baseline || null,
        requests: requests.map(({ start, sqlStart, ...r }) => r),
        measurements,
      };
      if (process.env.ARTICLE_LIST_BROWSER_OUTPUT) {
        const destination = path.resolve(
          process.env.ARTICLE_LIST_BROWSER_OUTPUT,
        );
        assert(destination.startsWith(path.resolve('output') + path.sep));
        fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
      }
      console.log(JSON.stringify(result));
    } finally {
      release?.();
      await prisma?.$disconnect();
      undo();
      require.extensions['.ts'] = oldLoader;
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert(path.basename(root).startsWith('wewe-article-http-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
