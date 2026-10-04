import axios from 'axios';
import { OwnerWebSession } from '../collection/owner-web-search';
import {
  applyNormalWebRenewal,
  NORMAL_WEB_RENEWAL_URL,
  NormalWebRenewal,
  normalWebRenewalCookie,
} from './normal-web-renewal';

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

/** Direct-Web renewal shape follows finlater/weread.koplugin@24c0765
 * (scripts/verify_qr_login.py, weread/lib/client.lua).
 * Callers must enforce a one-shot
 * private marker; this function neither retries nor requests MP articles.
 * Raw credentials stay in memory until the caller stores them privately.
 */
export async function renewDirectWebTicket(
  session: OwnerWebSession,
  ownerVid: string,
): Promise<
  NormalWebRenewal & {
    ticket?: string;
    wrpa?: string;
  }
> {
  const cookie = normalWebRenewalCookie(session, ownerVid);

  let response;
  try {
    response = await axios.post(
      NORMAL_WEB_RENEWAL_URL,
      {
        rq: '%2Fweb%2Fbook%2Fread',
        ql:
          session.cookies.find((entry) => entry.name === 'wr_ql')?.value ===
          '1',
      },
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

  const updated = applyNormalWebRenewal(
    session,
    ownerVid,
    {
      url: NORMAL_WEB_RENEWAL_URL,
      status: response.status,
      data,
      setCookies: response.headers['set-cookie'],
    },
    new Date().toISOString(),
  );
  return {
    ...updated,
    ticket: credentialHeader(response.headers['x-wr-ticket']),
    wrpa: credentialHeader(response.headers['x-wrpa-0']),
  };
}
