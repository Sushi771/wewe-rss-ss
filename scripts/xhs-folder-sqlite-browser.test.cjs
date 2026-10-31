'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');const {test}=require('node:test');
const root=process.cwd(), server=path.join(root,'apps/server'),req=createRequire(path.join(server,'package.json'));
const {browser,withFixture,web,modulePath}=require('./offline-browser-fixture.cjs');
const ts=req('typescript'); const page=ts.createSourceFile('xiaohongshu.tsx',fs.readFileSync(path.join(web,'src/pages/feeds/xiaohongshu.tsx'),'utf8'),99,true,ts.ScriptKind.TSX);
let reorder,save;(function visit(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(page)==='ManagementFolders')for(const p of n.attributes.properties){if(p.name?.getText(page)==='onReorder')reorder=p.initializer.expression.getText(page);if(p.name?.getText(page)==='onSave')save=p.initializer.expression.getText(page)}ts.forEachChild(n,visit)})(page);
async function database(){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'xhs-folders-e2e-'));const url='file:'+path.join(dir,'fixture.sqlite').replace(/\\/g,'/');process.env.DATABASE_URL=url;
 process.env.TS_NODE_PROJECT=path.join(server,'tsconfig.json');req('ts-node/register/transpile-only');req('tsconfig-paths/register');
 const {PrismaClient}=req('@prisma/client'),{ConfigService}=req('@nestjs/config');
 const {XiaohongshuService}=req(path.join(server,'src/collection/xiaohongshu.service.ts'));
 const {TrpcService}=req(path.join(server,'src/trpc/trpc.service.ts')),{TrpcRouter}=req(path.join(server,'src/trpc/trpc.router.ts'));
 const {splitSqliteStatements}=require('./sqlite-statements.cjs');
 const prisma=new PrismaClient({datasources:{db:{url}}});
 const migrations=path.join(server,'prisma/migrations');for(const entry of (await fsp.readdir(migrations,{withFileTypes:true})).filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){
  const sql=await fsp.readFile(path.join(migrations,entry.name,'migration.sql'),'utf8');for(const stmt of splitSqliteStatements(sql).map(s=>s.trim()).filter(Boolean))await prisma.$executeRawUnsafe(stmt);
 }
 const config=new ConfigService({auth:{code:'fixture'},platform:{url:''},feed:{updateDelayTime:0}}), xhs=new XiaohongshuService(prisma), svc=new TrpcService(prisma,config,{},{});
 const api=new TrpcRouter(svc,prisma,config,{},{},xhs).appRouter.createCaller({errorMsg:null,isLocal:true,isLocalSave:true});
 const a=await api.xiaohongshu.saveGroup({name:'A'}),b=await api.xiaohongshu.saveGroup({name:'B'}),c=await api.xiaohongshu.saveGroup({name:'C'});
 await prisma.xhsCreator.create({data:{id:'synthetic-author',profileUrl:'https://example.invalid/synthetic',displayName:'Synthetic',groupId:b.id}});
 return {api,prisma,ids:{a:a.id,b:b.id,c:c.id},close:async()=>{await prisma.$disconnect();await fsp.rm(dir,{recursive:true,force:true})}};
}
function handler(db){return (req,res)=>{
 if(!req.url.startsWith('/fixture-api/'))return false;
 (async()=>{let body='';for await(const chunk of req)body+=chunk;if(body.length>30000)throw Error('fixture input too large');const arg=body?JSON.parse(body):{};let result;
 switch(req.url){case '/fixture-api/groups':result=await db.api.xiaohongshu.groups();break;case '/fixture-api/reorder':result=await db.api.xiaohongshu.reorderGroups(arg);break;case '/fixture-api/save':result=await db.api.xiaohongshu.saveGroup(arg);break;case '/fixture-api/creator':result=await db.prisma.xhsCreator.findUnique({where:{id:'synthetic-author'},select:{groupId:true}});break;default:throw Error('unknown fixture endpoint')}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));})().catch(e=>{res.writeHead(500,{'content-type':'text/plain'});res.end(String(e.message))});return true;
};}
const ui=`
import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {NextUIProvider} from ${modulePath(path.join(web,'node_modules/@nextui-org/react/dist/index.mjs'))};
import ManagementFolders from ${modulePath(path.join(web,'src/components/ManagementFolders.tsx'))};
const call=async (method,input)=>{const r=await fetch('/fixture-api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input||{})});if(!r.ok)throw Error(await r.text());return r.json()};
function App(){const [data,setData]=useState(null),[busy,setBusy]=useState(false),[filter,setFilter]=useState('all');
 const read=async()=>{const v=await call('groups');setData(v);return {data:v}};useEffect(()=>{void read()},[]);
 const utils={xiaohongshu:{groups:{cancel:async()=>{},setData:(_,fn)=>setData(v=>fn(v))}}};
 const reorderGroups={mutateAsync:(v)=>call('reorder',v)},saveGroup={mutateAsync:(v)=>call('save',v)},groups={refetch:read},toast={warning:()=>{}};
 window.fixture={data,busy};return data&&<ManagementFolders folders={data.items} filter={filter} selectedIds={[]} dragType="synthetic" disabled={busy} onBusyChange={setBusy} onFilter={setFilter} onSave={${save}} onRemove={async()=>{}} onMove={async()=>{}} onReorder={${reorder}}/>;
}createRoot(document.getElementById('root')).render(<NextUIProvider><App/></NextUIProvider>);`;
async function smoke(){const db=await database();try{await db.api.xiaohongshu.reorderGroups({ids:[db.ids.c,db.ids.a,db.ids.b],expectedIds:[db.ids.a,db.ids.b,db.ids.c]});assert.deepEqual((await db.api.xiaohongshu.groups()).items.map(g=>g.id),[db.ids.c,db.ids.a,db.ids.b]);}finally{await db.close()}}
if(process.env.XHS_FIXTURE_SMOKE==='1'){smoke().then(()=>console.log('synthetic sqlite router fixture passed')).catch(e=>{console.error(e);process.exitCode=1})} else test('xhs browser with real SQLite router preserves sorted groups after reload and creation',{skip:!browser,timeout:120000},async()=>{
 const db=await database();try{await withFixture(ui,async({evaluate,send,pause})=>{
  const wait=async condition=>{for(let i=0;i<100;i++){if(await evaluate(condition))return;await pause(50)}throw Error('fixture UI timeout: '+condition)};
  const ids=()=>evaluate('window.fixture.data?.items.map(x=>x.name)');
  const move=async(name,direction)=>{await evaluate(`document.querySelector('[aria-label="文件夹 ${name} 更多操作"]').click()`);await pause(100);await evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='${direction}').click()`);await wait('window.fixture.busy===false');await pause(100)};
  await wait('window.fixture.data?.items.length===3');await move('C','上移');assert.deepEqual(await ids(),['A','C','B']);await send('Page.reload');await wait('window.fixture.data?.items.length===3');assert.deepEqual(await ids(),['A','C','B']);
  await evaluate(`document.querySelector('[aria-label="新建文件夹"]').click()`);await pause(100);await evaluate(`(()=>{const i=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'D');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(100);await evaluate(`Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='保存').click()`);await wait('window.fixture.data?.items.length===4');await move('D','上移');assert.deepEqual(await ids(),['A','C','D','B']);await send('Page.reload');await wait('window.fixture.data?.items.length===4');assert.deepEqual(await ids(),['A','C','D','B']);
  assert.equal((await db.prisma.xhsCreator.findUnique({where:{id:'synthetic-author'}})).groupId,db.ids.b);
 },{}, {handleRequest:handler(db),cleanupOwnedFixture:true});}finally{await db.close()}
});
