const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const source=fs.readFileSync('apps/web/src/pages/feeds/index.tsx','utf8');
const tree=ts.createSourceFile('index.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler;
function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='handleBatchExport')handler=n.initializer.getText(tree);ts.forEachChild(n,walk);}
walk(tree);assert(handler);
const js=ts.transpileModule('return ('+handler+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const helperModule={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('apps/web/src/utils/export-article-batches.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(helperModule,helperModule.exports);
function harness({scopeFailure=false,transport,helper=helperModule.exports.exportArticleBatches,size=130}={}){
 const state={result:'',notices:[],requests:0,scopeCalls:0,selectionClears:0,busy:[],selected:new Set(Array.from({length:size},(_,i)=>String(i)))};
 const refs={batchExporting:{current:false},exportCancelled:{current:false},exportController:{current:null}};
 const toast=Object.fromEntries(['warning','error','success'].map(kind=>[kind,(message,options)=>state.notices.push({kind,message,...options})]));
 const queryUtils={client:{article:{exportIds:{query:async()=>{state.scopeCalls++;if(scopeFailure)throw Error('private diagnostic');return [...state.selected];}},saveToObsidianBatch:{mutate:async({ids},{signal})=>{state.requests++;return transport(ids,signal,state,refs);}}}}};
 const args={...refs,articleSelectedIds:state.selected,dateError:null,setIsBatchExporting:v=>state.busy.push(v),queryUtils,id:'feed',articleDateFilter:{dateStart:'2026-01-01'},folderFilter:'all',search:'',setExportResult:v=>state.result=v,exportArticleBatches:helper,toast,setArticleSelectedIds:fn=>{const next=fn(state.selected);if(next.size===0)state.selectionClears++;}};
 const fn=new Function(...Object.keys(args),js)(...Object.values(args));
 return {fn,state,refs};
}
const success=ids=>({cancelled:false,results:ids.map(id=>({id,saved:{markdownPath:id+'.md',alreadySaved:false,status:'new'}}))});
test('AUDIT B: malformed later receipt preserves 64 acknowledgements, selection and no retry',async()=>{
 const h=harness({transport:async(ids,signal,state)=>state.requests===1?success(ids):{cancelled:false,results:[{id:'foreign',saved:{markdownPath:'x'}}]}});
 await h.fn();
 assert.equal(h.state.requests,2);assert.equal(h.state.selectionClears,0);
 assert.match(h.state.result,/导出中断，已停止：新增 64/);
 assert.equal(h.state.notices[0].kind,'warning');assert.match(h.state.notices[0].description,/不会自动重试/);
 assert.doesNotMatch(JSON.stringify(h.state.notices),/foreign|private diagnostic|正在导出/);
 assert.deepEqual(h.state.busy,[true,false]);assert.equal(h.refs.batchExporting.current,false);assert.equal(h.refs.exportController.current,null);
});
test('AUDIT B: callback failure after one acknowledged save uses interrupted path, not range error',async()=>{
 const helper=async(ids,send,onSaved)=>{await onSaved({markdownPath:'old.md',alreadySaved:true,status:'skipped'},'0');throw Error('backend-secret-diagnostic');};
 const h=harness({helper,size:2});await h.fn();
 assert.match(h.state.result,/导出中断，已停止：新增 0 · 跳过 1/);assert.equal(h.state.selectionClears,0);
 assert.doesNotMatch(JSON.stringify(h.state.notices),/backend-secret|未能取得完整导出范围/);
});
test('AUDIT B: range failure does not submit a save and gives a stable terminal result',async()=>{
 const h=harness({scopeFailure:true});await h.fn(true);
 assert.equal(h.state.requests,0);assert.equal(h.state.scopeCalls,1);assert.equal(h.state.selectionClears,0);
 assert.equal(h.state.result,'未能取得完整导出范围');assert.equal(h.state.notices[0].kind,'error');assert.match(h.state.notices[0].description,/已有文件会保留/);
});
test('AUDIT B: two same-tick clicks cause one batch sequence even if that sequence throws',async()=>{
 let release;
 const h=harness({size:1,transport:()=>new Promise(r=>{release=r;})});
 const first=h.fn();await h.fn();assert.equal(h.state.requests,1);
 release({cancelled:false,results:[]});await first;
 assert.equal(h.state.requests,1);assert.equal(h.state.selectionClears,0);assert.match(h.state.result,/导出中断/);
});
test('AUDIT B: response loss stops later batches, retains confirmed prefix and never resubmits',async()=>{
 const h=harness({transport:async(ids,signal,state)=>{if(state.requests===2)throw Error('lost response');return success(ids);}});
 await h.fn();assert.equal(h.state.requests,2);assert.match(h.state.result,/已停止后续导出：新增 64/);assert.match(h.state.notices[0].description,/不会自动重试/);assert.equal(h.state.selectionClears,0);
});
test('AUDIT B: unchanged normal completion preserves save classifications and clears only same selection',async()=>{
 const h=harness({size:2,transport:async ids=>({cancelled:false,results:[{id:ids[0],saved:{markdownPath:'protected.md',alreadySaved:true,status:'skipped',legacyLayoutRetained:true}},{id:ids[1],saved:{markdownPath:'repaired.md',alreadySaved:false,status:'repaired'}}]})});
 await h.fn();assert.equal(h.state.requests,1);assert.match(h.state.result,/新增 0 · 跳过 1 · 补齐 1 · 失败 0/);assert.equal(h.state.selectionClears,1);assert.match(h.state.notices[0].description,/保留原有位置及编辑/);
});
