import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { assertManualMediaBinding, assertScheduledMediaBinding } from './xhs-scheduled-media-binding';

type Tx=Pick<Prisma.TransactionClient,'$queryRaw'|'$executeRaw'>;
export type TaskSourceScope={taskId:string;creatorId:string;phase:'profile'|'list'|'detail'|'media'|'comments'|'replies';target:string;cursorHash:string;cursor?:string;rootId?:string;fingerprint:string;owner:string;noteKey?:string;isolatedUnknown?:boolean;confirmedResponse?:boolean;contextRestore?:boolean;preflightConfirmed?:boolean};
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

/** A locally failed admission is not an unknown remote response, but is held
 * for review across new tasks using the same legacy-compatible marker. */
export async function hasTaskDetailLocalReview(tx:Pick<Prisma.TransactionClient,'$queryRaw'>,creatorId:string,noteId:string) {
  const targetHash=hash(noteId),cursorHash=hash(''),fp=taskSourceFingerprint(creatorId,'detail',noteId,cursorHash),marker=prefix+fp;
  const rows=await tx.$queryRaw<Array<{id:string}>>`SELECT t.id FROM xhs_subscription_tasks t JOIN xhs_request_budgets b ON b.id=${marker} AND b.used=1 AND b.request_limit=1, json_each(CASE WHEN json_valid(t.document) THEN t.document ELSE '{}' END,'$.sourceUnknowns') j WHERE t.creator_id=${creatorId} AND json_extract(j.value,'$.marker')=${marker} AND json_extract(j.value,'$.fingerprint')=${fp} AND json_extract(j.value,'$.targetHash')=${targetHash} AND json_extract(j.value,'$.cursorHash')=${cursorHash} AND json_extract(j.value,'$.phase')='detail' AND json_extract(j.value,'$.outcome')='not-dispatched' AND json_extract(j.value,'$.classification')='local-pre-dispatch-review' AND json_extract(j.value,'$.taskId')=t.id AND json_extract(j.value,'$.creatorId')=t.creator_id LIMIT 1`;
  return rows.length===1;
}

/** A terminal task can retain an interrupted detail dispatch across restarts.
 * This only identifies a candidate to skip; it never settles or deletes it. */
