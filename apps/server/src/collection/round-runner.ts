import { randomUUID } from 'node:crypto';
import {
  admitUnboundRequest,
  settleUnboundRequest,
  unboundRoundContext,
  type RoundTx,
  type RoundRequest,
} from './xhs-unbound-round';
import { reserveRoundBudgetRisk, finishRoundRisk } from './round-budget-risk';
import { saveRoundPage } from './save-round-page';
import {
  dispatchUnboundContext,
  type ContextBinding,
} from './xhs-reviewed-dispatch';
import type { XhsSubscriptionRuntime } from './xhs-subscription-runtime';

type Writer = <T>(work: (tx: RoundTx) => Promise<T>) => Promise<T>;
/** Existing service supplies its incremental writer and legacy admission check. */
export async function runApprovedThreePages(
  write: Writer,
  runtime: XhsSubscriptionRuntime,
  reviewId: string,
  assertExistingAdmission: (tx: RoundTx) => Promise<void>,
) {
  const reviews = await write((tx) =>
    tx.$queryRawUnsafe<any[]>(
      'SELECT creator_bindings_json,scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
      reviewId,
    ),
  );
  if (reviews.length !== 1) throw Error('APPROVED_NEW_ROUND_REQUIRED');
  const bindings = JSON.parse(reviews[0].creator_bindings_json),
    scope = JSON.parse(reviews[0].scope_json);
  if (scope.creatorIds?.length !== 3 || scope.maxListPages !== 1)
    throw Error('EXACT_THREE_EXISTING_CREATORS_REQUIRED');
  const results: Array<Awaited<ReturnType<typeof saveRoundPage>>> = [];
  for (const creatorId of scope.creatorIds as string[]) {
    const authorId = bindings[creatorId];
    let profile: any;
    for (const phase of ['profile', 'list'] as const) {
      const request: RoundRequest = {
        operationId: randomUUID(),
        taskId: 'new-round:' + reviewId,
        creatorId,
        phase,
        target: phase === 'profile' ? 'profile' : 'page:1',
      };
      const binding: ContextBinding = {
        jobId: reviewId,
        id: request.operationId,
        authorId,
        noteId: '',
        phase,
      };
      // Existing persisted interval remains effective between distinct physical requests.
      const clocks = await write((tx) =>
        tx.$queryRawUnsafe<any[]>(
          'SELECT next_at FROM xhs_request_budgets WHERE id IN (?,?)',
          'xhs:source-total',
          'xhs:original-link:' + creatorId,
        ),
      );
      const wait = Math.max(
        0,
        ...clocks.map((x) => Number(x.next_at) - Date.now()),
      );
      if (wait > 60000) throw Error('XHS_REQUEST_RATE_PAUSED');
      if (wait) await runtime.waitForSourceRate(wait);
      let owner: string | undefined;
      try {
        const value: any = await dispatchUnboundContext<any>(
          binding,
          async (operation) => {
            runtime.reviewedReadyCheck()();
            owner = await write(async (tx) => {
              await assertExistingAdmission(tx);
              await admitUnboundRequest(tx, reviewId, request);
              return reserveRoundBudgetRisk(tx, reviewId, request, Date.now());
            }); // COMMIT before operation enters transport.
            return unboundRoundContext.run({ reviewId, request }, operation);
          },
          (permit) =>
            phase === 'profile'
              ? runtime.resolveReviewedContextAuthor(binding, permit)
              : runtime.listReviewedContext(binding, profile, null, permit),
        );
        if (!owner) throw Error('DURABLE_REQUEST_BINDING_REQUIRED');
        const saved = await write(async (tx) => {
          let receipt: any;
          if (phase === 'list')
            receipt = await saveRoundPage(tx, creatorId, authorId, value);
          await settleUnboundRequest(
            tx,
            reviewId,
            request.operationId,
            'response-received',
            phase === 'list'
              ? value.notes.map((n: any) => n.noteId)
              : undefined,
          );
          await finishRoundRisk(tx, owner!, 'response-received');
          return receipt;
        });
        if (phase === 'profile') profile = value;
        else results.push(saved);
      } catch (error) {
        if (owner) {
          const code = runtime.reviewedFailureCode();
          try {
            await write(async (tx) => {
              await settleUnboundRequest(
                tx,
                reviewId,
                request.operationId,
                'unknown',
              );
              await finishRoundRisk(
                tx,
                owner!,
                'unknown',
                code,
                (error as any)?.httpStatus,
                phase,
              );
            });
          } catch {
            /* durable pending/started survives, stops all further requests */
          }
        }
        throw error;
      }
    }
  }
  return {
    reviewId,
    accounts: results,
    sourceRequests: 6,
    pages: 3,
    automaticFutureRounds: false,
  };
}
