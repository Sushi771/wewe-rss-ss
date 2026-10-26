import { xhsOriginalLink } from './xhs-original-link';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, XhsCreator, XhsNote } from '@prisma/client';
import {
  appendXhsPage,
  xhsArchiveDraft,
  xhsPageLedger,
  XhsNormalizedCandidate,
} from './xiaohongshu-contract';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import {
  assertIncrementalTransaction,
  assertIncrementalWriteAdmission,
  incrementalWrite,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import { buildArticleMarkdown } from '../article-export';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { articlePublicationRange, XhsNoteFilter } from '@wewe-rss/shared';
import { visibleBodyText } from '../article-body-search';
import {
  buildCompleteArticleDownload,
  verifiedDownloadBody,
} from '../article-verified-download';
import { ArticleDownloadError } from '../article-download';
import {
  XhsCreatorFilter,
  XhsMetricSnapshot,
  xhsMetricSelection,
} from '@wewe-rss/shared';
import { readXhsMetrics, readXhsComments } from './xhs-engagement-store';
import { xhsEngagementMarkdown } from './xhs-engagement-export';
import {
  withXhsLocalSnapshot,
  xhsLocalSnapshotPublisher,
} from './xhs-local-snapshot';
import {
  inspectCachedMp4,
  prepareXhsVideoDownload,
  XhsVerifiedVideoCache,
} from '../xhs-video-download';

export const XHS_SOURCE = Symbol('XHS_SOURCE');
/** Optional acquired bytes at the internal normalized seam, never browser input. */
export type XhsSubscriptionCandidate = XhsNormalizedCandidate & {
  video?: XhsVerifiedVideoCache['video'];
};
/** Internal normalized seam only. No vendor URL/auth/schema or production adapter.
 * A future adapter must establish identities and whole-body/media evidence before
 * setting evidenceVerified. Client requests cannot supply this object.
 */
export interface XhsSource {
  read(creator: XhsCreator): Promise<{
    authorId: string;
    evidenceVerified: boolean;
    pages: {
      requestCursor: string | null;
      nextCursor: string | null;
      items: XhsSubscriptionCandidate[];
    }[];
  }>;
}
const fail = (
  message: string,
  code:
    | 'PRECONDITION_FAILED'
    | 'CONFLICT'
    | 'NOT_FOUND'
    | 'BAD_REQUEST' = 'PRECONDITION_FAILED',
): never => {
  throw new TRPCError({ code, message });
};
const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function cachedVideoMetadata(
  note: Pick<
    XhsNote,
    'kind' | 'status' | 'videoMimeType' | 'videoExpectedBytes' | 'videoSha256'
  >,
) {
  return note.kind === 'video' &&
    note.status === 'complete' &&
    note.videoMimeType === 'video/mp4' &&
    Number.isSafeInteger(note.videoExpectedBytes) &&
    note.videoExpectedBytes! > 0 &&
    note.videoExpectedBytes! <= 100_000_000 &&
    /^[a-f0-9]{64}$/.test(note.videoSha256 || '')
    ? {
        mimeType: 'video/mp4' as const,
        bytes: note.videoExpectedBytes!,
        sha256: note.videoSha256!,
        containerVerified: true as const,
        decoded: false as const,
      }
    : null;
}
const cachedNoteMetadataSelect = {
  id: true,
  creatorId: true,
  title: true,
  publishTime: true,
  status: true,
  kind: true,
  videoMimeType: true,
  videoExpectedBytes: true,
  videoSha256: true,
} satisfies Prisma.XhsNoteSelect;

/** Literal visible-text search, shared by cache listing and ZIP selection. */
export function xhsNoteMatchesSearch(
  note: { title: string; creatorName: string; contentHtml?: string | null },
  search?: string | null,
) {
  const term = (search ?? '').trim().toLowerCase();
  return (
    !term ||
    note.title.toLowerCase().includes(term) ||
    note.creatorName.toLowerCase().includes(term) ||
    visibleBodyText(note.contentHtml ?? null)
      .toLowerCase()
      .includes(term)
  );
}

type ManagementPlatform = 'wechat' | 'xiaohongshu';
// Shared process lock protects both platform namespaces while checking membership.
// SQLite transactions and restrictive foreign keys protect committed state.
let managementMutationActive = false;
async function mutateManagement<T>(action: () => Promise<T>) {
  if (managementMutationActive)
    return fail('分组正在修改，请等待完成。', 'CONFLICT');
  managementMutationActive = true;
  try {
    return await action();
  } finally {
    managementMutationActive = false;
  }
}
/** Ordinary classification edits share PR39's admission and durable transaction. */
function mutateManagementIncremental<T>(
  db: PrismaService,
  expectedBytes: number,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return mutateManagement(() =>
    incrementalWrite(db, expectedBytes, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return action(tx);
        });
      }),
    ),
  );
}
export function managementMemberIds(ids: string[], maxIdLength = 128) {
  if (
    !ids.length ||
    ids.length > 100 ||
    ids.some((id) => !id || id.length > maxIdLength)
  )
    return fail('每次请选择 1–100 个有效条目。', 'BAD_REQUEST');
  return [...new Set(ids)];
}
async function getManagementGroup(
  db: Prisma.TransactionClient,
  platform: ManagementPlatform,
  id: string,
) {
  const group = await db.managementGroup.findFirst({ where: { id, platform } });
  if (!group) return fail('找不到该平台的分组。', 'NOT_FOUND');
  return group;
}
export async function managementGroups(
  db: PrismaService,
  platform: ManagementPlatform,
) {
  return {
    platform,
    items: await db.managementGroup.findMany({
      where: { platform },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    }),
  };
}
export async function saveManagementGroup(
  db: PrismaService,
  platform: ManagementPlatform,
  input: { id?: string; name: string },
) {
  const name = input.name.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
    return fail('分组名称须为 1–80 个字符，不能含控制字符。', 'BAD_REQUEST');
  return mutateManagementIncremental(
    db,
    Buffer.byteLength(name, 'utf8') + 4096,
    async (tx) => {
      if (input.id) {
        await getManagementGroup(tx, platform, input.id);
        return tx.managementGroup.update({
          where: { id: input.id },
          data: { name },
        });
      }
      return tx.managementGroup.create({
        data: {
          id: randomUUID(),
          name,
          platform,
          order:
            ((
              await tx.managementGroup.aggregate({
                where: { platform },
                _max: { order: true },
              })
            )._max.order ?? -1) + 1,
        },
      });
    },
  );
}
/** Compare the saved order inside the transaction; stale clients cannot overwrite it. */
export async function reorderManagementGroups(
  db: PrismaService,
  platform: ManagementPlatform,
  input: { ids: string[]; expectedIds: string[] },
) {
  if (
    !input.ids.length ||
    input.ids.length > 1000 ||
    new Set(input.ids).size !== input.ids.length ||
    new Set(input.expectedIds).size !== input.expectedIds.length ||
    input.ids.length !== input.expectedIds.length ||
    input.ids.some(
      (id) => !id || id.length > 128 || !input.expectedIds.includes(id),
    )
  )
    return fail('分组排序必须包含完整且不重复的 ID。', 'BAD_REQUEST');
  return mutateManagementIncremental(
    db,
    Buffer.byteLength(JSON.stringify(input), 'utf8'),
    async (tx) => {
      const saved = await tx.managementGroup.findMany({
        where: { platform },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      });
      if (
        saved.length !== input.ids.length ||
        saved.some((g) => !input.ids.includes(g.id))
      )
        return fail('分组集合已变化，请重新读取后排序。', 'CONFLICT');
      if (saved.some((g, i) => g.id !== input.expectedIds[i]))
        return fail('分组顺序已变化，请重新读取后排序。', 'CONFLICT');
      for (const [order, id] of input.ids.entries())
        await tx.managementGroup.update({ where: { id }, data: { order } });
      return { ids: input.ids };
    },
  );
}

