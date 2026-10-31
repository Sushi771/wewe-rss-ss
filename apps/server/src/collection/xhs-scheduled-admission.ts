import { createHash } from 'node:crypto';

type Phase = 'basic' | 'media';
type Task = { taskId:string; creatorId:string; state:string; noteIds?:string[] };
type Tx = { $queryRaw<T>(strings:TemplateStringsArray,...values:unknown[]):Promise<T>; $executeRaw(strings:TemplateStringsArray,...values:unknown[]):Promise<number> };
export type Admission = { kind:'created'|'existing'|'blocked'|'deferred'; taskId:string; reason?:string };

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
  const creator=await tx.$queryRaw<Array<{enabled:number;external_author_id:string|null}>>`SELECT enabled,external_author_id FROM xhs_creators WHERE id=${creatorId}`;
  const risk=await tx.$queryRaw<Array<{state:string}>>`SELECT state FROM xhs_source_risk WHERE id='source'`;
  const fences=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' LIMIT 1`;
  const jobs=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId} AND state IN ('queued','running') LIMIT 1`;
  const tasks=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_subscription_tasks WHERE creator_id=${creatorId} AND state IN ('queued','running') LIMIT 1`;
  // A live source request or creator task is not a settled failure. Observe it
  // on a later tick without admitting a task or sending a source request.
  if(risk.length===1 && risk[0].state==='pending')return {kind:'deferred',taskId,reason:'XHS_SCHEDULE_SOURCE_BUSY'};
  let reason:string|undefined;
  if(creator.length!==1||creator[0].enabled!==1||!creator[0].external_author_id)reason='XHS_SCHEDULE_CREATOR_DISABLED';
  else if(risk.length!==1||risk[0].state!=='clear'||fences.length)reason='XHS_SCHEDULE_SOURCE_BLOCKED';
  else if(jobs.length||tasks.length)return {kind:'deferred',taskId,reason:'XHS_SCHEDULE_TASK_ACTIVE'};
  if(!reason && input.preBlocked)reason=input.preBlocked;
  if(!reason && phase==='media'){
    const basicId=scheduledTaskId(round,creatorId,'basic');const predecessor=await tx.$queryRaw<Array<{state:string;document:string}>>`SELECT state,document FROM xhs_subscription_tasks WHERE id=${basicId}`;
    if(predecessor.length!==1||predecessor[0].state!=='completed'||JSON.parse(predecessor[0].document).failed!==0)reason='XHS_SCHEDULE_BASIC_INCOMPLETE';
    else {
      const basic=JSON.parse(predecessor[0].document),expected=Array.isArray(basic.noteIds)?basic.noteIds.slice(batch*1000,(batch+1)*1000):undefined;
      if(!expected?.length || JSON.stringify(task.noteIds)!==JSON.stringify(expected))reason='XHS_SCHEDULE_BATCH_MISMATCH';
      if(!reason&&batch>0){const previousId=scheduledTaskId(round,creatorId,'media',batch-1);const previous=await tx.$queryRaw<Array<{state:string;document:string}>>`SELECT state,document FROM xhs_subscription_tasks WHERE id=${previousId} AND creator_id=${creatorId}`;const prior=previous.length===1?JSON.parse(previous[0].document):undefined;const safePartial=previous[0]?.state==='partial'&&prior?.failed===0&&prior?.remaining===0&&['XHS_MEDIA_NEEDS_DETAIL_REFRESH','XHS_MEDIA_REVIEW_REQUIRED'].includes(prior?.code);if(previous.length!==1||(previous[0].state!=='completed'&&!safePartial)||prior?.failed!==0)reason='XHS_SCHEDULE_PREVIOUS_BATCH_INCOMPLETE';}
    }
  }
  const value={...task,state:reason?'blocked':'queued',...(reason?{code:reason,message:'本轮未执行，需核对后处理。'}:{}),schedule:{round,phase,...(phase==='media'?{batch}:{})}};
  const count=await tx.$executeRaw`INSERT INTO xhs_subscription_tasks (id,creator_id,state,document,updated_at) VALUES (${taskId},${creatorId},${value.state},${JSON.stringify(value)},${BigInt(now)}) ON CONFLICT(id) DO NOTHING`;
  if(count!==1)throw Error('XHS_SCHEDULE_CONCURRENT_ADMISSION');
  return reason?{kind:'blocked',taskId,reason}:{kind:'created',taskId};
}
