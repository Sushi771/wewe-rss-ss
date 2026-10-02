import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import {
  articleContentHtml,
  articleIdentity,
  articlePublishTime,
} from './article-page';
import { canonicalArticleUrl } from './collection-format';
import { ProviderArticle, ProviderPage } from './subscription-provider';
import { ArticleCandidate } from './article-candidate';

/** Distinct evidence type for owner-confirmed browser DOM observation.
 * Must not be mislabeled as backend HTTP/live-original or reuse official-public-original.
 */
export type BrowserDomEvidence = {
  source: 'owner-confirmed-browser-dom';
  capturedAt: string;
  sha256: string;
  rawUrl?: string;
  observationKind: 'owner-confirmed-browser-dom';
};

export class BrowserDomVerificationError extends Error {
  constructor(
    public readonly code:
      | 'access_challenge'
      | 'identity_conflict'
      | 'invalid_dom_evidence'
      | 'dom_hash_mismatch'
      | 'invalid_article_dom'
      | 'missing_cached_image'
      | 'image_hash_mismatch'
      | 'invalid_image_cache'
      | 'unverified_images',
  ) {
    super(code);
  }
}

export type VerifiedBrowserDomArticle = {
  article: ProviderArticle;
  discovery: ArticleCandidate['discovery'];
  indexTimestamp: number | null;
  evidence: BrowserDomEvidence;
  canonical: string;
};

/** Strictly verify an owner-confirmed browser page against an independently discovered candidate.
 * Extracts articleIdentity, articlePublishTime, and articleContentHtml with zero backend HTTP requests.
 * Explicitly guards against using candidate.indexTimestamp as article publishTime.
 */
export function verifyBrowserDomArticle(
  candidate: ArticleCandidate,
  html: string,
  evidence: BrowserDomEvidence,
): VerifiedBrowserDomArticle {
  if (
    !evidence ||
    evidence.source !== 'owner-confirmed-browser-dom' ||
    evidence.observationKind !== 'owner-confirmed-browser-dom' ||
    !Number.isFinite(Date.parse(evidence.capturedAt)) ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
    Buffer.byteLength(html) > 10 * 1024 * 1024
  ) {
    throw new BrowserDomVerificationError('invalid_dom_evidence');
  }

  if (createHash('sha256').update(html).digest('hex') !== evidence.sha256) {
    throw new BrowserDomVerificationError('dom_hash_mismatch');
  }

  const $ = load(html);
  if (
    $(
      'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
    ).length ||
    /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
      html,
    )
  ) {
    throw new BrowserDomVerificationError('access_challenge');
  }

  let identity: ReturnType<typeof articleIdentity>;
  try {
    if (evidence.rawUrl) {
      const rawCanonical = canonicalArticleUrl(evidence.rawUrl);
      if (rawCanonical.url !== candidate.url) {
        throw new Error();
      }
    }
    identity = articleIdentity(html);
  } catch {
    throw new BrowserDomVerificationError('identity_conflict');
  }

  if (
    identity.id !== candidate.id ||
    identity.mpId !== candidate.mpId ||
    identity.url !== candidate.url
  ) {
    throw new BrowserDomVerificationError('identity_conflict');
  }

  if (!identity.canonical) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }

  if (
    !/^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{22}$/.test(
      identity.canonical,
    )
  ) {
    try {
      const canonical = new URL(identity.canonical);
      if (
        canonical.protocol !== 'https:' ||
        canonical.pathname !== '/s' ||
        canonicalArticleUrl(identity.canonical).url !== candidate.url
      ) {
        throw new Error();
      }
    } catch {
      throw new BrowserDomVerificationError('identity_conflict');
    }
  }

  const title = $('#activity-name').text().trim();
  const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '');
  if (!title) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }
  if (normalize(title) !== normalize(candidate.title)) {
    throw new BrowserDomVerificationError('identity_conflict');
  }

  // Strict publishTime extraction from DOM; never synthesize or fabricate from candidate indexTimestamp.
  const publishTime = articlePublishTime(html);
  if (!publishTime || publishTime < 946684800) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }

  const contentHtml = articleContentHtml(html);
  if (!contentHtml) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }

  const article: ProviderArticle = {
    id: identity.id,
    mpId: identity.mpId,
    url: identity.url,
    title,
    publishTime,
    contentHtml,
    picUrl: '',
  };

  return {
    article,
    discovery: candidate.discovery,
    indexTimestamp: candidate.indexTimestamp,
    evidence,
    canonical: identity.canonical,
  };
}

