import { cacheFailureReason } from './cache-failure';
import type { BatchOutcome } from './wechat2rss-subscription-batches';

export const refreshCacheFailurePoints = [
  'feed-read',
  'cache-read',
  'cache-save',
  'cache-callback',
  'legacy-cache',
  'global-gate',
] as const;
export type RefreshCacheFailurePoint =
  (typeof refreshCacheFailurePoints)[number];

/** Persist fixed categories, never provider messages, SQL, credentials or paths. */
export function refreshCacheFailure(
  error: unknown,
  point: RefreshCacheFailurePoint,
): BatchOutcome {
  const e = error as { message?: unknown; stopBatch?: unknown } | null;
  const message = e?.message;
  const account = [
    'WECHAT2RSS_ACCOUNT_CHALLENGED',
    'WECHAT2RSS_ACCOUNT_UNAVAILABLE',
  ].includes(String(message));
  const rate = message === 'WECHAT2RSS_RATE_LIMITED';
  const global =
    account ||
    rate ||
    message === 'CACHE_SYNC_STARTUP_BLOCKED' ||
    e?.stopBatch === true;
  const source = [
    'WECHAT2RSS_SUBSCRIPTION_MISSING',
    'WECHAT2RSS_SUBSCRIPTION_NAME_CHANGED',
    'WECHAT2RSS_SUBSCRIPTION_PAUSED',
  ].includes(String(message));
  return {
    state: global
      ? 'blocked'
      : message === 'CACHE_SYNC_BUSY'
        ? 'waiting'
        : 'failed',
    accepted: true,
    submissionUnknown: false,
    stopBatch: global,
    // This flag authorizes preparation retries, never an accepted /add replay.
    retryable: false,
    code: source
      ? message === 'WECHAT2RSS_SUBSCRIPTION_PAUSED'
        ? 'SUBSCRIPTION_PAUSED'
        : 'SOURCE_CHANGED'
      : 'CACHE_READ_FAILED',
    failureReason:
      account || rate
        ? 'CACHE_UPSTREAM_READ_ERROR'
        : message === 'CACHE_SYNC_BUSY'
          ? 'CACHE_STORAGE_TIMEOUT'
          : cacheFailureReason(error),
    failurePoint: global ? 'global-gate' : point,
    ...(account || rate
      ? {
          sharedRestriction: true,
          restrictionKind: rate
            ? ('rate-limit' as const)
            : ('account' as const),
        }
      : {}),
    message: global
      ? 'Shared account, rate or startup gate retained; accepted update is not resubmitted.'
      : source
        ? 'Subscription identity or availability changed; independent sources continue.'
        : 'Cache work failed; accepted receipt retained for bounded local-cache recovery, without another update request.',
  };
}
