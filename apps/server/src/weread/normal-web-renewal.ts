import { createHash } from 'node:crypto';
import {
  OwnerWebSession,
  ownerSessionCookie,
} from '../collection/owner-web-search';
import {
  NORMAL_WEB_RENEWAL_URL,
  OwnerWebCookieLifecycle,
  ReceivedRenewalCookieMetadata,
} from '../collection/owner-web-cookie-lifecycle';
import { ownerLatestAuthHash } from '../collection/owner-weread-session-state';

export { NORMAL_WEB_RENEWAL_URL };
export type NormalWebRenewalResponse = {
  url: string;
  status: number;
  data: unknown;
  setCookies: unknown;
};
export type NormalWebRenewal = {
  session: OwnerWebSession;
  normalLoginAt: string;
  renewedAt: string;
  parentAuthHash: string;
  resultingAuthHash: string;
  parentSessionSha256: string;
  resultingSessionSha256: string;
  resultingCookieHash: string;
  responseSha256: string;
  receivedCookieMetadata: ReceivedRenewalCookieMetadata[];
};
export const normalWebSha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
export function normalWebJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('WEB_RENEWAL_CONTEXT_INVALID');
  }
}

/** Validate the immutable login/maintenance snapshot at its real capture time.
 * This is evidence validation only: expiry is never changed and expired cookies
 * must be omitted from the actual fixed-endpoint maintenance request below. */
export function normalWebRenewalParentTime(
  session: OwnerWebSession,
  ownerVid: string,
  now = Date.now(),
) {
  const captured = Date.parse(session?.capturedAt);
  const at = Date.parse(session?.renewedAt || session?.capturedAt);
  if (
    session?.source !== 'owner-confirmed-native-web-login' ||
    !Number.isFinite(captured) ||
    !Number.isFinite(at) ||
    at < captured ||
    at > now + 300000
  )
    throw new Error('WEB_RENEWAL_CONTEXT_INVALID');
  ownerSessionCookie(session, ownerVid, at);
  return at;
}

/** Browser-equivalent normal renewal: only unexpired cookies are transmitted.
 * A live same-owner VID and refresh cookie are required even when SKEY expired.
 * This header is only consumed by the fixed HTTPS normal renewal endpoint. */
export function normalWebRenewalCookie(
  session: OwnerWebSession,
  ownerVid: string,
  now = Date.now(),
) {
  normalWebRenewalParentTime(session, ownerVid, now);
  const live = session.cookies.filter(
    (cookie) => cookie.expires === -1 || cookie.expires * 1000 > now,
  );
  if (
    !live.some(
      (cookie) => cookie.name === 'wr_vid' && cookie.value === ownerVid,
    ) ||
    !live.some((cookie) => cookie.name === 'wr_rt' && cookie.value)
  )
    throw new Error('WEB_RENEWAL_REFRESH_TOKEN_MISSING');
  return live
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/** Pure adaptor for the already obtained successful response. The optional
 * original text binds the evidence to exact saved bytes, not JSON formatting.
 * No writes, login-index changes, renewal requests or collection permission. */
export function applyNormalWebRenewal(
  session: OwnerWebSession,
  ownerVid: string,
  response: NormalWebRenewalResponse,
  renewedAt: string,
  parentSessionText = JSON.stringify(session),
): NormalWebRenewal {
  const now = Date.parse(renewedAt);
  if (
    !Number.isFinite(now) ||
    session?.source !== 'owner-confirmed-native-web-login' ||
    (session.renewedAt !== undefined &&
      !Number.isFinite(Date.parse(session.renewedAt))) ||
    now < Date.parse(session.renewedAt || session.capturedAt) ||
    JSON.stringify(normalWebJson(parentSessionText)) !== JSON.stringify(session)
  )
    throw new Error('WEB_RENEWAL_CONTEXT_INVALID');
  const parentTime = normalWebRenewalParentTime(session, ownerVid, now);
  // For an expired key the live refresh credential, not the expired key,
  // establishes eligibility for normal maintenance. Scope seeds stay historical.
  const oldKey = session.cookies.find((cookie) => cookie.name === 'wr_skey')!;
  if (oldKey.expires !== -1 && oldKey.expires * 1000 <= now)
    normalWebRenewalCookie(session, ownerVid, now);
  else ownerSessionCookie(session, ownerVid, now);
  const jar = new OwnerWebCookieLifecycle(session, ownerVid, parentTime);
  const receivedCookieMetadata = jar.absorbNormalRenewal(response, now);
  const updated: OwnerWebSession = {
    ...session,
    renewedAt,
    cookies: jar.sessionCookies(now),
  };
  ownerSessionCookie(updated, ownerVid, now);
  // This operation must actually rotate the failed authentication credential;
  // auxiliary changes cannot masquerade as renewed authentication.
  const parentAuthHash = ownerLatestAuthHash(session, ownerVid, parentTime);
  const resultingAuthHash = ownerLatestAuthHash(updated, ownerVid, now);
  if (parentAuthHash === resultingAuthHash)
    throw new Error('WEB_RENEWAL_KEY_UNCHANGED');
  return {
    session: updated,
    normalLoginAt: session.capturedAt,
    renewedAt,
    parentAuthHash,
    resultingAuthHash,
    parentSessionSha256: normalWebSha256(parentSessionText),
    resultingSessionSha256: normalWebSha256(JSON.stringify(updated)),
    resultingCookieHash: normalWebSha256(
      jar.header(NORMAL_WEB_RENEWAL_URL, now),
    ),
    responseSha256: normalWebSha256(JSON.stringify(response)),
    receivedCookieMetadata,
  };
}
