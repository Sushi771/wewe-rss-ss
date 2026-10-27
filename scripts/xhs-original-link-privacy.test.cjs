const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require(require.resolve('typescript',{paths:[path.resolve('apps/web')]}));
const {createTRPCProxyClient,httpBatchLink,httpLink,loggerLink,splitLink}=require(require.resolve('@trpc/client',{paths:[path.resolve('apps/web')]}));
const text=fs.readFileSync('apps/web/src/provider/trpc.tsx','utf8'),ast=ts.createSourceFile('provider.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);

let loggerOptions,condition;const onErrors=[];
function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='loggerLink')loggerOptions=n.arguments[0].getText(ast);if(ts.isCallExpression(n)&&n.expression.getText(ast)==='splitLink')condition=n.arguments[0].properties.find(p=>p.name?.getText(ast)==='condition').initializer.getText(ast);if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='onError')onErrors.push(n.getText(ast));ts.forEachChild(n,walk)}walk(ast);
function evaluate(expression,console){const code=ts.transpileModule('module.exports = '+expression,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;const module={exports:{}};new Function('module','console','isTRPCClientError',code)(module,console,()=>false);return module.exports}
test('actual mixed mutation responses and global error handlers never log a signed URL or error metadata',async()=>{
 const marker='SYNTHETIC_BATCH_SECRET',url='https://www.xiaohongshu.com/explore/00Synthetic?xsec_token='+marker+'&xsec_source=pc_user';
 const logs=[],sink={info:(...x)=>logs.push(x),log:(...x)=>logs.push(x),error:(...x)=>logs.push(x)};
 const result={result:{data:{state:'ready',url}}},error={error:{message:'fixed failure',code:-32603,data:{code:'INTERNAL_SERVER_ERROR',httpStatus:500}}};
 const requests=[];const fetch=async(input)=>{const u=new URL(String(input));requests.push(u.pathname);const body=u.pathname.includes(',')?[result,error]:u.pathname.endsWith('prepareOriginalLink')?result:error;return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})};
 // Exercise the exact logging projection even if a transport regresses to batching.
 for(const isolated of [false,true]){
  requests.length=0;
  const transport={url:'https://synthetic.invalid/trpc',fetch};const client=createTRPCProxyClient({links:[loggerLink(evaluate(loggerOptions,sink)),isolated?splitLink({condition:evaluate(condition,sink),true:httpLink(transport),false:httpBatchLink(transport)}):httpBatchLink(transport)]});
  const values=await Promise.allSettled([client.xiaohongshu.prepareOriginalLink.mutate({noteId:'synthetic'}),client.xiaohongshu.saveGroup.mutate({id:'synthetic'})]);
  assert.equal(values[0].status,'fulfilled');assert.equal(values[1].status,'rejected');assert.equal(values[1].reason.message,'fixed failure');assert.equal(values[0].value.url,url);assert.equal(requests.length,isolated?2:1);assert.equal(JSON.stringify(values[1].reason.meta).includes(marker),!isolated);
  for(const fn of onErrors)evaluate('({'+fn+'}).onError',sink)(values[1].reason);
 }
 assert.equal(onErrors.length,2);assert(!JSON.stringify(logs).includes(marker));assert(!JSON.stringify(logs).includes('responseJSON'));assert(logs.some(x=>x[0]==='trpc'&&x[1]?.type==='mutation'));assert(logs.length>0);
});

test('bounded recovery is isolated and excluded from signed-input logging',()=>{
 const sink={info:()=>{throw Error('unexpected log')},log:()=>{throw Error('unexpected log')},error:()=>{throw Error('unexpected log')}};
 const logger=evaluate(loggerOptions,sink), split=evaluate(condition,sink);
 for(const direction of ['up','down'])assert.equal(logger.enabled({path:'xiaohongshu.recoverSingleNote',direction}),false);
 assert.equal(split({path:'xiaohongshu.recoverSingleNote'}),true);
});

test('batch creation and context resubmission are isolated and never enter logs',()=>{
 const sink={info:()=>{throw Error('unexpected log')},log:()=>{throw Error('unexpected log')},error:()=>{throw Error('unexpected log')}};
 const logger=evaluate(loggerOptions,sink),split=evaluate(condition,sink);
 for(const path of ['xiaohongshu.startSubscriptionBatch','xiaohongshu.resumeSubscriptionBatch']){
  for(const direction of ['up','down'])assert.equal(logger.enabled({path,direction,input:{text:'synthetic-secret'}}),false);
  assert.equal(split({path}),true);
 }
});
