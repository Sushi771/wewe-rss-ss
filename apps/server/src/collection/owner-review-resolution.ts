import { ArticleCandidate } from './article-candidate';
import { canonicalArticleUrl } from './collection-format';

/** Offline parsing only. URL resolution does not verify an article's body or date. */
export function parseOwnerReviewResolution(
  candidate: ArticleCandidate,
  response: unknown,
) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('RESOLVER_CANDIDATE_INVALID');
  const requestedUrl = candidate.requestUrl ?? candidate.url;
  if (typeof requestedUrl !== 'string' || /[\s\\]|&amp;/.test(requestedUrl))
    throw new Error('RESOLVER_CANDIDATE_INVALID');
  let canonical: ReturnType<typeof canonicalArticleUrl>;
  try {
    const url = new URL(requestedUrl);
    if (
      ['__biz', 'mid', 'idx', 'sn'].some(
        (k) => url.searchParams.getAll(k).length !== 1,
      )
    )
      throw new Error();
    canonical = canonicalArticleUrl(requestedUrl);
  } catch {
    // Native URL errors can carry their raw input as an extra property.
    throw new Error('RESOLVER_CANDIDATE_INVALID');
  }
  if (
    candidate.id !== canonical.id ||
    candidate.mpId !== canonical.mpId ||
    candidate.url !== canonical.url
  )
    throw new Error('RESOLVER_CANDIDATE_INCONSISTENT');
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw new Error('RESOLVER_RESPONSE_INVALID');
  const data = response as Record<string, unknown>;
  for (const key of ['errCode', 'errcode', 'code'])
    if (key in data && data[key] !== 0)
      // Do not interpolate arbitrary upstream fields into a public error.
      throw new Error('RESOLVER_BUSINESS_REJECTED');
  if (!Array.isArray(data.reviewIds) || data.reviewIds.length !== 1)
    throw new Error('RESOLVER_CARDINALITY_INVALID');
  const item = data.reviewIds[0];
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new Error('RESOLVER_RESPONSE_INVALID');
  if (item.url !== requestedUrl) throw new Error('RESOLVER_URL_MISMATCH');
  const prefix = `${canonical.mpId}_`;
  if (typeof item.reviewId !== 'string' || !item.reviewId.startsWith(prefix))
    throw new Error('RESOLVER_REVIEW_ID_INVALID');
  const suffix = item.reviewId.slice(prefix.length);
  if (!suffix.length || suffix.length > 150 || /[^A-Za-z0-9_~-]/.test(suffix))
    throw new Error('RESOLVER_REVIEW_ID_INVALID');
  return {
    candidateId: canonical.id,
    mpId: canonical.mpId,
    reviewId: item.reviewId as string,
    requestedUrl,
    originalVerified: false as const,
  };
}