/** Prepares a verified ProviderPage from genuine browser DOM for isolated SQLite insertion. */
export function prepareBrowserDomReplay(
  candidate: ArticleCandidate,
  html: string,
  evidence: BrowserDomEvidence,
) {
  const verified = verifyBrowserDomArticle(candidate, html, evidence);
  // Browser DOM contains source URLs, not archived image bytes. The copy-only
  // rehearsal may preserve them, but they are not available for offline export.
  const $ = load(verified.article.contentHtml || '');
  const unarchivedImages = $('img[src]')
    .toArray()
    .filter(
      (image) => !($(image).attr('src') || '').startsWith('data:'),
    ).length;
  const page: ProviderPage = {
    articles: [verified.article],
    coverage: 'search-results',
    upstreamCount: 1,
    bodyMissing: 0,
    imageBlocked: unarchivedImages,
  };

  return {
    page,
    verified,
    discovery: 'owner-confirmed-browser-dom' as const,
    networkRequests: 0 as const,
    unarchivedImages,
    complete: false as const,
  };
}

export type CachedImageRecord = {
  url: string;
  bytes: Buffer;
  sha256: string;
  mimeType: string;
};

export type BrowserDomImageProvenance = {
  source: 'owner-confirmed-browser-dom-verified-image-cache';
  inlinedImagesCount: number;
  distinctImagesCount: number;
  verifiedAt: string;
  imagesManifestSha256: string;
};

export type InlinedBrowserDomArticle = {
  article: ProviderArticle;
  discovery: ArticleCandidate['discovery'];
  indexTimestamp: number | null;
  evidence: BrowserDomEvidence;
  canonical: string;
  imageProvenance: BrowserDomImageProvenance;
};

