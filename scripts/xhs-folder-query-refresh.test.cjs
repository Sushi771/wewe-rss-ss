'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test');
const ts=require(require.resolve('typescript',{paths:[path.resolve('apps/web')]}));
const {QueryClient,QueryObserver}=require(require.resolve('@tanstack/react-query',{paths:[path.resolve('apps/web')]}));
const source=ts.createSourceFile('xiaohongshu.tsx',fs.readFileSync('apps/web/src/pages/feeds/xiaohongshu.tsx','utf8'),99,true,ts.ScriptKind.TSX);let callback;
(function visit(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(source)==='ManagementFolders')callback=n.attributes.properties.find(p=>p.name?.getText(source)==='onMove').initializer.expression.getText(source);ts.forEachChild(n,visit)})(source);
test('real QueryClient surfaces refresh failure while a second refresh hangs and saved membership stays visible',async()=>{
 const warnings=[],optionsSeen=[],client=new QueryClient({logger:{log(){},warn(){},error(){}},defaultOptions:{queries:{retry:false,staleTime:Infinity,cacheTime:Infinity}}});
 const initial={items:[{id:'author',groupId:null}]},filter={metric:'fans'};const keys={groups:['groups'],list:['list'],notes:['notes']};
 client.setQueryData(keys.groups,{items:[]});client.setQueryData([...keys.list,filter],initial);client.setQueryData([...keys.list,undefined],initial);client.setQueryData(keys.notes,{items:[]});
 const observers=[new QueryObserver(client,{queryKey:keys.groups,queryFn:async()=>{throw Error('synthetic failed reread')}}),new QueryObserver(client,{queryKey:[...keys.list,filter],queryFn:async()=>new Promise(()=>{})}),new QueryObserver(client,{queryKey:keys.notes,queryFn:async()=>({items:[]})})];const unsubscribe=observers.map(o=>o.subscribe(()=>{}));
 const make=(key)=>({invalidate:(_input,filters,options)=>{optionsSeen.push(options);return client.invalidateQueries({queryKey:key,...filters},options)}});
 const list={...make(keys.list),cancel:()=>client.cancelQueries({queryKey:keys.list}),setData:(input,update)=>client.setQueryData([...keys.list,input],update)};
 let selection='not-cleared',notesSelection='not-cleared';
 const scope={utils:{xiaohongshu:{groups:make(keys.groups),list,notes:make(keys.notes)}},moveCreators:{mutateAsync:async input=>({ids:input.ids,groupId:input.groupId})},creatorMetricFilter:filter,setSelectedCreators:v=>selection=v,setSelectedIds:v=>notesSelection=v,Set,Promise,toast:{warning:s=>warnings.push(s)}};
 const code=ts.transpileModule(`(${callback})`,{compilerOptions:{target:9}}).outputText;const move=vm.runInNewContext(code,scope);
 try{let resolved=false;await move(['author'],'folder').then(()=>resolved=true);assert.equal(resolved,true);await new Promise(r=>setImmediate(r));
 assert.equal(client.getQueryData([...keys.list,filter]).items[0].groupId,'folder');assert.equal(client.getQueryData([...keys.list,undefined]).items[0].groupId,'folder');assert.equal(selection.length,0);assert.equal(notesSelection.size,0);
 assert.equal(warnings.length,1);assert.match(warnings[0],/分类已保存，列表刷新失败/);assert.equal(optionsSeen.length,3);assert(optionsSeen.every(o=>o.throwOnError===true));
 }finally{unsubscribe.forEach(u=>u());client.clear()}
});