/** Feed sorting only writes the complete membership of one group, preserving other groups. */
export async function reorderManagementFeeds(
  db: PrismaService,
  input: {
    id: string;
    order: number;
    expectedOrder?: number;
    expectedGroupId?: string | null;
  }[],
) {
  if (
    !input.length ||
    new Set(input.map((f) => f.id)).size !== input.length ||
    input.some((f) => !Number.isSafeInteger(f.order) || f.order < 0)
  )
    return fail('公众号排序 ID 或顺序无效。', 'BAD_REQUEST');
  return mutateManagementIncremental(
    db,
    Buffer.byteLength(JSON.stringify(input), 'utf8'),
    async (tx) => {
      const rows = await tx.feed.findMany({
        where: { id: { in: input.map((f) => f.id) } },
      });
      if (rows.length !== input.length)
        return fail('公众号不存在。', 'NOT_FOUND');
      const groupId = rows[0].groupId;
      if (
        input.some(
          (item) =>
            item.expectedGroupId !== undefined &&
            item.expectedGroupId !== groupId,
        )
      )
        return fail('公众号归属已变化，请重新读取后排序。', 'CONFLICT');
      if (
        rows.some((f) => f.groupId !== groupId) ||
        (await tx.feed.count({ where: { groupId } })) !== rows.length
      )
        return fail(
          '仅可排序同一分组的完整公众号列表，请重新读取。',
          'CONFLICT',
        );
      if (
        input.some(
          (item) =>
            item.expectedOrder !== undefined &&
            rows.find((row) => row.id === item.id)?.order !==
              item.expectedOrder,
        )
      )
        return fail('公众号顺序已变化，请重新读取后排序。', 'CONFLICT');
      for (const { id, order } of input)
        await tx.$executeRaw(
          Prisma.sql`UPDATE feeds SET "order" = ${order} WHERE id = ${id}`,
        );
      return true;
    },
  );
}

