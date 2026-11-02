import type { XhsProfileParser } from './xhs-redbook-subscription';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { xhsProfileMetrics } from './xhs-engagement-contract';

const fail = (): never => {
  throw new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return fail();
  return value.trim();
}

/** Optional source-only avatar metadata. Never persist a query, fragment or credentials. */
export function safeXhsAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:sns-avatar|sns-avatar-qc|sns-avatar-hw|sns-avatar-bd)\.xhscdn\.com$/.test(url.hostname) ||
        !/^\/avatar\/[A-Za-z0-9._!/-]+$/.test(url.pathname)) return undefined;
    return url.origin + url.pathname;
  } catch { return undefined; }
}

/** The reviewed otherinfo schema has no stable ID. Its identity is bound by the
 * exact signed target_user_id request in RedbookClient and its checked response
 * URL, not by nickname or red_id. Use only at that trusted adapter boundary.
 * red_id is a display identifier and is never substituted for the request ID. */
export const parseXhsProfile: XhsProfileParser = (raw, expectedAuthorId) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(expectedAuthorId)) return fail();
  const profile = record(raw),
    result = record(profile.result),
    basic = record(profile.basic_info);
  if (result.success !== true || result.code !== 0) return fail();
  const name = text(basic.nickname, 120);
  text(basic.red_id, 128);
  for (const object of [profile, basic]) {
    if (object.user_id !== undefined && object.user_id !== expectedAuthorId)
      throw new XhsSubscriptionError('XHS_AUTHOR_MISMATCH');
  }
  return {
    id: expectedAuthorId,
    name,
    ...(safeXhsAvatarUrl(basic.images) ? { avatarUrl: safeXhsAvatarUrl(basic.images) } : {}),
    metrics: xhsProfileMetrics(raw),
    profileUrl: `https://www.xiaohongshu.com/user/profile/${expectedAuthorId}`,
  };
};
