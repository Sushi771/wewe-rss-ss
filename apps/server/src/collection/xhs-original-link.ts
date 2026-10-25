import { ArticleDownloadError } from '../article-download';

/** Stable saved identity only. Never accept a source URL, query or token. */
export function xhsOriginalLink(id: string): string {
  let tuple: unknown;
  try {
    tuple = JSON.parse(id);
  } catch {
    // Reject below.
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 3 ||
    tuple[0] !== 'xiaohongshu' ||
    tuple[1] !== 'note' ||
    typeof tuple[2] !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(tuple[2]) ||
    JSON.stringify(tuple) !== id
  )
    throw new ArticleDownloadError('笔记缓存身份无效，未保存。', 422, {
      code: 'XHS_CACHED_NOTE_ID_INVALID',
    });
  return 'https://www.xiaohongshu.com/explore/' + tuple[2];
}
