import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { generationMatches, generationReviewSettled,verifiedReviewedNoteIds } from './xhs-whole-generation';
import { generationReviewMarkers } from './xhs-generation-review';
import { XhsSubscriptionError } from './xhs-subscription-errors';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
const blocked = (): never => { throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'); };

/** Read-only preparation. Confirmation must repeat this check under the writer lock. */
export async function prepareHistoryHandoff(tx: Tx, jobId: string, generationId: string) {
  if (!jobId || !generationId) return blocked();
  const rows = await tx.$queryRaw<Array<{document:string;state:string;creator_id:string;author:string;enabled:number}>>`
    SELECT j.document,j.state,j.creator_id,c.external_author_id AS author,c.enabled
    FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${jobId}`;
  if (rows.length !== 1) return blocked();
  const row = rows[0];
  let job: any;
  try { job = JSON.parse(row.document); } catch { return blocked(); }
  const g = job.generation;
  if (row.enabled !== 1 || job.id !== jobId || job.creatorId !== row.creator_id ||
      job.sourceGrant?.authorId !== row.author || !generationMatches(job) || g.id !== generationId ||
      !['paused','partial','failed','cancelled','completed'].includes(row.state) || job.state !== row.state ||
      g.activeFence || !generationReviewSettled(job) || !Array.isArray(g.selectedIds)) return blocked();
  const reviewed = generationReviewMarkers(job);
  const fences = [g.origin.fence, ...(g.reviews ?? []).map((r: any) => r.fence)];
  if (fences.some((f: any) => f?.phase !== 'detail' || !/^[a-zA-Z0-9_-]{1,128}$/.test(f.noteId ?? '') ||
      g.selectedIds.includes(JSON.stringify(['xiaohongshu','note',f.noteId])))) return blocked();
  const risk = await tx.$queryRaw<Array<{state:string;code:string|null;owner:string|null;http_status:number|null;endpoint:string|null}>>`SELECT state,code,owner,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
  if (risk.length !== 1 || risk[0].state !== 'blocked' || risk[0].code !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' || risk[0].owner !== null || risk[0].http_status !== null || risk[0].endpoint !== null) return blocked();
  const jobs = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') LIMIT 1`;
  const tasks = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_subscription_tasks WHERE state IN ('queued','running') LIMIT 1`;
  const recovery = await tx.$queryRaw<Array<{id:string}>>`SELECT original.id FROM xhs_limited_recovery original WHERE original.state IN ('armed','started','unknown') AND NOT EXISTS(SELECT 1 FROM xhs_limited_recovery_append followup WHERE followup.id=original.id AND followup.note_id=original.note_id AND followup.author_id=original.author_id AND followup.state='finished') LIMIT 1`;
  if (jobs.length || tasks.length || recovery.length) return blocked();
  const pending = await tx.$queryRaw<Array<{id:string;used:number;request_limit:number}>>`SELECT id,used,request_limit FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' ORDER BY id`;
  const expected = [g.origin.fence.marker, ...reviewed].sort();
  if (new Set(expected).size !== expected.length || pending.length !== expected.length ||
      pending.some((p,i) => p.id !== expected[i] || p.used !== 1 || p.request_limit !== 1)) return blocked();
  const resolved = verifiedReviewedNoteIds(job);
  const excludedIds = [...new Set<string>(fences.map((f: any) => JSON.stringify(['xiaohongshu','note',f.noteId])))].filter(id => !resolved.includes(id)).sort();
  const budgets = await tx.$queryRaw<Array<{id:string;used:number;request_limit:number;interval_ms:number}>>`SELECT id,used,request_limit,interval_ms FROM xhs_request_budgets WHERE id IN (${jobId},'xhs:source-total') ORDER BY id`;
  if (budgets.length !== 2 || g.origin.budgets.some((old:any) => {
    const live = budgets.find(b => b.id === old.id);
    return !live || !Number.isSafeInteger(live.used) || live.used < old.used || live.request_limit !== old.request_limit || live.interval_ms !== old.interval_ms;
  })) return blocked();
  const digest = createHash('sha256').update(JSON.stringify({jobId,generationId,creatorId:row.creator_id,authorId:row.author,document:row.document,risk:risk[0],pending,budgets})).digest('hex');
  return { digest, jobId, generationId, creatorId:row.creator_id, excludedIds, historicalAttemptCount:fences.length };
}

/** The caller must use the existing incremental SQLite writer transaction. */
export async function confirmHistoryHandoff(tx: Tx, input:{jobId:string;generationId:string;digest:string;confirm:true}, now=Date.now()) {
  if (!input || input.confirm !== true || !/^[a-f0-9]{64}$/.test(input.digest) || !Number.isSafeInteger(now) || now < 1) return blocked();
  const lock = await tx.$queryRaw<Array<{id:string}>>`UPDATE xhs_request_budgets SET next_at=next_at WHERE id='xhs:source-total' RETURNING id`;
  if (lock.length !== 1) return blocked();
  const snapshot = await prepareHistoryHandoff(tx,input.jobId,input.generationId);
  if (snapshot.digest !== input.digest) return blocked();
  const rows = await tx.$queryRaw<Array<{document:string;state:string}>>`SELECT document,state FROM xhs_whole_creator_jobs WHERE id=${input.jobId}`;
  if (rows.length !== 1) return blocked();
  const job = JSON.parse(rows[0].document);
  if (job.historyHandoff) return blocked();
  const a=job.reviewAttempt;
  const settledAttempt=a&&verifiedReviewedNoteIds(job).includes(a.receipt?.noteId)?{id:a.id,scope:a.scope,state:a.state,owner:a.owner,
    dispatch:{state:a.dispatch.state,transportEntered:a.dispatch.transportEntered,marker:a.dispatch.marker,creatorId:a.dispatch.creatorId,owner:a.dispatch.owner},
    receipt:{creatorId:a.receipt.creatorId,noteId:a.receipt.noteId,body:a.receipt.body,media:a.receipt.media,mediaCount:a.receipt.mediaCount}}:undefined;
  // Retain the existing original document facts and marker rows. Do not copy
  // transient access URLs into a second persistent record.
  job.historyHandoff = {version:1, digest:input.digest, generationId:input.generationId,
    originDigest:job.generation.originDigest, reviewIds:(job.generation.reviews ?? []).map((r:any)=>r.id),
    markers:[job.generation.origin.fence.marker,...generationReviewMarkers(job)].sort(),
    excludedIds:snapshot.excludedIds, ...(settledAttempt?{settledAttempt}:{}), confirmedAt:now};
  const changed = await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(now)} WHERE id=${input.jobId} AND state=${rows[0].state} AND document=${rows[0].document}`;
  if (changed !== 1) return blocked();
  const risk = await tx.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL,updated_at=${BigInt(now)} WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED' AND owner IS NULL AND http_status IS NULL AND endpoint IS NULL`;
  if (risk !== 1) return blocked();
  return {state:'confirmed' as const, excludedCount:snapshot.excludedIds.length};
}