/** Check container boundaries and required image headers without decoding pixels. */
export function validateImageSignature(bytes: Buffer, type: string): boolean {
  if (!Buffer.isBuffer(bytes)) return false;
  if (type === 'image/png') {
    if (
      bytes.length < 58 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    )
      return false;
    let offset = 8;
    let hasImageData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      const end = offset + 12 + length;
      if (end > bytes.length) return false;
      if (offset === 8) {
        if (
          kind !== 'IHDR' ||
          length !== 13 ||
          bytes.readUInt32BE(offset + 8) === 0 ||
          bytes.readUInt32BE(offset + 12) === 0 ||
          !(
            {
              0: [1, 2, 4, 8, 16],
              2: [8, 16],
              3: [1, 2, 4, 8],
              4: [8, 16],
              6: [8, 16],
            }[bytes[offset + 17]] || []
          ).includes(bytes[offset + 16]) ||
          bytes[offset + 18] !== 0 ||
          bytes[offset + 19] !== 0 ||
          bytes[offset + 20] > 1
        )
          return false;
      } else if (kind === 'IHDR') return false;
      if (kind === 'IDAT' && length > 0) hasImageData = true;
      if (kind === 'IEND') {
        return length === 0 && hasImageData && end === bytes.length;
      }
      offset = end;
    }
    return false;
  }
  if (type === 'image/jpeg') {
    if (
      bytes.length < 28 ||
      bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
    )
      return false;
    let offset = 2;
    let hasFrame = false;
    let hasScan = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return false;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return false;
      const marker = bytes[offset++];
      if (marker === 0xd9)
        return hasFrame && hasScan && offset === bytes.length;
      if (
        marker === 0x00 ||
        marker === 0xd8 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        return false;
      }
      if (marker === 0x01) continue;
      if (offset + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(offset);
      const end = offset + length;
      if (length < 2 || end > bytes.length) return false;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (
          length < 8 ||
          bytes.readUInt16BE(offset + 3) === 0 ||
          bytes.readUInt16BE(offset + 5) === 0 ||
          bytes[offset + 7] === 0 ||
          length !== 8 + 3 * bytes[offset + 7]
        )
          return false;
        hasFrame = true;
      }
      offset = end;
      if (marker !== 0xda) continue;
      if (
        !hasFrame ||
        length < 6 ||
        bytes[end - length + 2] === 0 ||
        length !== 6 + 2 * bytes[end - length + 2]
      )
        return false;
      let scanBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          scanBytes++;
          offset++;
          continue;
        }
        const markerStart = offset;
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) return false;
        if (bytes[offset] === 0x00) {
          scanBytes++;
          offset++;
          continue;
        }
        if (bytes[offset] >= 0xd0 && bytes[offset] <= 0xd7) {
          offset++;
          continue;
        }
        offset = markerStart;
        break;
      }
      if (scanBytes === 0) return false;
      hasScan = true;
    }
    return false;
  }
  if (type === 'image/gif') {
    if (
      bytes.length < 28 ||
      !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ||
      bytes.readUInt16LE(6) === 0 ||
      bytes.readUInt16LE(8) === 0 ||
      bytes[bytes.length - 1] !== 0x3b
    )
      return false;
    const hasGlobalPalette = (bytes[10] & 0x80) !== 0;
    let offset = 13 + (hasGlobalPalette ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
    let hasImageData = false;
    const readSubBlocks = (): boolean => {
      let hasData = false;
      while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0) return hasData;
        if (offset + length > bytes.length) {
          offset = bytes.length;
          return false;
        }
        hasData = true;
        offset += length;
      }
      return false;
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) return hasImageData && offset === bytes.length;
      if (marker === 0x21) {
        if (offset >= bytes.length) return false;
        offset++; // Extension label followed by terminated sub-blocks.
        readSubBlocks();
        if (offset >= bytes.length) return false;
        continue;
      }
      if (marker !== 0x2c || offset + 9 > bytes.length) return false;
      if (
        bytes.readUInt16LE(offset + 4) === 0 ||
        bytes.readUInt16LE(offset + 6) === 0
      )
        return false;
      const packed = bytes[offset + 8];
      const hasLocalPalette = (packed & 0x80) !== 0;
      if (!hasGlobalPalette && !hasLocalPalette) return false;
      offset += 9 + (hasLocalPalette ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8)
        return false;
      offset++; // LZW minimum code size.
      if (!readSubBlocks()) return false;
      hasImageData = true;
    }
    return false;
  }
  if (type === 'image/webp') {
    if (
      bytes.length < 26 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP' ||
      bytes.readUInt32LE(4) !== bytes.length - 8
    )
      return false;
    const verifyChunks = (
      start: number,
      limit: number,
      allowAnimation: boolean,
    ): boolean => {
      let offset = start;
      let hasImageData = false;
      while (offset + 8 <= limit) {
        const kind = bytes.toString('ascii', offset, offset + 4);
        const length = bytes.readUInt32LE(offset + 4);
        const data = offset + 8;
        const end = data + length;
        const paddedEnd = end + (length & 1);
        if (paddedEnd > limit) return false;
        if (kind === 'VP8 ') {
          if (
            length <= 10 ||
            (bytes[data] & 1) !== 0 ||
            bytes.toString('hex', data + 3, data + 6) !== '9d012a' ||
            (bytes.readUInt16LE(data + 6) & 0x3fff) === 0 ||
            (bytes.readUInt16LE(data + 8) & 0x3fff) === 0
          )
            return false;
          hasImageData = true;
        } else if (kind === 'VP8L') {
          if (
            length <= 5 ||
            bytes[data] !== 0x2f ||
            (bytes[data + 4] & 0xe0) !== 0
          )
            return false;
          hasImageData = true;
        } else if (kind === 'VP8X') {
          if (
            length !== 10 ||
            bytes[data + 1] !== 0 ||
            bytes[data + 2] !== 0 ||
            bytes[data + 3] !== 0
          )
            return false;
        } else if (kind === 'ANMF') {
          if (
            !allowAnimation ||
            length < 16 ||
            !verifyChunks(data + 16, end, false)
          )
            return false;
          hasImageData = true;
        }
        offset = paddedEnd;
      }
      return hasImageData && offset === limit;
    };
    return verifyChunks(12, bytes.length, true);
  }
  return false;
}

