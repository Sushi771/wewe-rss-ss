import { createHash } from 'node:crypto';
import { readHistoryHandoffs } from './xhs-history-handoff';

type Phase = 'basic' | 'media';
type Task = { taskId:string; creatorId:string; state:string; noteIds?:string[];historyExcludedIds?:string[] };
type Tx = { $queryRaw<T>(strings:TemplateStringsArray,...values:unknown[]):Promise<T>; $executeRaw(strings:TemplateStringsArray,...values:unknown[]):Promise<number> };
export type Admission = { kind:'created'|'existing'|'blocked'|'deferred'; taskId:string; reason?:string; historyExcludedIds?:string[] };

/** The id is the persistent round/creator/phase binding; never derive it from a request token. */
export function scheduledTaskId(round:string,creatorId:string,phase:Phase,batch=0) {
  if (!/^\d{4}-\d{2}-\d{2}\/(09:15|14:00|17:30)$/.test(round) || !creatorId || creatorId.length>300 || !['basic','media'].includes(phase)) throw Error('XHS_SCHEDULE_ID_INVALID');
  if(!Number.isSafeInteger(batch)||batch<0||(phase==='basic'&&batch!==0))throw Error('XHS_SCHEDULE_ID_INVALID');
  const identity=batch===0?['xhs-scheduled-v1',round,creatorId,phase]:['xhs-scheduled-v2',round,creatorId,phase,batch];
  const hex=createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,32).split('');
  hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);const id=hex.join('');
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}
/** Caller MUST run this inside the existing serialized incremental write transaction. */
export async function admitScheduledXhs(tx:Tx,input:{round:string; creatorId:string; phase:Phase; task:Task; now:number; batch?:number; preBlocked?:'XHS_SCHEDULE_SELECTION_LIMIT'|'XHS_SCHEDULE_MEDIA_BINDING_REQUIRED'}):Promise<Admission> {
  const {round,creatorId,phase,task,now}=input,batch=input.batch??0, taskId=scheduledTaskId(round,creatorId,phase,batch);
  if(task.taskId!==taskId||task.creatorId!==creatorId||task.state!=='queued'||!Number.isSafeInteger(now))throw Error('XHS_SCHEDULE_TASK_INVALID');
  const existing=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${taskId}`;
  if(existing.length){const old=JSON.parse(existing[0].document);if(old.creatorId!==creatorId||old.schedule?.round!==round||old.schedule?.phase!==phase||(old.schedule?.batch??0)!==batch||(phase==='media'&&JSON.stringify(old.noteIds)!==JSON.stringify(task.noteIds)))throw Error('XHS_SCHEDULE_BINDING_MISMATCH');return {kind:'existing',taskId};}
  const creator=await tx.$queryRaw<Array<{enabled:number|boolean;external_author_id:string|null}>>`SELECT enabled,external_author_id FROM xhs_creators WHERE id=${creatorId}`;
  const risk=await tx.$queryRaw<Array<{state:string}>>`SELECT state FROM xhs_source_risk WHERE id='source'`;
  const history=await readHistoryHandoffs(tx as any);
  const fences=(await tx.$queryRaw<Array<{id:string;used:number;request_limit:number}>>`SELECT id,used,request_limit FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`).filter(f=>!history.markers.includes(f.id));
  // A paired unknown prevents replay at dispatch, but must not prevent unrelated
  // creators from creating a task. Invalid or unpaired markers still block.
  const unknownPrefix='xhs:dispatch-pending:unknown:';
  const unknownRows=await tx.$queryRaw<Array<{id:string;creator_id:string;entry:string}>>`SELECT t.id,t.creator_id,j.value AS entry FROM xhs_subscription_tasks t, json_each(CASE WHEN json_valid(t.document) THEN t.document ELSE '{}' END,'$.sourceUnknowns') j JOIN xhs_request_budgets b ON b.id=json_extract(j.value,'$.marker') AND b.used=1 AND b.request_limit=1 WHERE b.id LIKE 'xhs:dispatch-pending:unknown:%' AND json_extract(j.value,'$.outcome') IN ('unknown','not-dispatched') AND json_extract(j.value,'$.taskId')=t.id AND json_extract(j.value,'$.creatorId')=t.creator_id AND json_extract(t.document,'$.creatorId')=t.creator_id`;
  const counts=new Map<string,number>();
  for(const row of unknownRows){let e:any;try{e=JSON.parse(row.entry);}catch{continue;}const fp=e.fingerprint;const expected=createHash('sha256').update(JSON.stringify([row.creator_id,e.phase,e.targetHash,e.cursorHash])).digest('hex');const classification=(e.outcome==='unknown'&&e.classification==='request-outcome-unknown')||(e.outcome==='not-dispatched'&&e.classification==='local-pre-dispatch-review'&&e.phase==='detail'&&/^[a-f0-9-]{36}$/.test(e.owner??''));if(typeof fp==='string'&&e.marker===unknownPrefix+fp&&classification&&['profile','list','detail','media','comments','replies'].includes(e.phase)&&/^[a-f0-9]{64}$/.test(e.targetHash??'')&&/^[a-f0-9]{64}$/.test(e.cursorHash??'')&&fp===expected)counts.set(e.marker,(counts.get(e.marker)??0)+1);}
  const unverifiedFences=fences.filter(f=>!f.id.startsWith(unknownPrefix)||f.used!==1||f.request_limit!==1||counts.get(f.id)!==1);
  const jobs=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId} AND state IN ('queued','running') LIMIT 1`;
  const tasks=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_subscription_tasks WHERE creator_id=${creatorId} AND state IN ('queued','running') LIMIT 1`;
  // A live source request or creator task is not a settled failure. Observe it
  // on a later tick without admitting a task or sending a source request.
  if(risk.length===1 && risk[0].state==='pending')return {kind:'deferred',taskId,reason:'XHS_SCHEDULE_SOURCE_BUSY'};
  let reason:string|undefined;
  if(creator.length!==1||(creator[0].enabled!==1&&creator[0].enabled!==true)||!creator[0].external_author_id)reason='XHS_SCHEDULE_CREATOR_DISABLED';
  else if(risk.length!==1||risk[0].state!=='clear'||unverifiedFences.length)reason='XHS_SCHEDULE_SOURCE_BLOCKED';
  else if(history.profilePendingCreators.includes(creatorId))reason='XHS_SCHEDULE_HISTORY_PROFILE_REVIEW_REQUIRED';
  else if(jobs.length||tasks.length)return {kind:'deferred',taskId,reason:'XHS_SCHEDULE_TASK_ACTIVE'};
  if(!reason && input.preBlocked)reason=input.preBlocked;
  if(!reason && phase==='media'){
    const basicId=scheduledTaskId(round,creatorId,'basic');const predecessor=await tx.$queryRaw<Array<{state:string;document:string}>>`SELECT state,document FROM xhs_subscription_tasks WHERE id=${basicId}`;
    const basic=predecessor.length===1?JSON.parse(predecessor[0].document):undefined;
    const historyPartial=predecessor[0]?.state==='partial'&&basic?.code==='XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED'&&basic?.failed===0;
    const itemPartial=predecessor[0]?.state==='partial'&&['XHS_DETAIL_PARSE_FAILED','XHS_DETAIL_OUTCOME_UNKNOWN','XHS_LOCAL_PRE_DISPATCH_FAILED'].includes(basic?.code)&&basic?.failed>0&&basic?.remaining===0;
    if(predecessor.length!==1||!(predecessor[0].state==='completed'||historyPartial||itemPartial)||(!itemPartial&&basic.failed!==0))reason='XHS_SCHEDULE_BASIC_INCOMPLETE';
    else {
      const ids=Array.isArray(basic.noteIds)?(itemPartial?basic.noteIds.filter((id:string)=>basic.items?.[id]==='completed'):basic.noteIds):undefined,expected=ids?.slice(batch*1000,(batch+1)*1000);
      if(!expected?.length || JSON.stringify(task.noteIds)!==JSON.stringify(expected))reason='XHS_SCHEDULE_BATCH_MISMATCH';
      if(!reason&&batch>0){const previousId=scheduledTaskId(round,creatorId,'media',batch-1);const previous=await tx.$queryRaw<Array<{state:string;document:string}>>`SELECT state,document FROM xhs_subscription_tasks WHERE id=${previousId} AND creator_id=${creatorId}`;const prior=previous.length===1?JSON.parse(previous[0].document):undefined;const safePartial=previous[0]?.state==='partial'&&prior?.failed===0&&prior?.remaining===0&&['XHS_MEDIA_NEEDS_DETAIL_REFRESH','XHS_MEDIA_REVIEW_REQUIRED'].includes(prior?.code);if(previous.length!==1||(previous[0].state!=='completed'&&!safePartial)||prior?.failed!==0)reason='XHS_SCHEDULE_PREVIOUS_BATCH_INCOMPLETE';}
    }
  }
  const value={...task,state:reason?'blocked':'queued',...(reason?{code:reason,message:'本轮未执行，需核对后处理。'}:{}),schedule:{round,phase,...(phase==='media'?{batch}:{})}};
  const historyExcludedIds=history.excludedByCreator[creatorId] ?? [];
  if(phase==='basic'&&historyExcludedIds.length)value.historyExcludedIds=historyExcludedIds;
  const count=await tx.$executeRaw`INSERT INTO xhs_subscription_tasks (id,creator_id,state,document,updated_at) VALUES (${taskId},${creatorId},${value.state},${JSON.stringify(value)},${BigInt(now)}) ON CONFLICT(id) DO NOTHING`;
  if(count!==1)throw Error('XHS_SCHEDULE_CONCURRENT_ADMISSION');
  return reason?{kind:'blocked',taskId,reason}:{kind:'created',taskId,historyExcludedIds};
}
