import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { Prisma, XhsCreator } from '@prisma/client';
import {
  XhsAuthor,
  XhsSubscriptionResolution,
  XhsSubscriptionTask,
} from '@wewe-rss/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  incrementalWrite,
  assertIncrementalTransaction,
  assertIncrementalWriteAdmission,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import {
  XhsNormalizedCandidate,
  xhsArchiveDraft,
} from './xiaohongshu-contract';
import { verifiedDownloadBody } from '../article-verified-download';
import { xhsPublicInputUrl } from './xhs-short-link';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';
import { saveXhsMetrics } from './xhs-engagement-store';
import type { XhsMetricSnapshot, XhsSavedComment } from '@wewe-rss/shared';
import type { inspectLimitedRecovery } from './xhs-limited-recovery-inspect';

export const XHS_SUBSCRIPTION_SOURCE = Symbol('XHS_SUBSCRIPTION_SOURCE');
export type XhsListedNote = {
  noteId: string;
  authorId: string;
  title: string;
  publishedAt: number;
  kind: 'image-text' | 'video';
};
/** Trusted internal adapter only. Tokens/credentials remain inside the adapter. */
export interface XhsSubscriptionSource {
  withCheckpointGroup?<T>(
    phase: 'profile' | 'list' | 'detail' | 'metrics',
    authorId: string,
    noteId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T>;
  checkpointWholeSource?(
    tx: Prisma.TransactionClient,
    collectedAt?: number,
  ): Promise<void>;

  metrics?(authorId: string, noteId?: string): Promise<XhsMetricSnapshot>;
  comments?(
    authorId: string,
    noteId: string,
    cursor: string,
    rootId?: string,
  ): Promise<{ comments: XhsSavedComment[]; nextCursor: string | null }>;
  capability?(): {
    sourceConfigured: boolean;
    canSubscribe: boolean;
    canRefresh: boolean;
    canDownload: boolean;
    canCollectComments?: boolean;
    message: string;
  };
  resolve(
    url: string,
  ): Promise<{ inputKind: 'note' | 'profile'; author: XhsAuthor }>;
  list(
    authorId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<{
    authorId: string;
    notes: XhsListedNote[];
    nextCursor: string | null;
  }>;
  detail(
    authorId: string,
    noteId: string,
    signal?: AbortSignal,
  ): Promise<XhsNormalizedCandidate>;
}
type Task = XhsSubscriptionTask & {
  noteIds: string[];
  items: Record<string, 'completed' | 'skipped' | 'failed'>;
  directory?: string;
  cursor?: string | null;
  cursorHistory?: (string | null)[];
  listedIds?: string[];
  listFinished?: boolean;
  pageLimit?: number;
  localReceipts?: Record<string, { savedAt: number; supplementStatus: string }>;
  localArchives?: Record<string, { savedAt: number }>;
  detailMetrics?: Record<string, number>;
  localFilesSaved?: number;
  localFilesReused?: number;
};
type Save = (
  creator: XhsCreator,
  noteId: string,
  destination: string,
) => Promise<{
  alreadySaved: boolean;
  mediaComplete?: boolean;
  supplement?: { status: string };
}>;
type Destination = (pickToken?: string) => Promise<string>;
const active = (t: XhsSubscriptionTask) =>
  t.state === 'queued' || t.state === 'running';
const finishedDownload = (t: Task) =>
  t.kind === 'download' &&
  t.failed === 0 &&
  t.remaining === 0 &&
  t.completed + t.skipped === t.total &&
  t.noteIds.length === t.total &&
  t.noteIds.every((id) => ['completed', 'skipped'].includes(t.items[id]));
const ahead = (saved: Task, t: Task) =>
  saved.completed + saved.skipped > t.completed + t.skipped ||
  (saved.cursorHistory?.length ?? 0) > (t.cursorHistory?.length ?? 0) ||
  (!!saved.listFinished && !t.listFinished);
const key = (id: string) => JSON.stringify(['xiaohongshu', 'note', id]);
const reject = (code: string, message = code): never => {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
};
const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
export function subscriptionUrl(raw: string) {
  try {
    return xhsPublicInputUrl(raw).href;
  } catch {
    return reject('XHS_URL_INVALID');
  }
}

@Injectable()
export class XhsSubscriptionService implements OnModuleInit {
  private resolutions = new Map<
    string,
    {
      value: Awaited<ReturnType<XhsSubscriptionSource['resolve']>>;
      expiresAt: number;
    }
  >();
  private pending = new Map<string, Task>();
  private lane = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private uncertain = new Map<string, Task>();
  private reconciling = new Map<string, Promise<void>>();
  private reserve?: Destination;
  private save?: Save;
  constructor(
    private readonly db: PrismaService,
    @Optional()
    @Inject(XHS_SUBSCRIPTION_SOURCE)
    private readonly source?: XhsSubscriptionSource,
  ) {}

  bindLocalSaver(reserve: Destination, save: Save) {
    this.reserve = reserve;
    this.save = save;
  }
  capability() {
    if (this.source?.capability) {
      const capability = this.source.capability();
      return {
        ...capability,
        canDownload: capability.canDownload && !!this.save,
      };
    }
    return {
      sourceConfigured: !!this.source,
      canSubscribe: !!this.source,
      canRefresh: !!this.source,
      canDownload: !!this.source && !!this.save,
      message: this.source
        ? '可识别作者并确认订阅；更新列表与图文下载分开执行。'
        : '尚未配置已核实的作者资料与安全连接，暂不可识别订阅或获取新笔记。',
    };
  }
  private write<T>(
    bytes: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return incrementalWrite(this.db, bytes, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return this.db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return fn(tx);
        });
      }),
    );
  }
  async onModuleInit() {
    // A single local backend owns execution. Restart never silently replays network work.
    const rows = await this.db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE state IN ('queued', 'running')`;
    for (const row of rows) {
      const task = JSON.parse(row.document) as Task;
      task.state = 'blocked';
      task.code = 'XHS_TASK_INTERRUPTED';
      task.message = '任务被中断，请重新选择剩余项目。';
      try {
        await this.persist(task);
      } catch {
        /* Expose a local receipt barrier; never start work. */
      }
    }
  }
  async resolveSubscription(
    input: {
      url: string;
    },
    options?: { fixedErrors?: boolean },
  ): Promise<XhsSubscriptionResolution> {
    const url = subscriptionUrl(input.url);
    if (!this.source) return reject('XHS_SOURCE_UNCONFIGURED');
    let value: Awaited<ReturnType<XhsSubscriptionSource['resolve']>>;
    try {
      value = await this.source.resolve(url);
    } catch (error) {
      const code = xhsPublicCode(error, 'XHS_RESOLUTION_BLOCKED');
      return reject(
        code,
        options?.fixedErrors
          ? code
          : code + '：无法核实作者信息或资料结构，请检查安全连接。',
      );
    }
    const author = value.author;
    if (
      !author ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(author.id) ||
      !author.name?.trim() ||
      author.name.length > 120 ||
      author.profileUrl !==
        `https://www.xiaohongshu.com/user/profile/${author.id}` ||
      !['profile', 'note'].includes(value.inputKind) ||
      (!['xhslink.com', 'xhslink.cn'].includes(new URL(url).hostname) &&
        value.inputKind !==
          (new URL(url).pathname.startsWith('/user/profile/')
            ? 'profile'
            : 'note'))
    )
      return reject('XHS_AUTHOR_UNVERIFIED');
    const now = Date.now();
    for (const [id, r] of this.resolutions)
      if (r.expiresAt <= now) this.resolutions.delete(id);
    if (this.resolutions.size >= 100) return reject('XHS_RESOLUTION_LIMIT');
    const resolutionId = randomUUID(),
      expiresAt = now + 10 * 60_000;
    const publicAuthor: XhsAuthor = {
      id: author.id,
      name: author.name.trim(),
      profileUrl: author.profileUrl,
      ...(author.metrics ? { metrics: author.metrics } : {}),
      ...(author.avatarUrl && /^https:\/\//.test(author.avatarUrl)
        ? { avatarUrl: author.avatarUrl }
        : {}),
    };
    this.resolutions.set(resolutionId, {
      value: { inputKind: value.inputKind, author: publicAuthor },
      expiresAt,
    });
    const existing = await this.db.xhsCreator.findFirst({
      where: {
        OR: [
          { externalAuthorId: author.id },
          { profileUrl: author.profileUrl },
        ],
      },
    });
    return {
      resolutionId,
      inputKind: value.inputKind,
      author: publicAuthor,
      existingCreatorId: existing?.id ?? null,
      expiresAt,
    };
  }
  /** Internal result only; source input and transient URLs never enter this transaction. */
  async commitLimitedRecovery(input: {
    owner: string;
    author: XhsAuthor;
    note: ReturnType<typeof inspectLimitedRecovery>;
  }) {
    const { owner, author, note } = input;
    if (
      author.id !== note.authorId ||
      author.profileUrl !==
        `https://www.xiaohongshu.com/user/profile/${author.id}` ||
      !note.text.trim()
    )
      return reject('XHS_DETAIL_INCOMPLETE');
    const noteId = key(note.noteId);
    const html = verifiedDownloadBody(
      '<div id="js_content">' +
        note.text
          .split('\n')
          .map((p) => '<p>' + esc(p) + '</p>')
          .join('') +
        '</div>',
    );
    return this.write(Buffer.byteLength(html) + 8192, async (tx) => {
      const claim = await tx.$queryRaw<
        Array<{ note_id: string; author_id: string; state: string }>
      >`
        SELECT note_id,author_id,state FROM xhs_limited_recovery
        WHERE id='single-round' AND owner=${owner}
        UNION ALL SELECT note_id,author_id,state FROM xhs_limited_recovery_append WHERE id='single-round' AND owner=${owner}`;
      if (
        claim.length !== 1 ||
        claim[0].state !== 'started' ||
        claim[0].note_id !== note.noteId ||
        claim[0].author_id !== author.id
      )
        return reject('XHS_SOURCE_RISK_REVIEW_REQUIRED');
      const oldCreator = await tx.xhsCreator.findFirst({
        where: {
          OR: [
            { externalAuthorId: author.id },
            { profileUrl: author.profileUrl },
          ],
        },
      });
      if (
        oldCreator?.externalAuthorId &&
        oldCreator.externalAuthorId !== author.id
      )
        return reject('XHS_AUTHOR_CONFLICT');
      if (oldCreator && !oldCreator.enabled)
        return reject('XHS_SUBSCRIPTION_CHANGED');
      const creator = oldCreator
        ? await tx.xhsCreator.update({
            where: { id: oldCreator.id },
            data: { externalAuthorId: author.id, lastStatus: 'subscribed' },
          })
        : await tx.xhsCreator.create({
            data: {
              id: randomUUID(),
              externalAuthorId: author.id,
              profileUrl: author.profileUrl,
              displayName: author.name,
              lastStatus: 'subscribed',
            },
          });
      const oldNote = await tx.xhsNote.findUnique({ where: { id: noteId } });
      if (oldNote && oldNote.creatorId !== creator.id)
        return reject('XHS_AUTHOR_CONFLICT');
      const retained = !!oldNote?.contentHtml;
      if (!oldNote)
        await tx.xhsNote.create({
          data: {
            id: noteId,
            creatorId: creator.id,
            title: note.title,
            publishTime: note.publishedAt,
            kind: 'image-text',
            status: 'listed',
            contentHtml: html,
          },
        });
      else if (!retained)
        await tx.xhsNote.update({
          where: { id: noteId },
          data: {
            title: note.title,
            publishTime: note.publishedAt,
            kind: 'image-text',
            status: 'listed',
            contentHtml: html,
          },
        });
      await saveXhsMetrics(tx, 'note', noteId, note.metrics);
      const manifest = JSON.stringify(note.media);
      const changed =
        await tx.$executeRaw`UPDATE xhs_limited_recovery SET state='finished',media_manifest=${manifest},updated_at=${BigInt(Date.now())}
        WHERE id='single-round' AND owner=${owner} AND state='started'`;
      const appended =
        await tx.$executeRaw`UPDATE xhs_limited_recovery_append SET state='finished',media_manifest=${manifest},updated_at=${BigInt(Date.now())} WHERE id='single-round' AND owner=${owner} AND state='started'`;
      if (changed + appended !== 1)
        return reject('XHS_SOURCE_RISK_REVIEW_REQUIRED');
      return {
        creatorId: creator.id,
        noteId,
        subscribed: true as const,
        body: retained ? ('retained' as const) : ('saved' as const),
        media: note.media.length ? ('pending' as const) : ('none' as const),
        mediaSourceEvidence: 'query-free-manifest' as const,
        mediaCount: note.media.length,
      };
    });
  }
  async subscribe(
    input: { resolutionId: string; groupId?: string },
    batchReceipt?: (
      tx: Prisma.TransactionClient,
      creatorId: string,
      authorId: string,
    ) => Promise<void>,
  ) {
    const resolution = this.resolutions.get(input.resolutionId);
    if (!resolution || resolution.expiresAt <= Date.now())
      return reject('XHS_RESOLUTION_EXPIRED');
    const { author } = resolution.value;
    return this.write(4096, async (tx) => {
      if (
        input.groupId &&
        !(await tx.managementGroup.findFirst({
          where: { id: input.groupId, platform: 'xiaohongshu' },
        }))
      )
        return reject('XHS_GROUP_INVALID');
      const old = await tx.xhsCreator.findFirst({
        where: {
          OR: [
            { externalAuthorId: author.id },
            { profileUrl: author.profileUrl },
          ],
        },
      });
      if (old?.externalAuthorId && old.externalAuthorId !== author.id)
        return reject('XHS_AUTHOR_CONFLICT');
      const creator = old
        ? await tx.xhsCreator.update({
            where: { id: old.id },
            data: {
              externalAuthorId: author.id,
              displayName: author.name,
              enabled: true,
              lastStatus: 'subscribed',
              ...(input.groupId ? { groupId: input.groupId } : {}),
            },
          })
        : await tx.xhsCreator.create({
            data: {
              id: randomUUID(),
              externalAuthorId: author.id,
              profileUrl: author.profileUrl,
              displayName: author.name,
              lastStatus: 'subscribed',
              groupId: input.groupId,
            },
          });
      await saveXhsMetrics(tx, 'creator', creator.id, author.metrics);
      if (batchReceipt) await batchReceipt(tx, creator.id, author.id);
      return {
        creatorId: creator.id,
        created: !old,
        subscribed: true as const,
      };
    });
  }
  private async creator(id: string) {
    const c = await this.db.xhsCreator.findUnique({ where: { id } });
    if (!c?.externalAuthorId || !c.enabled)
      return reject('XHS_SUBSCRIPTION_REQUIRED');
    return c;
  }
  async refresh(input: { id: string; maxPages?: number }) {
    if (
      input.maxPages !== undefined &&
      (!Number.isInteger(input.maxPages) ||
        input.maxPages < 1 ||
        input.maxPages > 10)
    )
      return reject('XHS_LIST_PAGE_LIMIT_INVALID');
    await this.creator(input.id);
    return this.enqueue(
      'list',
      input.id,
      [],
      undefined,
      undefined,
      input.maxPages,
    );
  }
  async downloadNotes(input: {
    creatorId: string;
    noteIds: string[];
    pickToken?: string;
    sameDirectoryAsTaskId?: string;
  }) {
    await this.creator(input.creatorId);
    const ids = [...new Set(input.noteIds)];
    if (!ids.length || ids.some((id) => !id || id.length > 300))
      return reject('XHS_SELECTION_INVALID');
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const count = await this.db.xhsNote.count({
        where: { creatorId: input.creatorId, id: { in: batch } },
      });
      if (count !== batch.length) return reject('XHS_SELECTION_INVALID');
    }
    if (!this.reserve || !this.save)
      return reject('XHS_LOCAL_SAVE_UNAVAILABLE');
    // Freeze the existing native picker grant before any detail/network work.
    const directory = await this.reserve(input.pickToken);
    if (input.sameDirectoryAsTaskId) {
      const previous = await this.loadTask(input.sameDirectoryAsTaskId);
      if (
        previous.kind !== 'download' ||
        previous.creatorId !== input.creatorId ||
        previous.directory !== directory
      )
        return reject('XHS_RESUME_DIRECTORY_CHANGED');
    }
    return this.enqueue('download', input.creatorId, ids, directory);
  }
  private async persist(t: Task) {
    const snapshot = JSON.parse(JSON.stringify(t)) as Task;
    const json = JSON.stringify(snapshot);
    try {
      await this.write(Buffer.byteLength(json) + 4096, (tx) =>
        this.persistIn(tx, snapshot),
      );
      this.uncertain.delete(t.taskId);
    } catch (error) {
      // An acknowledgement can fail after COMMIT. Read durable evidence before
      // classifying it; do not repeat a network request or local archive action.
      try {
        const saved = await this.loadTask(t.taskId);
        if (JSON.stringify(saved) === json) {
          this.uncertain.delete(t.taskId);
          return;
        }
        if (ahead(saved, snapshot))
          Object.assign(snapshot, saved, {
            state: 'blocked',
            code: 'XHS_TASK_RECEIPT_UNCERTAIN',
          });
      } catch {
        /* unknown durable state */
      }
      if (xhsPublicCode(error, '') === 'XHS_TASK_SUPERSEDED') throw error;
      this.uncertain.set(t.taskId, snapshot);
      throw new XhsSubscriptionError('XHS_TASK_RECEIPT_UNCERTAIN');
    }
  }
  private async persistIn(tx: Prisma.TransactionClient, t: Task) {
    const own = await tx.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${t.taskId}`;
    const saved = own.length
      ? (JSON.parse(own[0].document) as Task)
      : undefined;
    if (
      saved?.supersededByTaskId &&
      saved.supersededByTaskId !== t.supersededByTaskId
    )
      throw new XhsSubscriptionError('XHS_TASK_SUPERSEDED');
    if (saved && ahead(saved, t))
      throw new XhsSubscriptionError('XHS_TASK_RECEIPT_UNCERTAIN');
    if (t.resumedFromTaskId) {
      const rows = await tx.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${t.resumedFromTaskId}`;
      if (!rows.length) return reject('XHS_TASK_NOT_FOUND');
      const parent = JSON.parse(rows[0].document) as Task;
      if (
        parent.creatorId !== t.creatorId ||
        (parent.supersededByTaskId && parent.supersededByTaskId !== t.taskId)
      )
        throw new XhsSubscriptionError('XHS_TASK_SUPERSEDED');
      if (!parent.supersededByTaskId) {
        parent.supersededByTaskId = t.taskId;
        await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(parent)}, updated_at=${BigInt(Date.now())} WHERE id=${parent.taskId}`;
      }
    }
    // Preserve a detail receipt committed before an acknowledgement failure.
    if (saved?.detailMetrics)
      t.detailMetrics = { ...saved.detailMetrics, ...t.detailMetrics };
    const json = JSON.stringify(t);
    return tx.$executeRaw`INSERT INTO xhs_subscription_tasks (id, creator_id, state, document, updated_at) VALUES (${t.taskId}, ${t.creatorId}, ${t.state}, ${json}, ${BigInt(Date.now())}) ON CONFLICT(id) DO UPDATE SET state=excluded.state, document=excluded.document, updated_at=excluded.updated_at`;
  }
  private async enqueue(
    kind: Task['kind'],
    creatorId: string,
    noteIds: string[],
    directory?: string,
    checkpoint?: Task,
    pageLimit?: number,
  ) {
    if (!this.source) return reject('XHS_SOURCE_UNCONFIGURED');
    if ([...this.uncertain.values()].some((t) => t.creatorId === creatorId))
      return reject('XHS_TASK_RECEIPT_UNCERTAIN');
    if ([...this.pending.values()].some((t) => t.creatorId === creatorId))
      return reject('XHS_TASK_CONFLICT');
    if ([...this.pending.values()].filter(active).length >= 20)
      return reject('XHS_TASK_QUEUE_FULL');
    const t: Task = {
      ...checkpoint,
      pageLimit: pageLimit ?? checkpoint?.pageLimit,
      taskId: randomUUID(),
      creatorId,
      kind,
      state: 'queued',
      noteIds,
      items: checkpoint
        ? Object.fromEntries(
            Object.entries(checkpoint.items).filter(
              ([, state]) => state !== 'failed',
            ),
          )
        : {},
      total: checkpoint?.total ?? noteIds.length,
      completed: checkpoint?.completed ?? 0,
      skipped: checkpoint?.skipped ?? 0,
      failed: 0,
      remaining: checkpoint
        ? checkpoint.total - checkpoint.completed - checkpoint.skipped
        : noteIds.length,
      message: '等待处理',
      directory,
      code: undefined,
      resumedFromTaskId: checkpoint?.taskId,
      supersededByTaskId: undefined,
    };
    this.pending.set(t.taskId, t);
    try {
      await this.persist(t);
    } catch (e) {
      this.pending.delete(t.taskId);
      throw e;
    }
    this.lane = this.lane
      .then(() => this.run(t, directory))
      .catch(() => {
        /* persisted checkpoint remains recoverable; do not replay */
      });
    return { taskId: t.taskId, creatorId };
  }
  private async loadTask(taskId: string): Promise<Task> {
    const rows = await this.db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${taskId}`;
    if (!rows.length) return reject('XHS_TASK_NOT_FOUND');
    return JSON.parse(rows[0].document) as Task;
  }
  async task(input: { taskId: string }): Promise<XhsSubscriptionTask> {
    await this.reconcile(input.taskId);
    const t =
      this.uncertain.get(input.taskId) ?? (await this.loadTask(input.taskId));
    return this.view(t);
  }
  /** Confirmed native full-archive saves, independently of an optional interaction companion. */
  async confirmedLocalArchives(input: { taskId: string }) {
    await this.reconcile(input.taskId);
    if (this.uncertain.has(input.taskId))
      return reject('XHS_TASK_RECEIPT_UNCERTAIN');
    const task = await this.loadTask(input.taskId);
    return Object.entries(task.localArchives ?? {})
      .filter(
        ([id, receipt]) =>
          ['completed', 'skipped'].includes(task.items[id]) &&
          Number.isSafeInteger(receipt.savedAt) &&
          receipt.savedAt > 0,
      )
      .map(([noteId, receipt]) => ({
        noteId,
        ...receipt,
        ...(task.detailMetrics?.[noteId]
          ? { metricsCollectedAt: task.detailMetrics[noteId] }
          : {}),
      }));
  }
  /** Durable positive saver receipts only; cache completeness and video skips are not evidence. */
  async confirmedLocalSaves(input: { taskId: string }) {
    await this.reconcile(input.taskId);
    if (this.uncertain.has(input.taskId))
      return reject('XHS_TASK_RECEIPT_UNCERTAIN');
    const task = await this.loadTask(input.taskId);
    return Object.entries(task.localReceipts ?? {})
      .filter(
        ([id, receipt]) =>
          ['completed', 'skipped'].includes(task.items[id]) &&
          Number.isSafeInteger(receipt.savedAt) &&
          receipt.savedAt > 0 &&
          ['new', 'retained', 'conflict-version'].includes(
            receipt.supplementStatus,
          ),
      )
      .map(([noteId, receipt]) => ({ noteId, ...receipt }));
  }
  private view(t: Task): XhsSubscriptionTask {
    const uncertain = this.uncertain.has(t.taskId);
    // Only a durable, settled receipt can close an old all-finished checkpoint.
    // Counter equality alone is not proof: every selected item must be recorded.
    const reconciledComplete =
      !uncertain &&
      !this.pending.has(t.taskId) &&
      t.state === 'blocked' &&
      t.code === 'XHS_TASK_RECEIPT_UNCERTAIN' &&
      finishedDownload(t);
    const state = uncertain
      ? 'blocked'
      : reconciledComplete
        ? 'completed'
        : t.state;
    return {
      taskId: t.taskId,
      creatorId: t.creatorId,
      kind: t.kind,
      state,
      total: t.total,
      completed: t.completed,
      skipped: t.skipped,
      failed: t.failed,
      remaining: t.remaining,
      snapshotsSaved: t.snapshotsSaved,
      // Keep private receipt history, but never label a reconciled public
      // checkpoint as still uncertain: the UI correctly fences that code.
      code: uncertain
        ? 'XHS_TASK_RECEIPT_UNCERTAIN'
        : reconciledComplete
          ? undefined
          : t.code === 'XHS_TASK_RECEIPT_UNCERTAIN'
            ? 'XHS_TASK_CHECKPOINT_RECONCILED'
            : t.code,
      message: uncertain
        ? '任务回执尚未核实；未重放任何动作，请重新读取状态。'
        : reconciledComplete
          ? '处理完成'
          : t.message,
      resumedFromTaskId: t.resumedFromTaskId,
      supersededByTaskId: t.supersededByTaskId,
      resumable:
        !uncertain &&
        !t.supersededByTaskId &&
        !this.pending.has(t.taskId) &&
        (t.kind === 'list' || t.total > t.completed + t.skipped) &&
        ['cancelled', 'blocked', 'partial', 'failed'].includes(state),
    };
  }
  private async reconcile(taskId: string) {
    if (!this.uncertain.has(taskId) || this.pending.has(taskId)) return;
    const current = this.reconciling.get(taskId);
    if (current) return current;
    const work = (async () => {
      const snapshot = this.uncertain.get(taskId)!;
      try {
        const durable = await this.loadTask(taskId);
        if (durable.supersededByTaskId) {
          this.uncertain.delete(taskId);
          return;
        }
        if (JSON.stringify(durable) === JSON.stringify(snapshot)) {
          this.uncertain.delete(taskId);
          return;
        }
        if (ahead(durable, snapshot)) Object.assign(snapshot, durable);
      } catch {
        /* Receipt may not have been inserted; repair only local state. */
      }
      snapshot.state = 'blocked';
      snapshot.code = 'XHS_TASK_RECEIPT_UNCERTAIN';
      snapshot.message = '已核对本地检查点；请明确续跑，系统不会自动重放。';
      try {
        await this.persist(snapshot);
      } catch {
        /* retain the creator barrier */
      }
    })();
    this.reconciling.set(taskId, work);
    try {
      await work;
    } finally {
      this.reconciling.delete(taskId);
    }
  }
  async recentTasks(
    input: { creatorId?: string; limit?: number } = {},
  ): Promise<{ items: XhsSubscriptionTask[] }> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      return reject('XHS_TASK_LIMIT_INVALID');
    for (const t of [...this.uncertain.values()])
      if (!input.creatorId || t.creatorId === input.creatorId)
        await this.reconcile(t.taskId);
    const creatorClause = input.creatorId
      ? Prisma.sql`AND t.creator_id=${input.creatorId}`
      : Prisma.empty;
    const rows = await this.db.$queryRaw<Array<{ document: string }>>(
      Prisma.sql`SELECT t.document FROM xhs_subscription_tasks t JOIN xhs_creators c ON c.id=t.creator_id WHERE t.state IN ('queued','running','blocked','partial','cancelled','failed') ${creatorClause} AND json_extract(t.document,'$.supersededByTaskId') IS NULL ORDER BY CASE WHEN t.state IN ('queued','running') THEN 0 ELSE 1 END,t.updated_at DESC,t.id DESC LIMIT ${limit}`,
    );
    // A receipt barrier must remain discoverable even when older recoverable
    // tasks fill the requested page. Never expose its private checkpoint.
    const tasks = new Map<string, Task>();
    for (const t of this.uncertain.values())
      if (
        (!input.creatorId || t.creatorId === input.creatorId) &&
        !t.supersededByTaskId
      )
        tasks.set(t.taskId, t);
    for (const row of rows) {
      const t = JSON.parse(row.document) as Task;
      if (!tasks.has(t.taskId)) tasks.set(t.taskId, t);
    }
    return {
      items: [...tasks.values()].slice(0, limit).map((t) => this.view(t)),
    };
  }
  async resumeTask(input: { taskId: string; pickToken?: string }) {
    if (this.pending.has(input.taskId)) return reject('XHS_TASK_SETTLING');
    await this.reconcile(input.taskId);
    if (this.uncertain.has(input.taskId))
      return reject('XHS_TASK_RECEIPT_UNCERTAIN');
    const previous = await this.loadTask(input.taskId);
    if (previous.supersededByTaskId) return reject('XHS_TASK_SUPERSEDED');
    if (
      previous.kind === 'download' &&
      previous.total <= previous.completed + previous.skipped
    )
      return reject('XHS_TASK_NOT_RESUMABLE');
    if (!['cancelled', 'blocked', 'partial', 'failed'].includes(previous.state))
      return reject('XHS_TASK_NOT_RESUMABLE');
    await this.creator(previous.creatorId);
    let directory: string | undefined;
    if (previous.kind === 'download') {
      if (!this.reserve || !this.save || !previous.directory)
        return reject('XHS_LOCAL_SAVE_UNAVAILABLE');
      directory = await this.reserve(input.pickToken);
      if (directory !== previous.directory)
        return reject('XHS_RESUME_DIRECTORY_CHANGED');
    }
    return this.enqueue(
      previous.kind,
      previous.creatorId,
      previous.noteIds,
      directory,
      previous,
    );
  }
  async cancelTask(input: { taskId: string }) {
    const t = this.pending.get(input.taskId);
    if (t && active(t)) {
      t.state = 'cancelled';
      this.controllers.get(t.taskId)?.abort();
      t.message = '已取消；当前原子保存结束后停止。';
      await this.persist(t);
    }
    return this.task(input);
  }
  private async run(t: Task, directory?: string) {
    if (!active(t)) {
      this.pending.delete(t.taskId);
      return;
    }
    try {
      this.controllers.set(t.taskId, new AbortController());
      const creator = await this.creator(t.creatorId);
      if (!active(t)) return;
      t.state = 'running';
      t.message = '处理中';
      await this.persist(t);
      if (t.kind === 'list') await this.updateList(t, creator);
      else
        for (const id of t.noteIds) {
          if (!active(t)) break;
          if (t.items[id] === 'completed' || t.items[id] === 'skipped')
            continue;
          try {
            await this.creator(t.creatorId);
            const old = await this.db.xhsNote.findFirst({
              where: { id, creatorId: creator.id },
            });
            if (!old) return reject('XHS_SELECTION_CHANGED');
            if (
              old.kind === 'video' &&
              (old.status !== 'complete' || !old.contentHtml)
            ) {
              t.skipped++;
              t.items[id] = 'skipped';
            } else {
              if (old.status !== 'complete' || !old.contentHtml) {
                const tuple = JSON.parse(id);
                if (tuple[0] !== 'xiaohongshu' || tuple[1] !== 'note')
                  return reject('XHS_NOTE_ID_INVALID');
                await this.withSourceCheckpoint(
                  'detail',
                  creator.externalAuthorId!,
                  tuple[2],
                  async () => {
                    const note = await this.source!.detail(
                      creator.externalAuthorId!,
                      tuple[2],
                      this.controllers.get(t.taskId)?.signal,
                    );
                    if (!active(t)) return;
                    const draft = xhsArchiveDraft(
                      creator.externalAuthorId!,
                      note,
                    );
                    if (
                      draft.noteKey !== id ||
                      draft.status !== 'candidate' ||
                      !draft.readyForEvidenceCheck
                    )
                      return reject('XHS_DETAIL_INCOMPLETE');
                    const html = verifiedDownloadBody(
                      '<div id="js_content">' +
                        draft.text
                          .split('\n')
                          .map((p) => '<p>' + esc(p) + '</p>')
                          .join('') +
                        draft.images
                          .map(
                            (i) =>
                              '<img src="data:' +
                              i.type +
                              ';base64,' +
                              i.bytes.toString('base64') +
                              '">',
                          )
                          .join('') +
                        '</div>',
                    );
                    await this.write(
                      Buffer.byteLength(html) + 4096,
                      async (tx) => {
                        const currentCreator = await tx.xhsCreator.findUnique({
                          where: { id: creator.id },
                        });
                        if (
                          !currentCreator?.enabled ||
                          currentCreator.externalAuthorId !==
                            creator.externalAuthorId
                        )
                          return reject('XHS_SUBSCRIPTION_CHANGED');
                        const current = await tx.xhsNote.findFirst({
                          where: { id, creatorId: creator.id },
                        });
                        if (!current) return reject('XHS_SELECTION_CHANGED');
                        await saveXhsMetrics(tx, 'note', id, note.metrics);
                        if (
                          note.metrics &&
                          Number.isSafeInteger(note.metrics.collectedAt) &&
                          note.metrics.collectedAt > 0
                        ) {
                          const rows = await tx.$queryRaw<
                            Array<{ document: string }>
                          >`SELECT document FROM xhs_subscription_tasks WHERE id=${t.taskId} AND state='running'`;
                          if (rows.length !== 1)
                            return reject('XHS_TASK_CANCELLED');
                          const persisted = JSON.parse(
                            rows[0].document,
                          ) as Task;
                          if (persisted.supersededByTaskId)
                            return reject('XHS_TASK_SUPERSEDED');
                          const detailMetrics = {
                            ...persisted.detailMetrics,
                            [id]: note.metrics.collectedAt,
                          };
                          const changed =
                            await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=json_set(document,'$.detailMetrics',json(${JSON.stringify(detailMetrics)})),updated_at=${BigInt(Date.now())} WHERE id=${t.taskId} AND state='running'`;
                          if (changed !== 1)
                            return reject('XHS_TASK_CANCELLED');
                        }
                        if (
                          current.status !== 'complete' ||
                          !current.contentHtml
                        )
                          await tx.xhsNote.update({
                            where: { id },
                            data: {
                              title: draft.title,
                              publishTime: note.publishedAt,
                              contentHtml: html,
                              status: 'complete',
                              kind: 'image-text',
                            },
                          });
                        await this.source?.checkpointWholeSource?.(tx);
                      },
                    );
                    if (
                      note.metrics &&
                      Number.isSafeInteger(note.metrics.collectedAt) &&
                      note.metrics.collectedAt > 0
                    )
                      t.detailMetrics = {
                        ...t.detailMetrics,
                        [id]: note.metrics.collectedAt,
                      };
                  },
                );
              }
              if (!active(t)) break;
              const saved = await this.save!(creator, id, directory!);
              if (saved.supplement && saved.supplement.status !== 'retained')
                t.snapshotsSaved = (t.snapshotsSaved ?? 0) + 1;
              if (saved.mediaComplete === false)
                return reject('XHS_LOCAL_MEDIA_INCOMPLETE');
              // Successful native body/media publication does not require a companion.
              t.localArchives ??= {};
              t.localArchives[id] = { savedAt: Date.now() };
              if (
                saved.supplement &&
                ['new', 'retained', 'conflict-version'].includes(
                  saved.supplement.status,
                )
              ) {
                t.localReceipts ??= {};
                t.localReceipts[id] = {
                  savedAt: Date.now(),
                  supplementStatus: saved.supplement.status,
                };
              }
              if (saved.alreadySaved) {
                t.localFilesReused = (t.localFilesReused ?? 0) + 1;
                t.skipped++;
                t.items[id] = 'skipped';
              } else {
                t.localFilesSaved = (t.localFilesSaved ?? 0) + 1;
                t.completed++;
                t.items[id] = 'completed';
              }
            }
          } catch (error) {
            if (!active(t)) break;
            t.failed++;
            t.items[id] = 'failed';
            // Unknown provider failures may be authentication/verification stops.
            // Do not continue dispatching the rest of a batch after such a stop.
            t.state = t.completed || t.skipped ? 'partial' : 'blocked';
            t.code = xhsPublicCode(error, 'XHS_DOWNLOAD_BLOCKED');
            t.message = '下载已停止，请检查连接或本地保存状态。';
          }
          t.remaining = t.total - t.completed - t.skipped - t.failed;
          await this.persist(t);
        }
      if (active(t)) {
        t.state = t.failed || t.remaining ? 'partial' : 'completed';
        t.message =
          t.state === 'completed' ? '处理完成' : '部分完成，请检查剩余项目。';
        if (t.kind === 'download' && (t.localFilesSaved || t.localFilesReused))
          t.message += ` 已写入 ${t.localFilesSaved ?? 0} 篇本地文件，复用 ${t.localFilesReused ?? 0} 篇已有本地文件；已有正文和手工修改保留。`;
        if (t.snapshotsSaved)
          t.message += ` 已新增 ${t.snapshotsSaved} 份“互动与评论”快照附页；正文保留策略不变。`;
      }
    } catch (error) {
      if (active(t)) {
        // A failed last item checkpoint must not permanently turn confirmed
        // local results into a blocked task. The final persist below still has
        // to acknowledge these exact results; uncertainty continues to fence
        // the public view if that write cannot be confirmed. Never replay saves.
        const confirmedResults =
          xhsPublicCode(error, '') === 'XHS_TASK_RECEIPT_UNCERTAIN' &&
          finishedDownload(t);
        t.state = confirmedResults ? 'completed' : 'blocked';
        t.code = confirmedResults
          ? undefined
          : xhsPublicCode(error, 'XHS_TASK_BLOCKED');
        t.message = confirmedResults
          ? '处理完成'
          : '任务已停止，请检查安全连接和来源数据。';
      }
    } finally {
      try {
        await this.persist(t);
      } finally {
        this.pending.delete(t.taskId);
        this.controllers.delete(t.taskId);
      }
    }
  }
  private withSourceCheckpoint<T>(
    phase: 'profile' | 'list' | 'detail' | 'metrics',
    authorId: string,
    noteId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.source?.withCheckpointGroup
      ? this.source.withCheckpointGroup(phase, authorId, noteId, work)
      : work();
  }
  private async updateList(t: Task, creator: XhsCreator) {
    const seen = new Set(t.cursorHistory ?? []);
    const notes = new Set(t.listedIds ?? []);
    let pagesThisRun = 0;
    while (!t.listFinished && active(t)) {
      if (t.pageLimit !== undefined && pagesThisRun >= t.pageLimit)
        throw new XhsSubscriptionError('XHS_LIST_PAGE_LIMIT_REACHED');
      pagesThisRun++;
      const cursor = t.cursor ?? null;
      if (seen.has(cursor)) throw new XhsSubscriptionError('XHS_CURSOR_CYCLE');
      await this.withSourceCheckpoint(
        'list',
        creator.externalAuthorId!,
        undefined,
        async () => {
          const page = await this.source!.list(
            creator.externalAuthorId!,
            cursor,
            this.controllers.get(t.taskId)?.signal,
          );
          if (!active(t)) return;
          if (
            page.authorId !== creator.externalAuthorId ||
            !Array.isArray(page.notes) ||
            page.notes.length > 60 ||
            (page.nextCursor !== null &&
              (typeof page.nextCursor !== 'string' ||
                !page.nextCursor ||
                page.nextCursor.length > 2048))
          )
            return reject('XHS_LIST_INVALID');
          if (
            page.nextCursor !== null &&
            (page.nextCursor === cursor || seen.has(page.nextCursor))
          )
            throw new XhsSubscriptionError('XHS_CURSOR_CYCLE');
          if (!page.notes.length && page.nextCursor !== null)
            throw new XhsSubscriptionError('XHS_LIST_NO_PROGRESS');
          const pageIds = new Set<string>();
          let added = 0,
            skipped = 0;
          const next = await this.write(
            32768 + Buffer.byteLength(JSON.stringify(t)),
            async (tx) => {
              const current = await tx.xhsCreator.findUnique({
                where: { id: creator.id },
              });
              if (
                !current?.enabled ||
                current.externalAuthorId !== creator.externalAuthorId
              )
                return reject('XHS_SUBSCRIPTION_CHANGED');
              for (const n of page.notes) {
                if (
                  n.authorId !== creator.externalAuthorId ||
                  !/^[a-zA-Z0-9_-]{1,128}$/.test(n.noteId) ||
                  typeof n.title !== 'string' ||
                  n.title.length > 500 ||
                  !Number.isSafeInteger(n.publishedAt) ||
                  n.publishedAt < 0 ||
                  n.publishedAt > 2147483647 ||
                  !['image-text', 'video'].includes(n.kind)
                )
                  return reject('XHS_LIST_INVALID');
                const id = key(n.noteId);
                if (notes.has(id) || pageIds.has(id)) continue;
                pageIds.add(id);
                const old = await tx.xhsNote.findUnique({ where: { id } });
                if (old && old.creatorId !== creator.id)
                  return reject('XHS_NOTE_OWNER_CONFLICT');
                if (old) {
                  skipped++;
                  continue;
                }
                await tx.xhsNote.create({
                  data: {
                    id,
                    creatorId: creator.id,
                    title: n.title,
                    publishTime: n.publishedAt,
                    kind: n.kind,
                    status: n.kind === 'video' ? 'video-skipped' : 'listed',
                  },
                });
                added++;
              }
              if (page.nextCursor !== null && !pageIds.size)
                throw new XhsSubscriptionError('XHS_LIST_NO_PROGRESS');
              await tx.xhsCreator.update({
                where: { id: creator.id },
                data: {
                  lastCheckedAt: Math.floor(Date.now() / 1000),
                  lastStatus: page.nextCursor ? 'partial' : 'listed',
                },
              });
              const checkpoint: Task = {
                ...t,
                total: t.total + pageIds.size,
                completed: t.completed + added,
                skipped: t.skipped + skipped,
                remaining: 0,
                cursor: page.nextCursor,
                cursorHistory: [...seen, cursor],
                listedIds: [...notes, ...pageIds],
                listFinished: page.nextCursor === null,
              };
              // Page membership and continuation cursor commit together. Crashes cannot
              // advance past uncommitted metadata or erase earlier complete bodies.
              await this.persistIn(tx, checkpoint);
              await this.source?.checkpointWholeSource?.(tx);
              return checkpoint;
            },
          );
          const cancelled = !active(t);
          Object.assign(t, next);
          if (cancelled) t.state = 'cancelled';
          seen.add(cursor);
          pageIds.forEach((id) => notes.add(id));
          if (!active(t)) return;
        },
      );
      // Yield between pages, including synthetic immediate sources, so operators
      // can cancel a large job without waiting for enumeration to finish.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
