import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { assertLegacyDatabase, legacyBudgetDigest, legacyProofMatches } from './xhs-legacy-review';
import { xhsPublicInputUrl } from './xhs-short-link';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { generationReviewMarkers } from './xhs-generation-review';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
type Budget = { id: string; used: number; request_limit: number; next_at: bigint | number; interval_ms: number };
const phases = ['profile', 'list', 'detail', 'media', 'metrics'] as const;
export type GenerationPhaseLimits = Record<(typeof phases)[number], number>;
export type GenerationScope = { jobId: string; creatorId: string; authorId: string; generationId?: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const bad = (): never => { throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'); };
/** Keep the historical attempt intact, but allow unrelated selected work only
 * after its one authorized dispatch has a durable, identity-bound receipt. */
export function generationReviewSettled(job:any):boolean {
  const a=job?.reviewAttempt;
  if(!a)return !job?.reviewContext;
  const s=a.scope,r=a.receipt,d=a.dispatch,g=job.generation;
  const fences=g?[g.origin?.fence,...(Array.isArray(g.reviews)?g.reviews.filter((x:any)=>x?.decision==='exclude').map((x:any)=>x.fence):[])].filter((f:any)=>f?.phase==='detail'&&f?.state==='started'&&f?.noteId===s?.noteId):[];
  return !!s && !!g && a.id===hash(s) && s.jobId===job.id && s.generationId===g.id && s.authorId===job.sourceGrant?.authorId &&
    fences.length===1 && s.reviewId===hash(fences[0]) && Array.isArray(g.selectedIds) && !g.selectedIds.includes(JSON.stringify(['xiaohongshu','note',s.noteId])) &&
    s.phase==='detail' && s.maxRequests===1 && typeof s.noteId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s.noteId) &&
    a.state==='checkpointed' && d?.state==='checkpointed' && d.transportEntered===true && d.marker==='xhs:dispatch-pending:review:'+a.id && d.creatorId===job.creatorId &&
    r?.creatorId===job.creatorId && r.noteId===JSON.stringify(['xiaohongshu','note',s.noteId]) && ['saved','retained'].includes(r.body) &&
    ['pending','none','needs-review'].includes(r.media) && Number.isSafeInteger(r.mediaCount) && r.mediaCount>=0;
}
const identity = (g: any) => ({ id: g.id, profileUrl: g.profileUrl, createdAt: g.createdAt, phaseLimits: g.phaseLimits, origin: g.origin });
function historicalJob(job: any) {
  const o = job.generation.origin;
  return { ...job, sourceFence: o.fence, code: o.code, sourceGrant: o.grant };
}
function snapshotBudgets(values: any[]): Budget[] {
  return values.map(b => ({ ...b, next_at: BigInt(b.next_at) }));
}
/** Checks the immutable origin against the original server-persisted maintenance proof. */
export function generationMatches(job: any): boolean {
  try {
    const g = job?.generation, o = g?.origin, grant = job?.sourceGrant;
    if (!g || !/^[a-f0-9-]{36}$/.test(g.id) || !['prepared', 'running', 'paused', 'completed'].includes(g.state) ||
        !Number.isSafeInteger(g.createdAt) || g.createdAt < 1 || g.originDigest !== hash(identity(g)) ||
        !o || hash(o.fence) !== hash(job.sourceFence) || o.proofId !== job.legacyMaintenanceProof?.proofId ||
        !legacyProofMatches(historicalJob(job), job.id, grant?.authorId) || !Array.isArray(o.budgets) || o.budgets.length !== 2 ||
        legacyBudgetDigest(historicalJob(job), snapshotBudgets(o.budgets), job.id) !== job.legacyMaintenanceProof.scope.budgetDigest ||
        !grant || grant.creatorId !== job.creatorId || grant.authorId !== o.grant?.authorId ||
        JSON.stringify(grant.phases) !== JSON.stringify(o.grant.phases) || Object.keys(g.phaseLimits ?? {}).length !== phases.length) return false;
    return phases.every(p => Number.isSafeInteger(g.phaseLimits[p]) && g.phaseLimits[p] >= o.grant.limits[p] &&
      grant.limits?.[p] === g.phaseLimits[p] && Number.isSafeInteger(grant.used?.[p]) && grant.used[p] >= o.grant.used[p] );
  } catch { return false; }
}

export function activeWholeFence(job: any) {
  if (!job.generation) return job.sourceFence;
  if (!generationMatches(job)) return bad();
  return job.generation.activeFence;
}
export function setActiveWholeFence(job: any, value: any | undefined) {
  if (job.generation && !generationMatches(job)) return bad();
  const target = job.generation ?? job;
  const key = job.generation ? 'activeFence' : 'sourceFence';
  if (value === undefined) delete target[key]; else target[key] = value;
}

async function noOtherRecovery(tx: Tx) {
  const pending = await tx.$queryRaw<Array<{ id: string }>>`SELECT original.id FROM xhs_limited_recovery original WHERE original.state IN ('armed','started','unknown') AND NOT EXISTS(SELECT 1 FROM xhs_limited_recovery_append followup WHERE followup.id=original.id AND followup.note_id=original.note_id AND followup.author_id=original.author_id AND followup.state='finished') LIMIT 1`;
  if (pending.length) return bad();
}
async function budgetRows(tx: Tx, id: string) {
  return tx.$queryRaw<Budget[]>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id IN (${id},'xhs:source-total')`;
}
async function jobRow(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<Array<{ document: string; state: string; creator_id: string; author: string; enabled: number | boolean }>>`SELECT j.document,j.state,j.creator_id,c.external_author_id AS author,c.enabled AS enabled FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${id}`;
  if (rows.length !== 1 || (rows[0].enabled !== 1 && rows[0].enabled !== true)) return bad();
  return { ...rows[0], job: JSON.parse(rows[0].document) };
}
async function riskReady(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ state: string; code: string }>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
  if (rows.length !== 1 || rows[0].state !== 'blocked' || rows[0].code !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED') return bad();
}
/** Revalidated inside every admission transaction; never accepts an arbitrary marker allowlist. */
export async function historicalGenerationMarker(tx: Tx, scope: GenerationScope): Promise<string> {
  if (!scope.generationId) return '';
  const r = await jobRow(tx, scope.jobId), job = r.job, g = job.generation;
  if (r.creator_id !== scope.creatorId || r.author !== scope.authorId || job.id !== scope.jobId ||
      !generationMatches(job) || g.id !== scope.generationId || !['prepared', 'running'].includes(g.state) ||
      !['paused', 'partial', 'queued', 'running'].includes(r.state) || !generationReviewSettled(job)) return bad();
  await riskReady(tx); await noOtherRecovery(tx);
  const budgets = await budgetRows(tx, scope.jobId);
  if (budgets.length !== 2) return bad();
  for (const old of g.origin.budgets) {
    const live = budgets.find(b => b.id === old.id);
    if (!live || !Number.isSafeInteger(live.used) || live.used < old.used ||
        live.request_limit !== old.request_limit || live.interval_ms !== old.interval_ms) return bad();
  }
  const markers = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
  const retained = g.origin.fence.marker, active = g.activeFence?.marker;
  const reviewed = generationReviewMarkers(job);
  const floor = g.reviews?.at(-1)?.budgetFloors;
  if (floor && (budgets.find(b=>b.id===scope.jobId)!.used<floor.taskUsed || budgets.find(b=>b.id==='xhs:source-total')!.used<floor.sharedUsed)) return bad();
  if (!markers.some(m => m.id === retained) || reviewed.some(id=>!markers.some(m=>m.id===id)) || markers.some(m => m.id !== retained && m.id !== active && !reviewed.includes(m.id))) return bad();
  const writers = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') AND id<>${scope.jobId} LIMIT 1`;
  if (writers.length) return bad();
  return retained;
}
export async function retainedGenerationMarkers(tx: Tx, scope: GenerationScope): Promise<string[]> {
  const original = await historicalGenerationMarker(tx,scope);
  if (!original) return [];
  const r = await jobRow(tx,scope.jobId);
  return [original,...generationReviewMarkers(r.job)];
}

/** Records an explicit new generation without scheduling, source calls, or refunding any counter. */
export async function createWholeGeneration(tx: Tx, input: { jobId: string; profileUrl: string; confirmUnknown: true; phaseLimits: GenerationPhaseLimits }, now = Date.now()) {
  if (input.confirmUnknown !== true || !Number.isSafeInteger(now) || now < 1) return bad();
  const url = xhsPublicInputUrl(input.profileUrl);
  if (!url || !(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'].includes(url.hostname) ||
      (['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname) && /^\/user\/profile\/[a-zA-Z0-9_-]{1,128}\/?$/.test(url.pathname)))) return bad();
  const lock = await tx.$queryRaw<Array<{ id: string }>>`UPDATE xhs_request_budgets SET next_at=next_at WHERE id='xhs:source-total' RETURNING id`;
  if (lock.length !== 1) return bad();
  const r = await jobRow(tx, input.jobId), job = r.job;
  if (r.state !== 'paused' || job.id !== input.jobId || job.creatorId !== r.creator_id || job.generation || job.reviewAttempt ||
      !legacyProofMatches(job, input.jobId, r.author) || !job.sourceGrant || job.sourceGrant.creatorId !== r.creator_id || job.sourceGrant.authorId !== r.author) return bad();
  await riskReady(tx); await noOtherRecovery(tx); await assertLegacyDatabase(tx, job);
  const budgets = await budgetRows(tx, input.jobId), task = budgets.find(b => b.id === input.jobId);
  if (legacyBudgetDigest(job, budgets, input.jobId) !== job.legacyMaintenanceProof.scope.budgetDigest || !task ||
      !input.phaseLimits || Object.keys(input.phaseLimits).length !== phases.length || phases.some(p =>
        !Number.isSafeInteger(input.phaseLimits[p]) || !Number.isSafeInteger(job.sourceGrant.limits?.[p]) || !Number.isSafeInteger(job.sourceGrant.used?.[p]) ||
        input.phaseLimits[p] < job.sourceGrant.limits[p] || input.phaseLimits[p] < job.sourceGrant.used[p])) return bad();
  const markers = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
  const writers = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') LIMIT 1`;
  if (markers.length !== 1 || markers[0].id !== job.sourceFence.marker || writers.length) return bad();
  const origin = { fence: clone(job.sourceFence), code: job.code, grant: clone(job.sourceGrant), proofId: job.legacyMaintenanceProof.proofId,
    tasks: { archiveTask: job.archiveTask ?? null, downloadTask: job.downloadTask ?? null, listTask: job.listTask ?? null },
    budgets: budgets.map(b => ({ ...b, next_at: String(b.next_at) })) };
  const generation: any = { id: randomUUID(), state: 'prepared', profileUrl: input.profileUrl, createdAt: now, phaseLimits: clone(input.phaseLimits), origin };
  generation.originDigest = hash(identity(generation));
  job.generation = generation;
  job.sourceGrant.limits = clone(input.phaseLimits);
  if (!generationMatches(job)) return bad();
  const changed = await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(now)} WHERE id=${input.jobId} AND state='paused' AND document=${r.document}`;
  if (changed !== 1) return bad();
  return { id: generation.id as string, state: 'prepared' as const };
}
