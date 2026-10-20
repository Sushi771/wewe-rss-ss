'use strict';
const { splitSqliteStatements } = require('./sqlite-statements.cjs');

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
  'actual local body search UI escapes snippets and exposes incomplete coverage',
  { skip: !browser, timeout: 180000 },
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
    let prisma, release, prepareRelease;
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
        for (const statement of splitSqliteStatements(
          fs.readFileSync(
            path.join(server, 'prisma/migrations', migration, 'migration.sql'),
            'utf8',
          ),
        )
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
      const count = 260;
      assert(Number.isSafeInteger(count) && count >= 120 && count <= 3000);
      await prisma.$executeRawUnsafe(
        `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1 < ?)
   INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html,read_count,like_count,created_at)
   SELECT 'article-'||printf('%06d',x),'f'||(x%?),'Synthetic '||x,'',1700000000+CAST(x/3 AS INTEGER),
   CASE WHEN x%7=0 THEN NULL WHEN x%7=1 THEN '' WHEN x%7=2 THEN ' ' ELSE '<p>'||replace(hex(zeroblob(32768)),'00','x')||'</p>' END,x%99,x%17,CURRENT_TIMESTAMP FROM n`,
        count,
        feedCount,
      );
      await prisma.article.update({
        where: { id: 'article-000259' },
        data: {
          contentHtml:
            '<p>命中词 &lt;img src=x onerror=alert(1)&gt; 安全片段</p>',
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
      application.use(express.json());
      let preparationHeld = false;
      const preparationLatch = new Promise((resolve) => {
        prepareRelease = resolve;
      });
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
          assert(['GET', 'POST'].includes(req.method));
          assert.equal(req.headers.authorization, 'synthetic');
          res.once('finish', () => {
            record.ms = epoch() - record.start;
            record.status = res.statusCode;
            record.databaseMs = sql
              .slice(record.sqlStart)
              .reduce((s, e) => s + e.duration, 0);
          });
          if (req.url.includes('article.prepareSearch') && !preparationHeld) {
            preparationHeld = true;
            preparationLatch.then(next);
            return;
          }
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
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {useQueryClient} from '@tanstack/react-query';
import {BrowserRouter,Routes,Route,useNavigate} from 'react-router-dom';
import {TrpcProvider} from ${modulePath(providerFile)};
import {trpc} from ${modulePath(path.join(web, 'src/utils/trpc.ts'))};
import ArticleList from ${modulePath(listFile)};
import ${modulePath(path.join(web, 'src/index.css'))};
localStorage.setItem('authCode','synthetic');
document.addEventListener('load',(e)=>{if(e.target instanceof HTMLIFrameElement)window.readerLoaded=performance.now()},true);
function App(){const [filter,setFilter]=useState({}),[search,setSearch]=useState(''),[sort,setSort]=useState('publishTime'),[direction,setDirection]=useState('desc'),[selected,setSelected]=useState(new Set());const utils=trpc.useUtils();const queryClient=useQueryClient();const navigate=useNavigate();
window.fixture={pendingAll:()=>queryClient.isFetching(),pending:()=>queryClient.isFetching({queryKey:[['article','list']]}),setFilter,setSearch,setDirection,navigate,selected:()=>[...selected],refresh:()=>{window.dispatchEvent(new Event('wewe-articles-refresh'));return utils.article.list.invalidate();},fresh:()=>utils.article.list.reset()};
return <div style={{height:"100vh",overflow:"hidden"}}><div style={{height:44}}>导航</div><div className="mx-auto flex h-[calc(100vh-44px)] max-w-[1280px] flex-col"><div className="flex h-full min-h-0"><div className="mac-content min-h-0 min-w-0"><header className="shrink-0 p-4">文章列表</header><div className="min-h-0 flex-1 overflow-hidden"><ArticleList search={search} articleFilter={filter} sort={sort} onSortChange={setSort} direction={direction} onDirectionChange={setDirection} selectedIds={selected} onSelectionChange={setSelected}/></div></div></div></div></div>}
createRoot(document.getElementById('root')).render(<BrowserRouter><TrpcProvider><Routes><Route path='/*' element={<App/>}/></Routes></TrpcProvider></BrowserRouter>);`;
      const measurements = [];
      await withFixture(
        source,
        async ({ evaluate, send, pause }) => {
          release();
          const until = async (fn, msg) => {
            for (let i = 0; i < 400; i++) {
              if (await fn()) return;
              await pause(25);
            }
            throw Error(msg);
          };
          await until(
            () =>
              evaluate(
                "document.querySelectorAll('[data-article-id]').length===20",
              ),
            'initial list',
          );
          await evaluate("window.fixture.setSearch('命中词')");
          await until(
            () => evaluate("document.body.innerText.includes('待整理 260 篇')"),
            'unindexed scope shown',
          );
          await until(
            () =>
              evaluate(
                "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='停止整理')",
              ),
            'automatic batch begins',
          );
          await evaluate(
            "Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='停止整理').click()",
          );
          prepareRelease();
          await until(
            () =>
              evaluate(
                "document.body.innerText.includes('待整理 132 篇') && Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='整理本地正文搜索')",
              ),
            'stop after current bounded batch',
          );
          const stopped = requests.filter((x) =>
            x.procedures.includes('prepareSearch'),
          ).length;
          await pause(150);
          assert.equal(
            requests.filter((x) => x.procedures.includes('prepareSearch'))
              .length,
            stopped,
            'stopped indexing must not silently continue',
          );
          await evaluate(
            "Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='整理本地正文搜索').click()",
          );
          await until(
            () =>
              evaluate(
                "document.querySelector('[data-search-snippet]')?.textContent.includes('<img')",
              ),
            'body-only hit and snippet',
          );
          assert.equal(
            await evaluate(
              "document.querySelector('[data-search-snippet] img')===null",
            ),
            true,
          );
          assert.equal(
            await evaluate(
              "document.querySelector('[data-search-snippet] mark').textContent",
            ),
            '命中词',
          );
          assert.equal(
            await evaluate("document.body.innerText.includes('待整理 0 篇')"),
            true,
          );
          assert.equal(
            await evaluate(
              "document.querySelectorAll('[data-article-id]').length",
            ),
            1,
          );
          await prisma.article.update({
            where: { id: 'article-000259' },
            data: { contentHtml: '<p>更新后的独有正文</p>' },
          });
          await evaluate('window.fixture.refresh()');
          await until(
            () =>
              evaluate(
                "document.querySelectorAll('[data-article-id]').length===0",
              ),
            'stale body hit disappears',
          );
          await evaluate("window.fixture.setSearch('更新后的独有')");
          await until(
            () =>
              evaluate(
                "document.querySelector('[data-search-snippet] mark')?.textContent==='更新后的独有'",
              ),
            'updated body can be prepared and found',
          );
          assert(
            await evaluate(
              "(()=>{const e=document.querySelector('[data-search-snippet] mark');const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return r.width>0&&r.height>0&&r.right<=p.right+1&&r.left>=p.left-1})()",
            ),
            'highlight stays inside the visible snippet column',
          );
          await evaluate("window.fixture.setSearch('100%')");
          await until(
            () =>
              evaluate(
                "document.querySelectorAll('[data-article-id]').length===0",
              ),
            'percent is literal',
          );
          const visible = await evaluate(
            "(()=>{const e=document.querySelector('[data-search-snippet] mark');return !e||e.getBoundingClientRect().height>0})()",
          );
          assert(visible);
          await evaluate("window.fixture.setSearch('')");
          await pause(100);
          await until(
            () => evaluate('window.fixture.pendingAll()===0'),
            'requests settle before owned browser shutdown',
          );
          await until(
            () => requests.every((r) => r.status === 200),
            'all HTTP acknowledgements settle',
          );
          assert(requests.every((r) => r.status === 200));
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
          'actual automatic prepare with stop/resume across batches, literal query, escaped React snippet and body-update invalidation over authenticated local HTTP',
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
      prepareRelease?.();
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
