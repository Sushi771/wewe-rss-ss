import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { assertScheduledMediaBinding } from './xhs-scheduled-media-binding';

type Tx=Pick<Prisma.TransactionClient,'$queryRaw'|'$executeRaw'>;
export type TaskSourceScope={taskId:string;creatorId:string;phase:'profile'|'list'|'detail'|'media';target:string;cursorHash:string;fingerprint:string;owner:string;noteKey?:string;isolatedUnknown?:boolean};
const prefix='xhs:dispatch-pending:unknown:';
const bad=():never=>{throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fingerprint=(creatorId:string,phase:string,targetHash:string,cursorHash:string)=>hash(JSON.stringify([creatorId,phase,targetHash,cursorHash]));
export const taskSourceFingerprint=(creatorId:string,phase:string,target:string,cursorHash:string)=>fingerprint(creatorId,phase,hash(target),cursorHash);
export const taskUnknownMarker=(scope:TaskSourceScope)=>prefix+scope.fingerprint;

/** Only a paired, identity-bound receipt and legacy marker can justify skipping
 * an unknown detail before entering the shared source session. */
export async function hasTaskDetailUnknown(tx:Pick<Prisma.TransactionClient,'$queryRaw'>,creatorId:string,noteId:string) {
  const targetHash=hash(noteId),cursorHash=hash(''),fp=taskSourceFingerprint(creatorId,'detail',noteId,cursorHash),marker=prefix+fp;
  const rows=await tx.$queryRaw<Array<{id:string}>>`SELECT t.id FROM xhs_subscription_tasks t JOIN xhs_request_budgets b ON b.id=${marker} AND b.used=1 AND b.request_limit=1, json_each(CASE WHEN json_valid(t.document) THEN t.document ELSE '{}' END,'$.sourceUnknowns') j WHERE t.creator_id=${creatorId} AND json_extract(j.value,'$.marker')=${marker} AND json_extract(j.value,'$.fingerprint')=${fp} AND json_extract(j.value,'$.targetHash')=${targetHash} AND json_extract(j.value,'$.cursorHash')=${cursorHash} AND json_extract(j.value,'$.phase')='detail' AND json_extract(j.value,'$.outcome')='unknown' AND json_extract(j.value,'$.classification')='request-outcome-unknown' AND json_extract(j.value,'$.taskId')=t.id AND json_extract(j.value,'$.creatorId')=t.creator_id LIMIT 1`;
  return rows.length===1;
}

/** A verified prior media unknown is displayed as incomplete without acquiring
 * the shared lane or attempting the same resource in a later round. */
export async function hasTaskMediaUnknown(tx:Pick<Prisma.TransactionClient,'$queryRaw'>,creatorId:string,noteKey:string,resources:Array<string|null>) {
  const cursorHash=createHash('sha256').update(noteKey).digest('hex');
  const wanted=new Map<string,string>();
  for(const target of resources){
    if(!target || !/^[a-f0-9]{64}$/.test(target))continue;
    wanted.set(taskSourceFingerprint(creatorId,'media',target,cursorHash),hash(target));
  }
  if(!wanted.size)return false;
  const rows=await tx.$queryRaw<Array<{id:string;entry:string}>>`SELECT t.id,j.value AS entry FROM xhs_subscription_tasks t, json_each(CASE WHEN json_valid(t.document) THEN t.document ELSE '{}' END,'$.sourceUnknowns') j JOIN xhs_request_budgets b ON b.id=json_extract(j.value,'$.marker') AND b.used=1 AND b.request_limit=1 WHERE t.creator_id=${creatorId} AND json_extract(j.value,'$.phase')='media' AND json_extract(j.value,'$.outcome')='unknown' AND json_extract(j.value,'$.classification')='request-outcome-unknown' AND json_extract(j.value,'$.taskId')=t.id AND json_extract(j.value,'$.creatorId')=t.creator_id`;
  for(const row of rows){let item:any;try{item=JSON.parse(row.entry);}catch{return bad();}if(item.marker===prefix+item.fingerprint && item.cursorHash===cursorHash && wanted.get(item.fingerprint)===item.targetHash)return true;}
  return false;
}

/** Validate the task, author, and actual request target within the dispatch transaction. */
async function taskRow(tx:Tx,scope:TaskSourceScope) {
  if(!/^[a-f0-9]{64}$/.test(scope.fingerprint)||scope.fingerprint!==taskSourceFingerprint(scope.creatorId,scope.phase,scope.target,scope.cursorHash)||!/^[a-f0-9-]{36}$/.test(scope.owner))return bad();
  const rows=await tx.$queryRaw<Array<{document:string;author:string;enabled:number|boolean}>>`SELECT t.document,c.external_author_id AS author,c.enabled AS enabled FROM xhs_subscription_tasks t JOIN xhs_creators c ON c.id=t.creator_id WHERE t.id=${scope.taskId} AND t.creator_id=${scope.creatorId} AND t.state='running'`;
  if(rows.length!==1||(rows[0].enabled!==1&&rows[0].enabled!==true))return bad();
  let task:any;try{task=JSON.parse(rows[0].document);}catch{return bad();}
  if(task.taskId!==scope.taskId||task.creatorId!==scope.creatorId||task.state!=='running')return bad();
  if(scope.phase==='profile'||scope.phase==='list'){if(rows[0].author!==scope.target)return bad();}
  else if(scope.phase==='detail') {
    const note=JSON.stringify(['xiaohongshu','note',scope.target]);
    if(!Array.isArray(task.noteIds)||!task.noteIds.includes(note))return bad();
    const notes=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_notes WHERE id=${note} AND creator_id=${scope.creatorId}`;
    if(notes.length!==1)return bad();
  } else {
    const noteKey=scope.noteKey,round=task.schedule?.round,batch=task.schedule?.batch??0;
    if(typeof noteKey!=='string'||scope.cursorHash!==createHash('sha256').update(noteKey).digest('hex')||!/^[a-f0-9]{64}$/.test(scope.target)||typeof round!=='string')return bad();
    let tuple:any;try{tuple=JSON.parse(noteKey);}catch{return bad();}
    if(!Array.isArray(tuple)||tuple[0]!=='xiaohongshu'||tuple[1]!=='note'||typeof tuple[2]!=='string')return bad();
    const basicId=scheduledTaskId(round,scope.creatorId,'basic');
    await assertScheduledMediaBinding(tx,{round,creatorId:scope.creatorId,taskId:scope.taskId,basicId,authorId:rows[0].author,noteId:noteKey,batch});
    const basic=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${basicId} AND creator_id=${scope.creatorId}`;
    if(basic.length!==1)return bad();let slot:any;try{slot=JSON.parse(basic[0].document).mediaManifests?.[noteKey];}catch{return bad();}
    if(slot?.manifest?.authorId!==rows[0].author||slot?.manifest?.noteId!==tuple[2]||!Array.isArray(slot?.manifest?.images)||!slot.manifest.images.some((image:any)=>image.resourceKey===scope.target))return bad();
  }
  return {raw:rows[0].document,task};
}

/** A response stream failed after headers. The resource store must already
 * contain its own unknown receipt before this can release the shared owner. */
export async function settleTaskMediaStreamUnknown(tx:Tx,scope:TaskSourceScope) {
  if(scope.phase!=='media'||!scope.noteKey)return bad();
  const {raw,task}=await taskRow(tx,scope);
  if(task.sourceActive)return bad();
  const basicId=scheduledTaskId(task.schedule.round,scope.creatorId,'basic');
  const rows=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${basicId} AND creator_id=${scope.creatorId}`;
  if(rows.length!==1)return bad();let slot:any;try{slot=JSON.parse(rows[0].document).mediaManifests?.[scope.noteKey];}catch{return bad();}
  if(!Object.values(slot?.items??{}).some((item:any)=>item?.state==='unknown'&&item.resourceKey===scope.target))return bad();
  const risk=await tx.$queryRaw<Array<{owner:string}>>`SELECT owner FROM xhs_source_risk WHERE id='source' AND state='pending' AND owner=${scope.owner}`;
  if(risk.length!==1)return bad();
  if(task.sourceUnknowns!==undefined&&!Array.isArray(task.sourceUnknowns))return bad();const history=task.sourceUnknowns??[];if(history.length>=1000)return bad();
  const marker=taskUnknownMarker(scope);history.push({marker,fingerprint:scope.fingerprint,phase:scope.phase,targetHash:hash(scope.target),cursorHash:scope.cursorHash,outcome:'unknown',classification:'request-outcome-unknown',taskId:scope.taskId,creatorId:scope.creatorId});task.sourceUnknowns=history;
  await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,0,0)`;
  if(await tx.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL,updated_at=${BigInt(Date.now())} WHERE id='source' AND state='pending' AND owner=${scope.owner}`!==1)return bad();
  if(await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id=${scope.taskId} AND document=${raw}`!==1)return bad();
}

/** Existing old releases still block on these markers; only validated new tasks may pass unrelated ones. */
export async function verifiedUnknownMarkers(tx:Tx,scope:TaskSourceScope):Promise<string[]> {
  await taskRow(tx,scope);
  const risk=await tx.$queryRaw<Array<{owner:string}>>`SELECT owner FROM xhs_source_risk WHERE id='source' AND state='pending' AND owner=${scope.owner}`;
  if(risk.length!==1)return bad();
  const markers=await tx.$queryRaw<Array<{id:string;used:number;request_limit:number}>>`SELECT id,used,request_limit FROM xhs_request_budgets WHERE id LIKE ${prefix+'%'}`;
  if(!markers.length)return [];
  const rows=await tx.$queryRaw<Array<{id:string;creator_id:string;entry:string}>>`SELECT t.id,t.creator_id,j.value AS entry FROM xhs_subscription_tasks t, json_each(CASE WHEN json_valid(t.document) THEN t.document ELSE '{}' END,'$.sourceUnknowns') j JOIN xhs_request_budgets b ON b.id=json_extract(j.value,'$.marker') AND b.used=1 AND b.request_limit=1 WHERE b.id LIKE ${prefix+'%'} AND json_extract(j.value,'$.outcome')='unknown' AND json_extract(j.value,'$.taskId')=t.id AND json_extract(j.value,'$.creatorId')=t.creator_id AND json_extract(t.document,'$.creatorId')=t.creator_id`;
  const counts=new Map<string,number>();
  for(const row of rows){let entry:any;try{entry=JSON.parse(row.entry);}catch{return bad();}const fp=entry.fingerprint;if(typeof fp==='string' && entry.marker===prefix+fp && entry.classification==='request-outcome-unknown' && ['profile','list','detail','media'].includes(entry.phase)&&/^[a-f0-9]{64}$/.test(entry.targetHash??'')&&/^[a-f0-9]{64}$/.test(entry.cursorHash??'')&&fingerprint(row.creator_id,entry.phase,entry.targetHash,entry.cursorHash)===fp)counts.set(entry.marker,(counts.get(entry.marker)??0)+1);}
  return markers.filter(({id,used,request_limit})=>used===1&&request_limit===1&&/^[a-f0-9]{64}$/.test(id.slice(prefix.length))&&id.slice(prefix.length)!==scope.fingerprint&&counts.get(id)===1).map(({id})=>id);
}

export async function startTaskSource(tx:Tx,scope:TaskSourceScope) {
  const {raw,task}=await taskRow(tx,scope);
  if(task.sourceActive)return bad();
  // Task identity survives task replacement; neither a missing marker nor a
  // new task ID is permission to replay a recorded or unresolved request.
  const prior=await tx.$queryRaw<Array<{id:string}>>`SELECT t.id FROM xhs_subscription_tasks t WHERE json_valid(t.document) AND (json_extract(t.document,'$.sourceActive.fingerprint')=${scope.fingerprint} OR EXISTS(SELECT 1 FROM json_each(t.document,'$.sourceUnknowns') j WHERE json_extract(j.value,'$.fingerprint')=${scope.fingerprint} AND json_extract(j.value,'$.outcome')='unknown')) LIMIT 1`;
  if(prior.length)return bad();
  const existing=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id=${taskUnknownMarker(scope)}`;
  if(existing.length)return bad();
  const risk=await tx.$queryRaw<Array<{owner:string}>>`SELECT owner FROM xhs_source_risk WHERE id='source' AND state='pending' AND owner=${scope.owner}`;
  if(risk.length!==1)return bad();
  task.sourceActive={fingerprint:scope.fingerprint,phase:scope.phase,targetHash:hash(scope.target),cursorHash:scope.cursorHash,owner:scope.owner,outcome:'started'};
  if(await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id=${scope.taskId} AND document=${raw}`!==1)return bad();
}

