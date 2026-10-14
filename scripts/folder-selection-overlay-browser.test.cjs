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
let revision=0;const articles=[];
const article=(id,i)=>({id,mpId:'source0',title:'Synthetic article '+i,publishTime:Math.floor(Date.now()/1000)-i,bodyCached:true,bodyRetry:{allowed:false},feed:{mpName:'Synthetic publisher 0',collectionChannel:'wechat2rss'}});
window.fixture={rows,groups,requests:[],moves:[],invalidations:[],reads:0,articleReads:0,
 seed(){rows[0].groupId='folder-a';articles.push(...Array.from({length:60},(_,i)=>article('article'+i,i)));},
 complete(id){if(id){articles.unshift(article(id,0));revision++;}},
};
const articleItems=input=>articles.filter(a=>(!input?.mpId||a.mpId===input.mpId)&&(!input?.group||input.group==='all'||rows.find(r=>r.id===a.mpId)?.groupId===input.group));
const key=(scope,name,input)=>[scope,name,input??null];
function data(scope,name,input){
 if(scope==='feed'&&name==='list')return {items:rows.map(row=>({...row}))};
 if(scope==='feed'&&name==='groups')return {items:groups};
 if(scope==='article'&&name==='summary')return {articles:articleItems(input).length};
 if(scope==='feed'&&name==='addCapability')return {sources:[],existingRepairAvailable:false};
 if(name==='cacheSyncStatus')return {feeds:[]};
 if(name==='list'||name==='manualRefreshBatches'||name==='subscriptionBatches')return {items:[]};
 return undefined;
}
const operation=(client,scope,name)=>({cancel:()=>client.cancelQueries([scope,name]),setData:(input,next)=>client.setQueryData(key(scope,name,input),next),invalidate:()=>{window.fixture.invalidations.push({scope,name});return client.invalidateQueries({queryKey:[scope,name],refetchType:'active'});},reset:()=>client.resetQueries([scope,name])});
export const trpc=new Proxy({useUtils(){const client=useQueryClient();return new Proxy({}, {get:(_,scope)=>scope==='client'?{feed:{cacheRevision:{query:async()=>{window.fixture.reads++;return {revision:'synthetic:'+revision};}}}}:new Proxy({}, {get:(_,name)=>operation(client,scope,name)})});}}, {get:(target,scope)=>scope in target?target[scope]:new Proxy({}, {get:(_,name)=>({
 useQuery:(input,options={})=>useQuery({queryKey:key(scope,name,input),queryFn:async()=>data(scope,name,input),initialData:()=>data(scope,name,input),...options}),
 useInfiniteQuery:(input,options={})=>{window.fixture.requests.push(input);return useInfiniteQuery({queryKey:key(scope,name,input),queryFn:async()=>{window.fixture.articleReads++;return {items:articleItems(input).slice(0,20)};},initialData:{pages:[{items:articleItems(input).slice(0,20)}],pageParams:[undefined]},...options});},
 useMutation:()=>useMutation(async input=>{if(name!=='moveFeeds')throw Error('Unexpected synthetic mutation '+name);window.fixture.moves.push(input);for(const row of rows)if(input.ids.includes(row.id))row.groupId=input.groupId;return {ids:input.ids,groupId:input.groupId,moved:input.ids.length};}),
})})});
`;
async function fixture(run, { watch = false } = {}) {
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
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
${watch ? 'window.fixture.seed();' : ''}
function Probe(){const location=useLocation(),navigate=useNavigate();window.fixture.route=location.pathname;window.fixture.navigate=navigate;return null;}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/feeds']}><QueryClientProvider client={client}><NextUIProvider><main className="app-shell"><div className="mac-toolbar">Synthetic app toolbar</div><Probe/><Routes><Route path="/feeds/:id?" element={<Feeds/>}/></Routes></main></NextUIProvider></QueryClientProvider></MemoryRouter>);
`,
    run,
    {
      '@web/utils/trpc': backend,
      '@web/utils/use-cache-revision': watch
        ? path.join(web, 'src/utils/use-cache-revision.ts')
        : cacheWatch,
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
      await click(
        api,
        `Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='清除筛选与浏览位置')`,
      );
      assert.equal(
        await api.evaluate('window.fixture.requests.at(-1).group'),
        'all',
      );
      await click(
        api,
        `document.querySelector('li.mac-sidebar-item.active span.flex-1')`,
      );
      assert.equal(
        await api.evaluate('window.fixture.route'),
        '/feeds/source0',
      );
      assert.equal(
        await api.evaluate('window.fixture.requests.at(-1).group'),
        'all',
      );
      await api.evaluate('window.fixture.navigate(-1)');
      await api.pause(100);
      assert.equal(
        await api.evaluate('window.fixture.route'),
        '/feeds/source0',
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
      const trigger = `document.querySelector('[data-sort-folder="folder-a"] .folder-navigation-row').querySelectorAll('button')[1]`;
      const openPicker = async () => {
        await api.evaluate(`void(window.fixture.pickerTrigger=${trigger})`);
        await click(api, trigger);
        await click(
          api,
          `Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='添加订阅')`,
        );
        await api.pause(250);
      };
      const key = async (value, code, modifiers = 0) => {
        await api.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: value,
          code,
          modifiers,
          windowsVirtualKeyCode: value === 'Tab' ? 9 : 27,
        });
        await api.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: value,
          code,
          modifiers,
          windowsVirtualKeyCode: value === 'Tab' ? 9 : 27,
        });
        await api.pause(100);
      };
      await openPicker();
      assert(
        await api.evaluate(
          `document.querySelector('[role=dialog]').contains(document.activeElement)`,
        ),
      );
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
      await api.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await api.pause(100);
      await api.evaluate(
        `Array.from(document.querySelectorAll('[role=dialog] button')).filter(n=>!n.disabled).at(-1).focus()`,
      );
      await key('Tab', 'Tab');
      assert(
        await api.evaluate(
          `document.querySelector('[role=dialog]').contains(document.activeElement)`,
        ),
      );
      await api.evaluate(
        `document.querySelector('[role=dialog] button').focus()`,
      );
      await key('Tab', 'Tab', 8);
      assert(
        await api.evaluate(
          `document.querySelector('[role=dialog]').contains(document.activeElement)`,
        ),
      );
      await key('Escape', 'Escape');
      await api.pause(250);
      assert.equal(
        await api.evaluate(`Boolean(document.querySelector('[role=dialog]'))`),
        false,
      );
      assert(
        await api.evaluate(
          'document.activeElement===window.fixture.pickerTrigger',
        ),
      );
      await openPicker();
      await api.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: 2,
        y: 2,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await api.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 2,
        y: 2,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await api.pause(350);
      assert.equal(
        await api.evaluate(`Boolean(document.querySelector('[role=dialog]'))`),
        false,
      );
      assert(
        await api.evaluate(
          'document.activeElement===window.fixture.pickerTrigger',
        ),
      );
      await openPicker();
      await click(
        api,
        `document.querySelector('[role=dialog] .subscription-dialog-close')`,
      );
      await api.pause(250);
      assert.equal(
        await api.evaluate(`Boolean(document.querySelector('[role=dialog]'))`),
        false,
      );
      assert(
        await api.evaluate(
          'document.activeElement===window.fixture.pickerTrigger',
        ),
      );
    });
  },
);

