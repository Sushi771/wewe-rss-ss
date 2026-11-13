import type { BatchOutcome } from './wechat2rss-subscription-batches';

const stages = [
  'feed-lookup',
  'claim-read',
  'provider-config',
  'account-status',
  'subscription-check',
  'reservation',
  'prepare-callback',
] as const;
const codes = [
  'WECHAT2RSS_SOURCE_STOPPED',
  'WECHAT2RSS_SOURCE_STOP_PERSIST_FAILED',
  'WECHAT2RSS_SOURCE_RESTRICTED',
  'WECHAT2RSS_DISABLED',
  'WECHAT2RSS_PRIVATE_CONFIG_INVALID',
  'WECHAT2RSS_RATE_LIMITED',
  'WECHAT2RSS_NETWORK_ERROR',
  'WECHAT2RSS_REQUEST_TIMEOUT',
  'WECHAT2RSS_HTTP_STATUS',
  'WECHAT2RSS_INVALID_JSON',
  'WECHAT2RSS_SUBSCRIPTION_PAUSED',
  'WECHAT2RSS_SUBSCRIPTION_MISSING',
  'WECHAT2RSS_AUTOMATIC_WINDOW_CLOSED',
  'REFRESH_PREPARATION_FAILED',
] as const;
export type RefreshPreparationStage = (typeof stages)[number];
export type RefreshPreparationFailure = {
  code: (typeof codes)[number];
  stage: RefreshPreparationStage;
};

export function validRefreshPreparationFailure(
  value: unknown,
): value is RefreshPreparationFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RefreshPreparationFailure;
  return (
    Object.keys(v).sort().join(',') === 'code,stage' &&
    codes.includes(v.code) &&
    stages.includes(v.stage)
  );
}

/** No raw message, cause, stack, URL, credentials, SQL or path crosses storage. */
export function refreshPreparationFailure(
  error: unknown,
  stage: RefreshPreparationStage,
): RefreshPreparationFailure {
  const message =
    error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value
      : undefined;
  return {
    code: codes.includes(message) ? message : 'REFRESH_PREPARATION_FAILED',
    stage,
  };
}

/** Preparation has not exposed/invoked the network update closure. Never apply
 * this classification to an uncertain submission or an accepted cache read. */
export function refreshPreparationOutcome(
  error: unknown,
  stage: RefreshPreparationStage,
): BatchOutcome {
  const preparationFailure = refreshPreparationFailure(error, stage);
  const stopped = preparationFailure.code === 'WECHAT2RSS_SOURCE_STOPPED';
  const rate = preparationFailure.code === 'WECHAT2RSS_RATE_LIMITED';
  return {
    state: stopped || rate ? 'blocked' : 'failed',
    accepted: false,
    submissionUnknown: false,
    retryable: !stopped && !rate,
    stopBatch: stopped || rate,
    ...(rate
      ? { sharedRestriction: true, restrictionKind: 'rate-limit' as const }
      : {}),
    preparationFailure,
    message: stopped
      ? 'Source safety protection retained; preparation blocked before update request. No automatic retry.'
      : 'Preparation failed before update request.',
  };
}
