import axios from 'axios';
import {
  OwnerWebSession,
  ownerSessionCookie,
} from '../collection/owner-web-search';

const COOKIE_NAMES = new Set(['wr_vid', 'wr_skey', 'wr_rt', 'wr_ql', 'wr_pf']);

function credentialHeader(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    /[^\x21-\x7e]/.test(value)
  )
    throw new Error('WEB_RENEWAL_HEADER_INVALID');
  return value;
}

function renewedSession(
  session: OwnerWebSession,
  setCookies: unknown,
  ownerVid: string,
): OwnerWebSession {
  if (setCookies !== undefined && !Array.isArray(setCookies))
    throw new Error('WEB_RENEWAL_COOKIE_INVALID');
  const cookies = new Map(
    session.cookies.map((cookie) => [cookie.name, cookie]),
  );
  for (const line of (setCookies || []) as unknown[]) {
    if (typeof line !== 'string') throw new Error('WEB_RENEWAL_COOKIE_INVALID');
    const pair = line.split(';', 1)[0];
    const match = /^([A-Za-z][A-Za-z0-9_-]*)=([^;\s\x00-\x1f\x7f]*)$/.exec(
      pair,
    );
    if (!match || !COOKIE_NAMES.has(match[1])) continue;
    if (!match[2]) throw new Error('WEB_RENEWAL_COOKIE_INVALID');
    cookies.set(match[1], {
      name: match[1],
      value: match[2],
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    });
  }
  const updated: OwnerWebSession = {
    ...session,
    capturedAt: new Date().toISOString(),
    cookies: [...cookies.values()],
  };
  ownerSessionCookie(updated, ownerVid);
  return updated;
}

/** Direct-Web renewal shape follows finlater/weread.koplugin@24c0765
 * (scripts/verify_qr_login.py, weread/lib/client.lua).
 * Callers must enforce a one-shot
 * private marker; this function neither retries nor requests MP articles.
 * Raw credentials stay in memory until the caller stores them privately.
 */
export async function renewDirectWebTicket(
  session: OwnerWebSession,
  ownerVid: string,
): Promise<{
  session: OwnerWebSession;
  ticket?: string;
  wrpa?: string;
}> {
  const cookie = ownerSessionCookie(session, ownerVid);
  if (!session.cookies.some((entry) => entry.name === 'wr_rt'))
    throw new Error('WEB_RENEWAL_REFRESH_TOKEN_MISSING');

  let response;
  try {
    response = await axios.post(
      'https://weread.qq.com/web/login/renewal',
      { rq: '%2Fweb%2Fbook%2Fread', ql: false },
      {
        headers: {
          Cookie: cookie,
          Origin: 'https://weread.qq.com',
          Referer: 'https://weread.qq.com/',
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        },
        timeout: 10000,
        maxRedirects: 0,
        proxy: false,
        maxContentLength: 65536,
        validateStatus: () => true,
      },
    );
  } catch {
    throw new Error('WEB_RENEWAL_TRANSPORT_STOP');
  }
  if (response.status !== 200) throw new Error('WEB_RENEWAL_HTTP_STOP');
  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('WEB_RENEWAL_RESPONSE_INVALID');
  if (data.errCode !== undefined && data.errCode !== 0)
    throw new Error('WEB_RENEWAL_BUSINESS_STOP');
  if (![true, 1, '1'].includes(data.succ))
    throw new Error('WEB_RENEWAL_NOT_SUCCESS');

  const updated = renewedSession(
    session,
    response.headers['set-cookie'],
    ownerVid,
  );
  return {
    session: updated,
    ticket: credentialHeader(response.headers['x-wr-ticket']),
    wrpa: credentialHeader(response.headers['x-wrpa-0']),
  };
}
