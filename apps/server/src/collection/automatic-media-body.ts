import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { canonicalArticleUrl } from './collection-format';
import { assertSavedArticleIdentity } from './article-body-retry';
import { allowedImageUrl } from './image-fetch';
import {
  inspectSavedMedia,
  SavedMediaSnapshot,
  SavedMediaWrite,
} from './saved-media-writeback';
import { assertProviderPage, ProviderPage } from './subscription-provider';

export const mediaBodyHash = (html: string) =>
  createHash('sha256').update(html).digest('hex');
export const automaticMediaVersion = (row: Partial<SavedMediaSnapshot>) =>
  mediaBodyHash(
    JSON.stringify([
      row.id,
      row.mpId,
      row.contentHtml,
      row.sourceUrl,
      row.verifiedSourceUrl,
      row.updatedAt?.getTime(),
      row.lastBodyStatus,
      row.title,
      row.publishTime,
    ]),
  );
export const AUTOMATIC_MEDIA_BODY_LIMIT = 8_000_000;

/** Exact saved URLs only; empty/decorative/responsive slots stay unconfirmed. */
export function automaticMediaSources(html: string) {
  const state = inspectSavedMedia(html);
  const $ = load(html);
  if (!$('.rich_media_content, #js_content').length)
    return { urls: [], unknown: 1, ready: false };
  const urls = new Set<string>();
  let unknown = state.unknown;
  for (const image of $('img').toArray()) {
    const src = $(image).attr('src') || '';
    if (src.startsWith('data:image/')) continue;
    const source = $(image).attr('data-src') || src;
    if (!source) continue;
    try {
      if (source.length > 4096) throw Error();
      allowedImageUrl(source);
      urls.add(source);
    } catch {
      unknown++;
    }
  }
  if (urls.size > 60)
    return { urls: [], unknown: unknown + urls.size, ready: false };
  return {
    urls: [...urls],
    unknown:
      unknown + Number(state.missing > 0 && urls.size === 0 && unknown === 0),
    ready: state.ready,
  };
}

/** The caller captured this snapshot before HTTP; the existing transaction rechecks it. */
export function automaticMediaPlan(
  row: SavedMediaSnapshot,
  images: ReadonlyMap<string, string>,
) {
  if (
    !row.contentHtml ||
    Buffer.byteLength(row.contentHtml) > AUTOMATIC_MEDIA_BODY_LIMIT
  )
    throw Error('MEDIA_BODY_LIMIT');
  const url = row.verifiedSourceUrl || row.sourceUrl;
  if (!url) throw Error('MEDIA_IDENTITY_UNVERIFIED');
  const identity = canonicalArticleUrl(url);
  assertSavedArticleIdentity(row, identity);
  if (identity.mpId !== row.mpId) throw Error('MEDIA_IDENTITY_UNVERIFIED');
  const snapshot: SavedMediaSnapshot = {
    id: row.id,
    mpId: row.mpId,
    sourceUrl: row.sourceUrl,
    verifiedSourceUrl: row.verifiedSourceUrl,
    contentHtml: row.contentHtml,
    updatedAt: row.updatedAt,
    lastBodyStatus: row.lastBodyStatus,
    title: row.title,
    publishTime: row.publishTime,
  };
  const write: SavedMediaWrite = {
    images,
    snapshots: new Map([[identity.id, snapshot]]),
  };
  if (images.size) {
    const $ = load(row.contentHtml, undefined, false);
    for (const image of $('img').toArray()) {
      const node = $(image),
        src = node.attr('src') || '';
      if (src.startsWith('data:image/')) continue;
      const inline = images.get(node.attr('data-src') || src);
      if (inline) node.attr('src', inline).removeAttr('data-src');
    }
    // Leave room for explicit pending markers added by the protected merge.
    if (Buffer.byteLength($.html()) + 512 > AUTOMATIC_MEDIA_BODY_LIMIT)
      throw Error('MEDIA_BODY_LIMIT');
  }
  const page: ProviderPage = {
    articles: [
      {
        ...identity,
        title: row.title,
        publishTime: row.publishTime,
        contentHtml: row.contentHtml,
        picUrl: '',
      },
    ],
    coverage: 'stored-history-window',
    upstreamCount: 1,
    bodyMissing: 0,
    imageBlocked: 0,
  };
  return { write, page: assertProviderPage(page, row.mpId) };
}
