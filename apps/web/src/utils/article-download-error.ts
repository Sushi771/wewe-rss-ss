import {
  ARTICLE_VERIFICATION_TTL_MS,
  TimedArticleVerification,
  articleVerificationLocation,
  verificationArticleUrl,
} from '@wewe-rss/shared';

export class ArticleDownloadRequestError extends Error {
  constructor(
    message: string,
    readonly verification: TimedArticleVerification | null,
  ) {
    super(message);
  }
}

/** Reject unbound, malformed or stale links even if an API response is malformed. */
export function verificationFromDownloadError(
  result: unknown,
  requestedUrl: unknown,
  now = Date.now(),
): TimedArticleVerification | null {
  if (!result || typeof result !== 'object' || typeof requestedUrl !== 'string')
    return null;
  const payload = result as Record<string, unknown>;
  if (payload.code !== 'VERIFICATION_REDIRECT' || payload.stage !== 'article')
    return null;
  let requested: string;
  try {
    requested = verificationArticleUrl(requestedUrl);
  } catch {
    return null;
  }
  const raw = payload.verification;
  if (!raw || typeof raw !== 'object')
    return {
      status: 'unavailable',
      articleUrl: requested,
      reason: 'missing-location',
    };
  const observed = raw as Record<string, unknown>;
  if (typeof observed.articleUrl !== 'string') return null;
  try {
    if (requested !== verificationArticleUrl(observed.articleUrl)) return null;
  } catch {
    return null;
  }
  const articleUrl = requested;
  if (observed.status === 'unavailable') {
    if (
      !['missing-location', 'unsafe-location', 'sensitive-location'].includes(
        String(observed.reason),
      )
    )
      return null;
    return {
      status: 'unavailable',
      articleUrl,
      reason: observed.reason as
        | 'missing-location'
        | 'unsafe-location'
        | 'sensitive-location',
    };
  }
  if (observed.status !== 'available') return null;
  const checked = articleVerificationLocation(observed.url, articleUrl);
  if (checked.status !== 'available') return checked;
  const expires =
    typeof observed.expiresAt === 'string'
      ? Date.parse(observed.expiresAt)
      : NaN;
  if (
    !Number.isFinite(expires) ||
    expires <= now ||
    expires > now + ARTICLE_VERIFICATION_TTL_MS + 30_000
  )
    return { status: 'unavailable', articleUrl, reason: 'expired' };
  return { ...checked, expiresAt: String(observed.expiresAt) };
}
