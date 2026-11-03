import {createHash} from 'node:crypto';
import {LegacyMaintenanceVerifier, validateMaintenance, Scope, Evidence, Identity} from './legacy-maintenance';
export type Connection={exec(sql:string):void;get(sql:string,...params:unknown[]):any;run(sql:string,...params:unknown[]):{changes:number};close():void};
export type PreservingControllerPorts={
 claim:{check():unknown;assertWritable(kinds:string[]):unknown};
 // Only a trusted controller adapter may supply live state; no HTTP/JSON proof input.
 readLease():Evidence['lock'];readProjectWriters():Evidence['writers'];
 databaseIdentity():string;openDatabase():Connection;
 observeProjectWriters?():void;
};
const fail=():never=>{throw Error('LEGACY_MAINTENANCE_UNPROVEN')};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function legacySnapshot(db:Connection,jobId:string){
 const row=db.get('SELECT j.document,j.state,c.external_author_id AS author FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=?',jobId);
 if(!row||row.state!=='paused')return fail();let job:any;try{job=JSON.parse(row.document)}catch{return fail()}const f=job.sourceFence;
 if(!f||f.state!=='started'||f.owner!==undefined||typeof f.noteId!=='string')return fail();
 const budgets=db.get('SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id=?',jobId);
 const shared=db.get("SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id='xhs:source-total'");
 if(!budgets||!shared)return fail();
 const normalized=[budgets,shared].map(b=>({id:b.id,used:Number(b.used),limit:Number(b.request_limit),nextAt:String(b.next_at),intervalMs:Number(b.interval_ms)}));
 if(normalized.some(b=>!Number.isSafeInteger(b.used)||b.used<0||!Number.isSafeInteger(b.limit)||b.limit<0||b.used>b.limit||!Number.isSafeInteger(b.intervalMs)||b.intervalMs<0||!/^\d+$/.test(b.nextAt)))return fail();
 return {row,job,authorId:row.author,noteId:f.noteId,unknownDigest:digest({fence:f,code:job.code}),budgetDigest:digest({budgets:normalized,phaseGrant:job.sourceGrant??null})};
}
/** Called server-side while the preserving restart claim is still held. No stop/start or network operations. */
export async function persistLegacyMaintenance(scope:Scope,ports?:PreservingControllerPorts){
 if(!ports||typeof ports.claim?.check!=='function'||typeof ports.claim?.assertWritable!=='function'||typeof ports.readLease!=='function'||typeof ports.readProjectWriters!=='function'||typeof ports.databaseIdentity!=='function'||typeof ports.openDatabase!=='function')return fail();
 const checked=()=>{ports.claim.assertWritable(['restart']);ports.claim.check();if(ports.databaseIdentity()!==scope.databaseIdentity)return fail();};
 const open=()=>{checked();return ports.openDatabase();};
 const checkSnapshot=(db:Connection)=>{const s=legacySnapshot(db,scope.jobId);if(s.authorId!==scope.authorId||s.noteId!==scope.noteId||s.unknownDigest!==scope.unknownDigest||s.budgetDigest!==scope.budgetDigest)return fail();return s;};
 checked();
 ports.observeProjectWriters?.();
 const probeStart=Date.now();const probe=open();let rolledBackAt:number,probeClosedAt:number;
 try{probe.exec('BEGIN EXCLUSIVE');probe.exec('ROLLBACK');rolledBackAt=Date.now();}finally{probe.close();probeClosedAt=Date.now();}
 const snapshotDb=open();let capturedAt:number,snapshotClosedAt:number;
 try{snapshotDb.exec('BEGIN');checkSnapshot(snapshotDb);capturedAt=Date.now();snapshotDb.exec('ROLLBACK');}finally{snapshotDb.close();snapshotClosedAt=Date.now();}
 const observations:Evidence[]=[];
 const verifier=new LegacyMaintenanceVerifier(async()=>{
  checked();const db=open();try{checkSnapshot(db);}finally{db.close();}
  const lock=ports.readLease(),writers=ports.readProjectWriters();
  const evidence:Evidence={scope:structuredClone(scope),capturedAt:Date.now(),lock,writers,probe:{databaseIdentity:scope.databaseIdentity,mode:'exclusive',succeeded:true,enteredAt:probeStart,rolledBackAt:rolledBackAt!,connectionClosedAt:probeClosedAt!},snapshot:{databaseIdentity:scope.databaseIdentity,unknownDigest:scope.unknownDigest,budgetDigest:scope.budgetDigest,capturedAt:capturedAt!,connectionClosedAt:snapshotClosedAt!}};
  observations.push(structuredClone(evidence));return evidence;
 });
 const token=await verifier.collectFromController(scope);const record=await verifier.takeForPersistence(token,scope);
 const db=open();let committed=false;
 try{
  db.exec('BEGIN IMMEDIATE');checked();
  ports.observeProjectWriters?.();
  // Revalidate the live lease/writers immediately before persistence; never trust saved booleans.
  const fresh={scope:structuredClone(scope),capturedAt:Date.now(),lock:ports.readLease(),writers:ports.readProjectWriters(),probe:{databaseIdentity:scope.databaseIdentity,mode:'exclusive' as const,succeeded:true,enteredAt:probeStart,rolledBackAt:rolledBackAt!,connectionClosedAt:probeClosedAt!},snapshot:{databaseIdentity:scope.databaseIdentity,unknownDigest:scope.unknownDigest,budgetDigest:scope.budgetDigest,capturedAt:capturedAt!,connectionClosedAt:snapshotClosedAt!}};
  const checkTime=Date.now();observations.forEach(e=>validateMaintenance(scope,e,checkTime));validateMaintenance(scope,fresh,checkTime);
  if(fresh.lock.identity!==record.lockIdentity||fresh.lock.nonce!==record.lockNonce||digest(fresh.lock.holder)!==digest(record.holder))return fail();
  const s=checkSnapshot(db),old=s.job.legacyMaintenanceProof;
  if(old){if(digest(old.scope)!==digest(record.scope)||old.lockIdentity!==record.lockIdentity||old.lockNonce!==record.lockNonce||digest(old.holder)!==digest(record.holder)||old.oldOwner!==null||old.oldResult!=='unknown'||old.allowsRetry!==false||typeof old.proofId!=='string'||!/^[a-f0-9]{64}$/.test(old.proofId))return fail();db.exec('ROLLBACK');return {proofId:old.proofId,allowsRetry:false as const,alreadyRecorded:true};}
  s.job.legacyMaintenanceProof=record;
  const changed=db.run("UPDATE xhs_whole_creator_jobs SET document=? WHERE id=? AND state='paused' AND document=?",JSON.stringify(s.job),scope.jobId,s.row.document);
  if(Number(changed.changes)!==1)return fail();checked();const commitTime=Date.now();observations.forEach(e=>validateMaintenance(scope,e,commitTime));db.exec('COMMIT');committed=true;
  return {proofId:record.proofId,allowsRetry:false as const,alreadyRecorded:false};
 }finally{if(!committed){try{db.exec('ROLLBACK')}catch{/* already rolled back */}}db.close();}
}

