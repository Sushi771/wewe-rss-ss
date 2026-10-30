const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn,execFileSync}=require('node:child_process'); const {once}=require('node:events');
const gate = require('./project-writer-gate.cjs');
const moduleFile = require.resolve('./project-writer-gate.cjs');
const selfFixture=require.resolve('./writer-self.fixture.test.cjs');
test.before(require(selfFixture).prepareWriterSelf);
function fixture(run) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'project-writer-test-')),database=path.join(root,'synthetic.db');fs.writeFileSync(database,'synthetic gate fixture');
  return Promise.resolve().then(()=>run(database,root)).finally(()=>{assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));assert(path.basename(root).startsWith('project-writer-test-'));fs.rmSync(root,{recursive:true,force:true});});
}
function contender(database) {
  return execFileSync(process.execPath,['-e',`require(process.argv[3]).prepareWriterSelf().then(()=>{try{require(process.argv[1]).acquireWriter(process.argv[2]);process.stdout.write('ADMITTED')}catch(e){process.stdout.write(e.code||e.message)}}).catch(e=>{console.error(e);process.exitCode=1})`,moduleFile,database,selfFixture],{encoding:'utf8',windowsHide:true,timeout:15000});
}
const recordOf=child=>Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error('owned identity fixture exited before readiness: '+code+'/'+signal);})]);
for(const kind of ['timeout','invalid-json','wrong-pid'])test('production PowerShell self fallback stays fail-closed: '+kind,()=>fixture(database=>{
  let calls=0;
  const nativeRequire=require,context={module:{exports:{}},process:{pid:process.pid,platform:'win32',execPath:process.execPath,env:process.env,once(){}},require(id){
    if(id==='node:child_process')return{execFileSync(_exe,args,options){calls++;assert.equal(options.timeout,5000);assert(args.includes('-NonInteractive'));assert.match(args.at(-1),/Get-CimInstance Win32_Process/);if(kind==='timeout')throw Object.assign(Error('synthetic timeout'),{code:'ETIMEDOUT'});return kind==='invalid-json'?'invalid':JSON.stringify({pid:process.pid+1,startUtc:'2026-01-01T00:00:00.0000000Z',commandLine:'synthetic'});}};
    return nativeRequire(id);
  }};
  require('node:vm').runInNewContext(fs.readFileSync(moduleFile,'utf8'),context,{filename:moduleFile});
  const isolatedGate=context.module.exports;assert.throws(()=>isolatedGate.acquireWriter(database));assert.equal(calls,1);assert(!fs.existsSync(gate.binding(database).file));
}));
test('a second application cannot pass startup admission while the database writer is held',()=>fixture(database=>{const lease=gate.acquireWriter(database);try{assert.equal(contender(database),'EEXIST');assert.equal(gate.acquireWriter(database),lease);}finally{lease.close();}}));
test('a maintenance lease excludes application startup until its actual release',()=>fixture(database=>{const state={identity:{pid:123,startUtc:'synthetic',executable:process.execPath,commandLine:'synthetic'},scopeLease:{assertWritable(){},check(){},assertLegacyMaintenanceQuiescent(){}}};state.stopReceipt={...state.identity,stopped:true};const lease=gate.acquireMaintenance(database,state);try{assert.equal(contender(database),'EEXIST');assert.throws(()=>gate.acquireWriter(database));}finally{lease.close();}assert.equal(contender(database),'ADMITTED');}));
test('JSON/summary cannot supply live maintenance claim methods',()=>fixture(database=>{assert.throws(()=>gate.acquireMaintenance(database,{oldStopped:true}));assert.throws(()=>gate.acquireMaintenance(database,JSON.parse(JSON.stringify({identity:{pid:1},stopReceipt:{pid:1,stopped:true},scopeLease:{}}))));assert(!fs.existsSync(gate.binding(database).file));}));
test('database replacement invalidates the old admission and does not open a new writer namespace',()=>fixture((database,root)=>{const lease=gate.acquireWriter(database),next=path.join(root,'replacement');fs.writeFileSync(next,'other');fs.renameSync(database,database+'.old');fs.renameSync(next,database);assert.throws(()=>lease.check());assert.equal(contender(database),'EEXIST');assert.throws(()=>lease.close());}));
test('changed lock bytes are retained and cannot be silently cleared',()=>fixture(database=>{const lease=gate.acquireWriter(database);fs.writeFileSync(lease.file,'changed');assert.throws(()=>lease.check());assert.throws(()=>lease.close());assert.equal(fs.readFileSync(lease.file,'utf8'),'changed');}));
test('hard-link aliases cannot establish separate writer namespaces',()=>fixture((database,root)=>{const other=path.join(root,'alias');fs.linkSync(database,other);assert.throws(()=>gate.acquireWriter(database));assert.throws(()=>gate.acquireWriter(other));}));
test('owned process crash leaves a lease requiring the exact stop identity',()=>fixture(async(database,root)=>{
  const worker=path.join(root,'worker.cjs');fs.writeFileSync(worker,`require(${JSON.stringify(selfFixture)}).prepareWriterSelf().then(()=>{const l=require(process.argv[2]).acquireWriter(process.argv[3]);process.send(l.record);setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exitCode=1});`);
  const child=spawn(process.execPath,[worker,moduleFile,database],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  try{
    const [record]=await recordOf(child);const closed=once(child,'close');child.kill();await closed;
    assert.equal(contender(database),'EEXIST');
    const i={pid:record.pid,startUtc:record.startUtc,executable:process.execPath,commandLine:'wrong command'};
    let alive=true;const cp={identity:i,stopReceipt:{...i,stopped:true},scopeLease:{assertWritable(){assert(alive);},check(){assert(alive);},assertLegacyMaintenanceQuiescent(){assert.notEqual(child.exitCode,null);}}};
    assert.throws(()=>gate.acquireMaintenance(database,cp));assert(fs.existsSync(gate.binding(database).file));
    // A mismatching command hash is never treated as a stale lease that can be erased.
    alive=false;assert.throws(()=>gate.acquireMaintenance(database,cp));assert(fs.existsSync(gate.binding(database).file));
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'close');}}
}));
test('normal restart retires only the exact owned stopped writer lease',()=>fixture(async(database,root)=>{
  const worker=path.join(root,'retire-worker.cjs');fs.writeFileSync(worker,`require(${JSON.stringify(selfFixture)}).prepareWriterSelf().then(identity=>{const l=require(process.argv[2]).acquireWriter(process.argv[3]);process.send({...l.record,commandLine:identity?.commandLine??require('node:fs').readFileSync('/proc/self/cmdline','utf8')});setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exitCode=1});`);
  const child=spawn(process.execPath,[worker,moduleFile,database],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  try{
    const [record]=await recordOf(child);
    const commandLine=record.commandLine;
    const closed=once(child,'close');child.kill();await closed;
    const identity={pid:record.pid,startUtc:record.startUtc,executable:process.execPath,commandLine};
    gate.retireStoppedWriter(database,{identity,stopReceipt:{...identity,stopped:true},scopeLease:{assertWritable(k){assert.deepEqual(k,['restart']);},check(){assert(child.exitCode!==null||child.signalCode!==null);}}});
    assert(!fs.existsSync(gate.binding(database).file));assert.equal(contender(database),'ADMITTED');
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'close');}}
}));
