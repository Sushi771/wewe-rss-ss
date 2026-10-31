'use strict';const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const from=path.resolve('apps/web'), resolve=n=>require(require.resolve(n,{paths:[from]})),ts=resolve('typescript');
const src=fs.readFileSync('apps/web/src/components/XhsWholeCreator.tsx','utf8');
function fixture(job,selectedNoteIds){let pos=0,slots=[],calls=[],refetches=0,work=async()=>({});
 const hooks={useState(v){const i=pos++;if(!(i in slots))slots[i]=v;return [slots[i],x=>slots[i]=typeof x==='function'?x(slots[i]):x]},useRef(v){const i=pos++;return slots[i]??(slots[i]={current:v})}};
 const trpc={xiaohongshu:{resumeWholeCreatorMedia:{useMutation:opts=>{assert.equal(opts.retry,false);return {mutateAsync:async input=>{calls.push(input);return work()}}}},resumeWholeCreatorMissingBasic:{useMutation:opts=>{assert.equal(opts.retry,false);return {mutateAsync:async input=>{calls.push(input);return work()}}}}}};
 const out=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,mod={exports:{}};
 new Function('require','exports','module',out)(n=>n==='react'?hooks:n==='@web/utils/trpc'?{trpc}:resolve(n),mod.exports,mod);
 const draw=()=>{pos=0;return mod.exports.XhsSelectedMedia({job,selectedNoteIds,refresh:async()=>{refetches++}})};
 const nodes=(tree,fn)=>{const a=[];(function walk(n){if(n==null)return;if(Array.isArray(n)){n.forEach(walk);return}if(typeof n!=='object')return;if(fn(n))a.push(n);walk(n.props?.children)})(tree);return a};
 const strings=tree=>{const out=[];(function walk(n){if(n==null)return;if(Array.isArray(n)){n.forEach(walk);return}if(typeof n==='string'){out.push(n);return}if(typeof n==='object')walk(n.props?.children)})(tree);return out.join(' ')};
 return{draw,nodes,strings,calls,setJob:v=>job=v,setSelected:v=>selectedNoteIds=v,setWork:v=>work=v,get refetches(){return refetches}};
}
const id=JSON.stringify(['xiaohongshu','note','n1']),other=JSON.stringify(['xiaohongshu','note','n2']);
const job={id:'job',state:'partial',items:[{noteId:id,title:'一',mediaResult:'needs-review'},{noteId:other,title:'二',mediaResult:'needs-detail-refresh'}],generationRecovery:{id:'gen',directoryComplete:true,resumable:true,excludedIds:[]}};
const tick=()=>new Promise(r=>setImmediate(r));
test('media resume needs explicit confirmation, binds selection, dispatches once and never silently retries',async()=>{
 const f=fixture(job,[id]);let tree=f.draw(),btn=()=>f.nodes(tree,n=>n.type==='button').at(-1),box=()=>f.nodes(tree,n=>n.type==='input').at(-1);
 assert.match(f.strings(tree),/图片清单缺失或待核对/);assert.match(f.strings(tree),/需受控刷新详情/);assert.equal(btn().props.disabled,true);assert.equal(f.calls.length,0);
 box().props.onChange({target:{checked:true}});tree=f.draw();f.setSelected([other]);tree=f.draw();assert.equal(btn().props.disabled,true);
 box().props.onChange({target:{checked:true}});tree=f.draw();let release;f.setWork(()=>new Promise(r=>release=r));btn().props.onClick();btn().props.onClick();assert.deepEqual(f.calls,[{jobId:'job',generationId:'gen',noteIds:[other]}]);release({});await tick();tree=f.draw();assert.equal(f.refetches,1);assert.equal(btn().props.disabled,true);
});
test('unknown, restricted, excluded, and foreign selections cannot submit; results remain honest',()=>{
 for(const altered of [{...job,state:'paused'}, {...job,generationRecovery:{...job.generationRecovery,resumable:false}}, {...job,generationRecovery:{...job.generationRecovery,newResult:'unknown'}},{...job,generationRecovery:{...job.generationRecovery,newResult:'restricted'}},{...job,generationRecovery:{...job.generationRecovery,excludedIds:[id]}}]){
 const f=fixture(altered,[id]),tree=f.draw();assert.equal(f.nodes(tree,n=>n.type==='button').at(-1).props.disabled,true);assert.equal(f.calls.length,0);
 }
 const f=fixture(job,['other-id']),tree=f.draw();assert.equal(f.nodes(tree,n=>n.type==='button').at(-1).props.disabled,true);assert.match(f.strings(tree),/不在可续补范围/);
 const complete=fixture({...job,items:[{noteId:id,title:'一',mediaResult:'complete'}]},[]);assert.match(complete.strings(complete.draw()),/图片已验证保存/);
});
test('lost acknowledgment refreshes status and never automatically retries',async()=>{
 const f=fixture(job,[id]);let tree=f.draw();f.nodes(tree,n=>n.type==='input').at(-1).props.onChange({target:{checked:true}});tree=f.draw();f.setWork(async()=>{throw Error('lost')});f.nodes(tree,n=>n.type==='button').at(-1).props.onClick();await tick();tree=f.draw();assert.equal(f.calls.length,1);assert.equal(f.refetches,1);assert.match(f.strings(tree),/不会自动重发/);assert.equal(f.nodes(tree,n=>n.type==='button').at(-1).props.disabled,true);
});


test('recovery basic requires selected confirmation and distinguishes nothing missing from submitted task',async()=>{
 for(const [receipt,label] of [[{state:'nothing-missing'},/基础字段已齐全/],[{id:'job',state:'queued'},/已提交所选基础缺项/]]){
 const f=fixture(job,[id]);let tree=f.draw();const button=()=>f.nodes(tree,n=>n.type==='button')[0];assert.equal(button().props.disabled,true);f.nodes(tree,n=>n.type==='input')[0].props.onChange({target:{checked:true}});tree=f.draw();f.setWork(async()=>receipt);button().props.onClick();await tick();tree=f.draw();assert.deepEqual(f.calls,[{jobId:'job',generationId:'gen',noteIds:[id]}]);assert.match(f.strings(tree),label);assert.equal(f.refetches,1);assert.equal(button().props.disabled,true);
 }
});


test('only recovered unknown IDs are eligible for media, without widening selection or refreshing details',async()=>{
 const j={...job,generationRecovery:{...job.generationRecovery,excludedIds:[id,other],mediaRecoverableIds:[id]}};
 const f=fixture(j,[id]);let tree=f.draw();const buttons=()=>f.nodes(tree,n=>n.type==='button');const boxes=()=>f.nodes(tree,n=>n.type==='input');
 assert.equal(buttons()[0].props.disabled,true);boxes().at(-1).props.onChange({target:{checked:true}});tree=f.draw();assert.equal(buttons().at(-1).props.disabled,false);
 buttons().at(-1).props.onClick();await tick();assert.deepEqual(f.calls,[{jobId:'job',generationId:'gen',noteIds:[id]}]);
 const blocked=fixture(j,[id,other]);tree=blocked.draw();assert.equal(blocked.nodes(tree,n=>n.type==='button').at(-1).props.disabled,true);assert.equal(blocked.calls.length,0);assert.match(blocked.strings(tree),/需受控刷新详情/);
});