/** Validate persisted handoffs before allowing any retained marker exception. */
export async function readHistoryHandoffs(tx: Pick<Prisma.TransactionClient,'$queryRaw'>) {
  const rows = await tx.$queryRaw<Array<{document:string;creator_id:string;author:string}>>`
    SELECT j.document,j.creator_id,c.external_author_id AS author FROM xhs_whole_creator_jobs j
    JOIN xhs_creators c ON c.id=j.creator_id WHERE json_type(j.document,'$.historyHandoff')='object'`;
  const markers:string[] = [], excludedByCreator:Record<string,string[]> = {}, jobIds:string[]=[];
  for (const row of rows) {
    let job:any; try { job=JSON.parse(row.document); } catch { return blocked(); }
    const h=job.historyHandoff, g=job.generation;
    if (!h || h.version!==1 || !/^[a-f0-9]{64}$/.test(h.digest ?? '') || !Number.isSafeInteger(h.confirmedAt) ||
        !generationMatches(job) || job.creatorId!==row.creator_id || job.sourceGrant?.authorId!==row.author ||
        h.generationId!==g.id || h.originDigest!==g.originDigest ||
        JSON.stringify(h.reviewIds)!==JSON.stringify((g.reviews ?? []).map((r:any)=>r.id))) return blocked();
    const expected=[g.origin.fence.marker,...generationReviewMarkers(job)].sort();
    if (!Array.isArray(h.markers) || JSON.stringify(h.markers)!==JSON.stringify(expected) ||
        !Array.isArray(h.excludedIds) || new Set(expected).size!==expected.length || expected.some((id:string)=>markers.includes(id))) return blocked();
    const fences=[g.origin.fence,...(g.reviews ?? []).map((r:any)=>r.fence)];
    if (fences.some((f:any)=>f.phase!=='detail'||!/^[a-zA-Z0-9_-]{1,128}$/.test(f.noteId ?? ''))) return blocked();
    const possible=[...new Set<string>(fences.map((f:any)=>JSON.stringify(['xiaohongshu','note',f.noteId])))].sort();
    if (h.excludedIds.some((id:unknown)=>typeof id!=='string'||!possible.includes(id)) || new Set(h.excludedIds).size!==h.excludedIds.length) return blocked();
    const resolved=verifiedReviewedNoteIds(job);
    // Every historical note must either still be excluded or have a validated new receipt.
    if (possible.some(id=>!h.excludedIds.includes(id) && !resolved.includes(id))) return blocked();
    markers.push(...expected);
    jobIds.push(job.id);
    excludedByCreator[row.creator_id]=[...new Set([...(excludedByCreator[row.creator_id] ?? []),...h.excludedIds.filter((id:string)=>!resolved.includes(id))])].sort();
  }
  for (const id of markers) {
    const found=await tx.$queryRaw<Array<{used:number;request_limit:number}>>`SELECT used,request_limit FROM xhs_request_budgets WHERE id=${id}`;
    if (found.length!==1 || found[0].used!==1 || found[0].request_limit!==1) return blocked();
  }
  return {markers,excludedByCreator,jobIds};
}

