import type { Prisma } from '@prisma/client';
import type { DispatchOwner } from './xhs-dispatch-owner';
import { RedbookPauseError } from './redbook-client';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';

export type SafeSourceStage = 'admitted' | 'transport' | 'sent' | 'response' | 'parse' | 'storage' | 'checkpoint';
export type SafeSourceOutcome = 'in-progress' | 'not-sent' | 'response-received' | 'local-failure' | 'unknown' | 'checkpointed';
export interface SafeSourceReceipt {
  generationId: string;
  marker: string;
  owner: DispatchOwner;
  phase: string;
  sequence?: number;
  stage: SafeSourceStage;
  outcome: SafeSourceOutcome;
  settled: boolean;
  code?: string;
  status?: number;
  events?: Array<{ stage: SafeSourceStage; status?: number }>;
}
export type SourceReceipt = SafeSourceReceipt;
export interface SourceReceiptScope {
  jobId: string;
  creatorId: string;
  authorId: string;
  generationId?: string;
  marker: string;
  owner: DispatchOwner;
}
type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
const stages: SafeSourceStage[] = ['admitted', 'transport', 'sent', 'response', 'parse', 'storage', 'checkpoint'];
const outcomes: SafeSourceOutcome[] = ['in-progress', 'not-sent', 'response-received', 'local-failure', 'unknown', 'checkpointed'];
const localCodes = new Set(['XHS_LOCAL_OPERATION_FAILED', 'XHS_STORAGE_FAILED', 'XHS_LOCAL_PROGRAM_ERROR']);
const statusValue = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
const blocked = (): never => { throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'); };
const sameOwner = (a: DispatchOwner | undefined, b: DispatchOwner | undefined) => !!a && !!b && a.pid === b.pid && a.startIdentity === b.startIdentity && a.nonce === b.nonce;
function safeCode(code: unknown): string | undefined {
  if (typeof code !== 'string') return undefined;
  if (localCodes.has(code)) return code;
  const result = xhsPublicCode(new XhsSubscriptionError(code), '');
  return result || undefined;
}

/** Fixed diagnostics only. A local failure is not evidence of the upstream result. */
export function safeSourceFailure(error: unknown, stage: SafeSourceStage): { code: string; outcome: SafeSourceOutcome } {
  let code = xhsPublicCode(error, 'XHS_LOCAL_OPERATION_FAILED');
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^P\d{4}$/.test(error.code)) code = 'XHS_STORAGE_FAILED';
  else if (error instanceof TypeError) code = 'XHS_LOCAL_PROGRAM_ERROR';
  const outcome: SafeSourceOutcome = stage === 'storage' || stage === 'checkpoint' ? 'local-failure'
    : stage === 'response' || stage === 'parse' || (error instanceof RedbookPauseError && statusValue(error.httpStatus) !== undefined) ? 'response-received'
    : stage === 'admitted' ? 'not-sent' : 'unknown';
  return { code, outcome };
}

/** Internal transaction helper; it neither dispatches nor creates/clears a fence. */
export async function writeSourceReceipt(tx: Tx, scope: SourceReceiptScope, receipt: SafeSourceReceipt): Promise<boolean> {
  if (!scope.generationId) return false;
  const rows = await tx.$queryRaw<Array<{ document: string; state: string; creator_id: string; author: string }>>`
    SELECT j.document,j.state,j.creator_id,c.external_author_id AS author
    FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${scope.jobId}`;
  if (rows.length !== 1) return false;
  const row = rows[0], job = JSON.parse(row.document), generation = job.generation;
  if (generation?.id !== scope.generationId || job.id !== scope.jobId || job.creatorId !== scope.creatorId || row.creator_id !== scope.creatorId || row.author !== scope.authorId ||
      job.sourceGrant?.authorId !== scope.authorId || job.sourceGrant?.creatorId !== scope.creatorId) return blocked();
  const fence = generation.activeFence;
  // Never backfill the historical fence or a checkpoint already removed by its owner.
  if (!fence) return false;
  if (!['running', 'paused'].includes(row.state) || fence.marker !== scope.marker || !sameOwner(fence.owner, scope.owner) ||
      !['profile', 'list', 'detail', 'metrics'].includes(fence.phase) || !stages.includes(receipt.stage) || !outcomes.includes(receipt.outcome) || typeof receipt.settled !== 'boolean') return blocked();
  const previous: SafeSourceReceipt | undefined = fence.receipt;
  if (previous && (previous.generationId !== scope.generationId || previous.marker !== scope.marker || !sameOwner(previous.owner, scope.owner))) return blocked();
  const sequence = receipt.sequence ?? 0, previousSequence = previous?.sequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) return blocked();
  if (sequence < previousSequence) return false;
  if (previous?.settled || previous?.code) return false;
  const sameRequest = sequence === previousSequence;
  const priorStage = sameRequest && previous && stages.includes(previous.stage) ? stages.indexOf(previous.stage) : -1;
  const nextStage = stages.indexOf(receipt.stage);
  // Multi-request groups can start another transport after a response. The summary
  // stays monotonic while the bounded event list records those physical attempts.
  if (nextStage < priorStage && !(['transport', 'sent'].includes(receipt.stage) && priorStage <= stages.indexOf('parse'))) return false;
  const events = (previous?.events ?? []).filter(e => stages.includes(e.stage)).map(e => ({ stage: e.stage, ...(statusValue(e.status) !== undefined ? { status: e.status } : {}) }));
  const status = statusValue(receipt.status);
  events.push({ stage: receipt.stage, ...(status !== undefined ? { status } : {}) });
  const code = safeCode(receipt.code);
  const projected: SafeSourceReceipt = {
    generationId: generation.id, marker: fence.marker,
    owner: { pid: fence.owner.pid, startIdentity: fence.owner.startIdentity, nonce: fence.owner.nonce },
    phase: fence.phase, sequence, stage: stages[Math.max(priorStage, nextStage)], outcome: receipt.outcome, settled: receipt.settled,
    ...(code ? { code } : {}), ...(status !== undefined ? { status } : sameRequest && previous?.status !== undefined && statusValue(previous.status) !== undefined ? { status: previous.status } : {}),
    events: events.slice(-12),
  };
  fence.receipt = projected;
  generation.lastSourceReceipt = projected;
  const changed = await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${scope.jobId} AND state=${row.state} AND document=${row.document}`;
  if (changed !== 1) return blocked();
  return true;
}
