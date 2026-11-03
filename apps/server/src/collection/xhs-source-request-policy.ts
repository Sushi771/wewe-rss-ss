import { dispatchReviewedSource, dispatchReviewedContextStage, type ContextBinding } from './xhs-reviewed-dispatch';
import type { AttemptScope } from './xhs-reviewed-attempt';
import { retainedGenerationMarkers } from './xhs-whole-generation';
import { readHistoryHandoffs } from './xhs-history-handoff';
import { writeSourceReceipt } from './xhs-source-receipt';
import { startTaskSource, settleTaskSource, settleTaskMediaStreamUnknown, prepareTaskDetailAdmission, settleTaskDetailPreDispatch, verifiedUnknownMarkers, type TaskSourceScope } from './xhs-task-source-fence';
import { RedbookPauseError } from './redbook-client';
import { XhsMediaError } from './xhs-media-error';
import { randomUUID } from 'node:crypto';
import {
  xhsOriginalLinkCodes,
  type XhsOriginalLinkCode,
} from '@wewe-rss/shared';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  XhsOriginalLinkResult,
  XhsSourceBudgetScope,
  XhsSourceBudgetView,
} from '@wewe-rss/shared';
import type { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import type { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSqliteBudgetStore } from './xhs-request-budget-store';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';
import {
  incrementalWrite,
  assertIncrementalWriteAdmission,
  assertIncrementalTransaction,
  withIncrementalTransactionChecks,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import {
  prepareWholeSourceFence,
  markWholeSourceStarted,
  releasePreparedWholeSourceFence,
  type WholeSourceGroup,
  type Charge,
} from './xhs-whole-source-fence';
const SOURCE_TOTAL = 'xhs:source-total';
const DISPATCH_PREFIX = 'xhs:dispatch-pending:';
class AdmissionUnavailable extends Error {}
export type SourceTransactionDiagnostic = {
  transactionStage:'preflight'|'opening'|'checking-before'|'durability'|'operation'|'checking-after'|'committing';
  transactionError:'expired'|'closed'|'not-found'|'start-failed'|'commit-failed'|'other';
  transactionTotalMs:number;
  transactionOpenMs?:number;
  transactionCallbackMs?:number;
};
const sourceTransactionDiagnostics = new WeakMap<object,SourceTransactionDiagnostic>();
/** Fixed categories and bounded timings only; never expose Prisma messages. */
export function sourceTransactionDiagnostic(error:unknown):SourceTransactionDiagnostic|undefined {
  return error && typeof error==='object' ? sourceTransactionDiagnostics.get(error) : undefined;
}
function transactionErrorKind(error:Prisma.PrismaClientKnownRequestError):SourceTransactionDiagnostic['transactionError'] {
  const meta=error.meta?.error;
  const message=typeof meta==='string'?meta:error.message;
  if(/expired/i.test(message))return 'expired';
  if(/(?:committed|rolled back) transaction/i.test(message))return 'closed';
  if(/transaction (?:already |is )?closed/i.test(message))return 'closed';
  if(/transaction (?:not found|does not exist)/i.test(message))return 'not-found';
  if(/unable to start|failed to start/i.test(message))return 'start-failed';
  if(/unable to commit|failed to commit/i.test(message))return 'commit-failed';
  return 'other';
}
function fail(code: string): never {
  throw new XhsSubscriptionError(code);
}
async function write<T>(
  db: PrismaService,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  reserveBytes=8192,
) {
  const started=performance.now();let requested:number|undefined,entered:number|undefined,finished:number|undefined;
  let transactionStage:SourceTransactionDiagnostic['transactionStage']='preflight';
  const elapsed=(a:number,b:number)=>Math.min(60000,Math.max(0,Math.round(b-a)));
  try{return await incrementalWrite(db, reserveBytes, () =>
    sqliteWrites.write(async () => {
      await assertIncrementalWriteAdmission();
      requested=performance.now();transactionStage='opening';
      return db.$transaction(async tx => {
        entered=performance.now();transactionStage='checking-before';
        const result=await withIncrementalTransactionChecks(async () => {
        transactionStage='durability';
        await assertIncrementalTransaction(tx);
        transactionStage='operation';
        const value=await run(tx);
        transactionStage='checking-after';
        return value;
        });
        finished=performance.now();transactionStage='committing';
        return result;
      });
    }),
  );}catch(error){
    if(error instanceof Prisma.PrismaClientKnownRequestError && error.code==='P2028'){
      const end=performance.now();
      sourceTransactionDiagnostics.set(error,{transactionStage,transactionError:transactionErrorKind(error),transactionTotalMs:elapsed(started,end),...(requested===undefined?{}:{transactionOpenMs:elapsed(requested,entered??end)}),...(entered===undefined?{}:{transactionCallbackMs:elapsed(entered,finished??end)})});
    }
    throw error;
  }
}
async function policyId(db: PrismaService, scope: XhsSourceBudgetScope) {
  if (scope.purpose === 'resolution') return 'xhs:resolution';
  if (
    !scope.creatorId ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.creatorId) ||
    !(await db.xhsCreator.findUnique({ where: { id: scope.creatorId } }))
  )
    fail('XHS_SUBSCRIPTION_REQUIRED');
  return 'xhs:original-link:' + scope.creatorId;
}
export async function readXhsSourceBudget(
  db: PrismaService,
  scope: XhsSourceBudgetScope,
): Promise<XhsSourceBudgetView | null> {
  const budgetId = await policyId(db, scope);
  const store = new XhsSqliteBudgetStore(db);
  const [row, total] = await Promise.all([
    store.read(budgetId),
    store.read(SOURCE_TOTAL),
  ]);
  if (!total) return row ? null : {budgetId,limit:100000,used:0,remaining:100000,nextAt:0,intervalMs:5000,scopeUsed:0,limitEnforced:false};
  // An unconfigured purpose/author is a view of the existing shared grant, not
  // a newly created allowance. Its stable alias still prevents cross-note scope substitution.
  const local = row ?? total;
  return {
    budgetId,
    limit: total.limit,
    used: total.used,
    remaining: Math.max(
      0,
      Math.min(total.limit - total.used, local.limit - local.used),
    ),
    nextAt: Math.max(local.nextAt, total.nextAt),
    intervalMs: Math.max(local.intervalMs, total.intervalMs),
    scopeUsed: row?.used ?? 0,
    limitEnforced: false,
  };
}
/** Explicit configuration only. Re-saving a total is never an additive grant,
 * never resets used/nextAt, and never updates a legacy whole-task budget. */
export async function configureXhsSourceBudget(
  db: PrismaService,
  scope: XhsSourceBudgetScope,
  totalLimit: number,
  intervalMs: number,
) {
  if (
    !Number.isSafeInteger(totalLimit) ||
    totalLimit < 1 ||
    totalLimit > 100000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs > 60000
  )
    fail('XHS_REQUEST_POLICY_INVALID');
  const id = await policyId(db, scope);
  await write(db, async (tx) => {
    for (const key of [SOURCE_TOTAL, id]) {
      await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
        VALUES(${key},${totalLimit},${intervalMs}) ON CONFLICT(id) DO UPDATE
        SET request_limit=${totalLimit},interval_ms=${intervalMs}`;
    }
  });
  return (await readXhsSourceBudget(db, scope))!;
}
// Create only the observational/rate row when absent; never change existing counts or timing.
async function ensureSourceCounter(db: PrismaService) {
  if (await new XhsSqliteBudgetStore(db).read(SOURCE_TOTAL)) return;
  await write(db, async tx => {
    await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
      VALUES(${SOURCE_TOTAL},100000,5000) ON CONFLICT(id) DO NOTHING`;
  });
}
// Count admission is durable before transport; next_at describes actual dispatch,
// never the earlier slot preceding another scope's cancellable wait.
async function hasPendingDispatch(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  owned = '',
  retained: string[] = [],
  scoped?:TaskSourceScope,
) {
  if(scoped)retained=[...retained,...await verifiedUnknownMarkers(db as Prisma.TransactionClient,scoped)];
  retained = [...new Set([...retained, ...(await readHistoryHandoffs(db)).markers])];
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM xhs_request_budgets WHERE id LIKE ${DISPATCH_PREFIX + '%'} AND id <> ${owned} AND id NOT IN (${Prisma.join(retained.length ? retained : [''])}) LIMIT 1`;
  return rows.length > 0;
}

async function pendingWaitExpired(
  db: PrismaService,
  waiting: { since?: number },
  owned = '',
  group?: WholeSourceGroup,
  scoped?:TaskSourceScope,
) {
  const retained = group ? await retainedGenerationMarkers(db, group) : [];
  if (!(await hasPendingDispatch(db, owned, retained,scoped))) {
    waiting.since = undefined;
    return false;
  }
  waiting.since ??= performance.now();
  return performance.now() - waiting.since >= 1000;
}
async function reserveTotal(
  tx: Prisma.TransactionClient,
  now: number,
  owned = '',
  retained: string[] = [],
) {
  retained = [...new Set([...retained, ...(await readHistoryHandoffs(tx)).markers])];
  return (
    (await tx.$executeRaw`UPDATE xhs_request_budgets SET used=used+1
    WHERE id=${SOURCE_TOTAL} AND used < 9007199254740991 AND next_at <= ${BigInt(now)}
      AND NOT EXISTS (SELECT 1 FROM xhs_request_budgets WHERE id LIKE ${DISPATCH_PREFIX + '%'} AND id <> ${owned} AND id NOT IN (${Prisma.join(retained.length ? retained : [''])}))`) ===
    1
  );
}
async function rollbackTotal(tx: Prisma.TransactionClient) {
  // The one-shot receipt proves this counted request never started transport.
  // Remove its unit, while preserving intervening requests and their timestamp.
  const current = await new XhsSqliteBudgetStore(tx).read(SOURCE_TOTAL);
  if (!current || current.used < 1) return false;
  return (
    (await tx.$executeRaw`UPDATE xhs_request_budgets SET used=used-1
    WHERE id=${SOURCE_TOTAL} AND used=${current.used}
      AND next_at=${BigInt(current.nextAt)}`) === 1
  );
}
async function dispatchSource<T>(
  db: PrismaService,
  runtime: XhsSubscriptionRuntime,
  operation: () => Promise<T>,
  ready: (tx?: Prisma.TransactionClient) => Promise<void>,
  group?: WholeSourceGroup,
  charge?: Charge,
  scoped?:TaskSourceScope,
): Promise<T> {
  const store = new XhsSqliteBudgetStore(db);
  await ready();
  await ensureSourceCounter(db);
  const waiting: { since?: number } = {};
  for (;;) {
    await ready();
    if (!(await store.read(SOURCE_TOTAL))) {
      if (group || scoped) fail('XHS_REQUEST_BUDGET_REQUIRED');
      if (await hasPendingDispatch(db,'',[],scoped)) fail('XHS_REQUEST_RATE_PAUSED');
      return operation();
    }
    const marker = group?.marker ?? DISPATCH_PREFIX + randomUUID();
    let started = false;
    let dispatchCommitted = false;
    let gotResponse = false;
    let response: Promise<T> | undefined;
    try {
      // A durable fence precedes all outbound work. It has no timed expiry:
      // a failed clock commit must block other runtimes and process restarts.
      await write(db, async (tx) => {
        const retained = group ? await retainedGenerationMarkers(tx, group) : [];
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE xhs_request_budgets SET next_at=next_at
          WHERE id=${SOURCE_TOTAL} AND next_at <= ${BigInt(Date.now())}
          RETURNING id`;
        if (
          !rows.length ||
          (await hasPendingDispatch(tx, group?.acquired ? marker : '', retained,scoped))
        )
          throw new AdmissionUnavailable();
        await ready(tx);
        if (!group?.acquired) {
          if (group) await prepareWholeSourceFence(tx, group);
          else
            await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms)
            VALUES(${marker},1,1,${BigInt(Date.now())},0)`;
        }
      });
      if (group) group.acquired = true;
      // Generation phase usage must survive a later dispatch transaction rollback.
      if (group?.generationId) await write(db, async tx => {
        await ready(tx);
        await markWholeSourceStarted(tx,group.jobId,marker,group.owner,charge,group.generationId);
      });
      await write(db, async (tx) => {
        // Cancellation and dispatch serialize on this write lock. Any cancel
        // committed before it is acquired must be observed through this tx.
        const rows = await tx.$queryRaw<Array<{ interval_ms: bigint }>>`
          UPDATE xhs_request_budgets SET next_at=next_at
          WHERE id=${SOURCE_TOTAL} RETURNING interval_ms`;
        if (!rows.length) fail('XHS_REQUEST_BUDGET_REQUIRED');
        const owned = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM xhs_request_budgets WHERE id=${marker}`;
        if (!owned.length) fail('XHS_REQUEST_RATE_PAUSED');
        await ready(tx);
        if(scoped && !group)await startTaskSource(tx,scoped);
        if (group && !group.generationId) await markWholeSourceStarted(tx, group.jobId, marker, group.owner, charge, group.generationId);
        if (group?.mediaAttempt && !group.mediaDispatched) {
          if (charge !== 'media' || !group.mediaDispatch) fail('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
          await group.mediaDispatch(tx);
          group.mediaDispatched = true;
        }
        response = operation();
        started = true;
        if (group) group.started = true;
        const dispatchedAt = Date.now();
        void response.catch(() => {});
        await tx.$executeRaw`UPDATE xhs_request_budgets
          SET next_at=${BigInt(dispatchedAt + Number(rows[0].interval_ms))}
          WHERE id=${SOURCE_TOTAL}`;
        if (!group)
          await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
        // Only synchronous transport entry occurs inside this short transaction.
        // Network response latency is awaited after COMMIT.
      });
      dispatchCommitted = true;
      const result=await response!;gotResponse=true;
      if(scoped && !group){await write(db,tx=>settleTaskSource(tx,scoped,'response'));scoped.confirmedResponse=true;}
      return result;
    } catch (error) {
      // A dispatch transaction can fail after transport entry. Its network promise
      // must settle before the owning stack can attest quiescence for review.
      if (started && response) {
        if (!dispatchCommitted) runtime.markDispatchPersistenceFailure?.();
        try { await response; } catch { /* preserve the original persistence error */ }
      }
      const transportUnknown=charge==='media'
        ? error instanceof XhsMediaError && ['XHS_MEDIA_TRANSPORT_FAILED','XHS_MEDIA_TIMEOUT'].includes(error.code)
        : error instanceof RedbookPauseError ? error.reason==='transport' : !(error instanceof XhsSubscriptionError || error instanceof XhsMediaError);
      if(started && dispatchCommitted && !gotResponse && scoped && !group && transportUnknown) {
        // Only the original pending owner may atomically retain this unknown
        // request and release the shared lane; failed writes stay globally fenced.
        await write(db,tx=>settleTaskSource(tx,scoped,'unknown'));
        scoped.isolatedUnknown=true;
      }
      if (!started && (!group || !group.started)) {
        try {
          await write(db, (tx) =>
            group
              ? releasePreparedWholeSourceFence(tx, group.jobId, marker, group.owner, group.generationId)
              : tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`,
          );
        } catch {
          /* The durable fence remains conservative on cleanup failure. */
        }
      }
      if (started || !(error instanceof AdmissionUnavailable)) throw error;
    }
    const row = await store.read(SOURCE_TOTAL);
    if (
      !row ||
      (await pendingWaitExpired(db, waiting, group?.marker, group,scoped))
    )
      fail('XHS_REQUEST_RATE_PAUSED');
    await runtime.waitForSourceRate(
      Math.min(1000, Math.max(1, row.nextAt > Date.now() ? row.nextAt - Date.now() : 25)),
    );
  }
}
/** Bound once by production DI; covers every API/media/redirect dispatch.
 * Before any explicit source grant exists, legacy task caps retain their policy. */
export function bindXhsSourceTotalBudget(
  db: PrismaService,
  runtime: XhsSubscriptionRuntime,
) {
  runtime.bindWholeReceipt?.((scope,receipt) => write(db, tx => writeSourceReceipt(tx,scope,receipt)));
  runtime.bindScopedMediaFailure?.(scope=>write(db,tx=>settleTaskMediaStreamUnknown(tx,scope)));
  runtime.bindScopedLocalAdmissionFailure?.(scope=>write(db,async tx=>{
    if(await hasPendingDispatch(tx,'',[],scope))fail('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    await settleTaskDetailPreDispatch(tx,scope);
  }));
  runtime.bindSourceAdmission(
    async (alreadyBudgeted, group, ready,scoped) => {
      const store = new XhsSqliteBudgetStore(db);
      runtime.assertSourceReady();
      await ensureSourceCounter(db);
      if (!(await store.read(SOURCE_TOTAL))) {
        if (!alreadyBudgeted) fail('XHS_REQUEST_BUDGET_REQUIRED');
        return;
      }
      if(scoped?.phase==='detail' && !group){
        await write(db,tx=>prepareTaskDetailAdmission(tx,scoped));
        scoped.preflightConfirmed=true;
      }
      const budget = new XhsRequestBudget({
        rollback: () => write(db, (tx) => rollbackTotal(tx)),
        read: (id) => store.read(id),
        reserve: async (id, now) => {
          const waiting: { since?: number } = {};
          for (;;) {
            runtime.assertSourceReady();
            await ready?.();
            if (await write(db, async (tx) => reserveTotal(tx, now, group?.marker, [...(group ? await retainedGenerationMarkers(tx, group) : []),...(scoped ? await verifiedUnknownMarkers(tx,scoped) : [])]))) {
              return true;
            }
            const row = await store.read(id);
            if (row && row.used >= Number.MAX_SAFE_INTEGER)
              fail('XHS_REQUEST_BUDGET_EXHAUSTED');
            if (
              !row ||
              (await pendingWaitExpired(db, waiting, group?.marker, group,scoped))
            )
              return false;
            await runtime.waitForSourceRate(
              Math.min(1000, Math.max(
                1,
                row.nextAt > Date.now() ? row.nextAt - Date.now() : 25,
              )),
            );
            now = Date.now();
          }
        },
      });
      return budget.reserve(SOURCE_TOTAL);
    },
    (operation, ready, group, charge,scoped) =>
      dispatchSource(db, runtime, operation, ready, group, charge,scoped),
  );
}
async function withPolicy<T>(
  db: PrismaService,
  runtime: XhsSubscriptionRuntime,
  scope: XhsSourceBudgetScope,
  budgetId: string | undefined,
  work: () => Promise<T>,
) {
  runtime.assertSourceReady();
  bindXhsSourceTotalBudget(db, runtime);
  await ensureSourceCounter(db);
  const policy = await readXhsSourceBudget(db, scope);
  if (!policy) fail('XHS_REQUEST_BUDGET_REQUIRED');
  if (budgetId !== undefined && budgetId !== policy.budgetId)
    fail('XHS_BUDGET_SCOPE_MISMATCH');
  const store = new XhsSqliteBudgetStore(db);
  const combined = async (id: string) => {
    const [scopeRow, total] = await Promise.all([
      store.read(id),
      store.read(SOURCE_TOTAL),
    ]);
    if (!total) return null;
    const local = scopeRow ?? total;
    const remaining = Math.max(
      0,
      Math.min(local.limit - local.used, total.limit - total.used),
    );
    return {
      ...local,
      id,
      used: total.used,
      limit: total.used + remaining,
      nextAt: Math.max(local.nextAt, total.nextAt),
    };
  };
  const receipts = new Map<
    string,
    {
      local: Awaited<ReturnType<typeof store.read>>;
      total: NonNullable<Awaited<ReturnType<typeof store.read>>>;
      at: number;
    }
  >();
  const budget = new XhsRequestBudget({
    rollback: async (id, _before, now) => {
      const key = JSON.stringify([id, now]),
        receipt = receipts.get(key);
      receipts.delete(key);
      if (!receipt) return false;
      try {
        await write(db, async (tx) => {
          const txStore = new XhsSqliteBudgetStore(tx);
          if (
            !(await rollbackTotal(tx)) ||
            (receipt.local &&
              !(await txStore.rollback(id, receipt.local, receipt.at)))
          )
            throw new AdmissionUnavailable();
        });
        return true;
      } catch (error) {
        if (error instanceof AdmissionUnavailable) return false;
        throw error;
      }
    },
    read: combined,
    reserve: async (id, now) => {
      const receiptKey = JSON.stringify([id, now]);
      const waiting: { since?: number } = {};
      for (;;) {
        runtime.assertSourceReady();
        try {
          await write(db, async (tx) => {
            const txStore = new XhsSqliteBudgetStore(tx);
            const local = await txStore.read(id);
            const total = await txStore.read(SOURCE_TOTAL);
            if (
              !(await reserveTotal(tx, now)) ||
              (local && !(await txStore.reserve(id, now)))
            )
              throw new AdmissionUnavailable();
            receipts.set(receiptKey, { local, total: total!, at: now });
          });
          return true;
        } catch (error) {
          if (!(error instanceof AdmissionUnavailable)) throw error;
        }
        const row = await combined(id);
        const local = await store.read(id);
        if ((row && row.used >= Number.MAX_SAFE_INTEGER) || (local && local.used >= Number.MAX_SAFE_INTEGER))
          fail('XHS_REQUEST_BUDGET_EXHAUSTED');
        if (
          !row ||
          (await pendingWaitExpired(db, waiting))
        )
          return false;
        await runtime.waitForSourceRate(
          Math.min(1000, Math.max(1, row.nextAt > Date.now() ? row.nextAt - Date.now() : 25)),
        );
        now = Date.now();
      }
    },
  });
  // No outer reservation: guardTransport reserves each actual API/redirect once.
  return runtime.withRequestBudget(budget, policy.budgetId, work, true);
}
export function resolveXhsSubscriptionWithBudget(
  db: PrismaService,
  runtime: XhsSubscriptionRuntime,
  subscriptions: XhsSubscriptionService,
  input: { url: string; budgetId?: string; fixedErrors?: boolean },
) {
  return withPolicy(
    db,
    runtime,
    { purpose: 'resolution' },
    input.budgetId,
    () =>
      input.fixedErrors
        ? subscriptions.resolveSubscription(
            { url: input.url },
            { fixedErrors: true },
          )
        : subscriptions.resolveSubscription({ url: input.url }),
  );
}
export async function prepareXhsOriginalLink(
  db: PrismaService,
  runtime: XhsSubscriptionRuntime,
  input: { noteId: string; budgetId?: string; refreshContext?: boolean },
): Promise<XhsOriginalLinkResult> {
  try {
    let tuple: unknown;
    try {
      tuple = JSON.parse(input.noteId);
    } catch {
      fail('XHS_NOTE_ID_INVALID');
    }
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      tuple[0] !== 'xiaohongshu' ||
      tuple[1] !== 'note' ||
      typeof tuple[2] !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(tuple[2]) ||
      JSON.stringify(tuple) !== input.noteId
    )
      fail('XHS_NOTE_ID_INVALID');
    const note = await db.xhsNote.findUnique({
      where: { id: input.noteId },
      select: {
        creatorId: true,
        creator: { select: { externalAuthorId: true } },
      },
    });
    if (!note?.creator.externalAuthorId) fail('XHS_SUBSCRIPTION_REQUIRED');
    const authorId = note.creator.externalAuthorId;
    const externalNoteId = tuple[2] as string;
    runtime.assertSourceReady();
    const scope = {
      purpose: 'original-link' as const,
      creatorId: note.creatorId,
    };
    const expected = await policyId(db, scope);
    if (input.budgetId !== undefined && input.budgetId !== expected)
      fail('XHS_BUDGET_SCOPE_MISMATCH');
    const cached = runtime.cachedOriginalLink(authorId, externalNoteId);
    if (cached && !input.refreshContext) return cached; // Existing context requires no request or quota.
    return await withPolicy(db, runtime, scope, input.budgetId, () =>
      runtime.prepareOriginalLink(
        authorId,
        externalNoteId,
        input.refreshContext,
      ),
    );
  } catch (error) {
    const code = xhsPublicCode(error, 'XHS_ORIGINAL_LINK_NOT_READY');
    return {
      state: 'not_ready',
      code: (xhsOriginalLinkCodes as readonly string[]).includes(code)
        ? (code as XhsOriginalLinkCode)
        : 'XHS_ORIGINAL_LINK_NOT_READY',
    };
  }
}

export function dispatchReviewedWholeSource<T,R>(db:PrismaService,input:AttemptScope,id:string,request:{authorId:string;noteId:string;phase:string},ready:()=>void|Promise<void>,transport:(permit: import('./xhs-reviewed-dispatch').ReviewedTransportPermit)=>Promise<T>,checkpoint:(tx:Prisma.TransactionClient,value:T)=>Promise<R>){
 return dispatchReviewedSource(fn=>write(db,tx=>fn(tx),8*1024*1024+65536),input,id,request,ready,transport,(tx,value)=>checkpoint(tx as Prisma.TransactionClient,value));
}
export function dispatchReviewedWholeContext<T>(db:PrismaService,binding:ContextBinding,ready:()=>void|Promise<void>,transport:(permit:object)=>Promise<T>){
 return dispatchReviewedContextStage(fn=>write(db,tx=>fn(tx)),binding,ready,transport);
}
