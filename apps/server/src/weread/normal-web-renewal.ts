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
  ownerSessionCookie(session, ownerVid, now);
  const jar = new OwnerWebCookieLifecycle(session, ownerVid, now);
  const receivedCookieMetadata = jar.absorbNormalRenewal(response, now);
  const updated: OwnerWebSession = {
    ...session,
    renewedAt,
    cookies: jar.sessionCookies(now),
  };
  ownerSessionCookie(updated, ownerVid, now);
  // This operation must actually rotate the failed authentication credential;
  // auxiliary changes cannot masquerade as renewed authentication.
  const parentAuthHash = ownerLatestAuthHash(session, ownerVid, now);
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