/** Strictly inlines verified cached images into an article's contentHtml as data URIs.
 * Requires EVERY single remote image in contentHtml to be present in the cache,
 * with its byte SHA-256 matching the declared hash and valid magic byte signature.
 * Pure offline transformation: no network requests, no production bindings or writes.
 * Returns distinct provenance indicating image cache verification.
 */
export function inlineVerifiedBrowserDomImages(
  verified: VerifiedBrowserDomArticle,
  cachedImages:
    | Map<string, CachedImageRecord>
    | CachedImageRecord[]
    | Record<string, CachedImageRecord>,
  options?: { verifiedAt?: string },
): InlinedBrowserDomArticle {
  const contentHtml = verified.article.contentHtml;
  if (!contentHtml) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }

  // Fragments identify DOM occurrences, never distinct archived image bytes.
  const canonicalImageUrl = (value: string): string => {
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      url.hash = '';
      return url.toString();
    } catch {
      throw new BrowserDomVerificationError('invalid_image_cache');
    }
  };
  const cacheMap = new Map<string, CachedImageRecord>();
  const addCachedImage = (key: string, value: CachedImageRecord) => {
    if (
      typeof key !== 'string' ||
      !value ||
      typeof value.url !== 'string' ||
      !Buffer.isBuffer(value.bytes) ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(value.sha256) ||
      typeof value.mimeType !== 'string' ||
      !/^image\/(?:png|jpeg|gif|webp)$/i.test(value.mimeType)
    )
      throw new BrowserDomVerificationError('invalid_image_cache');
    const canonical = canonicalImageUrl(key);
    if (canonical !== canonicalImageUrl(value.url)) {
      throw new BrowserDomVerificationError('invalid_image_cache');
    }
    const normalized = {
      ...value,
      url: canonical,
      sha256: value.sha256.toLowerCase(),
      mimeType: value.mimeType.toLowerCase(),
    };
    const previous = cacheMap.get(canonical);
    if (
      previous &&
      (previous.sha256 !== normalized.sha256 ||
        previous.mimeType !== normalized.mimeType ||
        !previous.bytes.equals(normalized.bytes))
    )
      throw new BrowserDomVerificationError('invalid_image_cache');
    cacheMap.set(canonical, normalized);
  };
  if (cachedImages instanceof Map) {
    for (const [key, value] of cachedImages.entries()) {
      addCachedImage(key, value);
    }
  } else if (Array.isArray(cachedImages)) {
    for (const item of cachedImages) {
      addCachedImage(item?.url, item);
    }
  } else if (typeof cachedImages === 'object' && cachedImages !== null) {
    for (const [key, value] of Object.entries(cachedImages)) {
      addCachedImage(key, value);
    }
  } else {
    throw new BrowserDomVerificationError('invalid_image_cache');
  }

  const $ = load(contentHtml);
  const imageNodes = $('img[src]').toArray();
  const remoteImages = imageNodes.filter(
    (img) => !($(img).attr('src') || '').startsWith('data:'),
  );

  // Phase 1: Verify EVERY image before modifying anything
  const verifiedEntries: Array<{
    node: any;
    entry: CachedImageRecord;
  }> = [];
  const verifiedImages = new Map<string, CachedImageRecord>();

  for (const node of remoteImages) {
    const src = $(node).attr('src') || '';
    if (!src) continue;

    const canonical = canonicalImageUrl(src);
    const entry = cacheMap.get(canonical);
    if (!entry || !entry.bytes) {
      throw new BrowserDomVerificationError('missing_cached_image');
    }

    if (!entry.sha256 || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new BrowserDomVerificationError('invalid_image_cache');
    }

    const computedSha = createHash('sha256').update(entry.bytes).digest('hex');
    if (computedSha.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new BrowserDomVerificationError('image_hash_mismatch');
    }

    const mime = (entry.mimeType || '').toLowerCase();
    if (!/^image\/(?:png|jpeg|gif|webp)$/.test(mime)) {
      throw new BrowserDomVerificationError('invalid_image_cache');
    }

    if (!validateImageSignature(entry.bytes, mime)) {
      throw new BrowserDomVerificationError('invalid_image_cache');
    }

    verifiedImages.set(canonical, entry);
    verifiedEntries.push({ node, entry });
  }

  // Phase 2: Inline all verified images as data URIs
  for (const { node, entry } of verifiedEntries) {
    const dataUri = `data:${entry.mimeType.toLowerCase()};base64,${entry.bytes.toString('base64')}`;
    $(node).attr('src', dataUri);
  }

  // Calculate manifest hash of distinct verified images for deterministic provenance
  const sortedPairs = [...verifiedImages.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([url, entry]) => `${url}:${entry.sha256}`);
  const imagesManifestSha256 = createHash('sha256')
    .update(sortedPairs.join('\n'))
    .digest('hex');

  const inlinedContentHtml = $.html();

  const article: ProviderArticle = {
    ...verified.article,
    contentHtml: inlinedContentHtml,
  };

  const imageProvenance: BrowserDomImageProvenance = {
    source: 'owner-confirmed-browser-dom-verified-image-cache',
    inlinedImagesCount: verifiedEntries.length,
    distinctImagesCount: verifiedImages.size,
    verifiedAt: options?.verifiedAt || new Date().toISOString(),
    imagesManifestSha256,
  };

  return {
    article,
    discovery: verified.discovery,
    indexTimestamp: verified.indexTimestamp,
    evidence: verified.evidence,
    canonical: verified.canonical,
    imageProvenance,
  };
}

