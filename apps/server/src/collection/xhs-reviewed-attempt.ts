import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import { createDispatchOwner, ownsDispatch } from './xhs-dispatch-owner';
import { legacyProofMatches, legacyBudgetDigest, assertLegacyDatabase } from './xhs-legacy-review';
import { noUnresolvedRecovery } from './xhs-whole-source-fence';
import { generationMatches } from './xhs-whole-generation';
import { generationReviewMarkers } from './xhs-generation-review';
import { assertReviewedRisk,claimReviewedRisk,releaseReviewedRisk } from './xhs-history-handoff';
import { generationReviewSettled,verifiedReviewedNoteIds } from './xhs-whole-generation';
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
function preservedPrepared(job:any,scope:any):boolean {
 const a=job?.reviewAttempt;
 if(!a)return !scope?.oldPreparedId;
 const s=a.scope;
 return a.state==='prepared' && !a.owner && !a.dispatch && !!s && a.id===scope?.oldPreparedId && a.id===attemptDigest(s) &&
   s.jobId===scope.jobId && s.generationId===scope.generationId && s.authorId===scope.authorId && s.noteId===scope.noteId && s.phase==='detail' && s.maxRequests===1;
}
async function state(tx:Tx,input:AttemptScope,now:number){
 const lock=await tx.$queryRaw<Array<{id:string}>>`UPDATE xhs_request_budgets SET next_at=next_at WHERE id='xhs:source-total' RETURNING id`;
 if(lock.length!==1) return bad();
 await noUnresolvedRecovery(tx);
 const risk=await tx.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
 const rows=await tx.$queryRaw<Array<{document:string;state:string;creator_id:string;author:string;enabled:number|boolean}>>`SELECT j.document,j.state,j.creator_id,c.external_author_id AS author,c.enabled AS enabled FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${input.jobId}`;
 const expectedState=input.generationId?'partial':'paused';
 if(rows.length!==1||rows[0].state!==expectedState||rows[0].author!==input.authorId||(rows[0].enabled!==1&&rows[0].enabled!==true))return bad();
 const job=JSON.parse(rows[0].document),f=job.sourceFence,r=job.unknownReview;
 await assertReviewedRisk(tx,job);
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
 if(input.generationId && verifiedReviewedNoteIds(s.job).includes(JSON.stringify(['xiaohongshu','note',input.noteId])))return bad();
 if(s.job.reviewContext && s.job.reviewContext.state!=='ready')return bad();
 if(s.job.reviewAttempt){if(s.job.reviewAttempt.id===id&&attemptDigest(s.job.reviewAttempt.scope)===id&&s.job.reviewAttempt.state==='prepared')return {id,state:'prepared' as const};return bad();}
 s.job.reviewAttempt={id,scope:input,state:'prepared',budgets:s.budgets};
 const expectedState=input.generationId?'partial':'paused';
 const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(s.job)} WHERE id=${input.jobId} AND state=${expectedState} AND document=${s.raw}`;
 if(n!==1)return bad();return {id,state:'prepared' as const};
}
/** A separate, versioned context intent never alters or consumes a detail attempt. */
export async function createReviewedContextIntent(tx:Tx,input:AttemptScope,now=Date.now()){
 if(!input.generationId || input.phase!=='detail' || input.maxRequests!==1)return bad();
 const s=await state(tx,input,now);
 if(verifiedReviewedNoteIds(s.job).includes(JSON.stringify(['xiaohongshu','note',input.noteId])))return bad();
 if(s.job.reviewAttempt && generationReviewSettled(s.job)) {
   const previous=s.job.reviewContext, completed=s.job.reviewAttempt;
   if(previous && (!previous.scope || previous.id!==attemptDigest(previous.scope) || previous.state!=='ready' ||
     previous.scope.jobId!==input.jobId || previous.scope.generationId!==input.generationId || previous.scope.authorId!==input.authorId || previous.scope.noteId!==completed.scope.noteId ||
     !Array.isArray(previous.stages) || previous.stages.some((v:any)=>v.state!=='settled'||v.transportEntered!==true)))return bad();
   if(!Array.isArray(s.job.reviewAttemptHistory))s.job.reviewAttemptHistory=[];
   if(s.job.reviewAttemptHistory.length>=20)return bad();
   s.job.reviewAttemptHistory.push(s.job.reviewAttempt);delete s.job.reviewAttempt;
   if(s.job.reviewContext){if(!Array.isArray(s.job.reviewContextHistory))s.job.reviewContextHistory=[];if(s.job.reviewContextHistory.length>=20)return bad();s.job.reviewContextHistory.push(s.job.reviewContext);delete s.job.reviewContext;}
 }
 const old=s.job.reviewAttempt;
 if(old && !preservedPrepared(s.job,{jobId:input.jobId,generationId:input.generationId,authorId:input.authorId,noteId:input.noteId,oldPreparedId:old.id}))return bad();
 const previous=s.job.reviewContext;
 if(previous){
   const p=previous.scope;
   if(!p||p.version!==1||previous.id!==attemptDigest(p)||!['prepared','ready'].includes(previous.state)||!Array.isArray(previous.stages)||(previous.state==='prepared'&&!previous.stages.length&&p.expiresAt>now)||previous.stages.some((v:any)=>v.state!=='settled'||v.transportEntered!==true||!['profile','list'].includes(v.phase))||originalAttemptDigest({...s.job,sourceGrant:p.originalGrant})!==p.originalHash||
      p.jobId!==input.jobId||p.generationId!==input.generationId||p.authorId!==input.authorId||p.noteId!==input.noteId)return bad();
   if(!Array.isArray(s.job.reviewContextHistory))s.job.reviewContextHistory=[];
   if(s.job.reviewContextHistory.length>=20)return bad();
   s.job.reviewContextHistory.push(previous);
 }
 const task=s.budgets.find(b=>b.id===input.jobId),shared=s.budgets.find(b=>b.id==='xhs:source-total');
 if(!task||!shared||input.taskUsedCeiling!==task.used+4||input.sharedUsedCeiling!==shared.used+4 ||
    task.limit<input.taskUsedCeiling || shared.limit<input.sharedUsedCeiling)return bad();
 const scope={version:1 as const,jobId:input.jobId,generationId:input.generationId,authorId:input.authorId,noteId:input.noteId,
   originalHash:input.originalHash,originalGrant:JSON.parse(JSON.stringify(s.job.sourceGrant)),reviewId:input.reviewId,expiresAt:input.expiresAt,...(old?{oldPreparedId:old.id}:{}),
   limits:{profile:1,list:2,detail:1,media:0},taskUsedCeiling:input.taskUsedCeiling,sharedUsedCeiling:input.sharedUsedCeiling};
 const id=attemptDigest(scope);
 s.job.reviewContext={id,scope,state:'prepared',stages:[],budgets:s.budgets};
 const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(s.job)} WHERE id=${input.jobId} AND state='partial' AND document=${s.raw}`;
 if(n!==1)return bad();
 return {id,state:'prepared' as const};
}
/** Atomically charge and fence one context request before any transport is allowed. */
export async function startReviewedContextStage(tx:Tx,jobId:string,id:string,phase:'profile'|'list',expected:{authorId:string;noteId:string},now=Date.now()){
 if(phase!=='profile'&&phase!=='list')return bad();
 const rows=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId} AND state='partial'`;
 if(rows.length!==1)return bad();
 const initial=JSON.parse(rows[0].document),c=initial.reviewContext,s=c?.scope;
 if(!s||s.version!==1||JSON.stringify(s.limits)!==JSON.stringify({profile:1,list:2,detail:1,media:0})||c.id!==id||attemptDigest(s)!==id||s.jobId!==jobId||s.authorId!==expected.authorId||s.noteId!==expected.noteId||c.state!=='prepared'||!preservedPrepared(initial,s)||
   !Array.isArray(c.stages)||c.stages.length>2||c.stages.some((v:any)=>v.state!=='settled'||v.transportEntered!==true||!['profile','list'].includes(v.phase))||
   originalAttemptDigest({...initial,sourceGrant:s.originalGrant})!==s.originalHash)return bad();
 const counts={profile:c.stages.filter((v:any)=>v.phase==='profile').length,list:c.stages.filter((v:any)=>v.phase==='list').length};
 if((phase==='profile'&&(counts.profile!==0||counts.list!==0))||(phase==='list'&&counts.list>=2))return bad();
 const grant=initial.sourceGrant;
 for(const p of ['profile','list','detail','media','metrics']){
   const expected=s.originalGrant?.used?.[p]+(p==='profile'?counts.profile:p==='list'?counts.list:0);
   if(grant?.used?.[p]!==expected||grant?.limits?.[p]!==s.originalGrant?.limits?.[p])return bad();
 }
 const input:AttemptScope={jobId,generationId:s.generationId,authorId:s.authorId,noteId:s.noteId,phase:'detail',originalHash:originalAttemptDigest(initial),reviewId:s.reviewId,maxRequests:1,taskUsedCeiling:s.taskUsedCeiling,sharedUsedCeiling:s.sharedUsedCeiling,expiresAt:s.expiresAt};
 const checked=await state(tx,input,now),job=checked.job,context=job.reviewContext;
 if(context?.id!==id||JSON.stringify(context.stages)!==JSON.stringify(c.stages))return bad();
 const budgetRows=await tx.$queryRaw<Array<{id:string;used:number;request_limit:number;next_at:bigint;interval_ms:number}>>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id IN (${jobId},'xhs:source-total')`;
 if(budgetRows.length!==2||budgetRows.some(b=>Number(b.next_at)>now||!Number.isSafeInteger(b.interval_ms)||b.interval_ms<1000))return bad();
 const base=c.budgets;
 if(!Array.isArray(base)||budgetRows.some(b=>{const v=base.find((x:any)=>x.id===b.id);return !v||b.used!==v.used+c.stages.length||b.request_limit!==v.limit||b.used+2>(b.id===jobId?s.taskUsedCeiling:s.sharedUsedCeiling)}))return bad();
 if(!Array.isArray(job.sourceGrant.phases)||!job.sourceGrant.phases.includes(phase)||!Number.isSafeInteger(job.sourceGrant.used[phase])||job.sourceGrant.used[phase]>=job.sourceGrant.limits[phase])return bad();
 const owner=createDispatchOwner();if(!owner)return bad();
 const marker=`xhs:dispatch-pending:context:${id}:${c.stages.length+1}`;
 await claimReviewedRisk(tx,job,owner.nonce);
 for(const b of budgetRows){const n=await tx.$executeRaw`UPDATE xhs_request_budgets SET used=used+1,next_at=${BigInt(now+b.interval_ms)} WHERE id=${b.id} AND used=${b.used} AND next_at<=${BigInt(now)}`;if(n!==1)return bad();}
 job.sourceGrant.used[phase]++;context.state='started';context.stages.push({phase,state:'started',marker,owner});
 const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${jobId} AND state='partial' AND document=${rows[0].document}`;
 if(n!==1)return bad();
 await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,${BigInt(now)},0)`;
 return {owner,marker,phase};
}
/** Settle only a parsed, identity-checked response; unknown work retains its marker. */
export async function settleReviewedContextStage(tx:Tx,jobId:string,id:string,marker:string,owner:ReturnType<typeof createDispatchOwner>){
 const rows=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId} AND state='partial'`;
 if(rows.length!==1||!owner)return bad();
 const job=JSON.parse(rows[0].document),c=job.reviewContext,s=c?.scope,stage=c?.stages?.at(-1);
 if(!s||s.version!==1||c.id!==id||attemptDigest(s)!==id||s.jobId!==jobId||c.state!=='started'||!preservedPrepared(job,s)||
   stage?.state!=='started'||stage.transportEntered!==true||stage.marker!==marker||!ownsDispatch(stage.owner,owner)||
   originalAttemptDigest({...job,sourceGrant:s.originalGrant})!==s.originalHash)return bad();
 const risk=await tx.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
 await assertReviewedRisk(tx,job,owner.nonce);
 stage.state='settled';c.state='prepared';
 const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${jobId} AND state='partial' AND document=${rows[0].document}`;
 if(n!==1)return bad();
 const removed=await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker} AND used=1 AND request_limit=1`;
 if(removed!==1)return bad();
 await releaseReviewedRisk(tx,job,owner.nonce);
 return {state:'settled' as const};
}
/** Recheck the durable stage and source gate at the physical transport entry. */
export async function enterReviewedContextStage(tx:Tx,jobId:string,id:string,marker:string,owner:ReturnType<typeof createDispatchOwner>){
 if(!owner)return bad();await noUnresolvedRecovery(tx);
 const rows=await tx.$queryRaw<Array<{document:string;author:string;enabled:number|boolean}>>`SELECT j.document,c.external_author_id AS author,c.enabled AS enabled FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${jobId} AND j.state='partial'`;
 if(rows.length!==1||(rows[0].enabled!==1&&rows[0].enabled!==true))return bad();
 const job=JSON.parse(rows[0].document),c=job.reviewContext,s=c?.scope,stage=c?.stages?.at(-1);
 if(!s||s.version!==1||JSON.stringify(s.limits)!==JSON.stringify({profile:1,list:2,detail:1,media:0})||c.id!==id||attemptDigest(s)!==id||s.jobId!==jobId||s.expiresAt<=Date.now()||rows[0].author!==s.authorId||c.state!=='started'||!preservedPrepared(job,s)||
    !generationMatches(job)||!excludedGenerationFence(job,s.noteId)||stage?.state!=='started'||stage.marker!==marker||stage.transportEntered||!ownsDispatch(stage.owner,owner))return bad();
 if(originalAttemptDigest({...job,sourceGrant:s.originalGrant})!==s.originalHash)return bad();
 const risk=await tx.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
 const writers=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') LIMIT 1`;
 const children=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_subscription_tasks WHERE state IN ('queued','running') LIMIT 1`;
 const pending=await tx.$queryRaw<Array<{id:string;used:number;request_limit:number}>>`SELECT id,used,request_limit FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
 const allowed=[job.generation.origin.fence.marker,...generationReviewMarkers(job),marker];
 await assertReviewedRisk(tx,job,owner.nonce);
 if(writers.length||children.length||
    new Set(allowed).size!==allowed.length||pending.length!==allowed.length||pending.some(p=>!allowed.includes(p.id)||p.used!==1||p.request_limit!==1))return bad();
 stage.transportEntered=true;const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${jobId} AND state='partial' AND document=${rows[0].document}`;
 if(n!==1)return bad();return {state:'entered' as const};
}
/** Internal transition after the current session has verified the target access context. */
export async function markReviewedContextReady(tx:Tx,jobId:string,id:string,expected:{authorId:string;noteId:string}){
 const rows=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId} AND state='partial'`;
 if(rows.length!==1)return bad();
 const job=JSON.parse(rows[0].document),c=job.reviewContext,s=c?.scope;
 if(!s||s.version!==1||JSON.stringify(s.limits)!==JSON.stringify({profile:1,list:2,detail:1,media:0})||c.id!==id||attemptDigest(s)!==id||s.jobId!==jobId||s.expiresAt<=Date.now()||s.authorId!==expected.authorId||s.noteId!==expected.noteId||
    c.state!=='prepared'||!preservedPrepared(job,s)||!Array.isArray(c.stages)||c.stages.some((v:any)=>v.state!=='settled'||v.transportEntered!==true||!['profile','list'].includes(v.phase))||
    originalAttemptDigest({...job,sourceGrant:s.originalGrant})!==s.originalHash)return bad();
 const risk=await tx.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
 await assertReviewedRisk(tx,job);
 if(job.reviewAttempt){if(!Array.isArray(job.reviewAttemptHistory))job.reviewAttemptHistory=[];if(job.reviewAttemptHistory.length>=20)return bad();job.reviewAttemptHistory.push(job.reviewAttempt);delete job.reviewAttempt;}
 c.state='ready';const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${jobId} AND state='partial' AND document=${rows[0].document}`;
 if(n!==1)return bad();return {state:'ready' as const};
}
/** Internal handoff only. A consumed intent is not permission to bypass the dispatch guard. */
export async function consumeReviewedAttempt(tx:Tx,input:AttemptScope,id:string,now=Date.now()){
 const s=await state(tx,input,now),a=s.job.reviewAttempt;
 if(s.job.reviewContext && (s.job.reviewContext.state!=='ready'||s.job.reviewContext.scope?.oldPreparedId===id))return bad();
 if(!a||a.id!==id||id!==attemptDigest(input)||attemptDigest(a.scope)!==id||a.state!=='prepared'||JSON.stringify(a.budgets)!==JSON.stringify(s.budgets))return bad();
 const owner=createDispatchOwner();if(!owner)return bad();
 await claimReviewedRisk(tx,s.job,owner.nonce);
 a.state='consumed';a.owner=owner;a.consumedAt=now;
 const expectedState=input.generationId?'partial':'paused';
 const n=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(s.job)} WHERE id=${input.jobId} AND state=${expectedState} AND document=${s.raw}`;
 if(n!==1)return bad();return {id,state:'consumed' as const,owner};
}
