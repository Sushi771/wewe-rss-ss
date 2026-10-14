'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');

// Backend data only is synthetic; mount the actual Feeds page, ArticleList,
// router, browse-state hook, folder controls, picker and production stylesheet.
const backendSource = `
import {useQuery,useInfiniteQuery,useMutation,useQueryClient} from '@tanstack/react-query';
const rows=Array.from({length:240},(_,i)=>({id:'source'+i,mpName:'Synthetic publisher '+i,mpCover:'',mpIntro:'',order:i,groupId:null,collectionChannel:'wechat2rss',collectionRoute:{channel:'wechat2rss'}}));
const groups=[{id:'folder-a',name:'Synthetic folder',order:0,platform:'wechat'}];
window.fixture={rows,groups,requests:[],moves:[]};
const key=(scope,name,input)=>[scope,name,input??null];
function data(scope,name,input){
 if(scope==='feed'&&name==='list')return {items:rows.map(row=>({...row}))};
 if(scope==='feed'&&name==='groups')return {items:groups};
 if(scope==='article'&&name==='summary')return {articles:0};
 if(scope==='feed'&&name==='addCapability')return {sources:[],existingRepairAvailable:false};
 if(name==='cacheSyncStatus')return {feeds:[]};
 if(name==='list'||name==='manualRefreshBatches'||name==='subscriptionBatches')return {items:[]};
 return undefined;
}
const operation=(client,scope,name)=>({cancel:()=>client.cancelQueries([scope,name]),setData:(input,next)=>client.setQueryData(key(scope,name,input),next),invalidate:()=>Promise.resolve(),reset:()=>Promise.resolve()});
export const trpc=new Proxy({useUtils(){const client=useQueryClient();return new Proxy({}, {get:(_,scope)=>new Proxy({}, {get:(_,name)=>operation(client,scope,name)})});}}, {get:(target,scope)=>scope in target?target[scope]:new Proxy({}, {get:(_,name)=>({
 useQuery:(input,options={})=>useQuery({queryKey:key(scope,name,input),queryFn:async()=>data(scope,name,input),initialData:()=>data(scope,name,input),...options}),
 useInfiniteQuery:(input,options={})=>{window.fixture.requests.push(input);return useInfiniteQuery({queryKey:key(scope,name,input),queryFn:async()=>({items:[]}),initialData:{pages:[{items:[]}],pageParams:[undefined]},...options});},
 useMutation:()=>useMutation(async input=>{if(name!=='moveFeeds')throw Error('Unexpected synthetic mutation '+name);window.fixture.moves.push(input);for(const row of rows)if(input.ids.includes(row.id))row.groupId=input.groupId;return {ids:input.ids,groupId:input.groupId,moved:input.ids.length};}),
})})});
`;
async function fixture(run) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wewe-folder-interaction-modules-'),
  );
  const backend = path.join(dir, 'backend.ts');
  const cacheWatch = path.join(dir, 'cache-watch.ts');
  const env = path.join(dir, 'env.ts');
  fs.writeFileSync(backend, backendSource);
  fs.writeFileSync(cacheWatch, 'export const useCacheRevision=()=>false;');
  fs.writeFileSync(
    env,
    "export const acceptanceMode=false,privateOnlineMode=false,serverOriginUrl='',enabledAuthCode=false;",
  );
  await withFixture(
    `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useLocation,useNavigate} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {NextUIProvider} from ${modulePath(path.join(web, 'node_modules/@nextui-org/react/dist/index.mjs'))};
import Feeds from ${modulePath(path.join(web, 'src/pages/feeds/index.tsx'))};
import ${modulePath(path.join(web, 'src/index.css'))};
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function Probe(){const location=useLocation(),navigate=useNavigate();window.fixture.route=location.pathname;window.fixture.navigate=navigate;return null;}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/feeds']}><QueryClientProvider client={client}><NextUIProvider><main className="app-shell"><div className="mac-toolbar">Synthetic app toolbar</div><Probe/><Routes><Route path="/feeds/:id?" element={<Feeds/>}/></Routes></main></NextUIProvider></QueryClientProvider></MemoryRouter>);
`,
    run,
    {
      '@web/utils/trpc': backend,
      '@web/utils/use-cache-revision': cacheWatch,
      '@web/utils/env': env,
      '@web': path.join(web, 'src'),
      '@wewe-rss/shared': path.resolve('packages/shared/src/index.ts'),
      'react-router-dom': path.join(web, 'node_modules/react-router-dom'),
    },
    { productionStyles: true },
  );
}
async function ready({ evaluate, pause }) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate('Boolean(document.querySelector(".folder-filter"))'))
      return;
    await pause(30);
  }
  throw Error('actual feeds page did not render');
}
async function click({ evaluate, send, pause }, expression) {
  const point = await evaluate(
    `(()=>{const node=${expression};node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;window.fixture.lastClick={node:node.outerHTML.slice(0,150),hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,200),x,y};return {x,y};})()`,
  );
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await pause(100);
}
test(
  'move then click a source keeps that folder, selected row and source-scoped article query',
  { skip: !browser, timeout: 120000 },
  async () => {
    await fixture(async (api) => {
      await api.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await ready(api);
      const target = await api.evaluate(
        `(()=>{const r=document.querySelector('[data-sort-folder="folder-a"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      const data = {
        items: [{ mimeType: 'application/x-wewe-wechat', data: 'source0' }],
        dragOperationsMask: 16,
      };
      await api.send('Input.dispatchDragEvent', {
        type: 'dragEnter',
        ...target,
        data,
      });
      await api.send('Input.dispatchDragEvent', {
        type: 'drop',
        ...target,
        data,
      });
      await api.pause(100);
      await click(
        api,
        `document.querySelector('[data-sort-folder="folder-a"] .folder-filter')`,
      );
      await click(
        api,
        `document.querySelector('li.mac-sidebar-item span.flex-1')`,
      );
      assert.equal(
        await api.evaluate('window.fixture.route'),
        '/feeds/source0',
      );
      assert.equal(
        await api.evaluate(
          `document.querySelector('[data-sort-folder="folder-a"] .folder-filter').getAttribute('aria-pressed')`,
        ),
        'true',
      );
      assert.match(
        await api.evaluate(
          'document.querySelector("li.mac-sidebar-item.active").textContent',
        ),
        /Synthetic publisher 0/,
      );
      assert.equal(
        await api.evaluate('window.fixture.requests.at(-1).mpId'),
        'source0',
      );
      await api.evaluate(`window.fixture.navigate('/feeds/source1')`);
      await api.pause(100);
      assert.equal(
        await api.evaluate('window.fixture.route'),
        '/feeds/source1',
      );
      assert.equal(
        await api.evaluate('window.fixture.requests.at(-1).group'),
        'all',
      );
      await api.evaluate('window.fixture.navigate(-1)');
      await api.pause(100);
      assert.equal(
        await api.evaluate('window.fixture.requests.at(-1).mpId'),
        'source0',
      );
      assert.equal(
        await api.evaluate('window.fixture.requests.at(-1).group'),
        'folder-a',
      );
    });
  },
);
test(
  'actual folder picker remains above sticky toolbars and clickable at desktop and short mobile sizes',
  { skip: !browser, timeout: 120000 },
  async () => {
    await fixture(async (api) => {
      await api.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await ready(api);
      await click(
        api,
        `document.querySelector('[data-sort-folder="folder-a"] .folder-navigation-row').querySelectorAll('button')[1]`,
      );
      await api.pause(100);
      await click(
        api,
        `Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='添加订阅')`,
      );
      await api.pause(250);
      for (const [width, height] of [
        [1280, 800],
        [390, 500],
        [667, 375],
      ]) {
        await api.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await api.pause(100);
        const evidence = await api.evaluate(
          `(()=>{const d=document.querySelector('[role=dialog]'),h=d.querySelector('header'),f=d.querySelector('footer'),b=d.getBoundingClientRect();const probe=n=>{const r=n.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return top===n||n.contains(top);};return {within:b.top>=0&&b.bottom<=innerHeight,header:probe(h),footer:probe(f),dialogZ:getComputedStyle(d.parentElement).zIndex,toolbarZ:getComputedStyle(document.querySelector('.mac-toolbar')).zIndex};})()`,
        );
        assert.equal(
          evidence.header,
          true,
          JSON.stringify({ width, height, evidence }),
        );
        assert.equal(
          evidence.footer,
          true,
          JSON.stringify({ width, height, evidence }),
        );
        assert.equal(
          evidence.within,
          true,
          JSON.stringify({ width, height, evidence }),
        );
      }
      await click(
        api,
        `document.querySelector('[role=dialog] input[type=checkbox]')`,
      );
      assert.equal(
        await api.evaluate(
          'document.querySelector("[role=dialog] input[type=checkbox]").checked',
        ),
        true,
      );
    });
  },
);
