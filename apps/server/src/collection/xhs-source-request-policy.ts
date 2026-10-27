import { randomUUID } from 'node:crypto';
import {
  xhsOriginalLinkCodes,
  type XhsOriginalLinkCode,
} from '@wewe-rss/shared';
import type { Prisma } from '@prisma/client';
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
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
const SOURCE_TOTAL = 'xhs:source-total';
const DISPATCH_PREFIX = 'xhs:dispatch-pending:';
class AdmissionUnavailable extends Error {}
function fail(code: string): never {
  throw new XhsSubscriptionError(code);
}
async function write<T>(
  db: PrismaService,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return incrementalWrite(db, 8192, () =>
    sqliteWrites.write(async () => {
      await assertIncrementalWriteAdmission();
      return db.$transaction(async (tx) => {
        await assertIncrementalTransaction(tx);
        return run(tx);
      });
    }),
  );
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
  if (!total) return null;
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
    const store = new XhsSqliteBudgetStore(tx);
    const [old, total] = await Promise.all([
      store.read(id),
      store.read(SOURCE_TOTAL),
    ]);
    if ((old && totalLimit < old.used) || (total && totalLimit < total.used))
      fail('XHS_REQUEST_POLICY_INVALID');
    for (const key of [SOURCE_TOTAL, id]) {
      await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
        VALUES(${key},${totalLimit},${intervalMs}) ON CONFLICT(id) DO UPDATE
        SET request_limit=${totalLimit},interval_ms=${intervalMs}`;
    }
  });
  return (await readXhsSourceBudget(db, scope))!;
}
// Count admission is durable before transport; next_at describes actual dispatch,
// never the earlier slot preceding another scope's cancellable wait.
async function hasPendingDispatch(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
) {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM xhs_request_budgets WHERE id LIKE ${DISPATCH_PREFIX + '%'} LIMIT 1`;
  return rows.length > 0;
}
async function pendingWaitExpired(
  db: PrismaService,
  waiting: { since?: number },
) {
  if (!(await hasPendingDispatch(db))) {
    waiting.since = undefined;
    return false;
  }
  waiting.since ??= performance.now();
  return performance.now() - waiting.since >= 1000;
}
async function reserveTotal(tx: Prisma.TransactionClient, now: number) {
  return (
    (await tx.$executeRaw`UPDATE xhs_request_budgets SET used=used+1
    WHERE id=${SOURCE_TOTAL} AND used < request_limit AND next_at <= ${BigInt(now)}
      AND NOT EXISTS (SELECT 1 FROM xhs_request_budgets WHERE id LIKE ${DISPATCH_PREFIX + '%'})`) ===
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
): Promise<T> {
  const store = new XhsSqliteBudgetStore(db);
  const waiting: { since?: number } = {};
  for (;;) {
    await ready();
    if (!(await store.read(SOURCE_TOTAL))) return operation();
    const marker = DISPATCH_PREFIX + randomUUID();
    let started = false;
    let response: Promise<T> | undefined;
    try {
      // A durable fence precedes all outbound work. It has no timed expiry:
      // a failed clock commit must block other runtimes and process restarts.
      await write(db, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE xhs_request_budgets SET next_at=next_at
          WHERE id=${SOURCE_TOTAL} AND next_at <= ${BigInt(Date.now())}
          RETURNING id`;
        if (!rows.length || (await hasPendingDispatch(tx)))
          throw new AdmissionUnavailable();
        await ready(tx);
        await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms)
          VALUES(${marker},1,1,${BigInt(Date.now())},0)`;
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
        response = operation();
        started = true;
        const dispatchedAt = Date.now();
        void response.catch(() => {});
        await tx.$executeRaw`UPDATE xhs_request_budgets
          SET next_at=${BigInt(dispatchedAt + Number(rows[0].interval_ms))}
          WHERE id=${SOURCE_TOTAL}`;
        await tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;
        // Only synchronous transport entry occurs inside this short transaction.
        // Network response latency is awaited after COMMIT.
      });
      return await response!;
    } catch (error) {
      if (!started) {
        try {
          await write(
            db,
            (tx) =>
              tx.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`,
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
      row.nextAt - Date.now() > 1000 ||
      (await pendingWaitExpired(db, waiting))
    )
      fail('XHS_REQUEST_RATE_PAUSED');
    await runtime.waitForSourceRate(
      Math.max(1, row.nextAt > Date.now() ? row.nextAt - Date.now() : 25),
    );
  }
}
/** Bound once by production DI; covers every API/media/redirect dispatch.
 * Before any explicit source grant exists, legacy task caps retain their policy. */
export function bindXhsSourceTotalBudget(
  db: PrismaService,
  runtime: XhsSubscriptionRuntime,
) {
  runtime.bindSourceAdmission(
    async (alreadyBudgeted) => {
      const store = new XhsSqliteBudgetStore(db);
      if (!(await store.read(SOURCE_TOTAL))) {
        if (!alreadyBudgeted) fail('XHS_REQUEST_BUDGET_REQUIRED');
        return;
      }
      const budget = new XhsRequestBudget({
        waitAllowanceMs: 1000,
        rollback: () => write(db, (tx) => rollbackTotal(tx)),
        read: (id) => store.read(id),
        reserve: async (id, now) => {
          const waiting: { since?: number } = {};
          for (;;) {
            runtime.assertSourceReady();
            if (await write(db, (tx) => reserveTotal(tx, now))) {
              return true;
            }
            const row = await store.read(id);
            if (
              !row ||
              row.used >= row.limit ||
              row.nextAt - Date.now() > 1000 ||
              (await pendingWaitExpired(db, waiting))
            )
              return false;
            await runtime.waitForSourceRate(
              Math.max(
                1,
                row.nextAt > Date.now() ? row.nextAt - Date.now() : 25,
              ),
            );
            now = Date.now();
          }
        },
      });
      return budget.reserve(SOURCE_TOTAL);
    },
    (operation, ready) => dispatchSource(db, runtime, operation, ready),
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
    waitAllowanceMs: 1000,
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
        if (
          !row ||
          row.used >= row.limit ||
          row.nextAt - Date.now() > 1000 ||
          (await pendingWaitExpired(db, waiting))
        )
          return false;
        await runtime.waitForSourceRate(
          Math.max(1, row.nextAt > Date.now() ? row.nextAt - Date.now() : 25),
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
