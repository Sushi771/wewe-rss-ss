// Isolated acceptance of the real controller, with explicitly synthetic native
// observations. These fixtures never create production trust or stop a process.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createController}=require('./installed-lifecycle.cjs');
const {createNativePrimitives}=require('./installed-native-primitives.cjs');
async function fixture(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'held-controller-fixture-'));
 const releases=path.join(root,'releases'),pkg=path.join(releases,'synthetic-release'),journal=path.join(root,'.synthetic-update.json'),db=path.join(root,'synthetic.sqlite');
 fs.mkdirSync(pkg,{recursive:true});fs.writeFileSync(db,'synthetic, never opened');
 const gate=Buffer.from('// synthetic gate never executed');fs.writeFileSync(path.join(pkg,'installed-startup-gate.cjs'),gate);
 fs.writeFileSync(path.join(pkg,'release.json'),JSON.stringify({installedLifecycle:{protocol:'wewe-installed-lifecycle-v1',writeHoldProtocol:'project-writer-prisma-query-only-v1',journalBasename:path.basename(journal)},files:{'installed-startup-gate.cjs':crypto.createHash('sha256').update(gate).digest('hex')}}));
 const identity={pid:42,executable:path.join(pkg,'runtime/node.exe'),commandLine:'synthetic never launched'},tx='synthetic-transaction-01';
 fs.writeFileSync(journal+'.processes',JSON.stringify({format:1,protocol:'wewe-installed-lifecycle-v1',database:db,processes:[{releaseId:'synthetic-release',transactionId:tx,identity}]}));
 let smoke=0;const good={transactionId:tx,id:'synthetic-release',sha256:'a'.repeat(64),database:db,readOnly:true,databaseReadable:true,httpReady:true};
 const native={processIdentity:async()=>identity,sameIdentity:()=>true,waitReady:async()=>{smoke++;throw Error('ordinary page is held');},readUpdateHealth:async()=>({...good})};
 const controller=createController({journalFile:journal,database:db,releasesRoot:releases},native);
 const lease=await controller.acquire();
 const ctx={lease:lease.token,transactionId:tx,release:{id:'synthetic-release',path:pkg,sha256:'a'.repeat(64)},readOnly:true};
 try{await run({controller,ctx,native,good,smoke:()=>smoke,db});}
 finally{await lease.release();assert(path.dirname(root)===os.tmpdir()&&path.basename(root).startsWith('held-controller-fixture-'));fs.rmSync(root,{recursive:true});}
}
test('precommit readOnly skips ordinary RSS smoke but verifies the exact native health binding',()=>fixture(async f=>{
 assert.deepEqual(await f.controller.health(f.ctx),f.good);assert.equal(f.smoke(),0);
 assert.equal(fs.readFileSync(f.db,'utf8'),'synthetic, never opened');
}));
for(const key of ['transactionId','id','sha256','database','readOnly','databaseReadable','httpReady'])test('precommit refuses wrong '+key,()=>fixture(async f=>{
 f.native.readUpdateHealth=async()=>({...f.good,[key]:typeof f.good[key]==='boolean'?!f.good[key]:'wrong'});
 await assert.rejects(f.controller.health(f.ctx),/UPDATE_READ_ONLY_HEALTH_UNPROVEN/);assert.equal(f.smoke(),0);
}));
test('precommit requires matching process identity independently of HTTP readiness',()=>fixture(async f=>{
 f.native.sameIdentity=()=>false;await assert.rejects(f.controller.health(f.ctx),/HEALTH_PROCESS_IDENTITY_CHANGED/);
}));
test('non-readOnly controller path keeps its ordinary smoke contract',()=>fixture(async f=>{
 await assert.rejects(f.controller.health({...f.ctx,readOnly:false}),/ordinary page is held/);assert.equal(f.smoke(),1);
}));
test('a real native scope cannot be replaced by a candidate hash or empty object',()=>{
 assert.throws(()=>createNativePrimitives({scopeLease:{candidateSha256:'a'.repeat(64)}}),/REAL_NATIVE_SCOPE_REQUIRED/);
});
