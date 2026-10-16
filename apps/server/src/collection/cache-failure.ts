import { wechat2RssResponseDetails } from './providers/wechat2rss-response';
/** Fixed categories only; never return provider messages, SQL or paths. */
export const cacheFailureReasons = [
  'CACHE_IMAGES_UNVERIFIED',
  'CACHE_STORAGE_ENGINE_ERROR',
  'CACHE_STORAGE_TIMEOUT',
  'CACHE_SAVED_IMAGE_CONFLICT',
  'CACHE_UPSTREAM_READ_ERROR',
  'CACHE_RESPONSE_TOO_LARGE',
  'CACHE_HTTP_STATUS',
  'CACHE_INVALID_RESPONSE',
  'CACHE_REQUEST_TIMEOUT',
  'CACHE_NETWORK_ERROR',
  'CACHE_UNKNOWN_ERROR',
] as const;
export type CacheFailureReason = (typeof cacheFailureReasons)[number];
export function cacheFailureReason(error: unknown): CacheFailureReason {
  if (!error || typeof error !== 'object') return 'CACHE_UNKNOWN_ERROR';
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  if (e.message === 'WECHAT2RSS_RESPONSE_TOO_LARGE')
    return 'CACHE_RESPONSE_TOO_LARGE';
  if (
    e.message === 'WECHAT2RSS_HTTP_STATUS' ||
    e.message === 'WECHAT2RSS_RATE_LIMITED'
  )
    return 'CACHE_HTTP_STATUS';
  if (
    [
      'WECHAT2RSS_INVALID_JSON',
      'WECHAT2RSS_INVALID_ENCODING',
      'WECHAT2RSS_EMPTY_BODY',
    ].includes(String(e.message))
  )
    return 'CACHE_INVALID_RESPONSE';
  if (e.message === 'WECHAT2RSS_REQUEST_TIMEOUT')
    return 'CACHE_REQUEST_TIMEOUT';
  if (e.message === 'WECHAT2RSS_NETWORK_ERROR') return 'CACHE_NETWORK_ERROR';
  if (e.name === 'PrismaClientRustPanicError')
    return 'CACHE_STORAGE_ENGINE_ERROR';
  if (e.code === 'P2028' || e.code === 'P1008' || e.code === 'P2024')
    return 'CACHE_STORAGE_TIMEOUT';
  if (e.message === 'SAVED_BODY_IMAGE_SOURCE_CONFLICT')
    return 'CACHE_SAVED_IMAGE_CONFLICT';
  if (e.message === 'WECHAT2RSS_REQUEST_FAILED')
    return 'CACHE_UPSTREAM_READ_ERROR';
  return 'CACHE_UNKNOWN_ERROR';
}
export function cacheFailureDiagnostic(
  error: unknown,
  point: 'metadata-read' | 'cache-read' | 'cache-import',
  now: number,
) {
  return {
    failureReason: cacheFailureReason(error),
    failurePoint: point,
    failedAt: new Date(now).toISOString(),
    ...wechat2RssResponseDetails(error),
  };
}
export type CacheFailureDiagnostic = ReturnType<typeof cacheFailureDiagnostic>;
