import type { Prisma } from '@prisma/client';
import { consumeReviewedAttempt, AttemptScope, attemptDigest } from './xhs-reviewed-attempt';
import { ownsDispatch } from './xhs-dispatch-owner';
import { noUnresolvedRecovery } from './xhs-whole-source-fence';
import { XhsSubscriptionError } from './xhs-subscription-errors';
type Tx=Pick<Prisma.TransactionClient,'$queryRaw'|'$executeRaw'>;
export type RecoveryWriter=<T>(fn:(tx:Tx)=>Promise<T>)=>Promise<T>;
const bad=():never=>{throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED')};
export type ReviewedTransportPermit = object;
const permits=new WeakMap<object,{digest:string;owner:ReturnType<typeof createPermitOwner>; dispatch:<V>(operation:()=>Promise<V>)=>Promise<V>}>();
function createPermitOwner(owner: import('./xhs-dispatch-owner').DispatchOwner){return owner;}
export function consumeReviewedTransportPermit(permit:unknown,scope:AttemptScope){
 if(!permit||typeof permit!=='object')return bad();
 const bound=permits.get(permit);permits.delete(permit);
 if(!bound||bound.digest!==attemptDigest(scope)||!ownsDispatch(bound.owner,bound.owner))return bad();
 return bound;
}
/** One physical request; caller's normal runtime must provide authenticated transport and business checkpoint. */
export async function dispatchReviewedSource<T,R>(write:RecoveryWriter,input:AttemptScope,id:string,request:{authorId:string;noteId:string;phase:string},ready:()=>void|Promise<void>,transport:(permit:ReviewedTransportPermit)=>Promise<T>,checkpoint:(tx:Tx,value:T)=>Promise<R>){
 if(input.maxRequests!==1||request.authorId!==input.authorId||request.noteId!==input.noteId||request.phase!==input.phase||!['detail','metrics'].includes(request.phase))return bad();
 await ready();
 const marker='xhs:dispatch-pending:review:'+id;
 const owner=await write(async tx=>{
   const now=Date.now();
   const attempt=await consumeReviewedAttempt(tx,input,id,now);
   const rows=await tx.$queryRaw<Array<{id:string;interval_ms:number;used:number;next_at:bigint}>>`SELECT id,used,next_at,interval_ms FROM xhs_request_budgets WHERE id IN (${input.jobId},'xhs:source-total')`;
   if(rows.length!==2||rows.some(r=>Number(r.next_at)>now||!Number.isSafeInteger(Number(r.interval_ms))||Number(r.interval_ms)<1000))return bad();
   for(const row of rows){const cap=row.id===input.jobId?input.taskUsedCeiling:input.sharedUsedCeiling;
     const n=await tx.$executeRaw`UPDATE xhs_request_budgets SET used=used+1,next_at=${BigInt(now+Number(row.interval_ms))} WHERE id=${row.id} AND used=${row.used} AND used<9007199254740991 AND used<${cap} AND next_at<=${BigInt(now)}`;if(n!==1)return bad();}
   const jobRows=await tx.$queryRaw<Array<{document:string;creator_id:string}>>`SELECT document,creator_id FROM xhs_whole_creator_jobs WHERE id=${input.jobId}`;
   const job=JSON.parse(jobRows[0].document),grant=job.sourceGrant;
   if(!grant||!Number.isSafeInteger(grant.used?.[input.phase])||grant.used[input.phase]<0||!Number.isSafeInteger(grant.limits?.[input.phase])||grant.limits[input.phase]<0||grant.used[input.phase]>=grant.limits[input.phase])return bad();
   grant.used[input.phase]++;job.reviewAttempt.dispatch={marker,state:'started',owner:attempt.owner,creatorId:jobRows[0].creator_id};
   const saved=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${input.jobId} AND document=${jobRows[0].document}`;
   if(saved!==1)return bad();
   await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,${BigInt(now)},0)`;
   return attempt.owner;
 });
 // Consumption and charge are durable before transport; a crash here stays consumed/unknown.
 await ready();if(!ownsDispatch(owner,owner))return bad();
 const atEntry=async <V>(operation:()=>Promise<V>)=>{
   let response:Promise<V>|undefined;
   await write(async tx=>{
     await noUnresolvedRecovery(tx);
     const rows=await tx.$queryRaw<Array<{document:string;creator_id:string;enabled:number|boolean;author:string}>>`SELECT j.document,j.creator_id,c.enabled,c.external_author_id AS author FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${input.jobId} AND j.state='paused'`;
     if(rows.length!==1)return bad();const job=JSON.parse(rows[0].document),a=job.reviewAttempt;
     if((rows[0].enabled!==1&&rows[0].enabled!==true)||rows[0].author!==input.authorId||a?.dispatch?.creatorId!==rows[0].creator_id||a?.id!==id||a.state!=='consumed'||a.dispatch?.marker!==marker||a.dispatch.transportEntered||!ownsDispatch(a.dispatch.owner,owner))return bad();
     const risk=await tx.$queryRaw<Array<{code:string}>>`SELECT code FROM xhs_source_risk WHERE id='source' AND state='blocked'`;
     if(risk.length!==1||risk[0].code!=='XHS_SOURCE_HISTORY_REVIEW_REQUIRED')return bad();
     await ready();a.dispatch.transportEntered=true;
     const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${input.jobId} AND state='paused' AND document=${rows[0].document}`;if(n!==1)return bad();
     response=operation();void response.catch(()=>{});
     const at=Date.now();
     await tx.$executeRaw`UPDATE xhs_request_budgets SET next_at=${BigInt(at)}+interval_ms WHERE id IN (${input.jobId},'xhs:source-total')`;
   });
   return await response!;
 };
 const permit={};permits.set(permit,{digest:attemptDigest(input),owner,dispatch:atEntry});
 let response:T;
 try{response=await transport(permit);}finally{permits.delete(permit);}
 await ready();
 return write(async tx=>{
   const rows=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${input.jobId} AND state='paused'`;
   if(rows.length!==1)return bad();const job=JSON.parse(rows[0].document),a=job.reviewAttempt;
   if(a?.id!==id||a.state!=='consumed'||a.dispatch?.marker!==marker||a.dispatch.transportEntered!==true||!ownsDispatch(a.dispatch.owner,owner))return bad();
   const result=await checkpoint(tx,response);
   a.state='checkpointed';a.dispatch.state='checkpointed';a.checkpointedAt=Date.now();
   if(result && typeof result==='object'){a.receipt={};for(const key of ['creatorId','noteId','subscribed','body','media','mediaCount'])if(key in result)a.receipt[key]=(result as Record<string,unknown>)[key];}
   const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${input.jobId} AND state='paused' AND document=${rows[0].document}`;
   if(n!==1)return bad();
   const removed=await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;if(removed!==1)return bad();
   return result;
 });
}