export async function removeManagementGroup(
  db: PrismaService,
  platform: ManagementPlatform,
  id: string,
) {
  return mutateManagement(async () => {
    await createVerifiedSqliteBackup();
    return db.$transaction(async (tx) => {
      await getManagementGroup(tx, platform, id);
      if (
        (await tx.feed.count({ where: { groupId: id } })) ||
        (await tx.xhsCreator.count({ where: { groupId: id } }))
      )
        return fail('分组仍有条目，请先移动后再删除。', 'CONFLICT');
      await tx.managementGroup.delete({ where: { id } });
      return { removed: true as const };
    });
  });
}
export async function moveManagementMembers(
  db: PrismaService,
  platform: ManagementPlatform,
  ids: string[],
  groupId: string | null,
) {
  const unique = managementMemberIds(ids);
  return mutateManagementIncremental(
    db,
    Buffer.byteLength(JSON.stringify({ ids: unique, groupId }), 'utf8'),
    async (tx) => {
      if (groupId !== null) await getManagementGroup(tx, platform, groupId);
      const where = { id: { in: unique } };
      const count =
        platform === 'wechat'
          ? await tx.feed.count({ where })
          : await tx.xhsCreator.count({ where });
      if (count !== unique.length)
        return fail('选中条目不存在或不属于该平台，未移动。', 'NOT_FOUND');
      if (platform === 'wechat')
        // Folder changes must not rewrite upstream metadata or its updated_at.
        await tx.$executeRaw(
          Prisma.sql`UPDATE feeds SET group_id = ${groupId} WHERE id IN (${Prisma.join(unique)})`,
        );
      else await tx.xhsCreator.updateMany({ where, data: { groupId } });
      return { moved: unique.length, ids: unique, groupId };
    },
  );
}

/** Store the supplied public page as a pending link, never derive a trusted ID. */
export function xhsProfileLink(raw: string) {
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.xiaohongshu.com' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname === '/' ||
      /[\\\s\x00-\x1f]/.test(raw)
    )
      throw new Error();
    return url.href;
  } catch {
    return fail(
      '请填写不含登录参数的 HTTPS 小红书公开主页链接。',
      'BAD_REQUEST',
    );
  }
}