/** Prepares a verified ProviderPage with all cached images verified and inlined.
 * Guarantees archived images; single search-result coverage remains incomplete.
 * Strictly offline, 0 network requests, no production writes.
 */
export function prepareBrowserDomWithImagesReplay(
  candidate: ArticleCandidate,
  html: string,
  evidence: BrowserDomEvidence,
  cachedImages:
    | Map<string, CachedImageRecord>
    | CachedImageRecord[]
    | Record<string, CachedImageRecord>,
  options?: { verifiedAt?: string },
) {
  const verified = verifyBrowserDomArticle(candidate, html, evidence);
  // Sanitization can remove an image URL or its containing element. Every
  // original body image must survive with its effective (lazy-load) source
  // before an empty or partial sanitized image list can be called complete.
  const original = load(html);
  const originalImages = original('#js_content, .rich_media_content')
    .first()
    .find('img')
    .toArray();
  const sanitized = load(verified.article.contentHtml || '');
  const sanitizedImages = sanitized('img').toArray();
  if (originalImages.length !== sanitizedImages.length) {
    throw new BrowserDomVerificationError('unverified_images');
  }
  for (const [index, image] of originalImages.entries()) {
    const source =
      original(image).attr('data-src') || original(image).attr('src');
    let expectedSource: string;
    try {
      if (!source) throw new Error();
      expectedSource = new URL(source).toString();
    } catch {
      throw new BrowserDomVerificationError('unverified_images');
    }
    if (sanitized(sanitizedImages[index]).attr('src') !== expectedSource) {
      throw new BrowserDomVerificationError('unverified_images');
    }
  }
  const inlined = inlineVerifiedBrowserDomImages(
    verified,
    cachedImages,
    options,
  );
  const page: ProviderPage = {
    articles: [inlined.article],
    coverage: 'search-results',
    upstreamCount: 1,
    bodyMissing: 0,
    imageBlocked: 0,
  };

  return {
    page,
    verified: inlined,
    discovery: 'owner-confirmed-browser-dom' as const,
    provenance: 'owner-confirmed-browser-dom-verified-image-cache' as const,
    networkRequests: 0 as const,
    unarchivedImages: 0 as const,
    complete: false as const,
    imagesComplete: true as const,
  };
}
