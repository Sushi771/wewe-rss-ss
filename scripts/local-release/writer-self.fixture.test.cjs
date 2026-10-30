// Test preparation only: production gate/self and its fail-closed fallback stay unchanged.
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {createServer}=require('node:net'),{once}=require('node:events'),{execFileSync}=require('node:child_process');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
let observed;
const tool=process.platform==='win32'?require('./identity-tool.cjs').identityTool():undefined;
async function prepareWriterSelf(){
 if(process.platform!=='win32')return;
 if(observed)return observed;
 assert(tool,'verified native identity tool must be available for Windows fixtures');
 const server=createServer();
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const identity=JSON.parse(execFileSync(tool,['Snapshot',String(process.pid),String(server.address().port),'','',''],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:65536}));
  assert.equal(identity.pid,process.pid);assert.equal(identity.executable.toLowerCase(),process.execPath.toLowerCase());
  assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(identity.startUtc));assert.equal(typeof identity.commandLine,'string');assert(identity.commandLine.length>0);
  const record=Object.freeze({pid:identity.pid,startUtc:identity.startUtc,executableHash:hash(fs.readFileSync(identity.executable)),commandHash:hash(identity.commandLine)});
  const key=Symbol.for('wewe.project-writer-self.v1');if(globalThis[key])assert.deepEqual(globalThis[key],record,'an existing identity cache must match the native observation');
  globalThis[key]=record;observed=Object.freeze(identity);return observed;
 }finally{if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
module.exports={prepareWriterSelf};

if(require.main===module){
 const test=require('node:test'),vm=require('node:vm'),path=require('node:path');
 test.before(prepareWriterSelf);
 test('fixture identity is real, cached and shared with the unchanged writer gate',async()=>{
  if(process.platform!=='win32')return;
  const identity=await prepareWriterSelf();assert.equal(identity.pid,process.pid);assert.equal(await prepareWriterSelf(),identity);
  assert.equal(globalThis[Symbol.for('wewe.project-writer-self.v1')].commandHash,hash(identity.commandLine));
 });
 for(const kind of ['wrong-pid','wrong-executable','invalid-start','empty-command','tool-unavailable','timeout','changed-cache'])test('fixture identity rejects '+kind+' without replacing its cache',async()=>{
  let calls=0,server;
  class Listener extends require('node:events').EventEmitter{listen(_port,host){assert.equal(host,'127.0.0.1');this.listening=true;queueMicrotask(()=>this.emit('listening'));}address(){return{port:12345};}close(done){this.listening=false;done();}}
  const identity={pid:process.pid,executable:process.execPath,startUtc:'2026-01-01T00:00:00.0000000Z',commandLine:'synthetic fixture identity'};
  if(kind==='wrong-pid')identity.pid++;
  if(kind==='wrong-executable')identity.executable=path.join(path.dirname(process.execPath),'foreign.exe');
  if(kind==='invalid-start')identity.startUtc='unproved';
  if(kind==='empty-command')identity.commandLine='';
  const context={module:{exports:{}},process:{pid:process.pid,platform:'win32',execPath:process.execPath},queueMicrotask,require(id){
   if(id==='./identity-tool.cjs')return{identityTool:()=>kind==='tool-unavailable'?undefined:'verified-tool-fixture'};
   if(id==='node:net')return{createServer:()=>server=new Listener()};
   if(id==='node:child_process')return{execFileSync(_tool,args,options){calls++;assert.equal(args[0],'Snapshot');assert.equal(args[1],String(process.pid));assert.equal(options.timeout,5000);if(kind==='timeout')throw Object.assign(Error('synthetic timeout'),{code:'ETIMEDOUT'});return JSON.stringify(identity);}};
   return require(id);
  }};
  vm.createContext(context);const key=Symbol.for('wewe.project-writer-self.v1'),prior=kind==='changed-cache'?{pid:process.pid+1}:undefined;
  if(prior)context[key]=prior;
  vm.runInContext(fs.readFileSync(__filename,'utf8'),context,{filename:__filename});
  await assert.rejects(context.module.exports.prepareWriterSelf());assert.equal(context[key],prior);assert.equal(calls,kind==='tool-unavailable'?0:1);if(server)assert.equal(server.listening,false);
 });
}
