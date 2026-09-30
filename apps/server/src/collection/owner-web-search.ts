import axios from 'axios';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ArticleCandidate, searchArticleCandidates } from './article-candidate';

export const OWNER_SEARCH_ENDPOINT =
  'https://weread.qq.com/web/wx_search_broker_proxy';
const COOKIE_NAMES = new Set(['wr_pf', 'wr_ql', 'wr_rt', 'wr_skey', 'wr_vid']);
export type OwnerWebSession = {
  source: 'owner-confirmed-dedicated-web-login';
  capturedAt: string;
  ownerVid: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    expires: number;
  }>;
};
export function ownerSessionCookie(
  session: OwnerWebSession,
  ownerVid: string,
  now = Date.now(),
) {
  if (
    session?.source !== 'owner-confirmed-dedicated-web-login' ||
    session.ownerVid !== ownerVid ||
    !Number.isFinite(Date.parse(session.capturedAt)) ||
    Date.parse(session.capturedAt) > now + 300000 ||
    !Array.isArray(session.cookies) ||
    session.cookies.length > 5
  )
    throw new Error('OWNER_WEB_SESSION_INVALID');
  const names = new Set<string>();
  for (const c of session.cookies) {
    if (
      !COOKIE_NAMES.has(c.name) ||
      names.has(c.name) ||
      !c.value ||
      /[;\s\x00-\x1f\x7f]/.test(c.value) ||
      // Tencent's normal Web login currently omits Secure on these cookies.
      // Preserve that evidence; this client always sends them over fixed HTTPS.
      !['weread.qq.com', '.weread.qq.com'].includes(c.domain) ||
      !['/', '/web'].includes(c.path) ||
      typeof c.secure !== 'boolean' ||
      !Number.isFinite(c.expires) ||
      (c.expires !== -1 && c.expires * 1000 <= now)
    )
      throw new Error('OWNER_WEB_SESSION_INVALID');
    names.add(c.name);
  }
  if (
    !names.has('wr_skey') ||
    session.cookies.find((c) => c.name === 'wr_vid')?.value !== ownerVid
  )
    throw new Error('OWNER_WEB_SESSION_INVALID');
  return [...session.cookies]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export class OwnerSearchStopped extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}
function responseContent(text: string) {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    if (
      /captcha|验证码|访问过于频繁|安全验证|环境异常|verify\.html/i.test(text)
    )
      throw new OwnerSearchStopped('challenge_or_rate_limit');
    throw new OwnerSearchStopped('non_json');
  }
  if (!data || Array.isArray(data) || typeof data !== 'object')
    throw new OwnerSearchStopped('invalid_response');
  // Search titles may mention verification; only upstream error messages
  // and non-JSON challenge pages constitute an access stop.
  if (
    [data.errMsg, data.msg, data.message].some(
      (value) =>
        typeof value === 'string' &&
        /captcha|验证码|访问过于频繁|安全验证|环境异常/i.test(value),
    )
  )
    throw new OwnerSearchStopped('challenge_or_rate_limit');
  for (const [present, code, allowed] of [
    ['errCode' in data, data.errCode, [0]],
    ['ret' in data, data.ret, [0, -1]],
    [data.content && 'ret' in data.content, data.content?.ret, [0]],
  ] as Array<[boolean, unknown, number[]]>) {
    if (!present) continue;
    const n =
      typeof code === 'string' && /^-?\d+$/.test(code) ? Number(code) : code;
    if (n === -2012) throw new OwnerSearchStopped('auth_expired');
    if (typeof n !== 'number' || !allowed.includes(n))
      throw new OwnerSearchStopped('business_rejected');
  }
  const content = data.content;
  if (!content || !Array.isArray(content.data) || content.data.length > 100)
    throw new OwnerSearchStopped('invalid_response');
  const items: unknown[] = [];
  for (const bucket of content.data) {
    if (
      !Array.isArray(bucket?.items) ||
      items.length + bucket.items.length > 100
    )
      throw new OwnerSearchStopped('invalid_response');
    items.push(...bucket.items);
  }
  return { content, items };
}

