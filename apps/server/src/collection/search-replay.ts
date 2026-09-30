import {
  ArticleCandidate,
  OriginalEvidence,
  verifyCandidateOriginal,
} from './article-candidate';
import { archiveProviderImages } from './archive-provider-images';
import { decodeInlineImage } from './image-fetch';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { assertProviderPage, ProviderPage } from './subscription-provider';

export type CachedOriginal = {
  html: string;
  evidence: OriginalEvidence;
  images: Array<{
    url: string;
    bytes: Buffer;
    sha256: string;
    capturedAt: string;
    source: 'official-image-response';
  }>;
};

/** Only independently returned candidates can enter this body cache adapter.
 * Missing cache entries remain unverified; they never become synthetic results.
 * This offline adapter is not selected by any production update route.
 */
export async function prepareSearchReplay(
  candidates: ArticleCandidate[],
  mpId: string,
  resolveCache: (candidate: ArticleCandidate) => Promise<CachedOriginal | null>,
) {
  const verified: Array<
    ReturnType<typeof verifyCandidateOriginal> & {
      images: Array<{
        url: string;
        sha256: string;
        capturedAt: string;
        source: 'official-image-response';
      }>;
    }
  > = [];
  const unverified: Array<{ id: string; reason: 'no_original_cache' }> = [];
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.mpId !== mpId)
      throw new Error('SEARCH_REPLAY_WRONG_PUBLISHER');
    if (seen.has(candidate.id)) {
      if (seen.get(candidate.id) !== candidate.url)
        throw new Error('SEARCH_REPLAY_IDENTITY_CONFLICT');
      continue;
    }
    seen.set(candidate.id, candidate.url);
    const cached = await resolveCache(candidate);
    if (!cached) {
      unverified.push({ id: candidate.id, reason: 'no_original_cache' });
      continue;
    }
    if (cached.evidence.transport !== 'verified-cache')
      throw new Error('SEARCH_REPLAY_REQUIRES_CACHE');
    const result = verifyCandidateOriginal(
      candidate,
      cached.html,
      cached.evidence,
    );
    const $ = load(result.article.contentHtml!);
    const used: typeof cached.images = [];
    for (const image of $('img[src]').toArray()) {
      const source = $(image).attr('src')!;
      const entries = cached.images.filter((entry) => entry.url === source);
      if (entries.length !== 1)
        throw new Error('SEARCH_REPLAY_IMAGE_CACHE_MISSING_OR_AMBIGUOUS');
      const entry = entries[0];
      if (
        entry.source !== 'official-image-response' ||
        !Number.isFinite(Date.parse(entry.capturedAt)) ||
        createHash('sha256').update(entry.bytes).digest('hex') !== entry.sha256
      )
        throw new Error('SEARCH_REPLAY_IMAGE_CACHE_INVALID');
      // Existing image decoder validates magic bytes, type, and bounded size.
      const prefix = entry.bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'png'
        : entry.bytes[0] === 255 && entry.bytes[1] === 216
          ? 'jpeg'
          : ['GIF87a', 'GIF89a'].includes(entry.bytes.subarray(0, 6).toString())
            ? 'gif'
            : 'webp';
      const inline = `data:image/${prefix};base64,${entry.bytes.toString('base64')}`;
      decodeInlineImage(inline);
      $(image).attr('src', inline);
      used.push(entry);
    }
    result.article.contentHtml = $.html($('.rich_media_content').first());
    verified.push({
      ...result,
      images: used.map(({ url, sha256, capturedAt, source }) => ({
        url,
        sha256,
        capturedAt,
        source,
      })),
    });
  }
  const page: ProviderPage = {
    articles: verified.map((v) => v.article),
    coverage: 'search-results',
    upstreamCount: seen.size,
    bodyMissing: 0,
    imageBlocked: 0,
  };
  // Reuse the production image archiver only after every image has become a
  // validated inline cache hit. No HTTP is needed or allowed for this replay.
  const archived = await archiveProviderImages(assertProviderPage(page, mpId), {
    stopOnFailure: true,
  });
  verified.forEach((entry, index) => {
    entry.article = archived.articles[index];
  });
  return {
    page: archived,
    verified,
    unverified,
    discovery: 'real-response-replay' as const,
    originalNetworkRequests: 0,
    imageNetworkRequests: 0,
    complete: false as const,
  };
}
