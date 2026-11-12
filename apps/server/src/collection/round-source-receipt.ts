import { AsyncLocalStorage } from 'node:async_hooks';
import {
  safeSourceFailure,
  type SafeSourceStage,
  type SafeSourceOutcome,
} from './xhs-source-receipt';
import { RedbookTransportDiagnosticError } from './redbook-client';
import type { RoundRequest, RoundTx } from './xhs-unbound-round';

type Writer = <T>(work: (tx: RoundTx) => Promise<T>) => Promise<T>;
const stages: SafeSourceStage[] = [
  'admitted',
  'transport',
  'sent',
  'response',
  'parse',
  'storage',
  'checkpoint',
];
export const roundSourceReceiptContext = new AsyncLocalStorage<{
  observe(stage: SafeSourceStage, status?: number, notSent?: boolean): void;
}>();

/** Fixed metadata only: never accepts URLs, headers, response bodies or error text. */
export function createRoundSourceReceipt(
  write: Writer,
  reviewId: string,
  request: RoundRequest,
) {
  let stage: SafeSourceStage = 'admitted',
    outcome: SafeSourceOutcome = 'in-progress';
  let status: number | undefined, code: string | undefined;
  let transportFailure: string | undefined, nativeCode: string | undefined;
  let localReason: string | undefined;
  let terminal = false,
    active = false;
  let tail: Promise<unknown> = Promise.resolve();
  const events: Array<{
    stage: SafeSourceStage;
    status?: number;
    notSent?: true;
  }> = [];
  const snapshot = () => ({
    stage,
    outcome,
    terminal,
    ...(status ? { status } : {}),
    ...(code ? { code } : {}),
    ...(transportFailure ? { transportFailure } : {}),
    ...(nativeCode ? { nativeCode } : {}),
    ...(localReason ? { localReason } : {}),
    events: events.slice(-12).map((e) => ({ ...e })),
  });
  const persist = async (tx: RoundTx, value = snapshot()) => {
    const changed = await tx.$executeRawUnsafe(
      "INSERT INTO xhs_unbound_source_receipts(operation_id,document) SELECT operation_id,? FROM xhs_unbound_owner_requests WHERE operation_id=? AND review_id=? AND creator_id=? AND phase=? AND task_id=? AND logical_target=? AND outcome='started' ON CONFLICT(operation_id) DO UPDATE SET document=excluded.document",
      JSON.stringify(value),
      request.operationId,
      reviewId,
      request.creatorId,
      request.phase,
      request.taskId,
      request.target,
    );
    if (changed !== 1) throw Error('ROUND_RECEIPT_BINDING_CHANGED');
  };
  const observe = (
    next: SafeSourceStage,
    httpStatus?: number,
    notSent = false,
  ) => {
    if (!active || !stages.includes(next)) return;
    const checkedStatus =
      Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599
        ? httpStatus
        : undefined;
    stage = stages[Math.max(stages.indexOf(stage), stages.indexOf(next))];
    if (checkedStatus !== undefined) {
      status = checkedStatus;
      outcome = 'response-received';
    } else if (notSent && status === undefined) outcome = 'not-sent';
    events.push({
      stage: next,
      ...(checkedStatus ? { status: checkedStatus } : {}),
      ...(notSent ? { notSent: true as const } : {}),
    });
    if (events.length > 12) events.shift();
    const value = snapshot();
    tail = tail.then(() => write((tx) => persist(tx, value)));
    // Keep a failed write observable to drain(), without unhandled rejections.
    void tail.catch(() => {});
  };
  return {
    observe,
    snapshot,
    persist,
    async start() {
      active = true;
      observe('admitted');
      await tail;
    },
    run<T>(operation: () => Promise<T>) {
      return roundSourceReceiptContext.run({ observe }, operation);
    },
    drain() {
      return tail;
    },
    complete() {
      active = false;
      stage = 'checkpoint';
      outcome = 'checkpointed';
      terminal = true;
    },
    fail(error: unknown, localParseFailure = false) {
      active = false;
      const classified = safeSourceFailure(error, stage);
      code = classified.code;
      const localReasons = [
        'XHS_LIST_INVALID',
        'XHS_SUBSCRIPTION_CHANGED',
        'XHS_NOTE_OWNER_CONFLICT',
        'LIST_RESULT_SCOPE_INVALID',
        'ROUND_RECEIPT_BINDING_CHANGED',
      ];
      if (error instanceof Error && localReasons.includes(error.message))
        localReason = error.message;
      outcome =
        localParseFailure && status !== undefined
          ? 'local-failure'
          : status !== undefined && classified.outcome !== 'local-failure'
            ? 'response-received'
            : classified.outcome;
      if (error instanceof RedbookTransportDiagnosticError) {
        const kinds = [
          'guard-url',
          'guard-route',
          'guard-limits',
          'guard-headers',
          'guard-body',
          'guard-aborted',
          'request-create',
          'request-start',
          'request-error',
          'response-error',
          'response-aborted',
          'timeout',
          'abort',
          'response-length',
          'response-content-type',
          'response-size',
          'response-json',
          'response-url',
          'transport-other',
        ];
        if (kinds.includes(error.transportFailure))
          transportFailure = error.transportFailure;
        nativeCode = error.nativeCode;
        if (error.notSent && status === undefined) outcome = 'not-sent';
      }
      terminal = true;
    },
  };
}