test(
  'background local revision reveals new articles, preserves scope and anchor, and pauses hidden pages',
  { skip: !browser, timeout: 120000 },
  async () => {
    await fixture(
      async (api) => {
        await api.send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await api.send('Emulation.setFocusEmulationEnabled', {
          enabled: true,
        });
        await ready(api);
        await click(
          api,
          `document.querySelector('[data-sort-folder="folder-a"] .folder-filter')`,
        );
        await click(
          api,
          `document.querySelector('li.mac-sidebar-item span.flex-1')`,
        );
        await api.pause(1200);
        assert((await api.evaluate('window.fixture.reads')) > 0);
        await api.evaluate(
          `(()=>{const s=document.querySelector('.compact-list').parentElement;s.scrollTop=250;s.dispatchEvent(new Event('scroll'));window.fixture.scope=JSON.stringify(window.fixture.requests.at(-1));})()`,
        );
        await api.pause(50);
        const anchor = () =>
          api.evaluate(
            `(()=>{const s=document.querySelector('.compact-list').parentElement,r=s.getBoundingClientRect(),a=Array.from(s.querySelectorAll('[data-article-id]')).find(a=>a.getBoundingClientRect().bottom>r.top);return {id:a.dataset.articleId,offset:a.getBoundingClientRect().top-r.top};})()`,
          );
        const before = await anchor();
        await api.evaluate(`window.fixture.complete('new-visible')`);
        await api.pause(1400);
        assert(
          await api.evaluate(
            `Boolean(document.querySelector('[data-article-id="new-visible"]'))`,
          ),
        );
        assert.equal(
          await api.evaluate('window.fixture.route'),
          '/feeds/source0',
        );
        assert.equal(
          await api.evaluate('JSON.stringify(window.fixture.requests.at(-1))'),
          await api.evaluate('window.fixture.scope'),
        );
        const after = await anchor();
        assert.equal(after.id, before.id);
        assert(Math.abs(after.offset - before.offset) <= 2);
        const unchanged = await api.evaluate('window.fixture.articleReads');
        await api.evaluate('window.fixture.complete()');
        await api.pause(1200);
        assert.equal(
          await api.evaluate('window.fixture.articleReads'),
          unchanged,
        );
        await api.evaluate(
          `Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));`,
        );
        const hidden = await api.evaluate('window.fixture.reads');
        await api.evaluate(`window.fixture.complete('new-hidden')`);
        await api.pause(1200);
        assert.equal(await api.evaluate('window.fixture.reads'), hidden);
        assert.equal(
          await api.evaluate(
            `Boolean(document.querySelector('[data-article-id="new-hidden"]'))`,
          ),
          false,
        );
        await api.evaluate(
          `Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));`,
        );
        await api.pause(500);
        assert(
          await api.evaluate(
            `Boolean(document.querySelector('[data-article-id="new-hidden"]'))`,
          ),
        );
        assert.equal(
          await api.evaluate('window.fixture.route'),
          '/feeds/source0',
        );
        assert.equal(
          await api.evaluate('window.fixture.requests.at(-1).group'),
          'folder-a',
        );
        assert.equal(await api.evaluate('window.fixture.moves.length'), 0);
      },
      { watch: true },
    );
  },
);
