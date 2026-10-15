'use strict';
// Synthetic-only HTTP -> original protected tRPC route -> real SQLite commit.
// No production DB, timers, full AppModule, upstream services or external fetches.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');
const root = path.resolve('.');
const serverPath = path.join(root, 'apps/server');
const ts = require(require.resolve('typescript', { paths: [web] }));
const phase = process.env.RENAME_BENCHMARK_PHASE || 'candidate';
const fullPage = process.env.RENAME_BENCHMARK_FULL_PAGE === 'true';
const count = Number(process.env.RENAME_BENCHMARK_SAMPLES || 12);
const epoch = () => performance.timeOrigin + performance.now();
const percentile = (items, p) =>
  [...items].sort((a, b) => a - b)[Math.ceil(items.length * p) - 1];
test(
  'rename response, commit, cancellation, errors and fresh-client persistence through real local HTTP',
  { skip: !browser, timeout: 180000 },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-rename-http-'));
    const url =
      'file:' + path.join(temp, 'synthetic.sqlite').replaceAll('\\', '/');
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    // The existing runtime dependencies are reused; transpile only this checkout.
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
    const undoPaths = require(
      require.resolve('tsconfig-paths', { paths: [serverPath] }),
    ).register({
      baseUrl: root,
      paths: {
        '@server/*': ['apps/server/src/*'],
        '@wewe-rss/shared': ['packages/shared/src/index.ts'],
      },
    });
    let prisma, reader;
    const measurements = [],
      requests = [];
    const requestContext = new AsyncLocalStorage();
    try {
      const {
        PrismaService,
      } = require('../apps/server/src/prisma/prisma.service.ts');
      const { PrismaClient } = require(
        require.resolve('@prisma/client', { paths: [serverPath] }),
      );
      const { ConfigService } = require(
        require.resolve('@nestjs/config', { paths: [serverPath] }),
      );
      const {
        TrpcService,
      } = require('../apps/server/src/trpc/trpc.service.ts');
      const { TrpcRouter } = require('../apps/server/src/trpc/trpc.router.ts');
      const { createExpressMiddleware } = require(
        require.resolve('@trpc/server/adapters/express', {
          paths: [serverPath],
        }),
      );
      const express = require(
        require.resolve('express', { paths: [serverPath] }),
      );
      prisma = new PrismaService();
      reader = new PrismaClient({ datasources: { db: { url } } });
      for (const migration of fs
        .readdirSync(path.join(serverPath, 'prisma/migrations'))
        .filter((n) => /^\d/.test(n))
        .sort())
        for (const statement of fs
          .readFileSync(
            path.join(
              serverPath,
              'prisma/migrations',
              migration,
              'migration.sql',
            ),
            'utf8',
          )
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean))
          await prisma.$executeRawUnsafe(statement);
      for (let i = 0; i < 30; i++)
        await prisma.managementGroup.create({
          data: {
            id: 'g' + i,
            name: 'Folder ' + i,
            platform: 'wechat',
            order: i,
          },
        });
      const renameQueries = [];
      prisma.$use(async (params, next) => {
        if (requestContext.getStore()?.rename)
          renameQueries.push({ model: params.model, action: params.action });
        return next(params);
      });
      let loseResponse = false;
      const transaction = prisma.$transaction.bind(prisma);
      prisma.$transaction = async (...args) => {
        const result = await transaction(...args);
        const context = requestContext.getStore();
        if (context?.rename) {
          context.commitAt = epoch();
          const saved = await reader.managementGroup.findUniqueOrThrow({
            where: { id: result.id },
          });
          assert.equal(saved.name, result.name);
          context.visibleAt = epoch();
          context.response.setHeader(
            'X-Fixture-Commit-At',
            String(context.commitAt),
          );
          context.response.setHeader(
            'X-Fixture-Visible-At',
            String(context.visibleAt),
          );
          if (loseResponse) {
            // Interrupt a response already started, so a browser cannot treat
            // an empty reused socket as an unsent request and replay it.
            const response = context.response;
            response.end = () => {
              response.statusCode = 200;
              response.setHeader('Content-Type', 'application/json');
              response.flushHeaders();
              response.write('[');
              setImmediate(() => response.destroy());
              return response;
            };
          }
        }
        return result;
      };
      const config = new ConfigService({
        auth: { code: 'synthetic' },
        platform: { url: '' },
        feed: { updateDelayTime: 0 },
      });
      const service = new TrpcService(prisma, config, {}, {});
      const router = new TrpcRouter(service, prisma, config, {}, {}).appRouter;
      const api = express();
      api.use(express.json());
      let fail = false,
        hold = 0;
      api.use(
        '/trpc',
        (req, res, next) => {
          const rename = req.url.includes('saveGroup');
          requests.push(req.url.split('?')[0]);
          const context = { rename, response: res, arrivedAt: epoch() };
          requestContext.run(context, () => {
            if (rename && fail) {
              res
                .status(503)
                .json({ error: { message: 'Synthetic save unavailable' } });
              return;
            }
            if (rename && hold) setTimeout(next, hold);
            else next();
          });
        },
        createExpressMiddleware({
          router,
          createContext: () => ({ errorMsg: null, isLocal: true }),
        }),
      );
      const source = ts.createSourceFile(
        'feeds.tsx',
        fs.readFileSync(path.join(web, 'src/pages/feeds/index.tsx'), 'utf8'),
        99,
        true,
        ts.ScriptKind.TSX,
      );
      let callback;
      const visit = (n) => {
        if (
          ts.isJsxSelfClosingElement(n) &&
          n.tagName.getText(source) === 'ManagementFolders'
        )
          callback = n.attributes.properties
            .find((p) => p.name?.getText(source) === 'onSave')
            .initializer.expression.getText(source);
        ts.forEachChild(n, visit);
      };
      visit(source);
      const liveModule = path.join(temp, 'live-trpc.ts');
      const backendModule = path.join(temp, 'backend.ts');
      const envModule = path.join(temp, 'env.ts');
      const watchModule = path.join(temp, 'watch.ts');
      fs.writeFileSync(
        liveModule,
        `import {createTRPCReact} from ${modulePath(path.join(web, 'node_modules/@trpc/react-query/dist/index.mjs'))};export const live=createTRPCReact();`,
      );
      const ordinaryReads = fs
        .readFileSync(
          path.join(root, 'scripts/folder-selection-overlay-browser.test.cjs'),
          'utf8',
        )
        .match(/const backendSource = `([\s\S]*?)`;/)[1];
      fs.writeFileSync(
        backendModule,
        `import {live} from ${modulePath(liveModule)};\n` +
          ordinaryReads.replace('export const trpc=', 'const stub=') +
          `
export const trpc=new Proxy(stub,{get(target,scope){
 if(scope==='useUtils')return ()=>{const fallback=stub.useUtils(),actual=live.useUtils();return new Proxy(fallback,{get:(t,k)=>k==='feed'?new Proxy(t.feed,{get:(f,n)=>n==='groups'?actual.feed.groups:f[n]}):t[k]});};
 if(scope==='feed')return new Proxy(stub.feed,{get:(t,n)=>['groups','saveGroup'].includes(n)?live.feed[n]:t[n]});return target[scope];
}});`,
      );
      fs.writeFileSync(
        envModule,
        "export const acceptanceMode=false,privateOnlineMode=false,serverOriginUrl='',enabledAuthCode=false;",
      );
      fs.writeFileSync(watchModule, 'export const useCacheRevision=()=>false;');
      await withFixture(
        `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {live as trpc} from ${modulePath(liveModule)};
import {httpBatchLink} from ${modulePath(path.join(web, 'node_modules/@trpc/client/dist/index.mjs'))};
import {NextUIProvider} from ${modulePath(path.join(web, 'node_modules/@nextui-org/react/dist/index.mjs'))};
import ManagementFolders from ${modulePath(path.join(web, 'src/components/ManagementFolders.tsx'))};
${fullPage ? `import Feeds from ${modulePath(path.join(web, 'src/pages/feeds/index.tsx'))};import {MemoryRouter,Routes,Route} from 'react-router-dom';import ${modulePath(path.join(web, 'src/index.css'))};` : ''}
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
window.measurements=[];window.network=[];
const client=trpc.createClient({links:[httpBatchLink({url:'/trpc',fetch:async(url,options)=>{const start=performance.timeOrigin+performance.now();const response=await fetch(url,options);if(String(url).includes('saveGroup'))window.network.push({start,responseAt:performance.timeOrigin+performance.now(),commitAt:Number(response.headers.get('X-Fixture-Commit-At')),visibleAt:Number(response.headers.get('X-Fixture-Visible-At'))});return response;}})]});
document.addEventListener('click',event=>{if(event.target.closest('button')?.textContent==='保存'){const start=performance.timeOrigin+performance.now();const target=document.querySelector('[role=dialog] input').value.trim();const sample={start,target};window.measurements.push(sample);const closed=()=>{if(!document.querySelector('[role=dialog]'))sample.dialogClosedAt=performance.timeOrigin+performance.now();else requestAnimationFrame(closed);};requestAnimationFrame(closed);const check=()=>{const label=document.querySelector('.folder-filter[title="'+CSS.escape(target)+'"] .folder-filter-label');if(label?.textContent===target){requestAnimationFrame(()=>{sample.uiAt=performance.timeOrigin+performance.now();});}else requestAnimationFrame(check);};requestAnimationFrame(check);}},true);
function App(){const folders=trpc.feed.groups.useQuery(undefined,{retry:false});const saveFolder=trpc.feed.saveGroup.useMutation({retry:false});const queryUtils=trpc.useContext();const[busy,setBusy]=useState(false);const[filter,setFilter]=useState('all');${fullPage ? `window.fixture.items=folders.data?.items;Object.defineProperty(window.fixture,'busy',{configurable:true,get:()=>Array.from(document.querySelectorAll('[role=status]')).some(e=>e.textContent.includes('正在保存分类'))});Object.defineProperty(window.fixture,'filter',{configurable:true,get:()=>document.querySelector('.folder-filter[aria-pressed=true]')?.title===folders.data?.items[0]?.name?'g0':'all'});return <MemoryRouter initialEntries={['/feeds']}><main className="app-shell"><div className="mac-toolbar">Synthetic app toolbar</div><Routes><Route path="/feeds/:id?" element={<Feeds/>}/></Routes></main></MemoryRouter>;` : `window.fixture={busy,filter,items:folders.data?.items};return <ManagementFolders folders={folders.data?.items||[]} filter={filter} selectedIds={[]} dragType="fixture" disabled={busy||!folders.data} onBusyChange={setBusy} onFilter={setFilter} onSave={${callback}} onMove={async()=>{}} onRemove={async()=>{}}/>;`}}
createRoot(document.getElementById('root')).render(<NextUIProvider><trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><App/></QueryClientProvider></trpc.Provider></NextUIProvider>);
`,
        async ({ evaluate, send, pause }) => {
          if (fullPage)
            await send('Emulation.setDeviceMetricsOverride', {
              width: 1440,
              height: 900,
              deviceScaleFactor: 1,
              mobile: false,
            });
          const until = async (expression) => {
            for (let i = 0; i < 150; i++) {
              if (await evaluate(expression)) return;
              await pause(20);
            }
            assert.fail('Timed out: ' + expression);
          };
          await until('window.fixture?.items?.length===30');
          const edit = async (name) => {
            await evaluate(
              `Array.from(document.querySelectorAll('button')).find(e=>e.getAttribute('aria-label')?.startsWith('文件夹 '+window.fixture.items[0].name+' 更多操作')).click()`,
            );
            await until(
              `Array.from(document.querySelectorAll('[role=menuitem]')).some(e=>e.textContent==='重命名')`,
            );
            await evaluate(
              `Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.textContent==='重命名').click()`,
            );
            await until(
              `Boolean(document.querySelector('[role=dialog] input'))`,
            );
            await evaluate(
              `(()=>{const input=document.querySelector('[role=dialog] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
            );
            await pause(30);
          };
          const save = async () => {
            const expression = `Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent==='保存')`;
            if (!fullPage) return evaluate(`(${expression}).click()`);
            const point = await evaluate(
              `(()=>{const e=${expression};e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
            );
            await send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              ...point,
              button: 'left',
              clickCount: 1,
            });
            await send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              ...point,
              button: 'left',
              clickCount: 1,
            });
          };
          for (let i = 0; i < count; i++) {
            const name = 'Renamed ' + i;
            await edit(name);
            await save();
            await until(
              `window.measurements.at(-1)?.uiAt && window.measurements.at(-1)?.dialogClosedAt && !window.fixture.busy && window.fixture.items[0].name===${JSON.stringify(name)}`,
            );
            const sample = await evaluate(
              `({...window.measurements.at(-1),...window.network.at(-1)})`,
            );
            // The start recorded by the click capture is authoritative, not fetch start.
            sample.start = await evaluate('window.measurements.at(-1).start');
            assert(sample.commitAt > 0);
            assert(sample.visibleAt >= sample.commitAt);
            measurements.push({
              uiMs: sample.uiAt - sample.start,
              dialogClosedMs: sample.dialogClosedAt - sample.start,
              httpMs: sample.responseAt - sample.start,
              commitMs: sample.commitAt - sample.start,
              independentReadMs: sample.visibleAt - sample.start,
            });
            assert.equal(
              (
                await reader.managementGroup.findUniqueOrThrow({
                  where: { id: 'g0' },
                })
              ).name,
              name,
            );
          }
          assert(
            !renameQueries.some(
              (query) =>
                query.action === 'findMany' ||
                ['Feed', 'Article', 'XhsCreator', 'XhsNote'].includes(
                  query.model,
                ),
            ),
            'rename does not reread full groups, members or articles',
          );
          if (phase !== 'baseline') {
            // Slow durable work: UI is only provisional and mutations remain fenced.
            hold = 450;
            await edit('Slow rename');
            await save();
            await pause(90);
            assert.equal(await evaluate('window.fixture.busy'), true);
            assert.equal(
              await evaluate(
                'document.querySelector(\'.folder-filter[title="Slow rename"]\')?.textContent',
              ),
              'Slow rename',
            );
            assert.match(
              await evaluate(
                'document.querySelector("[role=status]")?.textContent',
              ),
              /正在保存/,
            );
            assert.notEqual(
              (
                await reader.managementGroup.findUniqueOrThrow({
                  where: { id: 'g0' },
                })
              ).name,
              'Slow rename',
            );
            await until('!window.fixture.busy');
            hold = 0;
            fail = true;
            await edit('Rejected rename');
            await save();
            await until(
              '!window.fixture.busy && Boolean(document.querySelector("[role=alert]"))',
            );
            assert.match(
              await evaluate(
                'document.querySelector("[role=alert]").textContent',
              ),
              /未确认保存/,
            );
            assert.equal(
              await evaluate(
                'document.querySelector(\'.folder-filter[title="Rejected rename"]\')',
              ),
              null,
            );
            fail = false;
            loseResponse = true;
            const beforeLost = requests.filter((u) =>
              u.includes('saveGroup'),
            ).length;
            await edit('Committed without response');
            await save();
            await until(
              '!window.fixture.busy && Boolean(document.querySelector("[role=alert]"))',
            );
            assert.equal(
              (
                await reader.managementGroup.findUniqueOrThrow({
                  where: { id: 'g0' },
                })
              ).name,
              'Committed without response',
            );
            assert.match(
              await evaluate(
                'document.querySelector("[role=alert]").textContent',
              ),
              /未确认保存/,
            );
            assert.equal(
              requests.filter((u) => u.includes('saveGroup')).length,
              beforeLost + 1,
              'a lost acknowledgement does not retry the mutation',
            );
            loseResponse = false;
            await send('Page.reload');
            await until(
              'window.fixture?.items?.[0]?.name==="Committed without response"',
            );
            for (const mode of ['cancel', 'escape']) {
              await edit('Discarded');
              const before = requests.filter((u) =>
                u.includes('saveGroup'),
              ).length;
              if (mode === 'cancel')
                await evaluate(
                  `Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent==='取消').click()`,
                );
              else {
                await send('Input.dispatchKeyEvent', {
                  type: 'keyDown',
                  key: 'Escape',
                  code: 'Escape',
                  windowsVirtualKeyCode: 27,
                });
                await send('Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  key: 'Escape',
                  code: 'Escape',
                  windowsVirtualKeyCode: 27,
                });
              }
              await pause(250);
              assert.equal(
                requests.filter((u) => u.includes('saveGroup')).length,
                before,
              );
            }
            await edit('Folder 1');
            await save();
            await until(
              '!window.fixture.busy && window.fixture.items[0].name==="Folder 1"',
            );
            await evaluate(
              `document.querySelectorAll('.folder-filter')[2].click()`,
            );
            await pause(20);
            assert.equal(await evaluate('window.fixture.filter'), 'g0');
            await send('Page.reload');
            await until('window.fixture?.items?.[0]?.name==="Folder 1"');
            assert.equal(
              (
                await reader.managementGroup.findUniqueOrThrow({
                  where: { id: 'g0' },
                })
              ).name,
              'Folder 1',
            );
          }
        },
        fullPage
          ? {
              '@web/utils/trpc': backendModule,
              '@web/utils/env': envModule,
              '@web/utils/use-cache-revision': watchModule,
              '@web': path.join(web, 'src'),
              '@wewe-rss/shared': path.resolve('packages/shared/src/index.ts'),
              'react-router-dom': path.join(
                web,
                'node_modules/react-router-dom',
              ),
            }
          : {},
        {
          productionStyles: fullPage,
          handleRequest: (req, res) => {
            if (req.url.startsWith('/trpc')) {
              api(req, res);
              return true;
            }
            return false;
          },
        },
      );
      const summary = {
        phase,
        samples: count,
        scope: fullPage
          ? 'actual Feeds page + production CSS + 240 synthetic feeds + original protected groups/saveGroup HTTP + PrismaService + synthetic SQLite; other reads stubbed, local headless browser'
          : 'actual component + extracted actual page callback + original protected tRPC router + PrismaService + synthetic SQLite, local headless browser',
        databaseBytes: fs.statSync(path.join(temp, 'synthetic.sqlite')).size,
        renameQueries: Object.fromEntries(
          [
            ...new Set(
              renameQueries.map(
                (query) => `${query.model || 'raw'}.${query.action}`,
              ),
            ),
          ].map((key) => [
            key,
            renameQueries.filter(
              (query) => `${query.model || 'raw'}.${query.action}` === key,
            ).length,
          ]),
        ),
        metrics: Object.fromEntries(
          [
            'uiMs',
            'dialogClosedMs',
            'httpMs',
            'commitMs',
            'independentReadMs',
          ].map((key) => [
            key,
            {
              p50: percentile(
                measurements.map((s) => s[key]),
                0.5,
              ),
              p95: percentile(
                measurements.map((s) => s[key]),
                0.95,
              ),
              max: Math.max(...measurements.map((s) => s[key])),
            },
          ]),
        ),
        measurements,
        requests: requests.length,
      };
      const output = process.env.RENAME_BENCHMARK_OUTPUT;
      if (output) {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(summary, null, 2));
      }
      console.log(JSON.stringify(summary));
    } finally {
      await prisma?.$disconnect();
      await reader?.$disconnect();
      undoPaths();
      require.extensions['.ts'] = oldLoader;
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      // Keep the tiny synthetic artifacts locally for audit; never delete user data.
    }
  },
);
