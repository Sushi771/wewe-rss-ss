import { z } from 'zod';
import {
  appendXhsPage,
  xhsArchiveDraft,
  xhsIdentity,
  xhsPageLedger,
  XhsNormalizedCandidate,
  XhsPageLedger,
} from './xiaohongshu-contract';

/** Internal normalized seam, not a claim about a real Redbook response schema.
 * No transport, credentials, timer, store or application registration lives here.
 */
export interface XhsPageSource {
  readonly source: string;
  readPage(request: XhsPageRequest): Promise<XhsSourcePage>;
}
export interface XhsPageRequest {
  source: string;
  authorId: string;
  requestCursor: string | null;
}
export interface XhsSourcePage extends XhsPageRequest {
  nextCursor: string | null;
  items: XhsNormalizedCandidate[];
}
export type RedbookStopReason =
  | 'disabled'
  | 'rate-limit'
  | 'login-expired'
  | 'media-expired'
  | 'interrupted'
  | 'contract'
  | 'unknown';
export class RedbookSourceStop extends Error {
  constructor(readonly reason: RedbookStopReason) {
    super(`REDBOOK_SOURCE_STOP:${reason}`);
  }
}
/** Fail closed even when imported or constructed by a caller. */
export const disabledRedbookSource: XhsPageSource = Object.freeze({
  source: 'redbook',
  async readPage() {
    throw new RedbookSourceStop('disabled');
  },
});

const cursor = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .nullable();
const ledgerSchema = z
  .object({
    authorKey: z.string().max(1024),
    nextCursor: cursor,
    requestedCursors: z.array(cursor).max(3),
    noteKeys: z.array(z.string().max(1024)).max(90),
    supplierReportedEnd: z.boolean(),
  })
  .strict();
const checkpointSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('redbook'),
    authorId: z.string().min(1).max(128),
    phase: z.enum(['ready', 'requesting', 'paused', 'window-complete']),
    reason: z.enum([
      'none',
      'disabled',
      'rate-limit',
      'login-expired',
      'media-expired',
      'interrupted',
      'contract',
      'unknown',
    ]),
    ledger: ledgerSchema,
  })
  .strict();
export type RedbookCheckpoint = z.infer<typeof checkpointSchema>;

/** Only metadata goes into the owning task's existing checkpoint storage.
 * No credential/media/raw-response fields. Supply only vetted paging cursors.
 */
export function parseRedbookCheckpoint(raw: unknown): RedbookCheckpoint {
  const state = checkpointSchema.parse(raw);
  const { ledger } = state;
  const requests = ledger.requestedCursors;
  if (
    ledger.authorKey !== xhsIdentity('author', state.authorId) ||
    new Set(requests).size !== requests.length ||
    new Set(ledger.noteKeys).size !== ledger.noteKeys.length ||
    ledger.noteKeys.length > requests.length * 30 ||
    (requests.length > 0 && requests[0] !== null) ||
    (requests.length === 0 && ledger.nextCursor !== null) ||
    (ledger.nextCursor !== null && requests.includes(ledger.nextCursor)) ||
    ledger.supplierReportedEnd !==
      (requests.length > 0 && ledger.nextCursor === null) ||
    (state.phase === 'paused') !== (state.reason !== 'none') ||
    (state.phase === 'window-complete') !==
      (ledger.supplierReportedEnd || requests.length === 3)
  )
    throw new RedbookSourceStop('contract');
  for (const key of ledger.noteKeys) {
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      throw new RedbookSourceStop('contract');
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      parts[0] !== 'xiaohongshu' ||
      parts[1] !== 'note' ||
      typeof parts[2] !== 'string' ||
      key !== xhsIdentity('note', parts[2])
    )
      throw new RedbookSourceStop('contract');
  }
  return state;
}
export function newRedbookCheckpoint(authorId: string): RedbookCheckpoint {
  return parseRedbookCheckpoint({
    version: 1,
    source: 'redbook',
    authorId,
    phase: 'ready',
    reason: 'none',
    ledger: xhsPageLedger(authorId),
  });
}
/** Owning task must persist this state BEFORE calling readPage. Single lane;
 * do not inherit WeChat's submit concurrency or any automatic retry policy.
 */
export function beginRedbookPage(raw: RedbookCheckpoint) {
  const state = parseRedbookCheckpoint(raw);
  if (state.phase !== 'ready') throw new RedbookSourceStop('interrupted');
  return {
    checkpoint: { ...state, phase: 'requesting' as const },
    request: {
      source: state.source,
      authorId: state.authorId,
      requestCursor: state.ledger.nextCursor,
    },
  };
}
/** Validate before handing bytes to the EXISTING XHS cache transaction. The
 * returned checkpoint may only be saved AFTER that transaction acknowledges.
 * A crash between the two leaves requesting, requiring evidence reconciliation.
 */
export function prepareRedbookPageCommit(
  raw: RedbookCheckpoint,
  page: XhsSourcePage,
): { checkpoint: RedbookCheckpoint; newNoteKeys: string[] } {
  const state = parseRedbookCheckpoint(raw);
  if (
    state.phase !== 'requesting' ||
    page.source !== state.source ||
    page.authorId !== state.authorId ||
    !Array.isArray(page.items) ||
    page.items.length > 30
  )
    throw new RedbookSourceStop('contract');
  // Validate the stricter cursor data before the shared ledger transition.
  cursor.parse(page.requestCursor);
  cursor.parse(page.nextCursor);
  for (const item of page.items) {
    const draft = xhsArchiveDraft(state.authorId, item);
    if (
      item.kind !== 'image-text' ||
      draft.status !== 'candidate' ||
      !draft.readyForEvidenceCheck
    )
      throw new RedbookSourceStop('contract');
  }
  const next = appendXhsPage(state.ledger as XhsPageLedger, page, 3);
  return {
    checkpoint: parseRedbookCheckpoint({
      ...state,
      ledger: next.ledger,
      phase:
        next.ledger.supplierReportedEnd ||
        next.ledger.requestedCursors.length === 3
          ? 'window-complete'
          : 'ready',
    }),
    newNoteKeys: next.newNoteKeys,
  };
}
/** Persist only a fixed category. Neither source restrictions nor uncertain
 * dispatch/commit outcomes get an automatic retry or timeout-based reset.
 */
export function pauseRedbookCheckpoint(
  raw: RedbookCheckpoint,
  error: unknown,
): RedbookCheckpoint {
  const state = parseRedbookCheckpoint(raw);
  if (state.phase === 'paused' || state.phase === 'window-complete')
    return state;
  return parseRedbookCheckpoint({
    ...state,
    phase: 'paused',
    reason: error instanceof RedbookSourceStop ? error.reason : 'unknown',
  });
}
export function recoverRedbookCheckpoint(raw: unknown): RedbookCheckpoint {
  const state = parseRedbookCheckpoint(raw);
  return state.phase === 'requesting'
    ? pauseRedbookCheckpoint(state, new RedbookSourceStop('interrupted'))
    : state;
}
