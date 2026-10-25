import { XhsSubscriptionError } from './xhs-subscription-errors';

export function xhsPublicInputUrl(raw: string) {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length > 8192 ||
      /[\\\s\x00-\x1f\x7f]/.test(raw) ||
      /^https:\/\/[^/]*:\d+(?:\/|$)/i.test(raw)
    )
      throw Error();
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      throw Error();
    if (url.hostname === 'xhslink.com') {
      if (
        !/^\/(?:a\/)?[a-zA-Z0-9_-]{1,128}\/?$/.test(url.pathname) ||
        url.search
      )
        throw Error();
    } else if (url.hostname === 'xhslink.cn') {
      if (!/^\/o\/[a-zA-Z0-9_-]{1,128}\/?$/.test(url.pathname) || url.search)
        throw Error();
    } else if (
      url.hostname !== 'www.xiaohongshu.com' ||
      !/^\/(?:user\/profile|explore|discovery\/item)\/[a-zA-Z0-9_-]{1,128}\/?$/.test(
        url.pathname,
      )
    )
      throw Error();
    return url;
  } catch {
    throw new XhsSubscriptionError('XHS_SHORT_LINK_REJECTED');
  }
}
/** Injected cookie-free transport only; redirects are inspected one at a time.
 * A transport must enforce timeout/response limits and never send ambient auth. */
export type XhsShortLinkTransport = (
  url: URL,
  options: {
    method: 'GET';
    redirect: 'manual';
    credentials: 'omit';
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  },
) => Promise<{ status: number; url: string; location: string | null }>;
export const fetchXhsShortLink: XhsShortLinkTransport = async (
  url,
  options,
) => {
  const response = await fetch(url, options);
  try {
    return {
      status: response.status,
      url: response.url,
      location: response.headers.get('location'),
    };
  } finally {
    await response.body?.cancel();
  }
};
export class XhsShortLinkResolver {
  constructor(
    private readonly transport: XhsShortLinkTransport = fetchXhsShortLink,
  ) {}
  async resolve(raw: string) {
    let url = xhsPublicInputUrl(raw);
    const seen = new Set<string>();
    for (let hop = 0; ['xhslink.com', 'xhslink.cn'].includes(url.hostname); hop++) {
      if (!this.transport)
        throw new XhsSubscriptionError('XHS_SHORT_LINK_UNAVAILABLE');
      if (hop >= 5 || seen.has(url.href))
        throw new XhsSubscriptionError('XHS_SHORT_LINK_REJECTED');
      seen.add(url.href);
      let response: Awaited<ReturnType<XhsShortLinkTransport>>;
      try {
        response = await this.transport(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: Object.freeze({ accept: 'text/html' }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new XhsSubscriptionError('XHS_SHORT_LINK_UNAVAILABLE');
      }
      if (
        response.url !== url.href ||
        ![301, 302, 303, 307, 308].includes(response.status) ||
        !response.location
      )
        throw new XhsSubscriptionError('XHS_SHORT_LINK_REJECTED');
      try {
        // Inspect the raw Location before WHATWG URL normalization removes an
        // explicit default port or repairs whitespace/backslashes.
        if (
          /[\\\s\x00-\x1f\x7f]/.test(response.location) ||
          /^(?:https:)?\/\/[^/]*:\d+(?:\/|$)/i.test(response.location)
        )
          throw Error();
        url = xhsPublicInputUrl(new URL(response.location, url).href);
      } catch {
        throw new XhsSubscriptionError('XHS_SHORT_LINK_REJECTED');
      }
    }
    return url;
  }
}
