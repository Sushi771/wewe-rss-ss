'use strict';
// No filesystem, process or default host adapter. Fixture effects are explicit;
// the existing release scope never authorizes production DB restoration.
const path = require('node:path');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const captured = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
// Existing release-scope uses [device,inode,birth] tuples; named stamps are also
// accepted by injected fixture adapters. Neither may be empty or mutable aliases.
const identity = v => v && typeof v==='object'&&(Array.isArray(v)?v.length===3:
  Object.keys(v).length>0&&Object.keys(v).length<=16)&&Object.values(v).every(n=>typeof n==='string'?n.length>0:
    typeof n==='number'&&Number.isFinite(n));
const inside = (root,file) => { const r=path.relative(root,file);return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r); };
function receipt(ok, reason) { if (!ok) throw new Error(reason); }
async function recoverSwitchFailure(request, effects = {}) {
  const validRequest = request && typeof request === 'object' && !Array.isArray(request);
  try { request = validRequest ? captured(request) : {}; }
  catch { request = {}; }
  const result = { status:'blocked', reason:'RECOVERY_SCOPE_UNPROVEN',
    migrationAttempted:request.migrationAttempted===true, migrated:request.migrated===true,
    databaseRestored:false, snapshotRestoredToNewPath:false, restoredDatabaseVerified:false,
    originalDatabaseOverwritten:false, oldApplicationRestarted:false, rollbackUsed:false,
    restoredDatabase:null, restoreAttempted:false, restoreOutcome:'not_attempted',
    activationAttempted:false, activationOutcome:'not_attempted',
    restartAttempted:false, restartOutcome:'not_attempted' };
  if (!validRequest) return {...result,reason:'RECOVERY_REQUEST_INVALID'};
  if (request.mode !== 'synthetic-fixture') {
    result.reason = 'RECOVERY_ALL_WRITERS_AND_ATOMIC_ACTIVATION_UNPROVEN';
    return result;
  }
  try {
    const {fixtureRoot,database,snapshot,destination,rollback,recoveryId}=request;
    receipt(/^[A-Za-z0-9_-]{16,80}$/.test(recoveryId||'') && path.isAbsolute(fixtureRoot||'') && path.resolve(fixtureRoot)===fixtureRoot && [database,snapshot?.path,destination].every(p=>
      typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p&&inside(fixtureRoot,p)) &&
      new Set([database,snapshot.path,destination].map(p=>path.resolve(p).toLowerCase())).size===3,
    'RECOVERY_PATH_NOT_ISOLATED');
    receipt(identity(snapshot.identity) && hex(snapshot.sha256)&&hex(snapshot.preservationSha256)&&
      rollback?.id&&/^[a-f0-9]{40}$/.test(rollback.sourceCommit||'')&&hex(rollback.manifestSha256),
    'RECOVERY_PROTECTED_SNAPSHOT_UNPROVEN');
    const binding={recoveryId,fixtureRoot,database,snapshot,destination,rollback};
    const scope=captured(await effects.assertScope(captured(binding)));
    receipt(scope?.authorized===true&&scope.kind==='synthetic-fixture-new-path-recovery'&&
      scope.plainPaths===true&&scope.exclusiveDestination===true&&identity(scope.databaseIdentity)&&
      typeof scope.leaseId==='string'&&scope.leaseId&&same(scope.binding,binding),'RECOVERY_SCOPE_UNPROVEN');
    const stopped=captured(await effects.assertWritersStopped({database,leaseId:scope.leaseId,recoveryId}));
    receipt(stopped?.allWritersStopped===true&&stopped.noPostSnapshotBusinessWrites===true&&
      stopped.database===database&&stopped.leaseId===scope.leaseId&&stopped.recoveryId===recoveryId&&
      same(stopped.databaseIdentity,scope.databaseIdentity),'RECOVERY_WRITERS_NOT_QUIESCENT');
    async function snapshotUnchanged(){
      const s=await effects.inspectSnapshot(snapshot.path,{recoveryId,leaseId:scope.leaseId});
      receipt(s?.recoveryId===recoveryId&&s.path===snapshot.path&&same(s.identity,snapshot.identity)&&s.sha256===snapshot.sha256&&
        s.integrity==='ok'&&s.preservationSha256===snapshot.preservationSha256,'RECOVERY_SNAPSHOT_CHANGED');
    }
    await snapshotUnchanged();
    result.restoreAttempted=true;result.restoreOutcome='unknown';result.restoredDatabase=destination;
    const copied=await effects.copySnapshotExclusive({source:snapshot.path,destination,leaseId:scope.leaseId,recoveryId});
    receipt(copied?.createdExclusive===true&&copied.destination===destination&&
      copied.source===snapshot.path&&copied.hardlinked===false&&copied.recoveryId===recoveryId&&
      copied.leaseId===scope.leaseId,'RECOVERY_COPY_NOT_EXCLUSIVE');
    result.snapshotRestoredToNewPath=true;result.restoreOutcome='created-unverified';
    const restored=captured(await effects.inspectRestored(destination,{recoveryId,leaseId:scope.leaseId}));
    receipt(restored?.recoveryId===recoveryId&&restored.path===destination&&identity(restored.identity)&&!same(restored.identity,snapshot.identity)&&
      restored.sha256===snapshot.sha256&&restored.integrity==='ok'&&
      restored.preservationSha256===snapshot.preservationSha256,'RECOVERY_RESTORED_DATA_UNPROVEN');
    result.restoredDatabaseVerified=true;result.restoreOutcome='verified-new-path';
    await snapshotUnchanged();
    const stillStopped=await effects.assertWritersStopped({database,leaseId:scope.leaseId,recoveryId});
    receipt(same(stillStopped,stopped),'RECOVERY_WRITER_PROOF_CHANGED');
    result.activationAttempted=true;result.activationOutcome='unknown';
    const activation=await effects.authorizeRestoredDatabase(captured({...binding,leaseId:scope.leaseId,identity:restored.identity}));
    receipt(activation?.authorized===true&&activation.isolatedActivation===true&&activation.atomic===true&&activation.recoveryId===recoveryId&&
      activation.database===destination&&activation.leaseId===scope.leaseId&&
      activation.originalDatabaseOverwritten===false,'RECOVERY_ACTIVATION_UNPROVEN');
    result.activationOutcome='confirmed';
    // Recheck both protected and restored objects immediately before restart.
    await snapshotUnchanged();
    const final=await effects.inspectRestored(destination,{recoveryId,leaseId:scope.leaseId});
    receipt(same(final,restored),'RECOVERY_RESTORED_OBJECT_CHANGED');
    const finalWriters=await effects.assertWritersStopped({database,leaseId:scope.leaseId,recoveryId});
    receipt(same(finalWriters,stopped),'RECOVERY_WRITER_PROOF_CHANGED');
    result.restartAttempted=true;result.restartOutcome='unknown';result.oldApplicationRestarted=null;
    const started=await effects.restartOldApplication(captured({database:destination,identity:restored.identity,rollback,leaseId:scope.leaseId,recoveryId}));
    receipt(started?.started===true&&started.database===destination&&started.recoveryId===recoveryId&&
      same(started.identity,restored.identity)&&same(started.rollback,rollback),'RECOVERY_RESTART_UNPROVEN');
    return {...result,status:'restored',reason:null,databaseRestored:true,oldApplicationRestarted:true,
      rollbackUsed:true,restartOutcome:'confirmed',recoveryMode:'verified-new-path',receipt:{recoveryId,leaseId:scope.leaseId,
        snapshotSha256:snapshot.sha256,preservationSha256:snapshot.preservationSha256,
        restoredIdentity:restored.identity,rollback}};
  } catch(error) {
    return {...result,status:'blocked',reason:error.message,databaseRestored:false,
      oldApplicationRestarted:result.restartAttempted?null:false,rollbackUsed:false};
  }
}
module.exports={recoverSwitchFailure};
