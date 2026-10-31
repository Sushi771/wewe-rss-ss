'use strict';
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), assert=require('node:assert/strict');
const {test}=require('node:test');
const ts=require(require.resolve('typescript',{paths:[path.resolve('apps/web')]}));
const page=ts.createSourceFile('xiaohongshu.tsx',fs.readFileSync('apps/web/src/pages/feeds/xiaohongshu.tsx','utf8'),99,true,ts.ScriptKind.TSX);
let reorderSource,saveSource;
(function visit(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(page)==='ManagementFolders'){
 for(const p of n.attributes.properties){if(p.name?.getText(page)==='onReorder')reorderSource=p.initializer.expression.getText(page);if(p.name?.getText(page)==='onSave')saveSource=p.initializer.expression.getText(page);}}
 ts.forEachChild(n,visit);})(page);
function setup(selectedIds=[]){
 let server=['a','b','c'].map((id,order)=>({id,name:id,order})), cache={items:server.map(x=>({...x}))}, fail=false, hold=false, release;
 const moves=[];const membership={author1:'b',author2:'a'};const calls=[];
 const utils={xiaohongshu:{groups:{cancel:async()=>{},setData:(_,fn)=>{cache=fn(cache)}}}};
 const reorderGroups={mutateAsync:async ({ids,expectedIds})=>{calls.push([...ids]);if(hold)await new Promise(r=>release=r);if(fail)throw Error('synthetic failure');assert.deepEqual([...expectedIds],server.map(x=>x.id));server=ids.map((id,order)=>({...server.find(x=>x.id===id),order}));return {ids:[...ids]};}};
 const saveGroup={mutateAsync:async ({name})=>{const item={id:name,name,order:server.length};server=[...server,item];return item;}};
 const groups={refetch:async()=>{cache={items:server.map(x=>({...x}))};return {data:cache}}};
 const scope={utils,reorderGroups,saveGroup,groups,Map,toast:{warning:()=>{}}};
 const compile=src=>vm.runInNewContext(ts.transpileModule(`(${src})`,{compilerOptions:{target:9}}).outputText,scope);
 const onReorder=compile(reorderSource),onSave=compile(saveSource);
 let pos=0,slots=[],busy=false;
 const react={useState(v){const i=pos++;if(!(i in slots))slots[i]=v;return [slots[i],n=>slots[i]=typeof n==='function'?n(slots[i]):n]},useRef(v){const i=pos++;return slots[i]??(slots[i]={current:v})}};
 const jsx={jsx:(type,props)=>({type,props:props||{}}),jsxs:(type,props)=>({type,props:props||{}})};
 const src=fs.readFileSync('apps/web/src/components/ManagementFolders.tsx','utf8');
 const out=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const mod={exports:{}};new Function('require','module','exports',out)((name)=>{
 if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;
 if(name==='@nextui-org/react'||name==='@web/components/AppOverlays')return new Proxy({}, {get:(_,k)=>k});
 if(name==='@web/components/OperationNotice')return {FailureNotice:'FailureNotice'};
 if(name==='./FolderDragRow'||name==='./FolderMemberPicker')return {__esModule:true,default:name};throw Error(name);
 },mod,mod.exports);
 function draw(){pos=0;return mod.exports.default({folders:cache.items,filter:'all',selectedIds,dragType:'synthetic',disabled:busy,onFilter(){},onSave,onRemove:async()=>{},onMove:async(ids,groupId)=>moves.push({ids,groupId}),onBusyChange:v=>busy=v,onReorder});}
 function nodes(tree,fn){const out=[];(function walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(walk);return;}if(fn(n))out.push(n);walk(n.props?.children)})(tree);return out;}
 const menu=(id)=>nodes(draw(),n=>n.type==='DropdownMenu'&&n.props['aria-label']===`文件夹 ${id} 操作`)[0];
 return {draw,nodes,menu,calls,moves,membership,ids:()=>Array.from(cache.items,x=>x.id),reload:()=>{cache={items:server.map(x=>({...x}))}},fail:v=>fail=v,hold:v=>hold=v,release:()=>release()};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('synthetic xhs folders: boundaries, up/down, new item, refresh, repeat click and failure',async()=>{
 const f=setup();let menu=f.menu('a');assert.equal(f.nodes(menu,n=>n.type==='DropdownItem'&&n.props.children==='上移')[0].props.isDisabled,true);menu.props.onAction('up');
 menu=f.menu('c');assert.equal(f.nodes(menu,n=>n.type==='DropdownItem'&&n.props.children==='下移')[0].props.isDisabled,true);menu.props.onAction('down');assert.equal(f.calls.length,0);
 f.menu('b').props.onAction('up');await tick();assert.deepEqual(f.ids(),['b','a','c']);
 f.menu('b').props.onAction('down');await tick();assert.deepEqual(f.ids(),['a','b','c']);
 f.hold(true);menu=f.menu('c');menu.props.onAction('up');menu.props.onAction('up');await tick();assert.equal(f.calls.length,3);f.release();await tick();f.hold(false);assert.deepEqual(f.ids(),['a','c','b']);
 f.fail(true);f.menu('c').props.onAction('up');await tick();assert.deepEqual(f.ids(),['a','c','b']);assert.ok(f.nodes(f.draw(),n=>n.props.role==='alert').length);f.fail(false);
 let tree=f.draw();f.nodes(tree,n=>n.type==='Button'&&n.props['aria-label']==='新建文件夹')[0].props.onPress();tree=f.draw();f.nodes(tree,n=>n.type==='Input'&&n.props.label==='文件夹名称')[0].props.onValueChange('d');tree=f.draw();f.nodes(tree,n=>n.type==='Button'&&n.props.children==='保存')[0].props.onPress();await tick();assert.deepEqual(f.ids(),['a','c','b','d']);
 f.menu('d').props.onAction('up');await tick();assert.deepEqual(f.ids(),['a','c','d','b']);f.reload();assert.deepEqual(f.ids(),['a','c','d','b']);assert.deepEqual(f.membership,{author1:'b',author2:'a'});
});



test('shared folder move permits 100 and reports 101 without submitting or truncating',async()=>{
 for(const count of [100,101]){const f=setup(Array.from({length:count},(_,i)=>'id'+i));const tree=f.draw();const button=f.nodes(tree,n=>n.type==='Button'&&n.props.children==='移动已选')[0];button.props.onPress();await tick();
 if(count===100){assert.equal(f.moves.length,1);assert.equal(f.moves[0].ids.length,100)}else{assert.equal(f.moves.length,0);assert.ok(f.nodes(f.draw(),n=>n.props.role==='alert').length)}
 }
});
