import { Inject, Injectable, Optional } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import { PrismaService } from '../prisma/prisma.service';
import { XhsCreator } from '@prisma/client';
import {
  appendXhsPage,
  xhsArchiveDraft,
  xhsPageLedger,
  XhsNormalizedCandidate,
} from './xiaohongshu-contract';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { buildArticleMarkdown } from '../article-export';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { decodeInlineImage } from './image-fetch';
import {
  buildCompleteArticleDownload,
  verifiedDownloadBody,
} from '../article-verified-download';
import { ArticleDownloadError } from '../article-download';

export const XHS_SOURCE = Symbol('XHS_SOURCE');
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
      items: XhsNormalizedCandidate[];
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
  async list() {
    return {
      platform: 'xiaohongshu' as const,
      items: await this.prisma.xhsCreator.findMany({
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { notes: true } } },
      }),
    };
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
    await createVerifiedSqliteBackup();
    const proposedId = randomUUID();
    const creator = await this.prisma.xhsCreator.upsert({
      where: { profileUrl },
      create: { id: proposedId, profileUrl, displayName: name },
      update: {},
    });
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
      await createVerifiedSqliteBackup();
      return await this.prisma.xhsCreator.update({
        where: { id },
        data: { enabled },
      });
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
  async notes(creatorId: string) {
    await this.getCreator(creatorId);
    return {
      platform: 'xiaohongshu' as const,
      items: await this.prisma.xhsNote.findMany({
        where: { creatorId },
        orderBy: [{ publishTime: 'desc' }, { id: 'asc' }],
        select: { id: true, title: true, publishTime: true, status: true },
      }),
    };
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
      const drafts = new Map<string, ReturnType<typeof xhsArchiveDraft>>();
      const timestamps = new Map<string, number>();
      for (const page of result.pages) {
        ledger = appendXhsPage(
          ledger,
          { authorId: result.authorId, ...page },
          3,
        ).ledger;
        for (const item of page.items) {
          const draft = xhsArchiveDraft(result.authorId, item);
          if (draft.status === 'candidate' && !draft.readyForEvidenceCheck)
            return fail('全文或图片数量未通过核验，旧归档保留。');
          if (!drafts.has(draft.noteKey)) drafts.set(draft.noteKey, draft);
          if (!timestamps.has(draft.noteKey))
            timestamps.set(draft.noteKey, item.publishedAt);
        }
      }
      if (!result.pages.length) return fail('未收到可核验列表，旧归档保留。');
      await createVerifiedSqliteBackup();
      const added = await this.prisma.$transaction(async (tx) => {
        let count = 0;
        for (const d of drafts.values()) {
          const old = await tx.xhsNote.findUnique({ where: { id: d.noteKey } });
          if (old) {
            if (old.creatorId !== id)
              return fail('笔记归属冲突，未覆盖旧内容。', 'CONFLICT');
            continue;
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
                '</div>'
              : null;
          await tx.xhsNote.create({
            data: {
              id: d.noteKey,
              creatorId: id,
              title:
                d.status === 'candidate' ? d.title : '视频笔记（未归档视频）',
              publishTime: timestamps.get(d.noteKey)!,
              status: d.status === 'candidate' ? 'complete' : 'video-skipped',
              contentHtml,
            },
          });
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
      });
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
  async body(creatorId: string, noteId: string) {
    const note = await this.prisma.xhsNote.findFirst({
      where: { id: noteId, creatorId, status: 'complete' },
    });
    if (!note?.contentHtml) return fail('此笔记没有已核验完整图文。');
    const $ = load(note.contentHtml),
      content = $('#js_content');
    const images = content
      .find('img')
      .toArray()
      .map((img) => {
        const inline = $(img).attr('src') || '';
        decodeInlineImage(inline);
        return inline;
      });
    return {
      title: note.title,
      publishTime: note.publishTime,
      text: content
        .find('p')
        .toArray()
        .map((p) => $(p).text())
        .join('\n'),
      images,
    };
  }
  async export(creatorId: string) {
    await this.getCreator(creatorId);
    const notes = await this.prisma.xhsNote.findMany({
      where: { creatorId, status: 'complete' },
      orderBy: [{ publishTime: 'asc' }, { id: 'asc' }],
    });
    if (!notes.length) return fail('没有已核验完整图文，尚不能下载。');
    if (
      notes.reduce(
        (sum, n) => sum + Buffer.byteLength(n.contentHtml || ''),
        0,
      ) > 25_000_000
    )
      return fail('归档超过本次浏览器下载的大小限制，未生成截断内容。');
    // Reuse cached-only original Markdown/image export and ZIP packaging. Never
    // request a signed CDN URL or pass an XHS ID to the WeChat download route.
    const root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-xhs-export-'));
    try {
      const folder = path.join(root, 'archive');
      await fs.mkdir(folder);
      for (const note of notes) {
        if (!note.contentHtml) return fail('归档正文缺失，下载未完成。');
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
        await fs.writeFile(
          path.join(folder, filename),
          '# ' + note.title.replace(/[\r\n]/g, ' ') + '\n\n' + result.markdown,
        );
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
  async prepareLocalDownload(creatorId: string, noteId: string) {
    const note = await this.prisma.xhsNote.findFirst({
      where: { id: noteId, creatorId, status: 'complete' },
    });
    if (!note?.contentHtml)
      throw new ArticleDownloadError(
        '此笔记没有已核验完整正文和图片，未保存。',
        422,
        { code: 'XHS_CACHED_ARTICLE_UNAVAILABLE' },
      );
    const article = {
      ...note,
      contentHtml: verifiedDownloadBody(note.contentHtml),
      lastBodyStatus: 'available',
      metrics: null,
    };
    return (directory: string) =>
      buildCompleteArticleDownload(
        article,
        '小红书本地缓存（笔记身份：' + note.id + '）',
        directory,
      );
  }
}
