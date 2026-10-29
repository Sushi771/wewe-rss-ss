import {projectWriterGate} from './project-writer-boundary';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { XhsSubscriptionError } from './xhs-subscription-errors';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const bad = (): never => { throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'); };
/** Validates a server-persisted maintenance record; never accepts a client proof. */
export function legacyProofMatches(job: any, jobId: string, authorId?: string) {
  const p = job?.legacyMaintenanceProof, f = job?.sourceFence, s = p?.scope;
  if (!p || !s || !f || f.owner !== undefined || f.state !== 'started' || !['detail', 'metrics'].includes(f.phase) ||
      p.boundaryVersion !== 'project-start-dispatch-v2' || p.oldOwner !== null || p.oldResult !== 'unknown' || p.allowsRetry !== false ||
      p.claim !== 'no-local-project-writer-at-observation' || !hex(p.proofId) || !hex(p.lockIdentity) || !hex(s.databaseIdentity) || !hex(s.projectIdentity) ||
      typeof p.lockNonce !== 'string' || !p.holder || !p.snapshot || s.jobId !== jobId || (authorId !== undefined && s.authorId !== authorId) ||
      s.noteId !== f.noteId || s.unknownDigest !== digest({ fence: f, code: job.code }) ||
      p.proofId !== digest({ scope: s, lockIdentity: p.lockIdentity, lockNonce: p.lockNonce, holder: p.holder, snapshot: p.snapshot })) return false;
  return true;
}
export function legacyBudgetDigest(job: any, rows: Array<{ id: string; used: number; request_limit: number; next_at: bigint | number; interval_ms: number }>, jobId: string) {
  const values = [rows.find(r => r.id === jobId), rows.find(r => r.id === 'xhs:source-total')];
  if (values.some(r => !r || !Number.isSafeInteger(r.used) || r.used < 0 || !Number.isSafeInteger(r.request_limit) || r.used > r.request_limit)) return bad();
  return digest({ budgets: values.map(r => ({ id: r!.id, used: Number(r!.used), limit: Number(r!.request_limit), nextAt: String(r!.next_at), intervalMs: Number(r!.interval_ms) })), phaseGrant: job.sourceGrant ?? null });
}
export async function assertLegacyDatabase(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, job: any) {
  const files = await tx.$queryRaw<Array<{name: string; file: string}>>`PRAGMA database_list`;
  const file = files.find(r => r.name === 'main')?.file;
  if (!file) return bad();
  const gate = projectWriterGate();
  const lease = gate.acquireWriter(file); lease.check();
  if (lease.record.databaseIdentity !== job.legacyMaintenanceProof.scope.databaseIdentity) return bad();
}
/** Records an explicit review only; the existing attempt path still rechecks every execution guard. */
export async function reviewLegacyUnknown(tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>, jobId: string, authorId: string, confirmed: boolean) {
  if (!confirmed) return bad();
  const rows = await tx.$queryRaw<Array<{ document: string }>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${jobId} AND state='paused'`;
  if (rows.length !== 1) return bad(); const job = JSON.parse(rows[0].document);
  if (!legacyProofMatches(job, jobId, authorId) || job.unknownReview || job.reviewAttempt) return bad();
  await assertLegacyDatabase(tx, job);
  const budgets = await tx.$queryRaw<Array<{ id: string; used: number; request_limit: number; next_at: bigint; interval_ms: number }>>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id IN (${jobId},'xhs:source-total')`;
  if (legacyBudgetDigest(job, budgets, jobId) !== job.legacyMaintenanceProof.scope.budgetDigest) return bad();
  job.unknownReview = { marker: job.sourceFence.marker, owner: null, legacyProofId: job.legacyMaintenanceProof.proofId, decision: 'request-retry', originalCode: job.code, originalGrant: job.sourceGrant, recordedAt: Date.now() };
  const n = await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${jobId} AND state='paused' AND document=${rows[0].document}`;
  if (n !== 1) return bad();
}