export async function terminalStartedDetail(tx:Pick<Prisma.TransactionClient,'$queryRaw'>,creatorId:string,noteId:string):Promise<string|null> {
  const targetHash=hash(noteId),cursorHash=hash(''),fp=taskSourceFingerprint(creatorId,'detail',noteId,cursorHash);
  const rows=await tx.$queryRaw<Array<{id:string;creator_id:string;state:string;document:string}>>`SELECT id,creator_id,state,document FROM xhs_subscription_tasks WHERE json_valid(document) AND json_extract(document,'$.sourceActive.fingerprint')=${fp}`;
  if(rows.length!==1)return null;
  const row=rows[0];let task:any;try{task=JSON.parse(row.document);}catch{return null;}
  const active=task.sourceActive,note=JSON.stringify(['xiaohongshu','note',noteId]);
  if(row.creator_id!==creatorId||!['blocked','failed','partial','cancelled'].includes(row.state)||task.taskId!==row.id||task.creatorId!==creatorId||task.state!==row.state||!Array.isArray(task.noteIds)||!task.noteIds.includes(note)||active?.phase!=='detail'||active.outcome!=='started'||active.targetHash!==targetHash||active.cursorHash!==cursorHash||typeof active.owner!=='string'||!/^[a-f0-9-]{36}$/.test(active.owner))return null;
  const risk=await tx.$queryRaw<Array<{state:string;owner:string|null;code:string|null;http_status:number|null;endpoint:string|null}>>`SELECT state,owner,code,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
  if(risk.length!==1||risk[0].state!=='clear'||risk[0].owner!==null||risk[0].code!==null||risk[0].http_status!==null||risk[0].endpoint!==null)return null;
  return row.id;
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
  const rows=await tx.$queryRaw<Array<{document:string;state:string;author:string;enabled:number|boolean}>>`SELECT t.document,t.state,c.external_author_id AS author,c.enabled AS enabled FROM xhs_subscription_tasks t JOIN xhs_creators c ON c.id=t.creator_id WHERE t.id=${scope.taskId} AND t.creator_id=${scope.creatorId} AND t.state IN ('running','completed','partial')`;
  if(rows.length!==1||(rows[0].enabled!==1&&rows[0].enabled!==true))return bad();
  let task:any;try{task=JSON.parse(rows[0].document);}catch{return bad();}
  if(task.taskId!==scope.taskId||task.creatorId!==scope.creatorId||task.state!==rows[0].state)return bad();
  if(scope.contextRestore){
    const round=task.schedule?.round;
    if(scope.phase!=='list'||!['completed','partial'].includes(task.state)||typeof round!=='string'||task.schedule?.phase!=='basic'||scheduledTaskId(round,scope.creatorId,'basic')!==scope.taskId||task.listFinished!==true||!Array.isArray(task.cursorHistory)||task.cursorHistory.length<1||task.cursorHistory.length>1000||typeof scope.cursor!=='string'||scope.cursorHash!==hash(scope.cursor)||!task.cursorHistory.some((c:any)=>(c??'')===scope.cursor)||rows[0].author!==scope.target)return bad();
  } else if(!['comments','replies'].includes(scope.phase) && task.state!=='running')return bad();
  if(scope.phase==='profile'||scope.phase==='list'){if(rows[0].author!==scope.target)return bad();}
  else if(scope.phase==='detail') {
    const note=JSON.stringify(['xiaohongshu','note',scope.target]);
    if(!Array.isArray(task.noteIds)||!task.noteIds.includes(note))return bad();
    const notes=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_notes WHERE id=${note} AND creator_id=${scope.creatorId}`;
    if(notes.length!==1)return bad();
  } else if(scope.phase==='comments'||scope.phase==='replies') {
    const round=task.schedule?.round,note=JSON.stringify(['xiaohongshu','note',scope.target]);
    const itemPartial=task.state==='partial'&&['XHS_DETAIL_PARSE_FAILED','XHS_DETAIL_OUTCOME_UNKNOWN','XHS_LOCAL_PRE_DISPATCH_FAILED'].includes(task.code)&&task.remaining===0&&task.items?.[note]==='completed';
    const historyPartial=task.state==='partial'&&task.code==='XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED'&&!task.failed;
    const scheduled=typeof round==='string'&&task.schedule?.phase==='basic'&&scheduledTaskId(round,scope.creatorId,'basic')===scope.taskId&&(task.state==='completed'||itemPartial||historyPartial);
    const manual=task.commentManual===true&&task.state==='running'&&!task.schedule&&Array.isArray(task.noteIds)&&task.noteIds.length===1;
    if((!scheduled&&!manual)||!Array.isArray(task.noteIds)||!task.noteIds.includes(note)||task.historyExcludedIds?.includes(note)||typeof scope.cursor!=='string'||scope.cursor.length>4096||scope.cursorHash!==hash(JSON.stringify([scope.rootId??'',scope.cursor])))return bad();
    const notes=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_notes WHERE id=${note} AND creator_id=${scope.creatorId}`;if(notes.length!==1)return bad();
    if(scope.phase==='replies') {if(!scope.rootId||!/^[a-zA-Z0-9_-]{1,128}$/.test(scope.rootId))return bad();const roots=await tx.$queryRaw<Array<{comment_id:string}>>`SELECT comment_id FROM xhs_saved_comments WHERE note_id=${note} AND comment_id=${scope.rootId} AND root_id IS NULL`;if(roots.length!==1)return bad();}
    else if(scope.rootId)return bad();
  } else {
    const noteKey=scope.noteKey,round=task.schedule?.round,batch=task.schedule?.batch??0;
    if(typeof noteKey!=='string'||scope.cursorHash!==createHash('sha256').update(noteKey).digest('hex')||!/^[a-f0-9]{64}$/.test(scope.target))return bad();
    let tuple:any;try{tuple=JSON.parse(noteKey);}catch{return bad();}
    if(!Array.isArray(tuple)||tuple[0]!=='xiaohongshu'||tuple[1]!=='note'||typeof tuple[2]!=='string')return bad();
    const basicId=typeof round==='string'?scheduledTaskId(round,scope.creatorId,'basic'):scope.taskId;
    if(typeof round==='string')await assertScheduledMediaBinding(tx,{round,creatorId:scope.creatorId,taskId:scope.taskId,basicId,authorId:rows[0].author,noteId:noteKey,batch});
    else await assertManualMediaBinding(tx,{creatorId:scope.creatorId,taskId:scope.taskId,authorId:rows[0].author,noteId:noteKey});
    const basic=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${basicId} AND creator_id=${scope.creatorId}`;
    if(basic.length!==1)return bad();let slot:any;try{slot=JSON.parse(basic[0].document).mediaManifests?.[noteKey];}catch{return bad();}
    if(slot?.manifest?.authorId!==rows[0].author||slot?.manifest?.noteId!==tuple[2]||!Array.isArray(slot?.manifest?.images)||!slot.manifest.images.some((image:any)=>image.resourceKey===scope.target))return bad();
  }
  return {raw:rows[0].document,task};
}

