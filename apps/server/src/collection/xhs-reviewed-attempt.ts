import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import { createDispatchOwner } from './xhs-dispatch-owner';
import { legacyProofMatches, legacyBudgetDigest, assertLegacyDatabase } from './xhs-legacy-review';
import { noUnresolvedRecovery } from './xhs-whole-source-fence';
import { generationMatches } from './xhs-whole-generation';
import { generationReviewMarkers } from './xhs-generation-review';
type Tx=Pick<Prisma.TransactionClient,'$queryRaw'|'$executeRaw'>;
export const attemptDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const originalAttemptDigest=(job:any)=>attemptDigest({fence:job.sourceFence,code:job.code,grant:job.sourceGrant});
export type AttemptScope={jobId:string;authorId:string;noteId:string;phase:string;originalHash:string;reviewId:string;maxRequests:number;taskUsedCeiling:number;sharedUsedCeiling:number;expiresAt:number;legacyProofId?:string;generationId?:string};
/** Bind only an already excluded historical detail, never an arbitrary note. */
export function excludedGenerationFence(job:any,noteId:string) {
 const g=job?.generation;
 if(!generationMatches(job)||g.activeFence||!Array.isArray(g.selectedIds)||g.selectedIds.includes(JSON.stringify(['xiaohongshu','note',noteId])))return undefined;
 generationReviewMarkers(job);
 const matches=[g.origin.fence,...(g.reviews??[]).filter((r:any)=>r.decision==='exclude').map((r:any)=>r.fence)].filter((f:any)=>f?.phase==='detail'&&f?.state==='started'&&f?.noteId===noteId);
 return matches.length===1?matches[0]:undefined;
}
export type ReviewedRecoveryView = {
 state:'review-required'|'prepared'|'expired'|'in-progress'|'consumed'|'checkpointed'|'restricted'|'blocked';
 noteId?:string;phase?:string;attemptId?:string;expiresAt?:number;legacyUnknown?:boolean;
 receipt?:{body:'saved'|'retained';media:'pending'|'none'|'needs-review';mediaCount:number};
 code?:string;
};
/** Public projection: original unknown and this separate attempt are never conflated. */
export function reviewedRecoveryView(job:any,now=Date.now(),active=false):ReviewedRecoveryView|undefined {
 const scope=job.reviewAttempt?.scope;
 const generation=!!scope?.generationId;
 const f=generation?excludedGenerationFence(job,scope.noteId):job.sourceFence;if(!f)return undefined;
 const owner=f.owner,legacy=!generation&&legacyProofMatches(job,job.id);
 if(job.state!==(generation?'partial':'paused')||f.state!=='started'||!['detail','metrics'].includes(f.phase)||
   typeof f.noteId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(f.noteId)||
   (!generation&&!legacy&&(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<1||!/^[0-9]{15,20}$/.test(owner.startIdentity)||
   typeof owner.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(owner.nonce))))return {state:'blocked'};
 const base={noteId:f.noteId as string,phase:f.phase as string,...(legacy?{legacyUnknown:true}: {})},a=job.reviewAttempt;
 if(!a)return {state:job.unknownReview&&job.unknownReview.decision!=='request-retry'?'blocked':'review-required',...base};
 const s=a.scope;
 if(!s||a.id!==attemptDigest(s)||s.jobId!==job.id||s.noteId!==f.noteId||s.phase!==f.phase||s.maxRequests!==1||(generation&&s.generationId!==job.generation.id))return {state:'blocked'};
 if(a.state==='prepared')return {state:s.expiresAt>now?'prepared':'expired',...base,attemptId:a.id,expiresAt:s.expiresAt};
 if(a.state==='consumed')return /^XHS_SOURCE_(?:AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(a.failureCode??'')?{state:'restricted',...base,code:a.failureCode}:active?{state:'in-progress',...base}:{state:'consumed',...base};
 const r=a.receipt;
 if(a.state==='checkpointed'&&a.dispatch?.state==='checkpointed'&&r&&
   ['saved','retained'].includes(r.body)&&['pending','none','needs-review'].includes(r.media)&&Number.isSafeInteger(r.mediaCount)&&r.mediaCount>=0)
   return {state:'checkpointed',...base,receipt:{body:r.body,media:r.media,mediaCount:r.mediaCount}};
 return {state:'blocked'};
}
const bad=():never=>{throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED')};
async function state(tx:Tx,input:AttemptScope,now:number){
 const lock=await tx.$queryRaw<Array<{id:string}>>`UPDATE xhs_request_budgets SET next_at=next_at WHERE id='xhs:source-total' RETURNING id`;
 if(lock.length!==1) return bad();
 await noUnresolvedRecovery(tx);
 const risk=await tx.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
 if(risk.length!==1||risk[0].state!=='blocked'||risk[0].code!=='XHS_SOURCE_HISTORY_REVIEW_REQUIRED')return bad();
 const rows=await tx.$queryRaw<Array<{document:string;state:string;creator_id:string;author:string;enabled:number|boolean}>>`SELECT j.document,j.state,j.creator_id,c.external_author_id AS author,c.enabled AS enabled FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${input.jobId}`;
 const expectedState=input.generationId?'partial':'paused';
 if(rows.length!==1||rows[0].state!==expectedState||rows[0].author!==input.authorId||(rows[0].enabled!==1&&rows[0].enabled!==true))return bad();
 const job=JSON.parse(rows[0].document),f=job.sourceFence,r=job.unknownReview;
 if(input.generationId){
   const excluded=excludedGenerationFence(job,input.noteId);
   if(job.id!==input.jobId||job.creatorId!==rows[0].creator_id||job.state!=='partial'||job.generation?.id!==input.generationId||input.phase!=='detail'||input.maxRequests!==1||!excluded||attemptDigest(excluded)!==input.reviewId||originalAttemptDigest(job)!==input.originalHash)return bad();
 } else if(!f||f.state!=='started'||f.noteId!==input.noteId||f.phase!==input.phase||originalAttemptDigest(job)!==input.originalHash||!r||attemptDigest(r)!==input.reviewId||r.decision!=='request-retry'||r.marker!==f.marker||r.originalCode!==job.code||JSON.stringify(r.originalGrant)!==JSON.stringify(job.sourceGrant))return bad();
 const legacy=input.legacyProofId!==undefined;
 if(!input.generationId && (legacy ? (!legacyProofMatches(job,input.jobId,input.authorId)||r.owner!==null||r.legacyProofId!==input.legacyProofId||job.legacyMaintenanceProof.proofId!==input.legacyProofId) : (!f.owner||!r.owner||r.owner.nonce!==f.owner.nonce||r.owner.pid!==f.owner.pid||r.owner.startIdentity!==f.owner.startIdentity||observeDispatchOwner(f.owner)!=='dead')))return bad();
 if(legacy&&!input.generationId)await assertLegacyDatabase(tx,job);
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=now||input.expiresAt>now+900000||!Number.isSafeInteger(input.maxRequests)||input.maxRequests<1||input.maxRequests>100)return bad();
 const budgets=await tx.$queryRaw<Array<{id:string;used:number;request_limit:number;next_at:bigint;interval_ms:number}>>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id IN (${input.jobId},'xhs:source-total')`;
 if(budgets.length!==2)return bad();
 if(input.generationId){
   const g=job.generation,floor=g.reviews?.at(-1)?.budgetFloors;
   for(const original of g.origin.budgets){const live=budgets.find(b=>b.id===original.id),minimum=original.id===input.jobId?floor?.taskUsed:floor?.sharedUsed;if(!live||live.used<Math.max(original.used,minimum??0)||live.request_limit!==original.request_limit||live.interval_ms!==original.interval_ms)return bad();}
 }
 if(legacy&&!input.generationId&&legacyBudgetDigest(job,budgets,input.jobId)!==job.legacyMaintenanceProof.scope.budgetDigest)return bad();
 for(const b of budgets){const cap=b.id===input.jobId?input.taskUsedCeiling:input.sharedUsedCeiling;if(!Number.isSafeInteger(cap)||cap<b.used+input.maxRequests)return bad();}
 const pending=await tx.$queryRaw<Array<{id:string;used:number;request_limit:number}>>`SELECT id,used,request_limit FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
 const writers=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') LIMIT 1`;
 const allowed=input.generationId?[job.generation.origin.fence.marker,...generationReviewMarkers(job)]:[f.marker];
 if(new Set(allowed).size!==allowed.length||pending.length!==allowed.length||pending.some(p=>!allowed.includes(p.id)||p.used!==1||p.request_limit!==1)||writers.length)return bad();
 if(input.generationId){const children=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_subscription_tasks WHERE state IN ('queued','running') LIMIT 1`;if(children.length)return bad();}
 return {job,raw:rows[0].document,budgets:budgets.map(b=>({id:b.id,used:b.used,limit:b.request_limit,nextAt:String(b.next_at)}))};
}
/** Creates only a bounded intent. Never retires an unknown dispatch or schedules work. */
export async function createReviewedAttempt(tx:Tx,input:AttemptScope,now=Date.now()){
 const s=await state(tx,input,now),id=attemptDigest(input);
 if(s.job.reviewAttempt){if(s.job.reviewAttempt.id===id&&attemptDigest(s.job.reviewAttempt.scope)===id&&s.job.reviewAttempt.state==='prepared')return {id,state:'prepared' as const};return bad();}
 s.job.reviewAttempt={id,scope:input,state:'prepared',budgets:s.budgets};
 const expectedState=input.generationId?'partial':'paused';
 const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(s.job)} WHERE id=${input.jobId} AND state=${expectedState} AND document=${s.raw}`;
 if(n!==1)return bad();return {id,state:'prepared' as const};
}
/** Internal handoff only. A consumed intent is not permission to bypass the dispatch guard. */
export async function consumeReviewedAttempt(tx:Tx,input:AttemptScope,id:string,now=Date.now()){
 const s=await state(tx,input,now),a=s.job.reviewAttempt;
 if(!a||a.id!==id||id!==attemptDigest(input)||attemptDigest(a.scope)!==id||a.state!=='prepared'||JSON.stringify(a.budgets)!==JSON.stringify(s.budgets))return bad();
 const owner=createDispatchOwner();if(!owner)return bad();
 a.state='consumed';a.owner=owner;a.consumedAt=now;
 const expectedState=input.generationId?'partial':'paused';
 const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(s.job)} WHERE id=${input.jobId} AND state=${expectedState} AND document=${s.raw}`;
 if(n!==1)return bad();return {id,state:'consumed' as const,owner};
}