@Injectable()
export class XiaohongshuService {
  private readonly active = new Set<string>();
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(XHS_SOURCE) private readonly source?: XhsSource,
  ) {}
  capability() {
    return {
      platform: 'xiaohongshu' as const,
      sourceConfigured: !!this.source,
      canRefresh: !!this.source,
      message: this.source
        ? '来源已注册，更新仍须核验真实身份及完整图文。'
        : '待接入数据源；可以管理待接入博主，尚不能读取新笔记。',
    };
  }
  async list(input?: XhsCreatorFilter) {
    if (typeof input?.groupId === 'string')
      await getManagementGroup(this.prisma, 'xiaohongshu', input.groupId);
    const metrics = await readXhsMetrics(this.prisma, 'creator');
    const items = await this.prisma.xhsCreator.findMany({
      where: input?.groupId === undefined ? {} : { groupId: input.groupId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { notes: true } } },
    });
    return {
      platform: 'xiaohongshu' as const,
      items: xhsMetricSelection(
        items.map((c) => ({ ...c, metrics: metrics.get(c.id) ?? null })),
        input,
      ),
    };
  }
  groups() {
    return managementGroups(this.prisma, 'xiaohongshu');
  }
  saveGroup(input: { id?: string; name: string }) {
    return saveManagementGroup(this.prisma, 'xiaohongshu', input);
  }
  removeGroup(id: string) {
    return removeManagementGroup(this.prisma, 'xiaohongshu', id);
  }
  async moveCreators(ids: string[], groupId: string | null) {
    const unique = managementMemberIds(ids);
    if (unique.some((id) => this.active.has(id)))
      return fail('博主正在处理，请等待完成后移动。', 'CONFLICT');
    unique.forEach((id) => this.active.add(id));
    try {
      return await moveManagementMembers(
        this.prisma,
        'xiaohongshu',
        unique,
        groupId,
      );
    } finally {
      unique.forEach((id) => this.active.delete(id));
    }
  }
  async add(displayName: string, raw: string) {
    const profileUrl = xhsProfileLink(raw),
      name = displayName.trim();
    if (!name || name.length > 120)
      return fail('请填写博主备注名称。', 'BAD_REQUEST');
    const old = await this.prisma.xhsCreator.findUnique({
      where: { profileUrl },
    });
    if (old)
      return {
        created: false,
        subscribed: false,
        creator: old,
        message: '此主页已在待接入列表中。',
      };
    const proposedId = randomUUID();
    const creator = await incrementalWrite(this.prisma, 4096, () =>
      this.prisma.$transaction(async (tx) => {
        await assertIncrementalTransaction(tx);
        return tx.xhsCreator.upsert({
          where: { profileUrl },
          create: { id: proposedId, profileUrl, displayName: name },
          update: {},
        });
      }),
    );
    return {
      created: creator.id === proposedId,
      subscribed: false,
      creator,
      message: '已保存待接入博主；尚未建立上游订阅或读取笔记。',
    };
  }
  async edit(id: string, enabled: boolean) {
    if (this.active.has(id))
      return fail('更新处理中，请等待结束后再修改。', 'CONFLICT');
    this.active.add(id);
    try {
      await this.getCreator(id);
      return await incrementalWrite(this.prisma, 4096, () =>
        this.prisma.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return tx.xhsCreator.update({ where: { id }, data: { enabled } });
        }),
      );
    } finally {
      this.active.delete(id);
    }
  }
  async remove(id: string) {
    if (this.active.has(id))
      return fail('更新处理中，请等待结束后再移除。', 'CONFLICT');
    this.active.add(id);
    try {
      const creator = await this.getCreator(id);
      if (await this.prisma.xhsNote.count({ where: { creatorId: id } }))
        return fail('此博主已有本地归档，请使用暂停保留内容。');
      await createVerifiedSqliteBackup();
      await this.prisma.xhsCreator.delete({ where: { id: creator.id } });
      return { removed: true };
    } finally {
      this.active.delete(id);
    }
  }
  private async getCreator(id: string) {
    const c = await this.prisma.xhsCreator.findUnique({ where: { id } });
    if (!c) return fail('找不到该博主。', 'NOT_FOUND');
    return c;
  }
  private async matchingNotes(
    creatorId?: string,
    filter?: XhsNoteFilter,
    completeOnly = false,
    selected?: string[],
  ) {
    creatorId ??= filter?.creatorId;
    if (creatorId) await this.getCreator(creatorId);
    if (typeof filter?.groupId === 'string')
      await getManagementGroup(this.prisma, 'xiaohongshu', filter.groupId);
    const candidates = await this.prisma.xhsNote.findMany({
      where: {
        ...(creatorId ? { creatorId } : {}),
        ...(filter?.groupId !== undefined
          ? { creator: { groupId: filter.groupId } }
          : {}),
        ...(completeOnly ? { status: 'complete' } : {}),
        ...(selected ? { id: { in: selected } } : {}),
        ...(filter ? { publishTime: articlePublicationRange(filter) } : {}),
      },
      orderBy: [{ publishTime: 'desc' }, { id: 'asc' }],
      select: {
        ...cachedNoteMetadataSelect,
        creator: { select: { displayName: true, groupId: true } },
      },
    });
    const matched: typeof candidates = [];
    for (const note of candidates) {
      const metadata = {
        title: note.title,
        creatorName: note.creator.displayName,
      };
      if (xhsNoteMatchesSearch(metadata, filter?.search)) {
        matched.push(note);
        continue;
      }
      // Decode one body at a time; do not materialize all inline image payloads
      // together or build another cache/index merely to support literal search.
      const body = await this.prisma.xhsNote.findFirst({
        where: { id: note.id, creatorId: note.creatorId },
        select: { contentHtml: true },
      });
      if (
        body &&
        xhsNoteMatchesSearch(
          { ...metadata, contentHtml: body.contentHtml },
          filter?.search,
        )
      )
        matched.push(note);
    }
    const metrics = await readXhsMetrics(this.prisma, 'note');
    return xhsMetricSelection(
      matched.map((n) => ({ ...n, metrics: metrics.get(n.id) ?? null })),
      filter,
    );
  }
  async notes(creatorId?: string, filter?: XhsNoteFilter) {
    const notes = await this.matchingNotes(creatorId, filter);
    const queryVersion = this.noteQueryVersion(notes);
    if (
      (filter?.offset && !filter.queryVersion) ||
      (filter?.queryVersion && filter.queryVersion !== queryVersion)
    )
      return fail('XHS_QUERY_STALE_RESTART', 'CONFLICT');
    return {
      queryVersion,
      platform: 'xiaohongshu' as const,
      total: notes.length,
      items: notes
        .slice(
          filter?.offset ?? 0,
          filter?.limit === undefined
            ? undefined
            : (filter.offset ?? 0) + filter.limit,
        )
        .map((note) => ({
          id: note.id,
          creatorId: note.creatorId,
          creatorName: note.creator.displayName,
          groupId: note.creator.groupId,
          title: note.title,
          publishTime: note.publishTime,
          status: note.status,
          kind:
            note.kind === 'video'
              ? ('video' as const)
              : ('image-text' as const),
          video: cachedVideoMetadata(note),
          metrics: note.metrics,
        })),
    };
  }
  private noteQueryVersion(
    rows: Array<{
      id: string;
      title: string;
      status: string;
      publishTime: number;
      metrics: XhsMetricSnapshot | null;
    }>,
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify(
          rows.map((n) => [n.id, n.title, n.status, n.publishTime, n.metrics]),
        ),
      )
      .digest('hex');
  }
  async refresh(id: string) {
    if (this.active.has(id))
      return fail('该博主正在处理，不会重复发送请求。', 'CONFLICT');
    this.active.add(id);
    try {
      const creator = await this.getCreator(id);
      if (!creator.enabled)
        return {
          status: 'paused' as const,
          added: 0,
          message: '博主已暂停，未请求数据源。',
        };
      if (!this.source)
        return {
          status: 'unconfigured' as const,
          added: 0,
          message: this.capability().message,
        };
      const result = await this.source.read(creator);
      if (
        !result.evidenceVerified ||
        (creator.externalAuthorId &&
          creator.externalAuthorId !== result.authorId)
      )
        return fail('来源身份或完整图文证据未通过，旧归档保留。');
      let ledger = xhsPageLedger(result.authorId);
      const drafts = new Map<
        string,
        {
          draft: ReturnType<typeof xhsArchiveDraft>;
          video: XhsVerifiedVideoCache['video'] | null;
          kind: 'image-text' | 'video';
        }
      >();
      const timestamps = new Map<string, number>();
      for (const page of result.pages) {
        ledger = appendXhsPage(
          ledger,
          { authorId: result.authorId, ...page },
          3,
        ).ledger;
        for (const item of page.items) {
          if (item.video && !Buffer.isBuffer(item.video.bytes))
            return fail('视频缓存须为已取得的完整字节，旧缓存保持不变。');
          const video =
            item.kind === 'video' && item.video
              ? { ...item.video, bytes: Buffer.from(item.video.bytes) }
              : null;
          const draft = xhsArchiveDraft(
            result.authorId,
            video ? { ...item, kind: 'image-text' } : item,
          );
          if (video) {
            // Reuse the single-note byte/identity/text/cover/hash/container gate.
            prepareXhsVideoDownload({
              evidenceVerified: result.evidenceVerified,
              note: item,
              video,
            });
          } else if (item.video)
            return fail('视频缓存与笔记类型不一致，旧缓存保持不变。');
          if (
            draft.status === 'candidate' &&
            !draft.readyForEvidenceCheck &&
            !video
          )
            return fail('全文或图片缓存未通过核查，旧归档保持不变。');
          const previous = drafts.get(draft.noteKey);
          if (!previous || (previous.draft.status === 'video-skipped' && video))
            drafts.set(draft.noteKey, { draft, video, kind: item.kind });
          if (!timestamps.has(draft.noteKey))
            timestamps.set(draft.noteKey, item.publishedAt);
        }
      }
      if (!result.pages.length) return fail('未收到可核验列表，旧归档保留。');
      const expectedBytes = [...drafts.values()].reduce(
        (bytes, { draft, video }) =>
          bytes +
          Buffer.byteLength(JSON.stringify({ ...draft, images: undefined })) +
          (draft.images || []).reduce(
            (sum, image) => sum + image.bytes.length * 2,
            0,
          ) +
          (video?.bytes.length || 0),
        4096,
      );
      const added = await incrementalWrite(this.prisma, expectedBytes, () =>
        this.prisma.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          const current = await tx.xhsCreator.findUniqueOrThrow({
            where: { id },
          });
          if (
            !current.enabled ||
            current.profileUrl !== creator.profileUrl ||
            current.externalAuthorId !== creator.externalAuthorId
          )
            return fail('博主身份或启用状态已变化，旧归档保留。', 'CONFLICT');
          let count = 0;
          for (const { draft: d, video, kind } of drafts.values()) {
            const old = await tx.xhsNote.findUnique({
              where: { id: d.noteKey },
            });
            if (old) {
              if (old.creatorId !== id)
                return fail('笔记归属冲突，未覆盖旧内容。', 'CONFLICT');
              if (old.status !== 'video-skipped' || !video) continue;
            }
            const contentHtml =
              d.status === 'candidate'
                ? '<div id="js_content">' +
                  d.text
                    .split('\n')
                    .map((p) => '<p>' + escape(p) + '</p>')
                    .join('') +
                  d.images
                    .map(
                      (i) =>
                        '<img src="data:' +
                        i.type +
                        ';base64,' +
                        i.bytes.toString('base64') +
                        '">',
                    )
                    .join('') +
                  // The shared video contract allows a real complete video with
                  // no caption/cover. Mark this local-only structural placeholder;
                  // title survives the unchanged sanitizer's attribute allowlist.
                  (video && !d.text.trim() && !d.images.length
                    ? '<p data-wewe-empty-video-caption title="wewe-empty-video-caption">本条视频没有正文文字。</p>'
                    : '') +
                  '</div>'
                : null;
            const data = {
              title:
                d.status === 'candidate' ? d.title : '视频笔记（未归档视频）',
              status: d.status === 'candidate' ? 'complete' : 'video-skipped',
              contentHtml,
              kind,
              videoBytes: video?.bytes ?? null,
              videoMimeType: video?.mimeType ?? null,
              videoExpectedBytes: video?.expectedBytes ?? null,
              videoSha256: video?.sha256 ?? null,
            };
            if (old) {
              // Only a skipped video's missing archive may be filled. Keep its
              // stable ID, creator relation, and previously trusted publication time.
              await tx.xhsNote.update({ where: { id: old.id }, data });
            } else {
              await tx.xhsNote.create({
                data: {
                  id: d.noteKey,
                  creatorId: id,
                  publishTime: timestamps.get(d.noteKey)!,
                  ...data,
                },
              });
            }
            if (d.status === 'candidate') count++;
          }
          await tx.xhsCreator.update({
            where: { id },
            data: {
              externalAuthorId: result.authorId,
              lastStatus: ledger.supplierReportedEnd ? 'complete' : 'partial',
              lastCheckedAt: Math.floor(Date.now() / 1000),
            },
          });
          return count;
        }),
      );
      return {
        status: ledger.supplierReportedEnd
          ? ('complete' as const)
          : ('partial' as const),
        added,
        message: ledger.supplierReportedEnd
          ? '本次来源列表窗口处理完成；不表示全历史覆盖。'
          : '已处理有限窗口，后续列表尚未完成。',
      };
    } catch {
      return fail('本次更新未完成，请核对数据源；旧归档保留，不会自动重试。');
    } finally {
      this.active.delete(id);
    }
  }
  async engagement(input: {
    creatorId: string;
    noteId: string;
    offset?: number;
    limit?: number;
  }) {
    const note = await this.prisma.xhsNote.findFirst({
      where: { id: input.noteId, creatorId: input.creatorId },
      select: { id: true },
    });
    if (!note) return fail('XHS_NOTE_NOT_FOUND', 'NOT_FOUND');
    return this.prisma.$transaction(async (tx) => {
      const [metrics, creators, comments] = await Promise.all([
        readXhsMetrics(tx, 'note'),
        readXhsMetrics(tx, 'creator'),
        readXhsComments(tx, input.noteId, input.offset, input.limit),
      ]);
      return {
        metrics: metrics.get(input.noteId) ?? null,
        creatorMetrics: creators.get(input.creatorId) ?? null,
        ...comments,
      };
    });
  }
  private async exportEngagement(
    creatorId: string,
    noteId: string,
    metrics?: XhsMetricSnapshot | null,
  ) {
    const initial = await this.engagement({ creatorId, noteId, limit: 200 });
    if (initial.totalSaved <= initial.returned) {
      const markdown = xhsEngagementMarkdown(
        metrics === undefined ? initial : { ...initial, metrics },
      );
      if (Buffer.byteLength(markdown) <= 4_000_000) return markdown;
    }
    return this.prisma.$transaction(
      async (tx) => {
        const target = await tx.xhsNote.findFirst({
          where: { id: noteId, creatorId },
          select: { id: true },
        });
        if (!target) return fail('XHS_NOTE_NOT_FOUND');
        const noteMetrics = await readXhsMetrics(tx, 'note');
        const creatorMetrics = await readXhsMetrics(tx, 'creator');
        const first = await readXhsComments(tx, noteId, 0, 200);
        const parts: string[] = [];
        let current = '',
          currentBytes = 0;
        for (
          let offset = 0;
          offset < Math.max(1, first.totalSaved);
          offset += 200
        ) {
          const page =
            offset === 0
              ? first
              : await readXhsComments(tx, noteId, offset, 200);
          const markdown = xhsEngagementMarkdown({
            ...page,
            metrics:
              metrics === undefined
                ? (noteMetrics.get(noteId) ?? null)
                : metrics,
            creatorMetrics: creatorMetrics.get(creatorId) ?? null,
          });
          for (const line of markdown.split(/(?<=\n)/)) {
            const lineBytes = Buffer.byteLength(line);
            if (current && currentBytes + lineBytes > 4_000_000) {
              parts.push(current);
              current = '';
              currentBytes = 0;
            }
            current += line;
            currentBytes += lineBytes;
          }
        }
        if (current) parts.push(current);
        return parts.length <= 1
          ? (parts[0] ?? '')
          : parts.map(
              (part, index) =>
                `\n\n## 评论分段 ${index + 1}/${parts.length}\n\n仅为已保存范围，未返回与受限内容未知。\n` +
                part,
            );
      },
      { timeout: 30000 },
    );
  }
  async export(creatorId?: string, noteIds?: string[], filter?: XhsNoteFilter) {
    const selected =
      noteIds === undefined ? undefined : managementMemberIds(noteIds, 300);
    const scope = await this.matchingNotes(creatorId, filter);
    if (
      filter?.queryVersion &&
      filter.queryVersion !== this.noteQueryVersion(scope)
    )
      return fail('XHS_QUERY_STALE_RESTART', 'CONFLICT');
    const selectedSet = selected ? new Set(selected) : undefined;
    const matched = scope.filter(
      (n) => n.status === 'complete' && (!selectedSet || selectedSet.has(n.id)),
    );
    const selectedMetrics = new Map(matched.map((n) => [n.id, n.metrics]));
    matched.sort(
      (a, b) =>
        a.publishTime - b.publishTime ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    if (selected && matched.length !== selected.length)
      return fail('所选笔记不完整或不属于当前筛选范围。', 'BAD_REQUEST');
    if (!matched.length) return fail('当前范围没有匹配的完整缓存笔记。');
    const notes: Array<
      Prisma.XhsNoteGetPayload<{
        select: typeof cachedNoteMetadataSelect & { contentHtml: true };
      }>
    > = [];
    let archiveBytes = 0;
    for (const match of matched) {
      const note = await this.prisma.xhsNote.findFirst({
        where: { id: match.id, creatorId: match.creatorId, status: 'complete' },
        select: { ...cachedNoteMetadataSelect, contentHtml: true },
      });
      if (!note)
        return fail('导出期间笔记身份或缓存已变化，请重新读取。', 'CONFLICT');
      const video = cachedVideoMetadata(note);
      if (note.kind === 'video' && !video)
        return fail('视频缓存元数据不完整，未打包。');
      archiveBytes +=
        Buffer.byteLength(note.contentHtml || '') + (video?.bytes || 0);
      if (archiveBytes > 25_000_000)
        return fail('归档超过当前下载的大小限制，未生成截断内容。');
      notes.push(note);
    }

    // Reuse cached-only original Markdown/image export and ZIP packaging. Never
    // request a signed CDN URL or pass an XHS ID to the WeChat download route.
    const root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-xhs-export-'));
    try {
      const folder = path.join(root, 'archive');
      await fs.mkdir(folder);
      for (const note of notes) {
        if (!note.contentHtml) return fail('归档正文缺失，下载未完成。');
        if (note.kind === 'video') {
          const directory = path.join(
            folder,
            createHash('sha256').update(note.id).digest('hex').slice(0, 24),
          );
          const prepare = await this.prepareLocalDownload(
            note.creatorId,
            note.id,
            selectedMetrics.get(note.id),
          );
          await fs.mkdir(directory);
          await prepare(directory);
          await fs.rename(
            path.join(directory, 'index.md'),
            path.join(directory, '正文.md'),
          );
          await prepare.afterSave?.({
            directory,
            markdownPath: path.join(directory, '正文.md'),
          });
          continue;
        }
        const result = await buildArticleMarkdown(
          { ...note, sourceUrl: null, lastBodyStatus: null, metrics: null },
          '',
          folder,
          async () => {
            throw new Error('NETWORK_FORBIDDEN');
          },
        );
        const filename =
          createHash('sha256').update(note.id).digest('hex').slice(0, 24) +
          '.md';
        const snapshot = await this.exportEngagement(
          note.creatorId,
          note.id,
          selectedMetrics.get(note.id),
        );
        await fs.writeFile(
          path.join(folder, filename),
          '# ' +
            note.title.replace(/[\r\n]/g, ' ') +
            '\n\n[原文](' +
            xhsOriginalLink(note.id) +
            ')\n\n' +
            result.markdown +
            (Array.isArray(snapshot)
              ? '\n\n评论分段见同目录附页。\n'
              : snapshot),
        );
        await xhsLocalSnapshotPublisher(
          note.id,
          note.title,
          snapshot,
        )?.({
          directory: folder,
          markdownPath: path.join(folder, filename),
        });
      }
      const zip = path.join(root, 'archive.zip');
      const { archiveDirectory } = await import('../offline-archive');
      await archiveDirectory(folder, zip);
      return {
        filename: '小红书归档.zip',
        mimeType: 'application/zip' as const,
        base64: (await fs.readFile(zip)).toString('base64'),
        notes: notes.length,
      };
    } finally {
      if (
        path.dirname(root) === tmpdir() &&
        path.basename(root).startsWith('wewe-xhs-export-')
      )
        await fs.rm(root, { recursive: true, force: true });
    }
  }
  /** Snapshot only this creator's complete cached note, never accept page content
   * or a path from the caller. Original local saver grants the destination.
   */
  async prepareLocalDownload(
    creatorId: string,
    noteId: string,
    metrics?: XhsMetricSnapshot | null,
  ) {
    const note = await this.prisma.xhsNote.findFirst({
      where: { id: noteId, creatorId, status: 'complete' },
    });
    if (!note?.contentHtml)
      throw new ArticleDownloadError(
        '此笔记没有已核验完整正文和图片，未保存。',
        422,
        { code: 'XHS_CACHED_ARTICLE_UNAVAILABLE' },
      );
    xhsOriginalLink(note.id);
    if (note.kind === 'video') {
      const creator = await this.getCreator(creatorId);
      const metadata = cachedVideoMetadata(note);
      let tuple: unknown;
      try {
        tuple = JSON.parse(note.id);
      } catch {
        /* Fail the identity gate below. */
      }
      if (
        !creator.externalAuthorId ||
        !metadata ||
        !note.videoBytes ||
        !Array.isArray(tuple) ||
        tuple.length !== 3 ||
        tuple[0] !== 'xiaohongshu' ||
        tuple[1] !== 'note' ||
        typeof tuple[2] !== 'string' ||
        JSON.stringify(tuple) !== note.id
      )
        throw new ArticleDownloadError(
          '视频缓存身份或元数据不完整，未保存。',
          422,
          { code: 'XHS_CACHED_VIDEO_UNAVAILABLE' },
        );
      // Parse only verified cached text/cover HTML, then rerun the shared video
      // contract gate. Neither raw platform responses nor remote URLs enter it.
      const $ = load(verifiedDownloadBody(note.contentHtml)),
        content = $('#js_content');
      const images = content
        .find('img')
        .toArray()
        .map((img, index) => ({
          ordinal: index + 1,
          inlineData: $(img).attr('src') || '',
        }));
      const bytes = Buffer.from(note.videoBytes);
      const inspected = inspectCachedMp4(bytes);
      if (
        inspected.sha256 !== metadata.sha256 ||
        inspected.bytes !== metadata.bytes
      )
        throw new ArticleDownloadError(
          '视频缓存字节与校验值不一致，未保存。',
          422,
          { code: 'XHS_CACHED_VIDEO_INVALID' },
        );
      const prepare = prepareXhsVideoDownload({
        evidenceVerified: true,
        note: {
          authorId: creator.externalAuthorId,
          noteId: tuple[2],
          kind: 'video',
          publishedAt: note.publishTime,
          title: note.title,
          text: content
            .find('p')
            .not(
              '[data-wewe-empty-video-caption], [title="wewe-empty-video-caption"]',
            )
            .toArray()
            .map((p) => $(p).text())
            .join('\n'),
          textStatus: 'full',
          expectedImageCount: images.length,
          images,
        },
        video: {
          complete: true,
          mimeType: metadata.mimeType,
          bytes,
          expectedBytes: metadata.bytes,
          sha256: metadata.sha256,
        },
      });
      const snapshot = await this.exportEngagement(creatorId, noteId, metrics);
      return withXhsLocalSnapshot(
        async (directory: string) => {
          const result = await prepare(directory);
          await fs.appendFile(
            path.join(directory, 'index.md'),
            Array.isArray(snapshot) ? '\n\n评论分段见同目录附页。\n' : snapshot,
          );
          return result;
        },
        note.id,
        note.title,
        snapshot,
      );
    }
    if (
      note.videoBytes !== null ||
      note.videoMimeType !== null ||
      note.videoExpectedBytes !== null ||
      note.videoSha256 !== null
    )
      throw new ArticleDownloadError(
        '笔记类型与视频缓存不一致，未保存。',
        422,
        { code: 'XHS_CACHED_VIDEO_INVALID' },
      );
    const sourceUrl = xhsOriginalLink(note.id);
    const article = {
      ...note,
      contentHtml: verifiedDownloadBody(note.contentHtml),
      lastBodyStatus: 'available',
      metrics: null,
    };
    const snapshot = await this.exportEngagement(creatorId, noteId, metrics);
    return withXhsLocalSnapshot(
      async (directory: string) => {
        const result = await buildCompleteArticleDownload(
          article,
          '[原文](' + sourceUrl + ')',
          directory,
        );
        await fs.appendFile(
          path.join(directory, 'index.md'),
          Array.isArray(snapshot) ? '\n\n评论分段见同目录附页。\n' : snapshot,
        );
        return { ...result, sourceUrl: null };
      },
      note.id,
      note.title,
      snapshot,
    );
  }
}
