const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');

async function isolated(){
 const release=__dirname,work=process.argv[3],forbidden=process.argv[4],mode=process.argv[5];
 const Module=require('node:module'),resolve=Module._resolveFilename;
 Module._resolveFilename=function(id,...args){const out=resolve.call(this,id,...args);if(typeof out==='string'&&out.toLowerCase().startsWith(forbidden.toLowerCase()+path.sep))throw Error('SOURCE_DIRECTORY_UNAVAILABLE');return out;};
 assert.throws(()=>require(path.join(forbidden,'scripts/local-release/project-writer-gate.cjs')),/SOURCE_DIRECTORY_UNAVAILABLE/);
 const control=path.join(release,'scripts/local-release'),controller=require(path.join(control,'restart.cjs')),effects=require(path.join(control,'switch.cjs'));
 const gate=require(path.join(control,'project-writer-gate.cjs')),manifest=JSON.parse(fs.readFileSync(path.join(release,'release.json'),'utf8'));
 const {DatabaseSync}=require('node:sqlite');fs.mkdirSync(work,{recursive:true});const database=path.join(work,'synthetic.db'),db=new DatabaseSync(database);
 const marker='xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000001';
 db.exec("CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,external_author_id TEXT);CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT);CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,used INTEGER,request_limit INTEGER,next_at INTEGER,interval_ms INTEGER);INSERT INTO xhs_creators VALUES('creator','author');INSERT INTO xhs_request_budgets VALUES('job',6,310,0,1000),('xhs:source-total',8,312,0,1000);");
 const original={id:'job',state:'paused',sourceFence:{marker,state:'started',phase:'detail',noteId:'note'},code:'XHS_DOWNLOAD_BLOCKED',sourceGrant:{used:{detail:1},limits:{detail:5}}};
 db.prepare("INSERT INTO xhs_whole_creator_jobs VALUES('job','creator','paused',?)").run(JSON.stringify(original));db.prepare('INSERT INTO xhs_request_budgets VALUES(?,1,1,0,0)').run(marker);db.close();
 const claimFile=path.join(work,'scope.lock'),token=crypto.randomUUID(),claimAcquiredAt=Date.now();fs.writeFileSync(claimFile,token,{flag:'wx'});
 const check=()=>assert.equal(fs.readFileSync(claimFile,'utf8'),token);let old,helper,helperChild,candidate,fallback;
 const backend=path.join(release,'backend.cjs');const started=new Map();
 function startBackend(port=0){const args=[backend,database,String(port)],child=spawn(process.execPath,args,{stdio:['ignore','ignore','inherit','ipc'],windowsHide:true});started.set(child.pid,new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',(code,signal)=>reject(Error('synthetic backend exited before readiness: '+code+'/'+signal)));}));return child;}
 const command=(port,extra=[])=>controller.launchCommandLine(process.execPath,[backend,database,String(port),...extra]);
 let observations=0,queries=0;const durations=[];
 try{
  old=startBackend();const ready=await started.get(old.pid),port=ready.port;
  const identity=effects.processIdentity('OwnedSnapshot',old.pid,port,{executable:process.execPath,commandLine:command(0)});
  if(mode==='live-child'){
    helperChild=spawn(process.execPath,[backend,database,'0','helper'],{stdio:['ignore','ignore','inherit','ipc'],windowsHide:true});await once(helperChild,'message');
    helper=effects.processIdentity('OwnedSnapshot',helperChild.pid,port,{executable:process.execPath,commandLine:command(0,['helper'])});
  }
  const closed=once(old,'close'),stopReceipt=await effects.stopOwned(old,identity);await closed;const exitedAt=Date.now();
  assert(fs.existsSync(gate.binding(database).file),'forced stop must leave the writer lease for controlled retirement');
  const projectIdentity=hash(release),state=()=>{check();return{projectIdentity,exitedAt,claimAcquiredAt};};
  const claim={policy:{preservingUpdate:{operation:'restart',active:{oldProcess:identity}}},check,assertWritable:k=>{check();assert.deepEqual(k,['restart']);},assertLegacyMaintenanceQuiescent(){throw Error('COMPLETE_REFERENCE_QUERY_FORBIDDEN');},
   legacyMaintenanceBoundary:(_identity,observe)=>({check:state,observe(){state();const f=observe();state();if(!f.complete||f.active.length)throw Error('LIVE_PROJECT_CHILD');return{...state(),observedAt:Date.now()};}}),confirmPreservingProcessExit(_pid,r,owned){check();assert.equal(r.stopped,true);for(const key of ['pid','startUtc','executable','commandLine'])assert.equal(r[key],owned.identity[key]);}};
  const observeProjectWriters=()=>{observations++;const f=effects.observeProjectWriters([identity.pid,...(helper?[helper.pid]:[])],port);queries+=f.queries;durations.push(f.durationMs);return f;};
  const callback=controller.loadLegacyMaintenance(release,manifest,'job');assert.equal(globalThis[Symbol.for('wewe.project-writer-api.v1')],gate);
  const checkpoint={identity,stopReceipt,scopeLease:claim,database,backup:{closed:true},observeProjectWriters};
  const startedAt=performance.now();let proof;
  if(mode==='live-child')await assert.rejects(callback(checkpoint),/LIVE_PROJECT_CHILD/);else proof=await callback(checkpoint);
  const elapsedMs=performance.now()-startedAt;
  const verify=new DatabaseSync(database),saved=JSON.parse(verify.prepare("SELECT document FROM xhs_whole_creator_jobs WHERE id='job'").get().document);
  assert.deepEqual(saved.sourceFence,original.sourceFence);assert.equal(saved.code,original.code);assert.deepEqual(saved.sourceGrant,original.sourceGrant);
  assert.deepEqual(verify.prepare("SELECT id,used FROM xhs_request_budgets WHERE id IN ('job','xhs:source-total') ORDER BY id").all().map(r=>[r.id,r.used]),[['job',6],['xhs:source-total',8]]);assert(verify.prepare('SELECT id FROM xhs_request_budgets WHERE id=?').get(marker));verify.close();
  if(mode==='live-child'){assert.equal(saved.legacyMaintenanceProof,undefined);assert.equal(observations,1);}
  else{
    assert.equal(proof.allowsRetry,false);assert.equal(saved.legacyMaintenanceProof.oldResult,'unknown');assert.equal(observations,2);assert.equal(queries,2);
    candidate=startBackend(port);await started.get(candidate.pid);
    const candidateIdentity=effects.processIdentity('OwnedSnapshot',candidate.pid,port,{executable:process.execPath,commandLine:command(port)});
    const restartSource=fs.readFileSync(path.join(control,'restart.cjs'),'utf8').replace(/\r\n/g,'\n'),from=restartSource.indexOf('      if(newChild){',restartSource.indexOf('const baseline =')),to=restartSource.indexOf('    } finally {\n      if (options.rehearsal)',from);
    assert(from>0&&to>from);const catchRun=new Function('ctx','return(async()=>{with(ctx){'+restartSource.slice(from,to)+'}})()');
    const ctx={newChild:candidate,ownedIdentities:new Map([[candidate.pid,{identity:candidateIdentity,packageId:'candidate',commandLine:candidateIdentity.commandLine}]]),oldStopCheckpoint:checkpoint,
      error:Error('synthetic candidate health failure'),stopped:true,preserving:true,stopOwned:effects.stopOwned,
      require:id=>id==='./release-scope.cjs'?{session:()=>claim}:id==='./project-writer-gate.cjs'?gate:require(id),database,fs,path,audit:work,previous:release,previousManifest:manifest,options:{production:false},schemaProof:undefined,finalBackup:undefined,fallbackChild:undefined,
      start(){fallback=startBackend(port);return fallback;},waitReady:async(_port,c)=>started.get(c.pid),port,processIdentity:effects.processIdentity,writeActiveReleaseAsync:async()=>{},writeJson(){}};
    assert.equal((await catchRun(ctx)).rollbackUsed,true);assert.notEqual(fallback.pid,candidate.pid);assert.equal(JSON.parse(fs.readFileSync(gate.binding(database).file)).pid,fallback.pid);
  }
  return{sourceUnavailable:true,compactEntry:true,sameGate:true,mode,observations,completeReferenceQueries:0,narrowQueries:queries,observerMs:durations,proofElapsedMs:elapsedMs,originalUnknownRetained:true,budgets:[6,8],rollbackUsed:mode!=='live-child'};
 }finally{
   for(const child of [old,candidate,fallback])if(child&&child.exitCode===null&&child.signalCode===null){try{const port=(await started.get(child.pid)).port;const i=effects.processIdentity('OwnedSnapshot',child.pid,port,{executable:process.execPath,commandLine:controller.launchCommandLine(process.execPath,child.spawnargs.slice(1))});const r=await effects.stopOwned(child,i);gate.retireStoppedWriter(database,{identity:i,stopReceipt:r,scopeLease:{check,assertWritable:()=>check()}});}catch(error){const closed=once(child,'close');child.kill();await closed;throw error;}}
   if(helperChild)await effects.stopOwned(helperChild,helper);
 }
}

if(process.argv[2]==='--isolated')isolated().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1;});
else{
 const test=require('node:test');
 test('real compact maintenance loader works without source; actual candidate failure retires its lease and rolls back',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-compact-v2-')),release=path.join(root,'package'),source=path.resolve(__dirname,'../..'),target=path.join(release,'server'),compiled=path.join(target,'dist/apps/server/src/collection');
  const ts=require(require.resolve('typescript',{paths:[path.join(source,'apps/server')]}));
  try{
   fs.mkdirSync(compiled,{recursive:true});fs.writeFileSync(path.join(compiled,'../main.js'),'exports.fixture=true;');
   for(const name of ['legacy-project-adapter','legacy-maintenance-controller','legacy-maintenance','project-writer-boundary'])fs.writeFileSync(path.join(compiled,name+'.js'),ts.transpileModule(fs.readFileSync(path.join(source,'apps/server/src/collection',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
   const generated=path.join(target,'node_modules/.store/generated-prisma');fs.mkdirSync(generated,{recursive:true});fs.writeFileSync(path.join(generated,'package.json'),JSON.stringify({name:'@prisma/client',version:'fixture'}));fs.writeFileSync(path.join(generated,'index.js'),'exports.fixture=true;');
   require('./build.cjs').copyRuntimeClosure(source,release);const bundled=require('./compact.cjs').bundleServer(target,path.join(source,'apps/server'),path.join(source,'apps/web'));assert.equal(bundled.legacyMaintenance,'legacy-maintenance.cjs');assert(!fs.existsSync(path.join(target,'dist')));
   const control=path.join(release,'scripts/local-release');fs.mkdirSync(control,{recursive:true});for(const f of fs.readdirSync(__dirname))if(/\.(?:cjs|ps1|cs)$/.test(f)&&!f.includes('.test.'))fs.copyFileSync(path.join(__dirname,f),path.join(control,f));
   const native=require('./identity-tool.cjs').identityTool();assert(native);const cache=path.relative(source,path.dirname(native));fs.mkdirSync(path.join(release,cache),{recursive:true});for(const f of ['process-identity.exe','verified.json'])fs.copyFileSync(path.join(path.dirname(native),f),path.join(release,cache,f));
   fs.copyFileSync(__filename,path.join(release,'exercise.cjs'));
   fs.writeFileSync(path.join(release,'backend.cjs'),`const path=require('node:path');if(process.argv[4]==='helper'){process.send({ready:true});setInterval(()=>{},1000);}else{require('./project-writer-gate.cjs').acquireWriter(process.argv[2]);const server=require('node:net').createServer();server.listen(+process.argv[3],'127.0.0.1',()=>process.send({port:server.address().port}));process.on('message',m=>{if(m==='helper'){const args=[__filename,process.argv[2],process.argv[3],'helper'];const c=require('node:child_process').spawn(process.execPath,args,{stdio:['ignore','ignore','inherit','ipc'],windowsHide:true});c.once('message',()=>process.send({pid:c.pid}));}});}`);
   const manifest={format:1,platform:process.platform,arch:process.arch,...require('./lib.cjs').fingerprint(release)};fs.writeFileSync(path.join(release,'release.json'),JSON.stringify(manifest));
   const evidence=[];for(const mode of ['rollback','live-child'])await t.test(mode,()=>{const out=execFileSync(process.execPath,[path.join(release,'exercise.cjs'),'--isolated',path.join(root,mode),source,mode],{cwd:release,env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''},encoding:'utf8',windowsHide:true,timeout:60000});const row=JSON.parse(out.trim().split(/\r?\n/).at(-1));evidence.push(row);assert.equal(row.sourceUnavailable,true);assert.equal(row.compactEntry,true);assert.equal(row.completeReferenceQueries,0);});
   console.log('LEGACY_COMPACT_EVIDENCE '+JSON.stringify(evidence));
  }finally{assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));assert(path.basename(root).startsWith('legacy-compact-v2-'));fs.rmSync(root,{recursive:true,force:true});}
 });
}
