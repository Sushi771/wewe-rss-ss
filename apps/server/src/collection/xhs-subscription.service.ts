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
  capability?(): {
    sourceConfigured: boolean;
    canSubscribe: boolean;
    canRefresh: boolean;
    canDownload: boolean;
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
};
type Save = (
  creator: XhsCreator,
  noteId: string,
  destination: string,
) => Promise<{ alreadySaved: boolean; mediaComplete?: boolean }>;
type Destination = (pickToken?: string) => Promise<string>;
const active = (t: XhsSubscriptionTask) =>
  t.state === 'queued' || t.state === 'running';
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
      await this.persist(task);
    }
  }
  async resolveSubscription(input: {
    url: string;
  }): Promise<XhsSubscriptionResolution> {
    const url = subscriptionUrl(input.url);
    if (!this.source) return reject('XHS_SOURCE_UNCONFIGURED');
    let value: Awaited<ReturnType<XhsSubscriptionSource['resolve']>>;
    try {
      value = await this.source.resolve(url);
    } catch (error) {
      return reject(
        xhsPublicCode(error, 'XHS_RESOLUTION_BLOCKED'),
        xhsPublicCode(error, 'XHS_RESOLUTION_BLOCKED') +
          '：无法核实作者信息或资料结构，请检查安全连接。',
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
      (new URL(url).hostname !== 'xhslink.com' &&
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
  async subscribe(input: { resolutionId: string; groupId?: string }) {
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
  async refresh(input: { id: string }) {
    await this.creator(input.id);
    return this.enqueue('list', input.id, []);
  }
  async downloadNotes(input: {
    creatorId: string;
    noteIds: string[];
    pickToken?: string;
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
    return this.enqueue('download', input.creatorId, ids, directory);
  }
  private async persist(t: Task) {
    const json = JSON.stringify(t);
    await this.write(Buffer.byteLength(json) + 4096, (tx) =>
      this.persistIn(tx, t),
    );
  }
  private persistIn(tx: Prisma.TransactionClient, t: Task) {
    const json = JSON.stringify(t);
    return tx.$executeRaw`INSERT INTO xhs_subscription_tasks (id, creator_id, state, document, updated_at) VALUES (${t.taskId}, ${t.creatorId}, ${t.state}, ${json}, ${BigInt(Date.now())}) ON CONFLICT(id) DO UPDATE SET state=excluded.state, document=excluded.document, updated_at=excluded.updated_at`;
  }
  private async enqueue(
    kind: Task['kind'],
    creatorId: string,
    noteIds: string[],
    directory?: string,
    checkpoint?: Task,
  ) {
    if (!this.source) return reject('XHS_SOURCE_UNCONFIGURED');
    if ([...this.pending.values()].some((t) => t.creatorId === creatorId))
      return reject('XHS_TASK_CONFLICT');
    if ([...this.pending.values()].filter(active).length >= 20)
      return reject('XHS_TASK_QUEUE_FULL');
    const t: Task = {
      ...checkpoint,
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
    const t = await this.loadTask(input.taskId);
    return {
      taskId: t.taskId,
      creatorId: t.creatorId,
      kind: t.kind,
      state: t.state,
      total: t.total,
      completed: t.completed,
      skipped: t.skipped,
      failed: t.failed,
      remaining: t.remaining,
      code: t.code,
      message: t.message,
      resumable:
        !this.pending.has(t.taskId) &&
        ['cancelled', 'blocked', 'partial', 'failed'].includes(t.state),
    };
  }
  async resumeTask(input: { taskId: string; pickToken?: string }) {
    if (this.pending.has(input.taskId)) return reject('XHS_TASK_SETTLING');
    const previous = await this.loadTask(input.taskId);
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
                const note = await this.source!.detail(
                  creator.externalAuthorId!,
                  tuple[2],
                  this.controllers.get(t.taskId)?.signal,
                );
                if (!active(t)) break;
                const draft = xhsArchiveDraft(creator.externalAuthorId!, note);
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
                await this.write(Buffer.byteLength(html) + 4096, async (tx) => {
                  const currentCreator = await tx.xhsCreator.findUnique({
                    where: { id: creator.id },
                  });
                  if (
                    !currentCreator?.enabled ||
                    currentCreator.externalAuthorId !== creator.externalAuthorId
                  )
                    return reject('XHS_SUBSCRIPTION_CHANGED');
                  const current = await tx.xhsNote.findFirst({
                    where: { id, creatorId: creator.id },
                  });
                  if (!current) return reject('XHS_SELECTION_CHANGED');
                  if (current.status !== 'complete' || !current.contentHtml)
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
                });
              }
              if (!active(t)) break;
              const saved = await this.save!(creator, id, directory!);
              if (saved.mediaComplete === false)
                return reject('XHS_LOCAL_MEDIA_INCOMPLETE');
              if (saved.alreadySaved) {
                t.skipped++;
                t.items[id] = 'skipped';
              } else {
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
      }
    } catch (error) {
      if (active(t)) {
        t.state = 'blocked';
        t.code = xhsPublicCode(error, 'XHS_TASK_BLOCKED');
        t.message = '任务已停止，请检查安全连接和来源数据。';
      }
    } finally {
      await this.persist(t);
      this.pending.delete(t.taskId);
      this.controllers.delete(t.taskId);
    }
  }
  private async updateList(t: Task, creator: XhsCreator) {
    const seen = new Set(t.cursorHistory ?? []);
    const notes = new Set(t.listedIds ?? []);
    while (!t.listFinished && active(t)) {
      const cursor = t.cursor ?? null;
      if (seen.has(cursor)) throw new XhsSubscriptionError('XHS_CURSOR_CYCLE');
      const page = await this.source!.list(
        creator.externalAuthorId!,
        cursor,
        this.controllers.get(t.taskId)?.signal,
      );
      if (!active(t)) return;
      if (
        page.authorId !== creator.externalAuthorId ||
        !Array.isArray(page.notes) ||
        page.notes.length > 30 ||
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
          return checkpoint;
        },
      );
      const cancelled = !active(t);
      Object.assign(t, next);
      if (cancelled) t.state = 'cancelled';
      seen.add(cursor);
      pageIds.forEach((id) => notes.add(id));
      if (!active(t)) return;
      // Yield between pages, including synthetic immediate sources, so operators
      // can cancel a large job without waiting for enumeration to finish.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