/** Only the normal login Cookie jar; no CDP, navigation, mobile init or automatic renewal. */
export async function fetchOwnerSearchPage(input: {
  sessionFile: string;
  stateFile: string;
  ownerVid: string;
  name: string;
  biz: string;
  // A continuation exists only within this call; never persist/reuse it next update.
  maxPages?: number;
}) {
  if (
    !path.isAbsolute(input.sessionFile) ||
    !path.isAbsolute(input.stateFile) ||
    !input.name.trim() ||
    input.name.length > 100 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.biz) ||
    ![1, 2].includes(input.maxPages || 1)
  )
    throw new Error('OWNER_SEARCH_CONFIG_INVALID');
  const session: OwnerWebSession = JSON.parse(
    await fs.readFile(input.sessionFile, 'utf8'),
  );
  const cookie = ownerSessionCookie(session, input.ownerVid);
  const sessionKey = createHash('sha256').update(cookie).digest('hex');
  // Cross-process exclusion also covers service restart and an interrupted attempt.
  const lock = await fs.open(input.stateFile + '.lock', 'wx', 0o600);
  const write = async (state: unknown) => {
    const pending = await fs.open(input.stateFile + '.pending', 'w', 0o600);
    try {
      await pending.writeFile(JSON.stringify(state));
      await pending.sync();
    } finally {
      await pending.close();
    }
    await fs.rename(input.stateFile + '.pending', input.stateFile);
  };
  const capturedAt = new Date().toISOString();
  let requests = 0;
  let reserved = false;
  let state: { lastAttemptAt?: number; stops?: Record<string, string> } = {};
  try {
    try {
      state = JSON.parse(await fs.readFile(input.stateFile, 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw new Error('OWNER_SEARCH_STATE_INVALID');
    }
    if (
      !state ||
      (state.stops &&
        (typeof state.stops !== 'object' || Array.isArray(state.stops))) ||
      (state.lastAttemptAt !== undefined &&
        !Number.isSafeInteger(state.lastAttemptAt))
    )
      throw new Error('OWNER_SEARCH_STATE_INVALID');
    if (state.stops?.[sessionKey])
      throw new OwnerSearchStopped(state.stops[sessionKey]);
    if (
      state.lastAttemptAt &&
      Date.now() - state.lastAttemptAt < 15 * 60 * 1000
    )
      throw new OwnerSearchStopped('cooldown');
    state = {
      ...state,
      lastAttemptAt: Date.now(),
      stops: { ...state.stops, [sessionKey]: 'interrupted_attempt' },
    };
    await write(state);
    reserved = true;
    const candidates = new Map<string, ArticleCandidate>();
    let body: any = { query: input.name, offset: 0, searchcookies: '' };
    let truncated = false;
    let pages = 0;
    for (let n = 1; n <= (input.maxPages || 1); n++) {
      ownerSessionCookie(session, input.ownerVid);
      requests++;
      const response = await axios.post<string>(OWNER_SEARCH_ENDPOINT, body, {
        proxy: false,
        timeout: 20000,
        maxRedirects: 0,
        maxContentLength: 512 * 1024,
        transformResponse: [(v) => v],
        validateStatus: () => true,
        headers: {
          Cookie: cookie,
          Origin: 'https://weread.qq.com',
          Referer: 'https://weread.qq.com/',
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        },
      });
      if (response.status !== 200)
        throw new OwnerSearchStopped(
          response.status === 401 || response.status === 403
            ? 'auth_or_access_rejected'
            : response.status === 429
              ? 'rate_limit'
              : response.status >= 300 && response.status < 400
                ? 'redirect'
                : 'http_rejected',
        );
      if (typeof response.data !== 'string')
        throw new OwnerSearchStopped('invalid_response');
      const { content, items } = responseContent(response.data);
      for (const candidate of searchArticleCandidates(
        items,
        { name: input.name, biz: input.biz },
        { source: 'owner-web-search', capturedAt, page: n },
      )) {
        const old = candidates.get(candidate.id);
        if (old && old.url !== candidate.url)
          throw new OwnerSearchStopped('identity_conflict');
        candidates.set(candidate.id, candidate);
      }
      pages++;
      const more = [true, 1].includes(content.continueFlag);
      truncated = more;
      if (!more || n === (input.maxPages || 1)) break;
      if (
        !Number.isSafeInteger(content.offset) ||
        content.offset <= body.offset ||
        content.offset > 1000000 ||
        !(
          (typeof content.searchID === 'string' &&
            content.searchID.length > 0 &&
            content.searchID.length <= 8192) ||
          Number.isSafeInteger(content.searchID)
        ) ||
        !content.cookies ||
        JSON.stringify(content.cookies).length > 8192
      )
        throw new OwnerSearchStopped('invalid_cursor');
      body = {
        query: input.name,
        offset: content.offset,
        searchid: content.searchID,
        searchcookies: content.cookies,
      };
    }
    delete state.stops![sessionKey];
    await write(state);
    return {
      candidates: [...candidates.values()],
      pages,
      requests,
      capturedAt,
      truncated,
      coverage: 'search-results' as const,
      complete: false as const,
    };
  } catch (error) {
    if (reserved) {
      state.stops![sessionKey] =
        error instanceof OwnerSearchStopped
          ? error.reason
          : 'request_or_structure_failed';
      await write(state);
    }
    // Axios errors carry request headers; never return/log the raw error.
    throw new OwnerSearchStopped(
      error instanceof OwnerSearchStopped
        ? error.reason
        : 'request_or_structure_failed',
    );
  } finally {
    await lock.close();
    await fs.unlink(input.stateFile + '.lock');
  }
}
