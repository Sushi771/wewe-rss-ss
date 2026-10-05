import { ownerSessionCookie, OwnerWebSession } from './owner-web-search';

const HOST = 'weread.qq.com';
const NAMES = new Set(['wr_pf', 'wr_ql', 'wr_rt', 'wr_skey', 'wr_vid']);
export const NORMAL_WEB_RENEWAL_URL = 'https://weread.qq.com/web/login/renewal';
export type ReceivedRenewalCookieMetadata = {
  name: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: number | null;
  maxAge?: number;
  expires?: string;
};
type WebCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: number;
};
const invalid = () => new Error('OWNER_WEB_COOKIE_INVALID');
const pathMatches = (requestPath: string, cookiePath: string) =>
  requestPath === cookiePath ||
  (requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
const defaultPath = (pathname: string) =>
  pathname.slice(0, pathname.lastIndexOf('/')) || '/';

/** A bounded operation-local jar, never persisted to the owner's saved session.
 * The installed cookiejar lacks Max-Age and RFC path/domain boundaries; this
 * restricted client accepts only the existing Web authentication names and host.
 */
export class OwnerWebCookieLifecycle {
  private cookies: WebCookie[];
  private readonly initial: WebCookie[];
  constructor(
    session: OwnerWebSession,
    private readonly ownerVid: string,
    now = Date.now(),
  ) {
    ownerSessionCookie(session, ownerVid, now);
    this.cookies = session.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: HOST,
      hostOnly: !c.domain.startsWith('.'),
      path: c.path,
      secure: c.secure,
      expiresAt: c.expires === -1 ? Infinity : c.expires * 1000,
    }));
    this.initial = this.cookies.map((c) => ({ ...c }));
  }

  header(url: string, now = Date.now()) {
    const target = new URL(url);
    // Fixed HTTPS origin also prevents forwarding even non-Secure login cookies.
    if (target.protocol !== 'https:' || target.hostname !== HOST || target.port)
      throw invalid();
    this.cookies = this.cookies.filter((c) => c.expiresAt > now);
    const selected = this.cookies.filter(
      (c) =>
        (c.hostOnly
          ? target.hostname === c.domain
          : target.hostname === c.domain ||
            target.hostname.endsWith('.' + c.domain)) &&
        pathMatches(target.pathname, c.path) &&
        (!c.secure || target.protocol === 'https:'),
    );
    if (
      !selected.some((c) => c.name === 'wr_skey' && c.value) ||
      !selected.some((c) => c.name === 'wr_vid' && c.value === this.ownerVid)
    )
      throw invalid();
    return selected
      .sort(
        (a, b) => b.path.length - a.path.length || a.name.localeCompare(b.name),
      )
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  absorb(url: string, setCookie: unknown, now = Date.now()) {
    this.absorbResponse(url, setCookie, now);
  }

  /** Only a successful response from this fixed endpoint may add wr_pf or
   * omit Secure. Effective client restrictions stay at least as strong as the
   * initial session; the received server attributes are recorded separately. */
  absorbNormalRenewal(
    response: {
      url: string;
      status: number;
      data: unknown;
      setCookies: unknown;
    },
    now = Date.now(),
  ) {
    const data = response.data as Record<string, unknown>;
    if (
      response.url !== NORMAL_WEB_RENEWAL_URL ||
      response.status !== 200 ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      ![true, 1, '1'].includes(data.succ as any) ||
      ['errCode', 'errcode', 'code'].some(
        (key) => data[key] !== undefined && data[key] !== 0,
      )
    )
      throw invalid();
    return this.absorbResponse(response.url, response.setCookies, now, true);
  }

  /** A validated snapshot with effective scope and finite server expiry. */
  sessionCookies(now = Date.now()): OwnerWebSession['cookies'] {
    const result = this.cookies
      .filter((c) => c.expiresAt > now)
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.hostOnly ? c.domain : '.' + c.domain,
        path: c.path,
        secure: c.secure,
        expires: c.expiresAt === Infinity ? -1 : c.expiresAt / 1000,
      }));
    return result;
  }

  private absorbResponse(
    url: string,
    setCookie: unknown,
    now: number,
    renewal = false,
  ): ReceivedRenewalCookieMetadata[] {
    const source = new URL(url);
    if (source.protocol !== 'https:' || source.hostname !== HOST || source.port)
      throw invalid();
    if (setCookie === undefined) {
      if (renewal) throw invalid();
      return [];
    }
    // Axios exposes each Set-Cookie separately; never comma-split Expires dates.
    const headers = typeof setCookie === 'string' ? [setCookie] : setCookie;
    if (!Array.isArray(headers) || headers.length > 50) throw invalid();
    const next = this.cookies.map((c) => ({ ...c }));
    const received: ReceivedRenewalCookieMetadata[] = [];
    const renewalNames = new Set<string>();
    for (const raw of headers) {
      if (
        typeof raw !== 'string' ||
        raw.length > 8192 ||
        /[\x00-\x1f\x7f]/.test(raw)
      )
        throw invalid();
      // Semicolons delimit attributes; all routing/expiry attributes are parsed.
      const parts = raw.split(';');
      const pair = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([^;]*)$/.exec(
        parts.shift() || '',
      );
      if (!pair) throw invalid();
      const name = pair[1];
      if (!NAMES.has(name)) {
        if (renewal) throw invalid();
        continue;
      }
      if (renewal && renewalNames.has(name)) throw invalid();
      renewalNames.add(name);
      const value = pair[2].trim();
      if (/[\s,]/.test(value)) throw invalid();
      if (renewal && /[^\x21-\x7e]/.test(value)) throw invalid();
      let domain = HOST,
        hostOnly = true,
        cookiePath = defaultPath(source.pathname),
        secure = false,
        expiresAt = Infinity;
      let maxAge: number | undefined;
      let expires: string | undefined;
      const attributes = new Set<string>();
      for (const part of parts) {
        const equal = part.indexOf('=');
        const key = (equal < 0 ? part : part.slice(0, equal))
          .trim()
          .toLowerCase();
        const attribute = equal < 0 ? '' : part.slice(equal + 1).trim();
        if (
          renewal &&
          ['domain', 'path', 'secure', 'max-age', 'expires'].includes(key)
        ) {
          if (attributes.has(key)) throw invalid();
          attributes.add(key);
        }
        switch (key) {
          case 'domain':
            domain = attribute.toLowerCase().replace(/^\./, '');
            // A parent domain would broaden the saved platform scope.
            if (domain !== HOST) throw invalid();
            hostOnly = false;
            break;
          case 'path':
            if (renewal && !['/', '/web'].includes(attribute)) throw invalid();
            cookiePath = attribute.startsWith('/')
              ? attribute
              : defaultPath(source.pathname);
            break;
          case 'secure':
            secure = true;
            break;
          case 'max-age':
            if (renewal && !/^-?\d+$/.test(attribute)) throw invalid();
            if (/^-?\d+$/.test(attribute)) {
              const seconds = Number(attribute);
              if (!Number.isSafeInteger(seconds)) throw invalid();
              maxAge = seconds;
            }
            break;
          case 'expires': {
            expires = attribute;
            const parsed = Date.parse(attribute);
            if (renewal && !Number.isFinite(parsed)) throw invalid();
            if (Number.isFinite(parsed)) expiresAt = parsed;
            break;
          }
        }
      }
      if (maxAge !== undefined)
        expiresAt = maxAge <= 0 ? 0 : now + maxAge * 1000;
      if (
        renewal &&
        maxAge !== undefined &&
        !Number.isSafeInteger(maxAge * 1000)
      )
        throw invalid();
      if (renewal && !Number.isFinite(expiresAt) && expiresAt !== Infinity)
        throw invalid();
      // An absent auxiliary cookie may be deleted. A successful renewal must
      // actually supply a usable new key and explicit matching server owner.
      if (
        renewal &&
        ['wr_vid', 'wr_skey'].includes(name) &&
        (!value || expiresAt <= now)
      )
        throw invalid();
      const ownSeed = this.initial.filter((c) => c.name === name);
      const seed = ownSeed.length
        ? ownSeed
        : this.initial.filter(
            (c) => renewal && name === 'wr_pf' && c.name === 'wr_skey',
          );
      if (renewal) {
        received.push({
          name,
          domain,
          hostOnly,
          path: cookiePath,
          secure,
          expiresAt: expiresAt === Infinity ? null : expiresAt,
          ...(maxAge === undefined ? {} : { maxAge }),
          ...(expires === undefined ? {} : { expires }),
        });
        // Preserve a host-only seed and HTTPS-only policy even when the
        // official endpoint omits Secure or returns a Domain attribute.
        hostOnly ||= seed.some((c) => c.hostOnly);
        secure ||= seed.some((c) => c.secure);
      }
      if (
        !seed.length ||
        !seed.some(
          (c) =>
            (!c.hostOnly || hostOnly) &&
            pathMatches(cookiePath, c.path) &&
            (!c.secure || secure),
        )
      )
        throw invalid();
      if (name === 'wr_vid' && (value !== this.ownerVid || expiresAt <= now))
        throw invalid();
      const same = (c: WebCookie) =>
        c.name === name && c.domain === domain && c.path === cookiePath;
      const previous = next.find(same);
      // A narrower response must never weaken an already narrowed scope.
      if (
        previous &&
        ((previous.hostOnly && !hostOnly) || (previous.secure && !secure))
      )
        throw invalid();
      if (renewal) {
        // A maintenance snapshot holds one credential per name. Replace its
        // former scope instead of retaining a stale, broader old credential.
        for (let i = next.length - 1; i >= 0; i--)
          if (next[i].name === name) next.splice(i, 1);
      } else {
        const index = next.findIndex(same);
        if (index !== -1) next.splice(index, 1);
      }
      if (expiresAt > now && value)
        next.push({
          name,
          value,
          domain,
          hostOnly,
          path: cookiePath,
          secure,
          expiresAt,
        });
      if (next.length > 25) throw invalid();
    }
    if (
      renewal &&
      (!renewalNames.has('wr_vid') || !renewalNames.has('wr_skey'))
    )
      throw invalid();
    this.cookies = next;
    return received;
  }
}