/** Explicit historical recovery shares the ordinary persistent source owner after handoff. */
export async function assertReviewedRisk(tx:Pick<Prisma.TransactionClient,'$queryRaw'>,job:any,owner?:string) {
  const rows=await tx.$queryRaw<Array<{state:string;code:string|null}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
  if(rows.length!==1)return blocked();
  const r=rows[0];
  if(r.state==='blocked'&&r.code==='XHS_SOURCE_HISTORY_REVIEW_REQUIRED'&&!job.historyHandoff)return 'history' as const;
  if(!job.historyHandoff || !(await readHistoryHandoffs(tx)).jobIds.includes(job.id))return blocked();
  const owners=await tx.$queryRaw<Array<{owner:string|null}>>`SELECT owner FROM xhs_source_risk WHERE id='source'`;
  if(owners.length!==1)return blocked();
  if((!owner&&r.state==='clear'&&r.code===null&&owners[0].owner===null)||(owner&&r.state==='pending'&&owners[0].owner===owner&&r.code===null))return 'handoff' as const;
  return blocked();
}
export async function claimReviewedRisk(tx:Tx,job:any,owner:string) {
  if(await assertReviewedRisk(tx,job)==='history')return;
  if(await tx.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner},updated_at=${BigInt(Date.now())} WHERE id='source' AND state='clear' AND owner IS NULL AND code IS NULL`!==1)return blocked();
}
export async function releaseReviewedRisk(tx:Tx,job:any,owner:string) {
  if(await assertReviewedRisk(tx,job,owner)==='history')return;
  if(await tx.$executeRaw`UPDATE xhs_source_risk SET state='clear',owner=NULL,updated_at=${BigInt(Date.now())} WHERE id='source' AND state='pending' AND owner=${owner} AND code IS NULL`!==1)return blocked();
}
