/** Fixed categories only; never return provider messages, SQL or paths. */
export const cacheFailureReasons = [
  'CACHE_IMAGES_UNVERIFIED',
  'CACHE_STORAGE_ENGINE_ERROR',
  'CACHE_STORAGE_TIMEOUT',
  'CACHE_SAVED_IMAGE_CONFLICT',
  'CACHE_UPSTREAM_READ_ERROR',
  'CACHE_UNKNOWN_ERROR',
] as const;
export type CacheFailureReason = (typeof cacheFailureReasons)[number];
export function cacheFailureReason(error: unknown): CacheFailureReason {
  if (!error || typeof error !== 'object') return 'CACHE_UNKNOWN_ERROR';
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
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