/** Bind a detail target to its pending source owner before budget admission. */
export async function prepareTaskDetailAdmission(tx:Tx,scope:TaskSourceScope) {
  if(scope.phase!=='detail')return bad();
  const {raw,task}=await taskRow(tx,scope);
  if(task.sourceActive)return bad();
  const risk=await tx.$queryRaw<Array<{owner:string}>>`SELECT owner FROM xhs_source_risk WHERE id='source' AND state='pending' AND owner=${scope.owner}`;
  if(risk.length!==1)return bad();
  task.sourcePreflight={fingerprint:scope.fingerprint,phase:'detail',targetHash:hash(scope.target),cursorHash:scope.cursorHash,owner:scope.owner,outcome:'prepared'};
  if(await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id=${scope.taskId} AND document=${raw}`!==1)return bad();
}

/** Only a committed preflight and matching pending owner can produce a
 * no-dispatch review marker. Caller must also prove there is no other pending
 * dispatch while holding the same transaction. */
export async function settleTaskDetailPreDispatch(tx:Tx,scope:TaskSourceScope) {
  if(scope.phase!=='detail')return bad();
  const {raw,task}=await taskRow(tx,scope),prepared=task.sourcePreflight;
  if(task.sourceActive||prepared?.outcome!=='prepared'||prepared.phase!=='detail'||prepared.owner!==scope.owner||prepared.fingerprint!==scope.fingerprint||prepared.targetHash!==hash(scope.target)||prepared.cursorHash!==scope.cursorHash)return bad();
  const risk=await tx.$queryRaw<Array<{owner:string}>>`SELECT owner FROM xhs_source_risk WHERE id='source' AND state='pending' AND owner=${scope.owner} AND code IS NULL AND http_status IS NULL AND endpoint IS NULL`;
  if(risk.length!==1)return bad();
  const marker=taskUnknownMarker(scope);
  if((await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id=${marker}`).length)return bad();
  if(task.sourceUnknowns!==undefined&&!Array.isArray(task.sourceUnknowns))return bad();
  const history=task.sourceUnknowns??[];if(history.length>=1000)return bad();
  history.push({marker,fingerprint:scope.fingerprint,phase:'detail',targetHash:hash(scope.target),cursorHash:scope.cursorHash,outcome:'not-dispatched',classification:'local-pre-dispatch-review',taskId:scope.taskId,creatorId:scope.creatorId,owner:scope.owner});
  task.sourceUnknowns=history;delete task.sourcePreflight;
  await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,0,0)`;
  if(await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)} WHERE id=${scope.taskId} AND document=${raw}`!==1)return bad();
  if(await tx.$executeRaw`UPDATE xhs_source_risk SET state='clear',owner=NULL,code=NULL,http_status=NULL,endpoint=NULL,updated_at=${BigInt(Date.now())} WHERE id='source' AND state='pending' AND owner=${scope.owner} AND code IS NULL AND http_status IS NULL AND endpoint IS NULL`!==1)return bad();
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
  const rows=await tx.$queryRaw<Array<{id:string;creator_id:string;entry:string}>>`SELECT t.id,t.creator_id,j.value AS entry FROM xhs_subscription_tasks t, json_each(CASE WHEN json_valid(t.document) THEN t.document ELSE '{}' END,'$.sourceUnknowns') j JOIN xhs_request_budgets b ON b.id=json_extract(j.value,'$.marker') AND b.used=1 AND b.request_limit=1 WHERE b.id LIKE ${prefix+'%'} AND json_extract(j.value,'$.outcome') IN ('unknown','not-dispatched') AND json_extract(j.value,'$.taskId')=t.id AND json_extract(j.value,'$.creatorId')=t.creator_id AND json_extract(t.document,'$.creatorId')=t.creator_id`;
  const counts=new Map<string,number>();
  for(const row of rows){let entry:any;try{entry=JSON.parse(row.entry);}catch{return bad();}const fp=entry.fingerprint;const classification=(entry.outcome==='unknown'&&entry.classification==='request-outcome-unknown')||(entry.outcome==='not-dispatched'&&entry.classification==='local-pre-dispatch-review'&&entry.phase==='detail'&&/^[a-f0-9-]{36}$/.test(entry.owner??''));if(typeof fp==='string' && entry.marker===prefix+fp && classification && ['profile','list','detail','media','comments','replies'].includes(entry.phase)&&/^[a-f0-9]{64}$/.test(entry.targetHash??'')&&/^[a-f0-9]{64}$/.test(entry.cursorHash??'')&&fingerprint(row.creator_id,entry.phase,entry.targetHash,entry.cursorHash)===fp)counts.set(entry.marker,(counts.get(entry.marker)??0)+1);}
  return markers.filter(({id,used,request_limit})=>used===1&&request_limit===1&&/^[a-f0-9]{64}$/.test(id.slice(prefix.length))&&id.slice(prefix.length)!==scope.fingerprint&&counts.get(id)===1).map(({id})=>id);
}

