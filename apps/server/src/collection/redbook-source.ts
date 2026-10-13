import type { XhsCreator } from '@prisma/client';
import type {
  XhsSource,
  XhsReadResult,
  XhsRefreshResult,
  XhsSubscriptionCandidate,
} from './xiaohongshu.service';
import {
  freshRedbookState,
  RedbookStateStore,
  RedbookScanState,
} from './redbook-scan-state';
import { RedbookClient } from './redbook-client';
import {
  mapRedbookPage,
  mapRedbookDetail,
  RedbookMediaTransport,
} from './redbook-response';

/** No live default transport. A reviewed in-memory client and cookie-free media
 * transport must be handed in separately. Schema assumptions remain explicit.
 */
export function redbookReader(
  client: RedbookClient,
  media?: RedbookMediaTransport,
): RedbookReader {
  return {
    async list(authorId, cursor) {
      const page = mapRedbookPage(
        await client.getUserNotes(authorId, cursor ?? ''),
        authorId,
      );
      return {
        nextCursor: page.nextCursor,
        notes: page.notes.map((note) => ({
          noteId: note.noteId,
          token: note.xsecToken,
        })),
      };
    },
    detail: async (authorId, noteId, token) =>
      mapRedbookDetail(
        await client.getNoteById(noteId, token),
        authorId,
        noteId,
        media,
      ),
  };
}

