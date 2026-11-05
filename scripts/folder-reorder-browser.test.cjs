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
const source = ts.createSourceFile(
  'feeds.tsx',
  fs.readFileSync(path.join(web, 'src/pages/feeds/index.tsx'), 'utf8'),
  99,
  true,
  ts.ScriptKind.TSX,
);
let callback;
function visit(node) {
  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(source) === 'ManagementFolders'
  )
    callback = node.attributes.properties
      .find((p) => p.name?.getText(source) === 'onReorder')
      .initializer.expression.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
test(
  'real folder menu releases saved sort despite a hanging read and preserves a rejected sort',
  { skip: !browser, timeout: 120000 },
  async () => {
    await withFixture(
      `
import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {NextUIProvider} from ${modulePath(path.join(web, 'node_modules/@nextui-org/react/dist/index.mjs'))};
import ManagementFolders from ${modulePath(path.join(web, 'src/components/ManagementFolders.tsx'))};
function App(){
 const [items,setItems]=useState(()=>['a','b','c'].map((id,order)=>({id,name:id,order})));
 const [busy,setBusy]=useState(false);const [filter,setFilter]=useState('all');
 const fail=useRef(false),reads=useRef([]),warnings=useRef([]),calls=useRef([]);
 const queryUtils={feed:{groups:{cancel:async()=>{},setData:(_,update)=>setItems(update({items}).items)}}};
 const reorderFolders={mutateAsync:async(input)=>{calls.current.push(input);if(fail.current)throw Error('Synthetic order rejected');return {ids:input.ids};}};
 const folders={refetch:()=>new Promise(resolve=>reads.current.push(resolve))};
 const toast={warning:message=>warnings.current.push(message)};
 window.fixture={busy,items,filter,calls:calls.current,warnings:warnings.current,setFail:value=>{fail.current=value;},failRead:()=>reads.current.at(-1)({error:Error('Synthetic reread failed')})};
 return <ManagementFolders folders={items} filter={filter} selectedIds={[]} dragType="application/x-wewe-wechat" disabled={busy} onBusyChange={setBusy} onFilter={setFilter} onSave={async()=>{}} onRemove={async()=>{}} onMove={async()=>{}} onReorder={${callback}}/>;
}
createRoot(document.getElementById('root')).render(<NextUIProvider><App/></NextUIProvider>);
`,
      async ({ evaluate, pause }) => {
        const down = async () => {
          await evaluate(
            `document.querySelector('[data-sort-folder="a"]').querySelectorAll('button')[2].click()`,
          );
          await pause(100);
          await evaluate(
            `Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent==='下移').click()`,
          );
          await pause(120);
        };
        await down();
        assert.equal(await evaluate('window.fixture.busy'), false);
        assert.deepEqual(
          await evaluate('window.fixture.items.map(item=>item.id)'),
          ['b', 'a', 'c'],
        );
        await evaluate('window.fixture.failRead()');
        await pause(40);
        assert.match(
          await evaluate('window.fixture.warnings[0]'),
          /排序已保存/,
        );
        assert.equal(
          await evaluate('Boolean(document.querySelector("[role=alert]"))'),
          false,
        );
        await evaluate('window.fixture.setFail(true)');
        await down();
        assert.equal(await evaluate('window.fixture.busy'), false);
        assert.deepEqual(
          await evaluate('window.fixture.items.map(item=>item.id)'),
          ['b', 'a', 'c'],
        );
        assert.match(
          await evaluate('document.querySelector("[role=alert]").textContent'),
          /Synthetic order rejected/,
        );
        assert.equal(await evaluate('window.fixture.calls.length'), 2);
        await evaluate(
          'document.querySelectorAll(".folder-filter")[0].click()',
        );
        await pause(20);
        assert.equal(await evaluate('window.fixture.filter'), 'all');
      },
    );
  },
);
