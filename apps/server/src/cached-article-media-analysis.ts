import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { allowedImageUrl, decodeInlineImage } from './collection/image-fetch';

type Analysis = {
  sourcePrefixes: readonly string[];
  canReuseLegacyImages: boolean;
  unconfirmed: boolean;
};
const cache = new Map<string, { value: Analysis; bytes: number }>();
const maxEntries = 512;
const maxBytes = 524288;
let bytes = 0;
let hits = 0;
let computations = 0;

/** Content-derived facts only: never retain HTML, DOM, files or successful I/O checks. */
export function cachedArticleMediaAnalysis(article: {
  contentHtml: string | null;
  lastBodyStatus: string | null;
}): Analysis {
  const body = article.contentHtml || '';
  const key = createHash('sha256')
    .update('media-v1\0')
    .update(createHash('sha256').update(body).digest())
    .update(JSON.stringify(article.lastBodyStatus ?? null))
    .digest('hex');
  const hit = cache.get(key);
  if (hit) {
    hits++;
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  computations++;
  const html = load(body);
  const content = html('.rich_media_content').length
    ? html('.rich_media_content')
    : html('#js_content');
  const prefixes = new Set<string>();
  let canReuseLegacyImages = true;
  let unconfirmed =
    !!body &&
    (article.lastBodyStatus === 'images-pending' ||
      content.is('[data-wewe-image-pending]') ||
      content.find('[data-wewe-image-pending]').length > 0);
  for (const element of content.find('img').toArray()) {
    const src = html(element).attr('src') || '';
    const dataSrc = html(element).attr('data-src') || '';
    const source = src.startsWith('data:') ? src : dataSrc || src;
    canReuseLegacyImages &&=
      src.startsWith('data:image/') || (!src && !dataSrc);
    if (!source.trim()) {
      unconfirmed = true;
      continue;
    }
    prefixes.add(`image_${createHash('md5').update(source).digest('hex')}.`);
    // Match the old uncertainty predicate's short circuit once pending/invalid.
    if (unconfirmed) continue;
    try {
      if (source.startsWith('data:')) decodeInlineImage(source);
      else allowedImageUrl(source);
    } catch {
      unconfirmed = true;
    }
  }
  const value: Analysis = Object.freeze({
    sourcePrefixes: Object.freeze([...prefixes]),
    canReuseLegacyImages,
    unconfirmed,
  });
  const size =
    key.length * 2 +
    value.sourcePrefixes.reduce((sum, prefix) => sum + prefix.length * 2, 0) +
    64;
  // Oversized input/analysis is still checked, but cannot occupy the process cache.
  if (Buffer.byteLength(body) <= 8000000 && size <= maxBytes) {
    while (cache.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = cache.keys().next().value!;
      bytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(key, { value, bytes: size });
    bytes += size;
  }
  return value;
}

export function cachedArticleMediaAnalysisStats() {
  return {
    entries: cache.size,
    bytes,
    maxEntries,
    maxBytes,
    hits,
    computations,
  };
}
