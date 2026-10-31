import type { PrismaService } from '../prisma/prisma.service';
import { readXhsMetrics } from './xhs-engagement-store';
import type { XhsDiagnosedMetrics } from './xhs-engagement-contract';
import { XhsSubscriptionError } from './xhs-subscription-errors';

/** Local selection only. It never authorizes, schedules, or sends a source request. */
export async function selectMissingBasic(db: PrismaService, creatorId: string, noteIds: string[]) {
  if (!creatorId || !Array.isArray(noteIds) || !noteIds.length || noteIds.length > 1000 ||
      noteIds.some(id => typeof id !== 'string' || !id || id.length > 300) || new Set(noteIds).size !== noteIds.length)
    throw new XhsSubscriptionError('XHS_SELECTION_INVALID');
  const rows = await db.xhsNote.findMany({where:{creatorId,id:{in:noteIds}},select:{id:true,publishTime:true}});
  if (rows.length !== noteIds.length || new Set(rows.map(row=>row.id)).size !== noteIds.length)
    throw new XhsSubscriptionError('XHS_SELECTION_INVALID');
  const snapshots = await readXhsMetrics(db, 'note');
  const byId = new Map(rows.map(row=>[row.id,row]));
  const missing = noteIds.filter(id=>{
    const row=byId.get(id)!, metrics=snapshots.get(id) as XhsDiagnosedMetrics|undefined;
    return !Number.isSafeInteger(row.publishTime) || row.publishTime <= 0 ||
      !metrics || !Number.isSafeInteger(metrics.collectedAt) || metrics.collectedAt<=0 || !metrics.contract || !['source-only','verified-response'].includes(metrics.evidence) ||
      ['likes','collects','shares','comments'].some(k=>{const at=metrics.valueCollectedAt && Object.prototype.hasOwnProperty.call(metrics.valueCollectedAt,k) ? metrics.valueCollectedAt[k] : metrics.collectedAt;return !Number.isSafeInteger(metrics.values?.[k]) || (metrics.values[k] as number)<0 || !Number.isSafeInteger(at) || at<=0;});
  });
  const jobs=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId}`;
  for (const row of jobs) {
    const job=JSON.parse(row.document), generation=job.generation;
    const fences=[job.sourceFence,generation?.origin?.fence,generation?.activeFence,...(Array.isArray(generation?.reviews)?generation.reviews.map((review:any)=>review?.fence):[])];
    const protectedIds=fences.filter(fence=>fence && fence.phase==='detail' && typeof fence.noteId==='string').map(fence=>JSON.stringify(['xiaohongshu','note',fence.noteId]));
    if (missing.some(id=>protectedIds.includes(id))) throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  }
  const limited=await db.$queryRaw<Array<{note_id:string}>>`
    SELECT note_id FROM xhs_limited_recovery WHERE state IN ('armed','started','unknown')
    UNION ALL SELECT note_id FROM xhs_limited_recovery_append WHERE state IN ('armed','started','unknown')`;
  if (limited.some(row=>missing.includes(JSON.stringify(['xiaohongshu','note',row.note_id])))) throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  return { noteIds: missing, complete: noteIds.filter(id=>!missing.includes(id)) };
}

