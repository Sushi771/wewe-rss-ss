const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {waitHeldManagementReady}=require('./held-management-readiness.cjs');
const original={...process.env}, originalFetch=global.fetch;
const expected={id:'synthetic-release',sha256:'a'.repeat(64),database:require('node:path').resolve('synthetic.sqlite')};
const healthy={...expected,httpReady:true,databaseReadable:true,readOnly:false};
const ready={status:'ready',writesAllowed:true,databaseRecovery:'ready'};
afterEach(()=>{process.env={...original};global.fetch=originalFetch;});
function setup(health=healthy,startup=ready){
 process.env.WECHAT2RSS_RECOVERY_HOLD='1';delete process.env.PRIVATE_ONLINE_MODE;
 const calls=[];global.fetch=async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/startup-status')?startup:health);};return calls;
}
test('held management uses only bound local GET health; source routes and hold remain unchanged',async()=>{
 const calls=setup();assert.equal((await waitHeldManagementReady(4111,{exitCode:null},expected)).mode,'held-local-management');
 assert.deepEqual(calls.map(x=>x.url),['http://127.0.0.1:4111/_local/update-health','http://127.0.0.1:4111/startup-status']);
 assert(calls.every(x=>x.options.method==='GET'&&x.options.redirect==='error'&&!x.options.headers&&!x.options.body));
 assert.equal(process.env.WECHAT2RSS_RECOVERY_HOLD,'1');
});
for(const key of ['id','sha256','database'])test('rejects mismatched '+key,async()=>{
 setup({...healthy,[key]:'different'});await assert.rejects(waitHeldManagementReady(4111,null,expected),/HELD_READINESS_IDENTITY_MISMATCH/);
});
for(const [key,value] of [['httpReady',false],['databaseReadable',false],['readOnly',true]])test('cannot claim post-commit readiness with '+key,async()=>{
 setup({...healthy,[key]:value});await assert.rejects(waitHeldManagementReady(4111,null,expected,{timeoutMs:5,retryMs:1}),/HELD_MANAGEMENT_NOT_READY/);
});
for(const state of [{...ready,writesAllowed:false},{...ready,status:'verifying'},{...ready,databaseRecovery:'failed'}])test('retains startup/write gate '+JSON.stringify(state),async()=>{
 setup(healthy,state);await assert.rejects(waitHeldManagementReady(4111,null,expected,{timeoutMs:5,retryMs:1}),/HELD_MANAGEMENT_NOT_READY/);
});
test('pure text 503 is not accepted and does not become JSON business failure',async()=>{
 const calls=setup();global.fetch=async()=>new Response('held',{status:503});
 await assert.rejects(waitHeldManagementReady(4111,null,expected,{timeoutMs:5,retryMs:1}),/HELD_MANAGEMENT_NOT_READY/);assert.equal(calls.length,0);
});
test('missing bindings, private mode and exited child fail before any fetch',async()=>{
 const calls=setup();await assert.rejects(waitHeldManagementReady(4111,null,{}),/BINDING_REQUIRED/);
 process.env.PRIVATE_ONLINE_MODE='1';await assert.rejects(waitHeldManagementReady(4111,null,expected),/MODE_REQUIRED/);
 delete process.env.PRIVATE_ONLINE_MODE;await assert.rejects(waitHeldManagementReady(4111,{exitCode:1},expected),/CHILD_EXITED/);assert.equal(calls.length,0);
});
