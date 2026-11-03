import type { Prisma } from '@prisma/client';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
export type WholeUnknownReview = { jobId:string; expectedAuthorId:string; expectedMarker:string; expectedNoteId:string; decision:'defer'|'request-retry' };
type Tx = Pick<Prisma.TransactionClient,'$queryRaw'|'$executeRaw'>;
const blocked = (): never => { throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'); };
/** Audit only: never schedules, consumes a budget, or removes any fence/marker. Caller supplies normal write transaction. */
export async function reviewWholeUnknown(tx: Tx, input:WholeUnknownReview) {
 if (!['defer','request-retry'].includes(input.decision)) return blocked();
 const locks = await tx.$queryRaw<Array<{id:string}>>`UPDATE xhs_request_budgets SET next_at=next_at WHERE id='xhs:source-total' RETURNING id`;
 if (locks.length !== 1) return blocked();
 const rows = await tx.$queryRaw<Array<{document:string;state:string;author:string}>>`SELECT j.document,j.state,c.external_author_id AS author FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${input.jobId}`;
 if (rows.length !== 1 || rows[0].state !== 'paused' || rows[0].author !== input.expectedAuthorId) return blocked();
 const job = JSON.parse(rows[0].document), fence=job.sourceFence;
 if (!fence || fence.marker !== input.expectedMarker || fence.noteId !== input.expectedNoteId || fence.state !== 'started' || !fence.owner) return blocked();
 const prior=job.unknownReview;
 if (prior) {
   if (prior.marker === fence.marker && prior.noteId === fence.noteId && prior.decision === input.decision && prior.owner.nonce === fence.owner.nonce && prior.owner.pid === fence.owner.pid && prior.owner.startIdentity === fence.owner.startIdentity && prior.originalCode === job.code && JSON.stringify(prior.originalGrant) === JSON.stringify(job.sourceGrant)) return {state:'recorded' as const, decision:prior.decision, executionAllowed:false as const};
   return blocked();
 }
 const others = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' AND id<>${fence.marker} LIMIT 1`;
 const running = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('running','queued') LIMIT 1`;
 const marker = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id=${fence.marker}`;
 if (others.length || running.length || marker.length !== 1 || observeDispatchOwner(fence.owner) !== 'dead') return blocked();
 job.unknownReview={marker:fence.marker,noteId:fence.noteId,owner:fence.owner,decision:input.decision,originalCode:job.code,originalGrant:job.sourceGrant,recordedAt:Date.now(),executionAllowed:false};
 const changed=await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${input.jobId} AND state='paused' AND document=${rows[0].document}`;
 if(changed!==1) return blocked();
 return {state:'recorded' as const,decision:input.decision,executionAllowed:false as const};
}
