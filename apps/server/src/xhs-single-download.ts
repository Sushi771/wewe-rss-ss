import { ArticleDownloadError } from './article-download';
import {
  XhsNormalizedCandidate,
  xhsArchiveDraft,
} from './collection/xiaohongshu-contract';
import {
  buildCompleteArticleDownload,
  verifiedDownloadBody,
} from './article-verified-download';
import {
  prepareXhsVideoDownload,
  XhsVerifiedVideoCache,
} from './xhs-video-download';

export const XHS_SINGLE_SOURCE = Symbol('XHS_SINGLE_SOURCE');

/** Server-only seam. A real adapter must prove request/identity binding, publication
 * time, full text and the ordered original image bytes. Never accept page uploads.
 * No production adapter or short-link resolver is registered by default.
 */
export interface XhsSingleSource {
  /** Declared only by a verified adapter; default registration remains absent. */
  videoEvidenceSupported?: boolean;
  read(url: string): Promise<{
    requestedUrl: string;
    evidenceVerified: boolean;
    note: XhsNormalizedCandidate;
    video?: XhsVerifiedVideoCache['video'];
  }>;
}

export function xhsSingleNoteUrl(raw: unknown) {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length > 8192 ||
      /[\\\s\x00-\x1f\x7f]/.test(raw)
    )
      throw new Error();
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.xiaohongshu.com' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^\/(?:explore|discovery\/item)\/[a-zA-Z0-9_-]+$/.test(url.pathname)
    )
      throw new Error();
    return url.href;
  } catch {
    throw new ArticleDownloadError(
      '请粘贴小红书公开笔记 HTTPS 长链接，短链接暂未接入。',
      400,
      { code: 'XHS_SINGLE_URL_INVALID' },
    );
  }
}

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );

/** Snapshot validated normalized content; do not derive a trusted ID from the URL. */
export function prepareXhsSingleDownload(
  url: string,
  result: Awaited<ReturnType<XhsSingleSource['read']>>,
) {
  try {
    if (result.requestedUrl !== url || result.evidenceVerified !== true)
      throw new Error();
    if (result.note.kind === 'video' && result.video)
      return prepareXhsVideoDownload({
        evidenceVerified: result.evidenceVerified,
        note: result.note,
        video: result.video,
      });
    const draft = xhsArchiveDraft(result.note.authorId, result.note);
    if (draft.status === 'video-skipped')
      throw new ArticleDownloadError(
        '视频笔记尚无经核实的完整视频缓存与格式合同，未归档。',
        422,
        { code: 'XHS_VIDEO_NOT_ARCHIVED' },
      );
    if (
      !draft.readyForEvidenceCheck ||
      !draft.title.trim() ||
      draft.title.length > 500 ||
      Buffer.byteLength(draft.text) > 5_000_000
    )
      throw new Error();
    const contentHtml = verifiedDownloadBody(
      '<div id="js_content">' +
        draft.text
          .split('\n')
          .map((p) => '<p>' + escape(p) + '</p>')
          .join('') +
        draft.images
          .map(
            (image) =>
              '<img src="data:' +
              image.type +
              ';base64,' +
              image.bytes.toString('base64') +
              '">',
          )
          .join('') +
        '</div>',
    );
    const article = {
      id: draft.noteKey,
      title: draft.title,
      contentHtml,
      publishTime: draft.publishedAt,
      lastBodyStatus: 'available',
      metrics: null,
    };
    // Signed query values may contain access tokens: never publish them in Markdown.
    const source = new URL(url);
    source.search = '';
    return (directory: string) =>
      buildCompleteArticleDownload(article, source.href, directory);
  } catch (error) {
    if (
      error instanceof ArticleDownloadError &&
      error.diagnostic.code === 'XHS_VIDEO_NOT_ARCHIVED'
    )
      throw error;
    throw new ArticleDownloadError(
      '笔记身份、全文或全部图片字节未通过核验，未保存。',
      422,
      { code: 'XHS_SINGLE_EVIDENCE_INCOMPLETE' },
    );
  }
}
