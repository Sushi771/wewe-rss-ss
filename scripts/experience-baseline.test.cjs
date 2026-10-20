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
  'isolated reading and archive experience baseline',
  { skip: !browser, timeout: 300000 },
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
      const count = 1809;
      assert(Number.isSafeInteger(count) && count >= 120 && count <= 3000);
      await prisma.$executeRawUnsafe(
        `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1 < ?)
   INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html,read_count,like_count,created_at)
   SELECT 'article-'||printf('%06d',x),'f'||(x%?),'Synthetic '||x,'',1700000000+CAST(x/3 AS INTEGER),
   CASE WHEN x%7=0 THEN NULL WHEN x%7=1 THEN '' WHEN x%7=2 THEN ' ' ELSE '<p>'||replace(hex(zeroblob(32768)),'00','x')||'</p>' END,x%99,x%17,CURRENT_TIMESTAMP FROM n`,
        count,
        feedCount,
      );
      const zlib = require('node:zlib');
      const makePng = (seed) => {
        const chunk = (type, data) => {
          const name = Buffer.from(type);
          const n = Buffer.alloc(4);
          n.writeUInt32BE(data.length);
          const crc = Buffer.alloc(4);
          crc.writeUInt32BE(zlib.crc32(Buffer.concat([name, data])));
          return Buffer.concat([n, name, data, crc]);
        };
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(256);
        ihdr.writeUInt32BE(256, 4);
        ihdr[8] = 8;
        ihdr[9] = 2;
        const raw = Buffer.alloc(256 * 769);
        for (let y = 0; y < 256; y++)
          for (let x = 1; x < 769; x++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            raw[y * 769 + x] = seed >>> 24;
          }
        return Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          chunk('IHDR', ihdr),
          chunk('IDAT', zlib.deflateSync(raw)),
          chunk('IEND', Buffer.alloc(0)),
        ]).toString('base64');
      };
      const pngs = Array.from({ length: 24 }, (_, i) => makePng(i + 1));
      const fixtures = [
        {
          id: 'article-001808',
          name: 'long',
          images: 1,
          text: '合成长文内容。'.repeat(32768),
        },
        {
          id: 'article-001807',
          name: 'images',
          images: 24,
          text: '合成多图内容。'.repeat(1000),
        },
      ];
      for (const f of fixtures)
        await prisma.article.update({
          where: { id: f.id },
          data: {
            contentHtml:
              '<div id="js_content"><p>' +
              f.text +
              '</p>' +
              Array.from(
                { length: f.images },
                (_, imageIndex) =>
                  '<img src="data:image/png;base64,' + pngs[imageIndex] + '">',
              ).join('') +
              '</div>',
            lastBodyStatus: 'available',
          },
        });
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
      let listFile = path.join(root, 'observable-list.tsx');
      fs.writeFileSync(
        listFile,
        fs
          .readFileSync(path.join(web, 'src/pages/feeds/list.tsx'), 'utf8')
          .replace('sandbox=""', 'sandbox="allow-same-origin"'),
      );
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
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {useQueryClient} from '@tanstack/react-query';
import {BrowserRouter,Routes,Route,useNavigate} from 'react-router-dom';
import {TrpcProvider} from ${modulePath(providerFile)};
import {trpc} from ${modulePath(path.join(web, 'src/utils/trpc.ts'))};
import ArticleList from ${modulePath(listFile)};
import ${modulePath(path.join(web, 'src/index.css'))};
localStorage.setItem('authCode','synthetic');
document.addEventListener('load',(e)=>{if(e.target instanceof HTMLIFrameElement)window.readerLoaded=performance.now()},true);
function App(){const [filter,setFilter]=useState({}),[search,setSearch]=useState(''),[sort,setSort]=useState('publishTime'),[direction,setDirection]=useState('desc'),[selected,setSelected]=useState(new Set());const utils=trpc.useUtils();const queryClient=useQueryClient();const navigate=useNavigate();
window.fixture={pending:()=>queryClient.isFetching({queryKey:[['article','list']]}),setFilter,setSearch,setDirection,navigate,clearReader:()=>queryClient.removeQueries({queryKey:[['article','byId']]}),selected:()=>[...selected],refresh:()=>{window.dispatchEvent(new Event('wewe-articles-refresh'));return utils.article.list.invalidate();},fresh:()=>utils.article.list.reset()};
return <div style={{height:"100vh",overflow:"hidden"}}><div style={{height:44}}>导航</div><div className="mx-auto flex h-[calc(100vh-44px)] max-w-[1280px] flex-col"><div className="flex h-full min-h-0"><div className="mac-content min-h-0 min-w-0"><header className="shrink-0 p-4">文章列表</header><div className="min-h-0 flex-1 overflow-hidden"><ArticleList search={search} articleFilter={filter} sort={sort} onSortChange={setSort} direction={direction} onDirectionChange={setDirection} selectedIds={selected} onSelectionChange={setSelected}/></div></div></div></div></div>}
createRoot(document.getElementById('root')).render(<BrowserRouter><TrpcProvider><Routes><Route path='/*' element={<App/>}/></Routes></TrpcProvider></BrowserRouter>);`;
      const measurements = [];
      await withFixture(
        source,
        async ({ evaluate, send, pause }) => {
          release();
          const {
            saveCachedArticleBatch,
          } = require('../apps/server/src/article-local-export-batch.ts');
          const until = async (fn) => {
            for (let i = 0; i < 400; i++) {
              if (await fn()) return;
              await pause(10);
            }
            throw Error('baseline timeout');
          };
          await until(() =>
            evaluate(
              "document.querySelectorAll('[data-article-id]').length===20",
            ),
          );
          const n = Number(process.env.EXPERIENCE_SAMPLES || 10);
          for (const f of fixtures)
            for (const parallel of [false, true])
              for (let i = 0; i < n; i++) {
                let background;
                if (parallel)
                  background = saveCachedArticleBatch(
                    prisma,
                    fixtures.map((x) => x.id),
                    path.join(root, 'parallel-' + f.name + '-' + i),
                  );
                for (const warmth of ['cold', 'warm']) {
                  if (warmth === 'cold') {
                    await send('Network.enable');
                    await send('Network.clearBrowserCache');
                    await evaluate('window.fixture.clearReader()');
                  }
                  phase = [
                    f.name,
                    parallel ? 'parallel' : 'idle',
                    warmth,
                    i,
                  ].join('-');
                  const before = requests.length;
                  const start = await evaluate(
                    `(()=>{window.readerLoaded=0;const t=performance.now();document.querySelector('[data-article-id="${f.id}"] a.compact-title').click();return t})()`,
                  );
                  await until(() => evaluate('Boolean(window.readerLoaded)'));
                  const value = await evaluate(
                    "(async()=>{const d=document.querySelector('iframe[title]').contentDocument;await Promise.all([...d.images].map(i=>i.decode()));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {text:d.body.innerText.length,images:[...d.images].map(i=>({ok:i.complete&&i.naturalWidth>0}))}})()",
                  );
                  assert(value.text >= f.text.length);
                  assert.equal(value.images.length, f.images);
                  assert(value.images.every((x) => x.ok));
                  const times = await evaluate(
                    `({loaded:window.readerLoaded-${start},complete:performance.now()-${start},resources:performance.getEntriesByType('resource').filter(x=>x.name.includes('article.byId')).map(x=>({ms:x.duration,end:x.responseEnd}))})`,
                  );
                  measurements.push({
                    stage: phase,
                    kind: f.name,
                    parallel,
                    warmth,
                    visibleMs: times.loaded,
                    imagesMs: times.complete,
                    http: requests
                      .slice(before)
                      .filter((x) => x.procedures.includes('byId'))
                      .map((x) => x.ms),
                    images: f.images,
                    clientHttp: times.resources.slice(-1),
                    renderAfterHttpMs:
                      warmth === 'cold' && times.resources.length
                        ? times.loaded - (times.resources.at(-1).end - start)
                        : null,
                    text: value.text,
                  });
                  await evaluate(
                    `document.querySelector('button[aria-label="Close"]').click()`,
                  );
                  await until(() =>
                    evaluate('!document.querySelector("iframe[title]")'),
                  );
                }
                if (background) await background;
                const directory = path.join(
                  root,
                  'archive-' + f.name + '-' + parallel + '-' + i,
                );
                const start = performance.now();
                const result = await saveCachedArticleBatch(
                  prisma,
                  [f.id],
                  directory,
                );
                const written = performance.now() - start;
                assert.equal(result.results.length, 1);
                const saved = result.results[0].saved;
                assert(
                  saved?.mediaStatus === 'complete',
                  JSON.stringify(result),
                );
                const md = fs.readFileSync(saved.markdownPath, 'utf8');
                assert(md.includes('合成'));
                const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(
                  (x) => x[1],
                );
                assert.equal(refs.length, f.images);
                for (const ref of refs) {
                  const file = path.resolve(
                    path.dirname(saved.markdownPath),
                    decodeURIComponent(ref),
                  );
                  assert(fs.readFileSync(file).length > 0);
                }
                measurements.push({
                  warmth: 'cold',
                  stage: 'archive',
                  kind: f.name,
                  parallel,
                  writeMs: written,
                  openVerifiedMs: performance.now() - start,
                  images: refs.length,
                });
                const repeatStart = performance.now();
                const repeated = await saveCachedArticleBatch(
                  prisma,
                  [f.id],
                  directory,
                );
                const repeatWrite = performance.now() - repeatStart;
                assert.equal(repeated.results[0].saved.alreadySaved, true);
                assert.notEqual(repeated.results[0].saved.mediaComplete, false);
                fs.readFileSync(repeated.results[0].saved.markdownPath);
                for (const ref of refs)
                  fs.readFileSync(
                    path.resolve(
                      path.dirname(saved.markdownPath),
                      decodeURIComponent(ref),
                    ),
                  );
                measurements.push({
                  stage: 'archive',
                  kind: f.name,
                  parallel,
                  warmth: 'warm',
                  writeMs: repeatWrite,
                  openVerifiedMs: performance.now() - repeatStart,
                  images: refs.length,
                });
              }
        },
        {
          'react-router-dom': path.join(web, 'node_modules/react-router-dom'),
          '@nextui-org/react': path.join(web, 'node_modules/@nextui-org/react'),
          '@trpc/client': path.join(web, 'node_modules/@trpc/client'),
          dayjs: path.join(web, 'node_modules/dayjs'),
          sonner: path.join(web, 'node_modules/sonner'),
          '../utils/trpc': path.join(web, 'src/utils/trpc.ts'),
          '../utils/auth': path.join(web, 'src/utils/auth.ts'),
          '../utils/startup-status': path.join(
            web,
            'src/utils/startup-status.ts',
          ),
          '../utils/env': env,
          '@web/utils/env': env,
          '@web': path.join(web, 'src'),
          '@wewe-rss/shared': path.resolve('packages/shared/src/index.ts'),
        },
        {
          productionStyles: true,
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
          'actual ArticleList/TrpcProvider/protected HTTP + SQLite + local archive; synthetic long text/24 inline images; cold browser+query cache, OS cache uncontrolled; iframe load plus image decode and two frames; archive write and read-open validation',
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
