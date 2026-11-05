'use strict';
// Pure, in-memory effects only: no host database, listener, process, or cleanup.
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {recoverSwitchFailure}=require('./switch-recovery.cjs');
const {validateRoles,expectedPending,migrationContract}=require('./switch-contract.cjs');
const h=n=>String(n).repeat(64), commit=n=>String(n).repeat(40);
const clone=v=>JSON.parse(JSON.stringify(v));
function manifest(id='current',added=false){
  const files={'runtime/node.exe':h(1),'server/prisma/schema.prisma':added?h(3):h(2),
    'server/prisma/migrations/001_initial/migration.sql':h(4)};
  if(added)files['server/prisma/migrations/002_tasks/migration.sql']=h(5);
  const m={format:1,id,sourceCommit:commit(1),sourceHash:h(2),schemaCompatibility:'current',
    desktopHelperIncluded:false,files,links:{},prisma:{clientVersion:'5.22.0',cliVersion:'5.22.0',engineSha256:h(6)}};
  m.migrationContract=migrationContract(m);return m;
}
function roles(){const current={manifest:manifest(),manifestSha256:h(7)};return {current,candidate:{manifest:manifest('candidate',true),manifestSha256:h(8)},rollback:clone(current)};}
function fixture(){
  const fixtureRoot=path.resolve('synthetic-fixture-only');
  const request={mode:'synthetic-fixture',recoveryId:'synthetic_recovery_0001',fixtureRoot,
    database:path.join(fixtureRoot,'partial.db'),destination:path.join(fixtureRoot,'new-restored.db'),
    snapshot:{path:path.join(fixtureRoot,'protected.db'),identity:{dev:1,ino:2},sha256:h(1),preservationSha256:h(2)},
    rollback:{id:'old',sourceCommit:commit(1),manifestSha256:h(3)},migrationAttempted:true,migrated:false};
  const trace=[],leaseId='fixture-exclusive-lease',databaseIdentity={dev:1,ino:1};
  const restored={recoveryId:request.recoveryId,path:request.destination,identity:{dev:1,ino:3},sha256:h(1),integrity:'ok',preservationSha256:h(2)};
  const effects={
    assertScope:async binding=>{trace.push('scope');return {authorized:true,kind:'synthetic-fixture-new-path-recovery',plainPaths:true,exclusiveDestination:true,databaseIdentity,leaseId,binding};},
    assertWritersStopped:async ({database,recoveryId})=>{trace.push('writers');return {database,recoveryId,leaseId,databaseIdentity,allWritersStopped:true,noPostSnapshotBusinessWrites:true};},
    inspectSnapshot:async (p,{recoveryId})=>{trace.push('snapshot');return {recoveryId,path:p,...clone(request.snapshot),integrity:'ok'};},
    copySnapshotExclusive:async ({source,destination,recoveryId})=>{trace.push('copy');return {source,destination,recoveryId,leaseId,createdExclusive:true,hardlinked:false};},
    inspectRestored:async ()=>{trace.push('restored');return clone(restored);},
    authorizeRestoredDatabase:async ({recoveryId})=>{trace.push('activate');return {authorized:true,isolatedActivation:true,atomic:true,database:request.destination,recoveryId,leaseId,originalDatabaseOverwritten:false};},
    restartOldApplication:async args=>{trace.push('restart');return {...args,started:true};},
  };
  return {request,effects,trace,restored};
}
test('三角色同schema回退及新增迁移从包哈希推导，不使用历史固定名称',()=>{
  const r=roles();assert.equal(validateRoles(r),r);
  assert.deepEqual(expectedPending(r,{integrity:'ok',applied:['001_initial'],pending:['002_tasks']}),['002_tasks']);
});
test('无helper当前包通过；声明helper但缺文件或版本错拒绝',()=>{
  for(const change of [r=>r.current.manifest.desktopHelperIncluded=true,
    r=>r.candidate.manifest.prisma.cliVersion='5.10.1',r=>r.rollback.manifest.sourceCommit='unverified']){
    const r=roles();change(r);assert.throws(()=>validateRoles(r),/RELEASE_/);
  }
});
test('历史迁移哈希变化、回退schema不符、未知或缺失迁移均拒绝',()=>{
  const changed=roles();changed.candidate.manifest.files['server/prisma/migrations/001_initial/migration.sql']=h(9);
  assert.throws(()=>validateRoles(changed),/RELEASE_MIGRATION_CONTRACT_CHANGED/);
  const old=roles();old.rollback.manifest.files['server/prisma/schema.prisma']=h(9);
  assert.throws(()=>validateRoles(old),/RELEASE_MIGRATION_CONTRACT_CHANGED/);
  for(const inspection of [{integrity:'ok',applied:[],pending:['002_tasks']},{integrity:'ok',applied:['001_initial'],pending:['unknown']}])
    assert.throws(()=>expectedPending(roles(),inspection),/RELEASE_/);
});
test('新路径恢复先停写、验保护快照、独占复制、全内容校验后才重启',async()=>{
  const f=fixture(),r=await recoverSwitchFailure(f.request,f.effects);
  assert.equal(r.databaseRestored,true);assert.equal(r.restartOutcome,'confirmed');assert.equal(r.originalDatabaseOverwritten,false);
  assert.equal(r.receipt.recoveryId,f.request.recoveryId);
  assert.deepEqual(f.trace,['scope','writers','snapshot','copy','restored','snapshot','writers','activate','snapshot','restored','writers','restart']);
});
test('真实模式和空请求无任何恢复或重启效果',async()=>{
  for(const request of [undefined,null,{}, {...fixture().request,mode:'production'}, {...fixture().request,mode:'rehearsal'}]){
    const f=fixture(),r=await recoverSwitchFailure(request,f.effects);
    assert.equal(r.status,'blocked');assert.equal(r.databaseRestored,false);assert.equal(r.restartAttempted,false);assert.deepEqual(f.trace,[]);
  }
});
test('单写者或无新业务写入未获证：禁止复制及重启',async()=>{
  for(const key of ['allWritersStopped','noPostSnapshotBusinessWrites']){
    const f=fixture(),original=f.effects.assertWritersStopped;
    f.effects.assertWritersStopped=async args=>({...await original(args),[key]:false});
    const r=await recoverSwitchFailure(f.request,f.effects);assert.equal(r.restoreAttempted,false);assert(!f.trace.includes('restart'));
  }
});
test('路径越界、已有目标或reparse路径的scope凭证拒绝',async()=>{
  const escaped=fixture();escaped.request.destination=path.join(escaped.request.fixtureRoot+'-neighbor','new.db');
  assert.equal((await recoverSwitchFailure(escaped.request,escaped.effects)).restoreAttempted,false);
  for(const key of ['plainPaths','exclusiveDestination']){
    const f=fixture(),original=f.effects.assertScope;f.effects.assertScope=async args=>({...await original(args),[key]:false});
    const r=await recoverSwitchFailure(f.request,f.effects);assert.equal(r.restoreAttempted,false);assert(!f.trace.includes('restart'));
  }
});
test('copy抛错保留目标结果unknown，禁止盲目重试和旧应用启动',async()=>{
  const f=fixture();f.effects.copySnapshotExclusive=async()=>{f.trace.push('copy');throw Error('disk interruption');};
  const r=await recoverSwitchFailure(f.request,f.effects);assert.equal(r.restoreAttempted,true);assert.equal(r.restoreOutcome,'unknown');
  assert.equal(r.restartAttempted,false);assert.equal(f.trace.filter(v=>v==='copy').length,1);
});
test('quick_check不能替代原数据摘要，恢复损坏绝不重启',async()=>{
  const f=fixture();f.effects.inspectRestored=async()=>({...f.restored,preservationSha256:h(9)});
  const r=await recoverSwitchFailure(f.request,f.effects);assert.equal(r.databaseRestored,false);assert.equal(r.restartAttempted,false);
});
test('复制后保护快照被替换拒绝，保留失败副本',async()=>{
  const f=fixture(),original=f.effects.inspectSnapshot;let count=0;
  f.effects.inspectSnapshot=async(...args)=>({...await original(...args),identity:++count===1?f.request.snapshot.identity:{dev:1,ino:999}});
  const r=await recoverSwitchFailure(f.request,f.effects);assert.equal(r.snapshotRestoredToNewPath,true);assert.equal(r.restartAttempted,false);
});
test('激活未获原子授权不重启，激活尝试后错误明确unknown',async()=>{
  const f=fixture();f.effects.authorizeRestoredDatabase=async()=>{throw Error('activation interrupted');};
  const r=await recoverSwitchFailure(f.request,f.effects);assert.equal(r.activationOutcome,'unknown');assert.equal(r.restartAttempted,false);
});
test('已调用restart但抛错或回执不完整，状态unknown且不重试',async()=>{
  for(const outcome of [()=>{throw Error('lost start receipt');},()=>true,()=>undefined]){
    const f=fixture();f.effects.restartOldApplication=async()=>{f.trace.push('restart');return outcome();};
    const r=await recoverSwitchFailure(f.request,f.effects);
    assert.equal(r.restartAttempted,true);assert.equal(r.restartOutcome,'unknown');assert.equal(r.oldApplicationRestarted,null);
    assert.equal(r.databaseRestored,false);assert.equal(f.trace.filter(v=>v==='restart').length,1);
  }
});
test('production switch入口在文件/进程/数据库效果前阻断',async()=>{
  const {controlledSwitch}=require('./switch.cjs');
  await assert.rejects(controlledSwitch({production:true,release:'missing',legacy:'missing'}),error=>
    error.code==='RELEASE_SWITCH_ALL_WRITERS_RECOVERY_UNPROVEN'&&error.migrationAttempted===false&&error.databaseRestored===false);
});
