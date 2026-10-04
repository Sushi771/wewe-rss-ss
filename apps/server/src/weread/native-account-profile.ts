import axios from 'axios';
import {
  OwnerWebSession,
  ownerSessionCookie,
} from '../collection/owner-web-search';

export type NativeAccountProfile = {
  source: 'owner-confirmed-native-profile';
  ownerVid: string;
  name: string;
  avatar?: string;
  capturedAt: string;
  nativeLoginAt: string;
};

export function parseNativeAccountProfile(
  data: any,
  session: OwnerWebSession,
): NativeAccountProfile {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    String(data.userVid) !== session.ownerVid ||
    ['errCode', 'errcode', 'code'].some(
      (key) => data[key] !== undefined && Number(data[key]) !== 0,
    ) ||
    typeof data.name !== 'string' ||
    !data.name.trim() ||
    data.name.length > 200 ||
    /[\x00-\x1f\x7f]/.test(data.name)
  )
    throw new Error('本人资料身份或昵称未通过核验。');
  let avatar: string | undefined;
  try {
    const url = new URL(data.avatar);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['qpic.cn', 'qlogo.cn', 'rescdn.qq.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith('.' + host),
      )
    )
      avatar = url.href;
  } catch {
    /* Avatar is optional and never fetched server-side. */
  }
  return {
    source: 'owner-confirmed-native-profile',
    ownerVid: session.ownerVid,
    name: data.name.trim(),
    ...(avatar ? { avatar } : {}),
    capturedAt: new Date().toISOString(),
    nativeLoginAt: session.capturedAt,
  };
}

/** First-party BVQc4ULa.js: QR accessToken/webLoginVid -> g4 GET /api/userInfo
 * ?userVid=...; g4 sets x-vid/x-skey, then the client consumes userInfo.name.
 * Uses only this normal Web session, never mobile fields, renewal or retries.
 */
export async function fetchNativeAccountProfile(session: OwnerWebSession) {
  const cookie = ownerSessionCookie(session, session.ownerVid);
  if (session.source !== 'owner-confirmed-native-web-login')
    throw new Error('本人资料需要正常Web登录。');
  const skey = session.cookies.find((item) => item.name === 'wr_skey')!.value;
  try {
    const response = await axios.get('https://weread.qq.com/api/userInfo', {
      params: { userVid: session.ownerVid },
      headers: {
        'x-vid': session.ownerVid,
        'x-skey': skey,
        Cookie: cookie,
        Referer: 'https://weread.qq.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 10000,
      maxRedirects: 0,
      proxy: false,
      maxContentLength: 65536,
      validateStatus: () => true,
    });
    if (response.status !== 200) throw new Error('本人资料读取受限，未重试。');
    return parseNativeAccountProfile(response.data, session);
  } catch {
    throw new Error(
      '本人资料读取失败或身份不符，未重试；已确认的正常登录保留。',
    );
  }
}