export type RestartCheckpoint={identity:{pid:number;startUtc:string;executable:string;commandLine:string};stopReceipt:{pid:number;startUtc:string;executable:string;commandLine:string;stopped:boolean};scopeLease:PreservingControllerPorts['claim']&{policy?:{preservingUpdate?:{operation?:string;active?:{oldProcess?:{pid:number;startUtc:string}}}}};backup:unknown};
/** Internal preserving-restart callback adapter. Ordinary JSON cannot supply the live claim methods. */
export async function fromPreservingRestartCheckpoint(scope:Scope,checkpoint:RestartCheckpoint,ports:Omit<PreservingControllerPorts,'claim'>){
 const {identity:i,stopReceipt:r,scopeLease:lease}=checkpoint;
 if(!i||!r||typeof lease?.check!=='function'||typeof lease?.assertWritable!=='function'||lease.policy?.preservingUpdate?.operation!=='restart'||r.stopped!==true||i.pid!==r.pid||i.startUtc!==r.startUtc||i.executable!==r.executable||i.commandLine!==r.commandLine||lease.policy.preservingUpdate.active?.oldProcess?.pid!==i.pid||lease.policy.preservingUpdate.active?.oldProcess?.startUtc!==i.startUtc)return fail();
 lease.check();return persistLegacyMaintenance(scope,{...ports,claim:lease});
}
