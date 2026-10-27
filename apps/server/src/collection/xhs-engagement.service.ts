import { Inject, Injectable, Optional } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  XHS_SUBSCRIPTION_SOURCE,
  XhsSubscriptionSource,
} from './xhs-subscription.service';
import {
  incrementalWrite,
  assertIncrementalTransaction,
  assertIncrementalWriteAdmission,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import {
  readCommentWindow,
  readXhsComments,
  readXhsMetrics,
  saveCommentPage,
  saveCommentWindow,
  saveXhsMetrics,
} from './xhs-engagement-store';
import { xhsPublicCode } from './xhs-subscription-errors';
import { RedbookPauseError } from './redbook-client';

const fail = (message: string): never => {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
};
@Injectable()
export class XhsEngagementService {
  private active = new Set<string>();
  constructor(
    private readonly db: PrismaService,
    @Optional()
    @Inject(XHS_SUBSCRIPTION_SOURCE)
    private readonly source?: XhsSubscriptionSource,
  ) {}
  private write<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return incrementalWrite(this.db, 2_000_000, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return this.db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return fn(tx);
        });
      }),
    );
  }
  private async target(creatorId: string, noteId?: string) {
    const creator = await this.db.xhsCreator.findUnique({
      where: { id: creatorId },
    });
    if (!creator) return fail('XHS_CREATOR_NOT_FOUND');
    let externalNote: string | undefined;
    if (noteId) {
      const note = await this.db.xhsNote.findFirst({
        where: { id: noteId, creatorId },
      });
      if (!note) return fail('XHS_NOTE_NOT_FOUND');
      const tuple = JSON.parse(note.id);
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 3 ||
        tuple[0] !== 'xiaohongshu' ||
        tuple[1] !== 'note' ||
        typeof tuple[2] !== 'string'
      )
        return fail('XHS_NOTE_ID_INVALID');
      externalNote = tuple[2];
    }
    return { creator, externalNote };
  }
  async view(input: {
    creatorId: string;
    noteId: string;
    offset?: number;
    limit?: number;
  }) {
    await this.target(input.creatorId, input.noteId);
    return this.db.$transaction(async (tx) => {
      const [metrics, creatorMetrics, comments] = await Promise.all([
        readXhsMetrics(tx, 'note'),
        readXhsMetrics(tx, 'creator'),
        readXhsComments(tx, input.noteId, input.offset, input.limit),
      ]);
      return {
        metrics: metrics.get(input.noteId) ?? null,
        creatorMetrics: creatorMetrics.get(input.creatorId) ?? null,
        ...comments,
      };
    });
  }
  async refreshMetrics(input: { creatorId: string; noteId?: string }) {
    const { creator, externalNote } = await this.target(
      input.creatorId,
      input.noteId,
    );
    if (!creator.enabled || !creator.externalAuthorId || !this.source?.metrics)
      return fail('XHS_SOURCE_UNAVAILABLE');
    const source = this.source;
    const authorId = creator.externalAuthorId;
    const lock = input.noteId ?? input.creatorId;
    if (this.active.has(lock)) return fail('XHS_ENGAGEMENT_BUSY');
    this.active.add(lock);
    try {
      const work = async () => {
        const snapshot = await source!.metrics!(authorId!, externalNote);
        await this.write(async (tx) => {
          const current = await tx.xhsCreator.findUnique({
            where: { id: creator.id },
          });
          if (
            !current?.enabled ||
            current.externalAuthorId !== creator.externalAuthorId
          )
            return fail('XHS_SUBSCRIPTION_CHANGED');
          await saveXhsMetrics(
            tx,
            input.noteId ? 'note' : 'creator',
            input.noteId ?? creator.id,
            snapshot,
          );
          await this.source?.checkpointWholeSource?.(tx, snapshot.collectedAt);
        });
        return snapshot;
      };
      return source!.withCheckpointGroup
        ? await source!.withCheckpointGroup(
            externalNote ? 'metrics' : 'profile',
            authorId!,
            externalNote,
            work,
          )
        : await work();
    } finally {
      this.active.delete(lock);
    }
  }
  /** One explicit, finite request window. No background replay on restart. */
  async collect(input: {
    creatorId: string;
    noteId: string;
    rootId?: string;
    maxPages: number;
    maxItems: number;
    restart?: boolean;
  }) {
    if (
      !Number.isInteger(input.maxPages) ||
      input.maxPages < 1 ||
      input.maxPages > 5 ||
      !Number.isInteger(input.maxItems) ||
      input.maxItems < 1 ||
      input.maxItems > 200
    )
      return fail('XHS_COMMENT_LIMIT_INVALID');
    const { creator, externalNote } = await this.target(
      input.creatorId,
      input.noteId,
    );
    if (!creator.enabled || !creator.externalAuthorId || !this.source?.comments)
      return fail('XHS_SOURCE_UNAVAILABLE');
    if (
      this.source.capability &&
      this.source.capability().canCollectComments !== true
    )
      return fail('XHS_COMMENT_COLLECTION_DISABLED');
    if (this.active.has(input.noteId)) return fail('XHS_ENGAGEMENT_BUSY');
    this.active.add(input.noteId);
    try {
      if (input.rootId) {
        const roots = await this.db.$queryRaw<
          Array<{ root_id: string | null }>
        >`
          SELECT root_id FROM xhs_saved_comments WHERE note_id=${input.noteId} AND comment_id=${input.rootId}`;
        if (roots.length !== 1 || roots[0].root_id !== null)
          return fail('XHS_COMMENT_ROOT_INVALID');
      }
      const scope = input.rootId ? `root:${input.rootId}` : 'top';
      let window = await readCommentWindow(this.db, input.noteId, scope);
      if (input.restart)
        window = {
          scope,
          nextCursor: '',
          pages: 0,
          state: 'partial',
          code: null,
          collectedAt: 0,
          cursors: [],
        };
      let received = 0;
      for (
        let page = 0;
        page < input.maxPages && window.nextCursor !== null;
        page++
      ) {
        const cursor = window.nextCursor;
        try {
          const result = await this.source.comments(
            creator.externalAuthorId,
            externalNote!,
            cursor,
            input.rootId,
          );
          if (
            result.nextCursor !== null &&
            (result.nextCursor === cursor ||
              window.cursors.includes(result.nextCursor))
          )
            throw Error('XHS_COMMENT_CURSOR_CYCLE');
          if (received + result.comments.length > input.maxItems) {
            window = {
              ...window,
              state: 'partial',
              code: 'XHS_COMMENT_ITEM_LIMIT',
              collectedAt: Date.now(),
            };
            await this.write((tx) =>
              saveCommentWindow(tx, input.noteId, window),
            );
            break;
          }
          const next = {
            ...window,
            nextCursor: result.nextCursor,
            pages: window.pages + 1,
            cursors: [...window.cursors, cursor],
            state:
              result.nextCursor === null
                ? ('returned-end' as const)
                : ('partial' as const),
            code: null,
            collectedAt: Date.now(),
          };
          if (next.cursors.length > 1000)
            throw Error('XHS_COMMENT_CURSOR_HISTORY_LIMIT');
          await this.write(async (tx) => {
            const current = await tx.xhsCreator.findUnique({
              where: { id: creator.id },
            });
            if (
              !current?.enabled ||
              current.externalAuthorId !== creator.externalAuthorId
            )
              return fail('XHS_SUBSCRIPTION_CHANGED');
            await saveCommentPage(tx, input.noteId, result.comments, next);
          });
          window = next;
          received += result.comments.length;
        } catch (error) {
          // Local persistence failure may have committed. Never label a newer
          // durable cursor failed or replay it automatically.
          const durable = await readCommentWindow(this.db, input.noteId, scope);
          if (durable.pages > window.pages)
            return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
          const code =
            error instanceof RedbookPauseError
              ? `XHS_SOURCE_${error.reason.toUpperCase()}_BLOCKED`
              : error instanceof Error &&
                  /^XHS_COMMENT_[A-Z_]+$/.test(error.message)
                ? error.message
                : xhsPublicCode(error, 'XHS_COMMENT_FETCH_FAILED');
          window = {
            ...window,
            state: 'failed',
            code,
            collectedAt: Date.now(),
          };
          await this.write((tx) => saveCommentWindow(tx, input.noteId, window));
          break;
        }
      }
      return this.view({ creatorId: input.creatorId, noteId: input.noteId });
    } finally {
      this.active.delete(input.noteId);
    }
  }
}
