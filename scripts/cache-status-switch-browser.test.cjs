'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');
const ts = require(require.resolve('typescript', { paths: [web] }));
// Keep the actual page's sibling keys: this test reproduced orphan status DOM
// with the old duplicate key, using installed React rather than mocked hooks.
const page = ts.createSourceFile(
  'feeds.tsx',
  fs.readFileSync(path.join(web, 'src/pages/feeds/index.tsx'), 'utf8'),
  99,
  true,
  ts.ScriptKind.TSX,
);
let statusElement, detailsOpening;
function visit(node) {
  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(page) === 'CacheSyncStatus'
  )
    statusElement = node.getText(page);
  if (
    ts.isJsxOpeningElement(node) &&
    node.tagName.getText(page) === 'details' &&
    node.attributes.getText(page).includes('feed-reading-details')
  )
    detailsOpening = node.getText(page);
  ts.forEachChild(node, visit);
}
visit(page);
test(
  'actual sibling keys: twenty switches, StrictMode, late old read and repeat renders keep one current diagnostic',
  { skip: !browser, timeout: 120000 },
  async () => {
    const stub = path.resolve('scripts/.cache-status-query-fixture.ts');
    fs.writeFileSync(
      stub,
      `import {useQuery} from '@tanstack/react-query'; export const trpc={feed:{cacheSyncStatus:{useQuery:(_input,options)=>useQuery({queryKey:['cacheSyncStatus'],queryFn:()=>window.fixture.read(),...options})}}};`,
    );
    try {
      await withFixture(
        `
import React,{useState,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import CacheSyncStatus from ${modulePath(path.join(web, 'src/pages/feeds/cache-sync-status.tsx'))};
const queryClient=new QueryClient();
let finish; let reads=0;
const snapshot=Array.from({length:21},(_,i)=>({feedId:'f'+i,state:'media-pending',upstreamCheckTime:'2026-10-14T14:'+String(i).padStart(2,'0')+':00Z'}));
function App(){const [currentMpId,setId]=useState('f0'); const [version,setVersion]=useState(0);
window.fixture={switchTo:setId,rerender:()=>setVersion(v=>v+1),read:()=>{reads++;return new Promise(resolve=>{finish=resolve;});},resolve:()=>finish({feeds:snapshot}),seed:()=>queryClient.setQueryData(['cacheSyncStatus'],{feeds:snapshot}),fail:()=>queryClient.getQueryCache().find(['cacheSyncStatus']).setState({status:'error',error:Error('synthetic failed read')}),reads:()=>reads};
return <div data-version={version}>{${statusElement}}{${detailsOpening}<summary>Source details</summary></details>}<div id="date-filter">Date filter</div></div>;
}
createRoot(document.getElementById('root')).render(<StrictMode><QueryClientProvider client={queryClient}><App/></QueryClientProvider></StrictMode>);
`,
        async ({ evaluate, pause }) => {
          await evaluate('window.fixture.seed()');
          await pause(80);
          const count = () =>
            evaluate('document.querySelectorAll("p[role=status]").length');
          assert.equal(await count(), 1);
          for (let i = 1; i <= 20; i++) {
            await evaluate(`window.fixture.switchTo('f${i}')`);
            await pause(25);
            assert.equal(
              await count(),
              1,
              `switch ${i} must replace old diagnostic DOM`,
            );
          }
          await evaluate('window.fixture.resolve();window.fixture.rerender()');
          await pause(80);
          assert.equal(await count(), 1);
          assert.match(
            await evaluate(
              'document.querySelector("p[role=status]").textContent',
            ),
            /:20/,
          );
          for (let i = 0; i < 10; i++) {
            await evaluate('window.fixture.rerender()');
            await pause(10);
          }
          assert.equal(await count(), 1);
          await evaluate('window.fixture.fail()');
          await pause(40);
          assert.match(await evaluate('document.body.innerText'), /暂无法读取/);
          assert.equal(await count(), 1);
        },
        { '@web/utils/trpc': stub },
      );
    } finally {
      fs.unlinkSync(stub);
    }
  },
);
