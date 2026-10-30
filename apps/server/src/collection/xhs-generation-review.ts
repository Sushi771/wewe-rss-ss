import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ownsDispatch, DispatchOwner } from './xhs-dispatch-owner';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import { generationMatches } from './xhs-whole-generation';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
type Budget = { id: string; used: number; request_limit: number; interval_ms: number };
const phases = ['profile', 'list', 'detail', 'media', 'metrics'] as const;
type Floors = { taskUsed: number; sharedUsed: number; phaseUsed: Record<(typeof phases)[number], number> };
export type GenerationUnknownReview = { fence: any; reviewedAt: number; decision: 'request-retry'; budgetFloors: Floors; id: string };
const bad = (): never => { throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const ownerValid = (v: any): v is DispatchOwner => !!v && Object.keys(v).length === 3 && Number.isSafeInteger(v.pid) && v.pid > 0 &&
  typeof v.startIdentity === 'string' && /^[0-9]{15,20}$/.test(v.startIdentity) && typeof v.nonce === 'string' && /^[a-f0-9-]{36}$/.test(v.nonce);
const fenceValid = (f: any) => !!f && ['prepared', 'started'].includes(f.state) && /^xhs:dispatch-pending:whole:[a-f0-9-]{36}$/.test(f.marker) &&
  ownerValid(f.owner) && ['profile', 'list', 'detail', 'metrics'].includes(f.phase) &&
  (['detail', 'metrics'].includes(f.phase) ? typeof f.noteId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(f.noteId) : f.noteId === undefined);
const reviewIdentity = (generationId: string, r: Omit<GenerationUnknownReview, 'id'>) => ({ generationId, fence: r.fence, reviewedAt: r.reviewedAt, decision: r.decision, budgetFloors: r.budgetFloors });
const stages = ['admitted', 'transport', 'sent', 'response', 'parse', 'storage', 'checkpoint'];
const restrictedStatuses = new Set([401, 403, 406, 429, 461, 471]);
const restrictedCode = /^XHS_SOURCE_(?:AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)(?:_|$)/;
const receiptKeys = ['phase', 'stage', 'outcome', 'code', 'status', 'settled', 'marker', 'owner', 'generationId', 'events', 'sequence'];
function receiptBound(job: any, fence: any): boolean {
  const r = fence.receipt;
  return !!r && Object.keys(r).every(k => receiptKeys.includes(k)) && typeof r.settled === 'boolean' &&
    r.marker === fence.marker && r.generationId === job.generation.id && r.phase === fence.phase &&
    stages.includes(r.stage) &&
    ['in-progress', 'not-sent', 'response-received', 'local-failure', 'unknown', 'checkpointed'].includes(r.outcome) &&
    (r.status === undefined || (Number.isSafeInteger(r.status) && r.status >= 100 && r.status <= 599)) &&
    (r.sequence === undefined || (Number.isSafeInteger(r.sequence) && r.sequence >= 0)) &&
    Array.isArray(r.events) && r.events.length <= 12 && r.events.every((event: any) => !!event && typeof event === 'object' && !Array.isArray(event) &&
      Object.keys(event).every(k => k === 'stage' || k === 'status') && stages.includes(event.stage) &&
      (event.status === undefined || (Number.isSafeInteger(event.status) && event.status >= 100 && event.status <= 599))) &&
    (r.code === undefined || (typeof r.code === 'string' && !!r.code && xhsPublicCode(new XhsSubscriptionError(r.code), '') === r.code)) &&
    !restrictedStatuses.has(r.status) && !(typeof r.code === 'string' && restrictedCode.test(r.code)) &&
    !r.events.some((event: any) => restrictedStatuses.has(event.status)) &&
    ownerValid(r.owner) && r.owner.pid === fence.owner.pid && r.owner.startIdentity === fence.owner.startIdentity && r.owner.nonce === fence.owner.nonce;
}

/** Validates server-persisted append-only reviews; never accepts a client marker list. */
export function generationReviewMarkers(job: any): string[] {
  if (!generationMatches(job)) return bad();
  const g = job.generation;
  if (g.reviews === undefined) return [];
  if (!Array.isArray(g.reviews)) return bad();
  const seen = new Set<string>([g.origin.fence.marker]);
  let taskFloor = g.origin.budgets.find((b: Budget) => b.id === job.id).used;
  let sharedFloor = g.origin.budgets.find((b: Budget) => b.id === 'xhs:source-total').used;
  let phaseFloor = g.origin.grant.used, reviewedAt = g.createdAt;
  const markers: string[] = [];
  for (const r of g.reviews as GenerationUnknownReview[]) {
    const floor = r?.budgetFloors;
    if (!r || Object.keys(r).length !== 5 || r.decision !== 'request-retry' || !fenceValid(r.fence) ||
        (r.fence.receipt !== undefined && !receiptBound(job, r.fence)) || seen.has(r.fence.marker) ||
        !Number.isSafeInteger(r.reviewedAt) || r.reviewedAt < reviewedAt || r.id !== hash(reviewIdentity(g.id, r)) || !floor ||
        Object.keys(floor).length !== 3 || !Number.isSafeInteger(floor.taskUsed) || floor.taskUsed < taskFloor ||
        !Number.isSafeInteger(floor.sharedUsed) || floor.sharedUsed < sharedFloor ||
        !floor.phaseUsed || Object.keys(floor.phaseUsed).length !== phases.length || phases.some(p =>
          !Number.isSafeInteger(floor.phaseUsed[p]) || floor.phaseUsed[p] < phaseFloor[p] || job.sourceGrant.used[p] < floor.phaseUsed[p])) return bad();
    seen.add(r.fence.marker); markers.push(r.fence.marker);
    taskFloor = floor.taskUsed; sharedFloor = floor.sharedUsed; phaseFloor = floor.phaseUsed; reviewedAt = r.reviewedAt;
  }
  if (g.activeFence && seen.has(g.activeFence.marker)) return bad();
  return markers;
}

/** A settled receipt is usable only for this still-owning process and the exact fence. */
function settledReceipt(job: any, fence: any): boolean {
  const r = fence.receipt;
  return receiptBound(job, fence) && r.settled === true && ownsDispatch(fence.owner, fence.owner);
}

/** Explicit review only: preserve all unknown facts and marker rows, without dispatch or refunds. */
export async function reviewGenerationUnknown(tx: Tx, input: { jobId: string; generationId: string; confirmUnknown: true }, now = Date.now()) {
  if (!input || Object.keys(input).length !== 3 || typeof input.jobId !== 'string' || !input.jobId || input.jobId.length > 128 ||
      typeof input.generationId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.generationId) ||
      input.confirmUnknown !== true || !Number.isSafeInteger(now) || now < 1) return bad();
  const lock = await tx.$queryRaw<Array<{ id: string }>>`UPDATE xhs_request_budgets SET next_at=next_at WHERE id='xhs:source-total' RETURNING id`;
  if (lock.length !== 1) return bad();
  const rows = await tx.$queryRaw<Array<{ document: string; state: string; creator_id: string; author: string; enabled: number | boolean }>>`
    SELECT j.document,j.state,j.creator_id,c.external_author_id AS author,c.enabled AS enabled
    FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${input.jobId}`;
  if (rows.length !== 1) return bad();
  const row = rows[0], job = JSON.parse(row.document), g = job.generation;
  if (row.state !== 'paused' || job.state !== 'paused' || job.id !== input.jobId || job.creatorId !== row.creator_id ||
      (row.enabled !== 1 && row.enabled !== true) || !generationMatches(job) || g.id !== input.generationId || g.state !== 'paused' ||
      job.sourceGrant.authorId !== row.author || job.reviewAttempt || now < g.createdAt || !fenceValid(g.activeFence)) return bad();
  const previousMarkers = generationReviewMarkers(job), fence = g.activeFence;
  if (fence.receipt !== undefined && !receiptBound(job, fence)) return bad();
  if (!settledReceipt(job, fence) && observeDispatchOwner(fence.owner) !== 'dead') return bad();
  const risk = await tx.$queryRaw<Array<{ state: string; code: string }>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
  if (risk.length !== 1 || risk[0].state !== 'blocked' || risk[0].code !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED') return bad();
  const writers = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') LIMIT 1`;
  const children = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_subscription_tasks WHERE state IN ('queued','running') LIMIT 1`;
  const recovery = await tx.$queryRaw<Array<{ id: string }>>`SELECT original.id FROM xhs_limited_recovery original WHERE original.state IN ('armed','started','unknown') AND NOT EXISTS(SELECT 1 FROM xhs_limited_recovery_append followup WHERE followup.id=original.id AND followup.note_id=original.note_id AND followup.author_id=original.author_id AND followup.state='finished') LIMIT 1`;
  if (writers.length || children.length || recovery.length) return bad();
  const budgets = await tx.$queryRaw<Budget[]>`SELECT id,used,request_limit,interval_ms FROM xhs_request_budgets WHERE id IN (${input.jobId},'xhs:source-total')`;
  if (budgets.length !== 2) return bad();
  const previous = g.reviews?.[g.reviews.length - 1]?.budgetFloors;
  for (const origin of g.origin.budgets) {
    const live = budgets.find(b => b.id === origin.id), floor = origin.id === input.jobId ? previous?.taskUsed : previous?.sharedUsed;
    if (!live || !Number.isSafeInteger(live.used) || live.used < Math.max(origin.used, floor ?? 0) ||
        live.request_limit !== origin.request_limit || live.interval_ms !== origin.interval_ms) return bad();
  }
  const pending = await tx.$queryRaw<Array<{ id: string; used: number; request_limit: number }>>`SELECT id,used,request_limit FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
  const allowed = [g.origin.fence.marker, ...previousMarkers, fence.marker];
  if (new Set(allowed).size !== allowed.length || pending.length !== allowed.length || pending.some(p => !allowed.includes(p.id) || p.used !== 1 || p.request_limit !== 1)) return bad();
  const entry: Omit<GenerationUnknownReview, 'id'> = { fence: clone(fence), reviewedAt: now, decision: 'request-retry', budgetFloors: {
    taskUsed: budgets.find(b => b.id === input.jobId)!.used, sharedUsed: budgets.find(b => b.id === 'xhs:source-total')!.used, phaseUsed: clone(job.sourceGrant.used),
  } };
  g.reviews = [...(g.reviews ?? []), { ...entry, id: hash(reviewIdentity(g.id, entry)) }];
  delete g.activeFence;
  generationReviewMarkers(job);
  const changed = await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(now)} WHERE id=${input.jobId} AND state='paused' AND document=${row.document}`;
  if (changed !== 1) return bad();
  return { state: 'reviewed' as const, generationId: input.generationId };
}
