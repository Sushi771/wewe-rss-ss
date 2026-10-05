/** The target comes from this response's Location, never from a fabricated URL. */
export type ArticleVerification =
  | { status: 'available'; articleUrl: string; url: string }
  | {
      status: 'unavailable';
      articleUrl: string;
      reason: 'missing-location' | 'unsafe-location' | 'sensitive-location';
    };

export type TimedArticleVerification =
  | (Extract<ArticleVerification, { status: 'available' }> & {
      expiresAt: string;
    })
  | Extract<ArticleVerification, { status: 'unavailable' }>
  | { status: 'unavailable'; articleUrl: string; reason: 'expired' };

export const ARTICLE_VERIFICATION_TTL_MS = 5 * 60 * 1000;

const paths = new Set(['/mp/wappoc_appmsgcaptcha', '/mp/verify']);
const nestedKeys = new Set([
  'url',
  'target',
  'target_url',
  'redirect',
  'redirect_url',
  'redirect_uri',
  'return_url',
  'returnurl',
  'continue',
  'next',
]);
const scalarValues: Record<string, RegExp> = {
  action: /^[A-Za-z_-]{1,64}$/,
  __biz: /^[A-Za-z0-9+/]{1,64}={0,2}$/,
  mid: /^\d{1,20}$/,
  idx: /^[1-9]\d{0,5}$/,
  sn: /^[a-f0-9]{4,64}$/i,
  chksm: /^[a-f0-9]{4,64}$/i,
  lang: /^[A-Za-z_-]{1,16}$/,
  scene: /^\d{1,10}$/,
  timestamp: /^\d{1,16}$/,
  time: /^\d{1,16}$/,
  r: /^\d{1,16}(?:\.\d{1,16})?$/,
  f: /^[A-Za-z0-9_-]{1,32}$/,
};
const articleKeys = new Set([
  '__biz',
  'mid',
  'idx',
  'sn',
  'chksm',
  'appmsgid',
  'itemidx',
  'scene',
  'from',
  'isappinstalled',
  'subscene',
  'ascene',
  'lang',
]);
const sensitiveKey =
  /token|ticket|cookie|skey|secret|password|authorization|session|(?:^|_)(?:key|code|(?:wx)?uin|vid|randstr|signature|sig)(?:$|_)/i;
const sensitiveValue = /^(?:Bearer\s|eyJ[\w-]+\.[\w-]+\.[\w-]+)/i;
const forbidden = /[\\\s\x00-\x1f\x7f]/;

function officialUrl(raw: string, base?: string, articleFragment = false) {
  if (!raw || raw.length > 8192 || forbidden.test(raw)) throw new Error();
  const url = new URL(raw, base);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.port ||
    url.username ||
    url.password ||
    (!articleFragment && url.hash) ||
    /^(?:https:)?\/\/[^/?#]*@/i.test(raw)
  )
    throw new Error();
  return url;
}

function decoded(value: string) {
  for (let count = 0; count < 3 && value.includes('%'); count++) {
    const next = decodeURIComponent(value);
    if (next === value) break;
    value = next;
  }
  if (value.includes('%') || forbidden.test(value)) throw new Error();
  return value;
}

function articleIdentity(url: URL) {
  if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname))
    return url.origin + url.pathname;
  const biz = url.searchParams.get('__biz');
  const mid = url.searchParams.get('mid') || url.searchParams.get('appmsgid');
  const idx = url.searchParams.get('idx') || url.searchParams.get('itemidx');
  const sn = url.searchParams.get('sn');
  if (
    url.pathname !== '/s' ||
    !biz ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(biz) ||
    !mid ||
    !/^\d+$/.test(mid) ||
    !idx ||
    !/^[1-9]\d*$/.test(idx) ||
    !sn ||
    !/^[a-f0-9]{4,64}$/i.test(sn)
  )
    throw new Error();
  if (!/^\d{5,15}$/.test(atob(biz))) throw new Error();
  return JSON.stringify([biz, mid, idx, sn]);
}

/** Public article identity for labels; discard unrelated input tickets/scene data. */
export function verificationArticleUrl(raw: string): string {
  const article = officialUrl(raw.trim(), undefined, true);
  articleIdentity(article);
  if (article.pathname !== '/s') return article.origin + article.pathname;
  const clean = new URL('https://mp.weixin.qq.com/s');
  for (const key of ['__biz', 'mid', 'idx', 'sn']) {
    const value =
      article.searchParams.get(key) ||
      article.searchParams.get(
        key === 'mid' ? 'appmsgid' : key === 'idx' ? 'itemidx' : key,
      );
    if (value) clean.searchParams.set(key, value);
  }
  return clean.href;
}

/** Pure URL policy shared by server and UI. No fetch, storage, navigation or cookies.
 * Unknown paths/parameters fail closed until a real first-party response is reviewed.
 */
export function articleVerificationLocation(
  raw: unknown,
  articleUrl: string,
): ArticleVerification {
  const unavailable = (
    reason: Extract<ArticleVerification, { status: 'unavailable' }>['reason'],
  ): ArticleVerification => ({ status: 'unavailable', articleUrl, reason });
  if (typeof raw !== 'string' || !raw) return unavailable('missing-location');
  try {
    const article = officialUrl(articleUrl);
    const identity = articleIdentity(article);
    const target = officialUrl(raw, articleUrl);
    if (!paths.has(target.pathname)) return unavailable('unsafe-location');
    const seen = new Set<string>();
    for (const [key, value] of target.searchParams) {
      const name = key.toLowerCase();
      if (sensitiveKey.test(name) || sensitiveValue.test(value))
        return unavailable('sensitive-location');
      if (seen.has(name)) return unavailable('unsafe-location');
      seen.add(name);
      if (nestedKeys.has(name)) {
        const nested = officialUrl(decoded(value));
        const nestedSeen = new Set<string>();
        for (const [childKey, childValue] of nested.searchParams) {
          const child = childKey.toLowerCase();
          if (sensitiveKey.test(child) || sensitiveValue.test(childValue))
            return unavailable('sensitive-location');
          if (
            !articleKeys.has(child) ||
            nestedSeen.has(child) ||
            forbidden.test(decoded(childValue))
          )
            return unavailable('unsafe-location');
          nestedSeen.add(child);
        }
        if (articleIdentity(nested) !== identity)
          return unavailable('unsafe-location');
      } else if (
        !Object.prototype.hasOwnProperty.call(scalarValues, name) ||
        !scalarValues[name].test(decoded(value))
      ) {
        return unavailable('unsafe-location');
      }
    }
    return { status: 'available', articleUrl, url: target.href };
  } catch {
    return unavailable('unsafe-location');
  }
}