/** The adapter is intentionally independent of Rnote's X-API-Key contract. */
export interface RedbookReader {
  list(
    authorId: string,
    cursor: string | null,
  ): Promise<{
    nextCursor: string | null;
    notes: { noteId: string; token: string }[];
  }>;
  detail(
    authorId: string,
    noteId: string,
    token: string,
  ): Promise<XhsSubscriptionCandidate>;
}
export interface RedbookSourceDependencies {
  reader: RedbookReader;
  store: RedbookStateStore;
  /** Supplied only after reviewed real-response evidence and explicit safe session handoff.
   * No browser/client/env flag can grant this. Offline tests use a synthetic seam.
   */
  contractReviewed: boolean;
  isComplete(creatorId: string, noteId: string): Promise<boolean>;
  /** Explicit reviewed profile binding, never infer author identity from URL. */
  authorFor?: (creator: XhsCreator) => string | null;
}
// Not an API author ID; all creators share this fail-closed source queue lane.
export const REDBOOK_QUEUE_SCOPE = JSON.stringify(['redbook', 'source-queue']);
/** Dormant by default: constructing/registering this class never enables network or creates state. */
export class RedbookSource implements XhsSource {
  readonly configured: boolean;
  private readonly cancelled = new Set<string>();
  private readonly running = new Set<string>();
  constructor(private readonly dependencies?: RedbookSourceDependencies) {
    this.configured = !!dependencies?.contractReviewed;
  }
  async read(): Promise<XhsReadResult> {
    throw new Error('REDBOOK_STREAM_REQUIRED');
  }
  async pause(creator: XhsCreator) {
    this.cancelled.add(creator.id);
    const authorId =
      creator.externalAuthorId ?? this.dependencies?.authorFor?.(creator);
    if (!this.dependencies || !authorId || this.running.has(creator.id)) return;
    await this.dependencies.store.exclusive(
      REDBOOK_QUEUE_SCOPE,
      async (queue, saveQueue) => {
        // Operator pause must never weaken an earlier upstream/uncertain stop.
        if (queue?.phase === 'paused' && queue.reason !== 'operator') return;
        await this.dependencies!.store.exclusive(
          authorId,
          async (old, save) => {
            if (old?.phase === 'paused' && old.reason !== 'operator') return;
            await save({
              ...(old ?? freshRedbookState(authorId)),
              phase: 'paused',
              reason: 'operator',
            });
          },
        );
        await saveQueue({
          ...freshRedbookState(REDBOOK_QUEUE_SCOPE),
          phase: 'paused',
          reason: 'operator',
        });
      },
    );
  }
  /** Internal operator-only checkpoint recovery, deliberately absent from the
   * browser router. Restrictions and uncertain dispatched pages cannot resume.
   */
  async resumeOperatorCheckpoint(creator: XhsCreator) {
    const authorId =
      creator.externalAuthorId ?? this.dependencies?.authorFor?.(creator);
    if (!this.dependencies || !authorId || this.running.has(creator.id))
      throw new Error('REDBOOK_RESUME_BLOCKED');
    await this.dependencies.store.exclusive(
      REDBOOK_QUEUE_SCOPE,
      async (queue, saveQueue) => {
        if (
          queue &&
          queue.phase !== 'ready' &&
          !(queue.phase === 'paused' && queue.reason === 'operator')
        )
          throw new Error('REDBOOK_RESUME_BLOCKED');
        await this.dependencies!.store.exclusive(
          authorId,
          async (state, save) => {
            if (
              !state ||
              state.phase !== 'paused' ||
              state.reason !== 'operator' ||
              state.pages >= 3 ||
              state.cursors.includes(state.nextCursor)
            )
              throw new Error('REDBOOK_RESUME_BLOCKED');
            await save({ ...state, phase: 'ready', reason: 'none' });
          },
        );
        await saveQueue(freshRedbookState(REDBOOK_QUEUE_SCOPE));
      },
    );
    this.cancelled.delete(creator.id);
  }
  async scan(
    creator: XhsCreator,
    commit: (result: XhsReadResult) => Promise<XhsRefreshResult>,
  ): Promise<XhsRefreshResult> {
    const dependencies = this.dependencies;
    const authorId =
      creator.externalAuthorId ?? dependencies?.authorFor?.(creator);
    const paused = (added = 0): XhsRefreshResult => ({
      status: 'paused',
      added,
      message: '扫描已暂停；请先核对停止原因及安全交接，不会自动重试。',
    });
    if (!dependencies?.contractReviewed || !authorId || !creator.enabled)
      return paused();
    if (this.cancelled.has(creator.id)) return paused();
    this.running.add(creator.id);
    let stopReason: RedbookScanState['reason'] = 'upstream';
    return dependencies.store
      .exclusive<XhsRefreshResult>(
        REDBOOK_QUEUE_SCOPE,
        async (queue, saveQueue) => {
          if (queue && queue.phase !== 'ready') return paused();
          try {
            const result = await dependencies.store.exclusive<XhsRefreshResult>(
              authorId,
              async (saved, save) => {
                let state = saved ?? freshRedbookState(authorId);
                if (state.authorId !== authorId)
                  throw new Error('REDBOOK_AUTHOR_CONFLICT');
                if (['requesting', 'awaiting-commit'].includes(state.phase)) {
                  state = { ...state, phase: 'paused', reason: 'interrupted' };
                  await save(state);
                }
                if (state.phase === 'paused') {
                  stopReason = state.reason;
                  return paused();
                }
                // A new manual refresh checks a fresh bounded head window. Never advance a
                // finished three-page window into deep history, even when upstream has more.
                if (state.phase === 'window-complete')
                  state = freshRedbookState(authorId);
                let added = 0;
                try {
                  while (state.pages < 3) {
                    if (this.cancelled.has(creator.id)) {
                      stopReason = 'operator';
                      await save({
                        ...state,
                        phase: 'paused',
                        reason: 'operator',
                      });
                      return paused(added);
                    }
                    const requestCursor = state.nextCursor;
                    if (state.cursors.includes(requestCursor))
                      throw new Error('REDBOOK_CURSOR_REPLAY');
                    state = {
                      ...state,
                      phase: 'requesting',
                      pages: state.pages + 1,
                      cursors: [...state.cursors, requestCursor],
                    };
                    await save(state); // Debit before dispatch. Uncertain outcomes never replay automatically.
                    const page = await dependencies.reader.list(
                      authorId,
                      requestCursor,
                    );
                    if (
                      page.notes.length > 30 ||
                      (page.nextCursor !== null &&
                        state.cursors.includes(page.nextCursor))
                    )
                      throw new Error('REDBOOK_PAGE_CONTRACT');
                    const items: XhsSubscriptionCandidate[] = [];
                    const seen = new Set(state.noteIds);
                    for (const note of page.notes) {
                      if (seen.has(note.noteId)) continue;
                      seen.add(note.noteId);
                      if (seen.size > 90)
                        throw new Error('REDBOOK_NOTE_BUDGET');
                      if (
                        await dependencies.isComplete(creator.id, note.noteId)
                      )
                        continue;
                      if (this.cancelled.has(creator.id))
                        throw new Error('REDBOOK_OPERATOR_PAUSE');
                      const detail = await dependencies.reader.detail(
                        authorId,
                        note.noteId,
                        note.token,
                      );
                      if (
                        detail.authorId !== authorId ||
                        detail.noteId !== note.noteId
                      )
                        throw new Error('REDBOOK_DETAIL_IDENTITY');
                      items.push(detail);
                    }
                    if (this.cancelled.has(creator.id))
                      throw new Error('REDBOOK_OPERATOR_PAUSE');
                    state = {
                      ...state,
                      phase: 'awaiting-commit',
                      noteIds: [...seen],
                    };
                    await save(state);
                    const result = await commit({
                      authorId,
                      evidenceVerified: true,
                      initialCursor: requestCursor,
                      pages: [
                        { requestCursor, nextCursor: page.nextCursor, items },
                      ],
                    });
                    added += result.added;
                    if (this.cancelled.has(creator.id)) {
                      stopReason = 'operator';
                      state = {
                        ...state,
                        nextCursor: page.nextCursor,
                        phase: 'paused',
                        reason: 'operator',
                      };
                      await save(state);
                      return paused(added);
                    }
                    state = {
                      ...state,
                      nextCursor: page.nextCursor,
                      phase:
                        page.nextCursor === null || state.pages === 3
                          ? 'window-complete'
                          : 'ready',
                      reason: 'none',
                    };
                    await save(state);
                    if (state.phase === 'window-complete')
                      return {
                        status:
                          page.nextCursor === null ? 'complete' : 'partial',
                        added,
                        message:
                          '本次最多三批、每批请求30条的窗口已完成；理论最多90条，不保证实得，不表示全部历史。',
                      };
                  }
                  return paused(added);
                } catch {
                  stopReason = this.cancelled.has(creator.id)
                    ? 'operator'
                    : state.phase === 'awaiting-commit'
                      ? 'commit'
                      : 'upstream';
                  await save({
                    ...state,
                    phase: 'paused',
                    reason: stopReason,
                  });
                  return paused(added);
                }
              },
            );
            if (result.status === 'paused')
              await saveQueue({
                ...freshRedbookState(REDBOOK_QUEUE_SCOPE),
                phase: 'paused',
                reason: stopReason,
              });
            return result;
          } catch (error) {
            await saveQueue({
              ...freshRedbookState(REDBOOK_QUEUE_SCOPE),
              phase: 'paused',
              reason: 'upstream',
            });
            throw error;
          }
        },
      )
      .finally(async () => {
        this.running.delete(creator.id);
        // Also cover cancellation during the last checkpoint/lock release.
        // The exclusive scan lock has been released before this runs.
        if (this.cancelled.has(creator.id)) await this.pause(creator);
      })
      .then((result) =>
        this.cancelled.has(creator.id) ? paused(result.added) : result,
      );
  }
}
