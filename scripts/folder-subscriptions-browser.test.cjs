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
const page = ts.createSourceFile(
  'feeds.tsx',
  fs.readFileSync(path.join(web, 'src/pages/feeds/index.tsx'), 'utf8'),
  99,
  true,
  ts.ScriptKind.TSX,
);
let onMove;
function visit(node) {
  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(page) === 'ManagementFolders'
  )
    onMove = node.attributes.properties
      .find((p) => p.name?.getText(page) === 'onMove')
      .initializer.expression.getText(page);
  ts.forEachChild(node, visit);
}
visit(page);
test(
  'actual folder component and move callback: native drop, failed multi-add, saved reload, dedup and 2000-option search',
  { skip: !browser, timeout: 120000 },
  async () => {
    await withFixture(
      `
import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {NextUIProvider} from ${modulePath(path.join(web, 'node_modules/@nextui-org/react/dist/index.mjs'))};
import ManagementFolders from ${modulePath(path.join(web, 'src/components/ManagementFolders.tsx'))};
function App(){
 const [rows,setRows]=useState(()=>JSON.parse(localStorage.getItem('rows')||'null')||Array.from({length:2000},(_,i)=>({id:'s'+i,name:'Subscription '+i,groupId:i===0?'g1':null})));
 const [busy,setBusy]=useState(false);const [filter,setFilter]=useState('g1');
 const movedIntoFolder=useRef(false),dragSnapshot=useRef(rows);const draggedItem=null;
 const setDraggedItem=()=>{};const setOrderedFeeds=setRows;const setSelectedIds=()=>{};
 const calls=useRef([]),fail=useRef(false);
 const queryUtils={feed:{list:{cancel:async()=>{},setData:(_,update)=>setRows(update({items:rows}).items)}}};
 const moveFeeds={mutateAsync:async({ids,groupId})=>{calls.current.push({ids,groupId});if(fail.current)throw Error(typeof fail.current==='string'?fail.current:'Synthetic save failed');const next=rows.map(row=>ids.includes(row.id)?{...row,groupId}:row);localStorage.setItem('rows',JSON.stringify(next));return {ids,groupId,moved:ids.length};}};
 const refetchFeedList=()=>new Promise(()=>{}); const toast={warning:()=>{}};
 window.fixture={rows,busy,filter,calls:calls.current,setFail:value=>{fail.current=value;}};
 return <ManagementFolders folders={[{id:'g1',name:'Folder A'},{id:'g2',name:'Folder B'}]} members={rows} filter={filter} selectedIds={[]} dragType="application/x-wewe-wechat" disabled={busy} onBusyChange={setBusy} onFilter={setFilter} onSave={async()=>{}} onRemove={async()=>{}} onMove={${onMove}}/>;
}
createRoot(document.getElementById('root')).render(<NextUIProvider><App/></NextUIProvider>);
`,
      async ({ evaluate, send, pause }) => {
        const target = await evaluate(
          `(()=>{const r=document.querySelectorAll('.folder-navigation-row')[2].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        const data = {
          items: [{ mimeType: 'application/x-wewe-wechat', data: 's1' }],
          dragOperationsMask: 16,
        };
        await send('Input.dispatchDragEvent', {
          type: 'dragEnter',
          ...target,
          data,
        });
        await send('Input.dispatchDragEvent', {
          type: 'drop',
          ...target,
          data,
        });
        await pause(80);
        assert.equal(await evaluate('window.fixture.rows[1].groupId'), 'g1');
        assert.equal(
          await evaluate('window.fixture.busy'),
          false,
          'stalled post-save list read does not retain UI lock',
        );
        assert.equal(await evaluate('window.fixture.calls.length'), 1);
        // Exact user-reported no-write failure: restore old membership, unlock
        // controls and allow navigation. A rejected move is never a success.
        await evaluate(
          `window.fixture.setFail('SQLite 一致性备份超时，本次未写入')`,
        );
        const other = await evaluate(
          `(()=>{const r=document.querySelectorAll('.folder-navigation-row')[3].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        await send('Input.dispatchDragEvent', {
          type: 'dragEnter',
          ...other,
          data,
        });
        await send('Input.dispatchDragEvent', { type: 'drop', ...other, data });
        await pause(80);
        assert.equal(await evaluate('window.fixture.rows[1].groupId'), 'g1');
        assert.equal(await evaluate('window.fixture.busy'), false);
        assert.match(
          await evaluate('document.querySelector("[role=alert]").textContent'),
          /SQLite 一致性备份超时，本次未写入/,
        );
        await evaluate(
          `document.querySelectorAll('.folder-filter')[3].click()`,
        );
        await pause(25);
        assert.equal(await evaluate('window.fixture.filter'), 'g2');
        await send('Page.reload');
        await pause(200);
        assert.equal(await evaluate('window.fixture.rows[1].groupId'), 'g1');
        const openPicker = async () => {
          await evaluate(
            `document.querySelectorAll('.folder-navigation-row')[2].querySelectorAll('button')[1].click()`,
          );
          await pause(80);
          await evaluate(
            `Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='添加订阅').click()`,
          );
          await pause(150);
        };
        await openPicker();
        assert.equal(
          await evaluate(
            'document.querySelectorAll("[role=dialog] input[type=checkbox]").length',
          ),
          50,
        );
        await evaluate(
          `window.fixture.setFail(true);Array.from(document.querySelectorAll('[role=dialog] input[type=checkbox]')).filter(n=>!n.disabled).slice(0,2).forEach(n=>n.click())`,
        );
        await pause(60);
        const add = () =>
          evaluate(
            `Array.from(document.querySelectorAll('[role=dialog] button')).find(n=>n.textContent.includes('添加所选')).click()`,
          );
        await add();
        await pause(100);
        assert.match(
          await evaluate('document.querySelector("[role=dialog]").innerText'),
          /Synthetic save failed/,
        );
        assert.equal(await evaluate('window.fixture.rows[2].groupId'), null);
        assert.equal(
          await evaluate(
            'document.querySelectorAll("[role=dialog] input[type=checkbox]:checked:not(:disabled)").length',
          ),
          2,
        );
        await evaluate('window.fixture.setFail(false)');
        await add();
        await pause(150);
        assert.equal(
          await evaluate('Boolean(document.querySelector("[role=dialog]"))'),
          false,
        );
        assert.deepEqual(
          await evaluate(
            'window.fixture.rows.slice(0,4).map(row=>row.groupId)',
          ),
          ['g1', 'g1', 'g1', 'g1'],
        );
        await send('Page.reload');
        await pause(200);
        assert.deepEqual(
          await evaluate(
            'window.fixture.rows.slice(0,4).map(row=>row.groupId)',
          ),
          ['g1', 'g1', 'g1', 'g1'],
        );
        await openPicker();
        assert.equal(
          await evaluate(
            'document.querySelectorAll("[role=dialog] input[type=checkbox]:checked:disabled").length',
          ),
          4,
        );
        const elapsed = await evaluate(
          `(async()=>{const start=performance.now();const input=document.querySelector('[aria-label="搜索已有订阅"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Subscription 1999');input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return performance.now()-start;})()`,
        );
        assert.equal(
          await evaluate(
            'document.querySelectorAll("[role=dialog] input[type=checkbox]").length',
          ),
          1,
        );
        assert(
          elapsed < 1000,
          `2000-member search renders in ${elapsed.toFixed(1)}ms`,
        );
        assert.equal(await evaluate('window.fixture.rows.length'), 2000);
      },
    );
  },
);