export async function startTaskSource(tx:Tx,scope:TaskSourceScope) {
  const {raw,task}=await taskRow(tx,scope);
  if(task.sourceActive)return bad();
  // Task identity survives task replacement; neither a missing marker nor a
  // new task ID is permission to replay a recorded or unresolved request.
  const prior=await tx.$queryRaw<Array<{id:string}>>`SELECT t.id FROM xhs_subscription_tasks t WHERE json_valid(t.document) AND (json_extract(t.document,'$.sourceActive.fingerprint')=${scope.fingerprint} OR EXISTS(SELECT 1 FROM json_each(t.document,'$.sourceUnknowns') j WHERE json_extract(j.value,'$.fingerprint')=${scope.fingerprint} AND json_extract(j.value,'$.outcome') IN ('unknown','not-dispatched'))) LIMIT 1`;
  if(prior.length)return bad();
  const existing=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id=${taskUnknownMarker(scope)}`;
  if(existing.length)return bad();
  const risk=await tx.$queryRaw<Array<{owner:string}>>`SELECT owner FROM xhs_source_risk WHERE id='source' AND state='pending' AND owner=${scope.owner}`;
  if(risk.length!==1)return bad();
  if(task.sourcePreflight?.owner===scope.owner)delete task.sourcePreflight;
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
