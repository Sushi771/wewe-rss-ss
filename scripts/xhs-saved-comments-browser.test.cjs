'use strict';
const path=require('node:path'),assert=require('node:assert/strict'),{test}=require('node:test');
const {browser,withFixture,web,modulePath}=require('./offline-browser-fixture.cjs');
test('saved comments browser: open, close, paginate, expand, retry and switch note',{skip:!browser,timeout:120000},async()=>{
 const component=modulePath(path.join(web,'src/components/XhsSavedComments.tsx'));
 const mock=`import React from 'react'; export const trpc={xiaohongshu:{engagement:{useQuery:({noteId,offset})=>{const [failure,setFailure]=React.useState(noteId==='fail');return failure?{error:true,refetch:async()=>setFailure(false)}:{data:{comments:offset===0?[{id:'r',rootId:null,authorName:'甲',content:'中文长文本'.repeat(60),likes:0},{id:'c',rootId:'r',authorName:null,content:'回复内容',likes:null}]:[{id:'second',rootId:null,authorName:'乙',content:'第二页',likes:2}],windows:[{scope:'top',state:'partial',pages:1,collectedAt:1}],totalSaved:101,returned:offset===0?100:1}}}}}};`;
 const src=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Comments from ${component};function App(){const [note,setNote]=useState('');window.fixture=true;return <div style={{width:320}}><button onClick={()=>setNote('one')}>打开一</button><button onClick={()=>setNote('two')}>打开二</button><button onClick={()=>setNote('fail')}>打开失败</button><button onClick={()=>setNote('')}>关闭</button>{note&&<Comments key={note} creatorId="a" noteId={note}/>}</div>}createRoot(document.getElementById('root')).render(<App/>);`;
 await withFixture(src,async({evaluate,pause,send})=>{
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 const click=async label=>{await evaluate(`Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='${label}').click()`);await pause(80)};
 await click('打开一');assert.match(await evaluate('document.body.innerText'),/中文长文本/);assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),true);assert.equal(await evaluate('document.querySelector("section").scrollWidth <= document.querySelector("section").clientWidth'),true);await evaluate('document.querySelector("summary").click()');assert.match(await evaluate('document.body.innerText'),/回复内容/);
 await click('下一页');assert.match(await evaluate('document.body.innerText'),/第二页/);await click('打开二');assert.match(await evaluate('document.body.innerText'),/中文长文本/);assert.doesNotMatch(await evaluate('document.body.innerText'),/第二页/);
 await click('打开失败');assert.match(await evaluate('document.body.innerText'),/读取失败/);await click('重试读取');assert.match(await evaluate('document.body.innerText'),/中文长文本/);
 await click('关闭');assert.equal(await evaluate('document.querySelectorAll("section").length'),0);
 },{'@web/utils/trpc':`data:text/javascript;base64,${Buffer.from(mock).toString('base64')}`},{cleanupOwnedFixture:true});
});


test('late previous note or closed view cannot reappear',{skip:!browser,timeout:120000},async()=>{
 const component=modulePath(path.join(web,'src/components/XhsSavedComments.tsx'));
 const mock=`import React from 'react';export const trpc={xiaohongshu:{engagement:{useQuery:({noteId,offset})=>{const [data,setData]=React.useState(null);React.useEffect(()=>{let live=true;const put=()=>{if(live)setData({comments:[{id:noteId,rootId:null,authorName:'甲',content:noteId,likes:0}],windows:[],totalSaved:1,returned:1})};if(noteId==='A')window.resolveA=put;else put();return()=>{live=false}},[noteId,offset]);return data?{data}:{isLoading:true}}}}};`;
 const src=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Comments from ${component};function App(){const [note,setNote]=useState('');window.fixture=true;return <><button onClick={()=>setNote('A')}>A</button><button onClick={()=>setNote('B')}>B</button><button onClick={()=>setNote('')}>关闭</button>{note&&<Comments key={note} creatorId="a" noteId={note}/>}</>}createRoot(document.getElementById('root')).render(<App/>);`;
 await withFixture(src,async({evaluate,pause})=>{const click=async label=>{await evaluate(`Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='${label}').click()`);await pause(80)};
 await click('A');assert.match(await evaluate('document.body.innerText'),/正在读取/);await click('B');assert.match(await evaluate('document.querySelector("section").innerText'),/B/);await evaluate('window.resolveA()');await pause(80);assert.match(await evaluate('document.querySelector("section").innerText'),/B/);assert.equal(await evaluate('document.querySelector("section button").disabled'),true);
 await click('A');await click('关闭');await evaluate('window.resolveA()');await pause(80);assert.equal(await evaluate('document.querySelectorAll("section").length'),0);
 },{'@web/utils/trpc':`data:text/javascript;base64,${Buffer.from(mock).toString('base64')}`},{cleanupOwnedFixture:true});
});
