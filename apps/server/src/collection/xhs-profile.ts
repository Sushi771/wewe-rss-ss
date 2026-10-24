import type { XhsProfileParser } from './xhs-redbook-subscription';
import { XhsSubscriptionError } from './xhs-subscription-errors';

const fail = (): never => {
  throw new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
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
    profileUrl: `https://www.xiaohongshu.com/user/profile/${expectedAuthorId}`,
  };
};