/** On a known response the active guard ends; unknown retains a marker and releases only this owner. */
export async function settleTaskSource(tx:Tx,scope:TaskSourceScope,outcome:'response'|'unknown') {
  const {raw,task}=await taskRow(tx,scope),active=task.sourceActive;
  if(!active||active.fingerprint!==scope.fingerprint||active.targetHash!==hash(scope.target)||active.cursorHash!==scope.cursorHash||active.owner!==scope.owner||active.phase!==scope.phase||active.outcome!=='started')return bad();
  const risk=await tx.$queryRaw<Array<{owner:string}>>`SELECT owner FROM xhs_source_risk WHERE id='source' AND state='pending' AND owner=${scope.owner}`;
  if(risk.length!==1)return bad();
  delete task.sourceActive;
  if(outcome==='unknown'){
    if(task.sourceUnknowns!==undefined&&!Array.isArray(task.sourceUnknowns))return bad();
    const history=task.sourceUnknowns??[];if(history.length>=1000)return bad();
    const marker=taskUnknownMarker(scope);history.push({marker,fingerprint:scope.fingerprint,phase:scope.phase,targetHash:hash(scope.target),cursorHash:scope.cursorHash,outcome:'unknown',classification:'request-outcome-unknown',taskId:scope.taskId,creatorId:scope.creatorId});task.sourceUnknowns=history;
    await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,0,0)`;
    if(await tx.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL,updated_at=${BigInt(Date.now())} WHERE id='source' AND state='pending' AND owner=${scope.owner}`!==1)return bad();
  }
  if(await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id=${scope.taskId} AND document=${raw}`!==1)return bad();
}
