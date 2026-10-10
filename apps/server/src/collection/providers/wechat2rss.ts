import { isIP } from 'node:net';
import { parseWechat2RssJsonFeed } from '../provider-article';
import { ProviderPage, SubscriptionProvider } from '../subscription-provider';
import { canonicalArticleUrl } from '../collection-format';
import { selectWechat2RssSingleCache } from '../../wechat2rss-single-cache';

type ListedFeed = { id: number | string; name: string; link: string };
type IdentityRead = { deadline: number; remainingListRequests: number };
const IDENTITY_CHECK_EXPIRED = 'WECHAT2RSS_IDENTITY_CHECK_EXPIRED';

function privateHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === 'wechat2rss' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
    return true;
  if (isIP(hostname) !== 4) return false;
  const parts = hostname.split('.').map(Number);
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  );
}

export class Wechat2RssProvider implements SubscriptionProvider {
  readonly id = 'wechat2rss' as const;
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    const url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !privateHost(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !token ||
      token.length > 512
    )
      throw new Error('WECHAT2RSS_PRIVATE_CONFIG_INVALID');
    this.base = url;
  }

  /** Never expose upstream URLs or raw responses: k is a secret query parameter. */
  private async get(
    path: string,
    params: Record<string, string> = {},
    deadline?: number,
  ): Promise<unknown> {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    url.searchParams.set('k', this.token);
    const remaining = deadline === undefined ? 10000 : deadline - Date.now();
    if (remaining <= 0) throw new Error(IDENTITY_CHECK_EXPIRED);
    const signal = AbortSignal.timeout(Math.min(10000, remaining));
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal,
      });
      if (response.status !== 200 || !response.body)
        throw new Error('HTTP_STATUS');
      const parts: Buffer[] = [];
      let size = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        size += bytes.length;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error('RESPONSE_TOO_LARGE');
        }
        parts.push(bytes);
      }
      if (deadline !== undefined && Date.now() >= deadline)
        throw new Error(IDENTITY_CHECK_EXPIRED);
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      if (deadline !== undefined && (Date.now() >= deadline || signal.aborted))
        throw new Error(IDENTITY_CHECK_EXPIRED);
      throw new Error('WECHAT2RSS_REQUEST_FAILED');
    }
  }

  private envelope(raw: unknown): Record<string, unknown> {
    if (
      !raw ||
      typeof raw !== 'object' ||
      raw['err'] !== '' ||
      !('data' in raw)
    )
      throw new Error('WECHAT2RSS_UPSTREAM_REJECTED');
    return raw as Record<string, unknown>;
  }

  async listSubscriptions(read?: IdentityRead) {
    const feeds: Array<{ feedId: string; name: string; feedUrl: string }> = [];
    let total: number | null = null;
    for (let page = 1; page <= 20; page++) {
      if (
        read &&
        (Date.now() >= read.deadline || read.remainingListRequests-- <= 0)
      )
        throw new Error(IDENTITY_CHECK_EXPIRED);
      const raw = this.envelope(
        await this.get(
          '/list',
          { page: String(page), size: '50' },
          read?.deadline,
        ),
      );
      if (
        !Array.isArray(raw.data) ||
        !raw.meta ||
        typeof raw.meta !== 'object' ||
        !Number.isSafeInteger(raw.meta['total'])
      )
        throw new Error('WECHAT2RSS_LIST_INVALID');
      total = raw.meta['total'] as number;
      for (const item of raw.data as ListedFeed[]) {
        const id = String(item?.id);
        if (
          !/^\d{5,15}$/.test(id) ||
          typeof item.name !== 'string' ||
          typeof item.link !== 'string'
        )
          throw new Error('WECHAT2RSS_LIST_INVALID');
        const link = new URL(item.link);
        if (
          !/^\/feed\/[A-Za-z0-9_-]+\.(?:xml|json)$/.test(link.pathname) ||
          link.username ||
          link.password
        )
          throw new Error('WECHAT2RSS_FEED_LINK_INVALID');
        feeds.push({
          feedId: `MP_WXS_${id}`,
          name: item.name.trim(),
          feedUrl: link.pathname,
        });
      }
      if (feeds.length >= total) break;
      if (page === 20 || raw.data.length === 0)
        throw new Error('WECHAT2RSS_LIST_INCOMPLETE');
    }
    if (
      new Set(feeds.map((v) => v.feedId)).size !== feeds.length ||
      feeds.length !== total
    )
      throw new Error('WECHAT2RSS_LIST_CONFLICT');
    return feeds;
  }

  async checkAccountStatus(deadline?: number) {
    const raw = this.envelope(await this.get('/login/list', {}, deadline));
    if (!Array.isArray(raw.data))
      throw new Error('WECHAT2RSS_LOGIN_LIST_INVALID');
    const accounts = raw.data as Array<Record<string, unknown>>;
    return {
      available: accounts.some(
        (a) => a.available === true && a.needCheck !== true,
      ),
      challenged: accounts.some((a) => a.needCheck === true),
      retryAfter: accounts.find(
        (a) => a.needCheck === true && typeof a.waitTime === 'string',
      )?.waitTime as string | undefined,
    };
  }

  async acceptSubscription(articleUrl: string) {
    const link = new URL(articleUrl);
    if (
      link.protocol !== 'https:' ||
      link.hostname !== 'mp.weixin.qq.com' ||
      link.username ||
      link.password ||
      link.port ||
      !(link.pathname === '/s' || link.pathname.startsWith('/s/'))
    )
      throw new Error('WECHAT2RSS_ARTICLE_URL_INVALID');
    const raw = this.envelope(
      await this.get('/addurl', { url: link.toString() }),
    );
    if (typeof raw.data !== 'string')
      throw new Error('WECHAT2RSS_ADD_RESPONSE_INVALID');
    const accepted = new URL(raw.data);
    if (
      !['http:', 'https:'].includes(accepted.protocol) ||
      accepted.username ||
      accepted.password ||
      !/^\/feed\/[A-Za-z0-9_-]+\.(xml|json)$/.test(accepted.pathname)
    )
      throw new Error('WECHAT2RSS_ADD_RESPONSE_INVALID');
    // Only a path is retained; host/query may include private configuration.
    return accepted.pathname;
  }

  async resolveAcceptedSubscription(feedPath: string, read?: IdentityRead) {
    if (!/^\/feed\/[A-Za-z0-9_-]+\.(xml|json)$/.test(feedPath))
      throw new Error('WECHAT2RSS_ADD_RESPONSE_INVALID');
    const matches = (await this.listSubscriptions(read)).filter(
      (v) =>
        v.feedUrl.replace(/\.json$/, '.xml') ===
        feedPath.replace(/\.json$/, '.xml'),
    );
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error('WECHAT2RSS_LIST_CONFLICT');
    // An accepted URL/ID may precede publisher metadata. Keep identity pending
    // rather than creating an unnamed subscription from an incomplete cache.
    if (!matches[0].name) return null;
    return {
      feedId: matches[0].feedId,
      name: matches[0].name,
      accepted: true as const,
    };
  }

  /** One foreground add: up to three list checks, six paginated GETs and 35s total.
   * No /addurl replay, detached timer or background polling. */
  async waitForAcceptedSubscription(feedPath: string) {
    const read: IdentityRead = {
      deadline: Date.now() + 35000,
      remainingListRequests: 6,
    };
    try {
      for (const delay of [0, 3000, 27000]) {
        if (delay) {
          if (
            read.remainingListRequests <= 0 ||
            Date.now() + delay >= read.deadline
          )
            return null;
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          const account = await this.checkAccountStatus(read.deadline);
          if (!account.available)
            throw new Error(
              account.challenged
                ? 'WECHAT2RSS_ACCOUNT_CHALLENGED'
                : 'WECHAT2RSS_ACCOUNT_UNAVAILABLE',
            );
        }
        const accepted = await this.resolveAcceptedSubscription(feedPath, read);
        if (accepted) return accepted;
      }
      return null;
    } catch (error) {
      if (error instanceof Error && error.message === IDENTITY_CHECK_EXPIRED)
        return null;
      throw error;
    }
  }

  async addSubscription(articleUrl: string) {
    const path = await this.acceptSubscription(articleUrl);
    const accepted = await this.resolveAcceptedSubscription(path);
    if (!accepted) throw new Error('WECHAT2RSS_ACCEPTED_ID_PENDING');
    return accepted;
  }

  async refreshSubscription(feedId: string) {
    if (!/^MP_WXS_\d{5,15}$/.test(feedId))
      throw new Error('WECHAT2RSS_FEED_ID_INVALID');
    if (!(await this.listSubscriptions()).some((v) => v.feedId === feedId))
      throw new Error('WECHAT2RSS_SUBSCRIPTION_MISSING');
    this.envelope(await this.get(`/add/${feedId.slice(7)}`));
    return { accepted: true as const, pending: true as const };
  }

  /** Read one already-subscribed cache only. No /addurl, /add or original-page fetch. */
  async fetchSingleCachedArticle(articleUrl: string) {
    const identity = canonicalArticleUrl(articleUrl);
    const matches = (await this.listSubscriptions()).filter(
      (v) => v.feedId === identity.mpId,
    );
    if (matches.length !== 1)
      throw new Error('WECHAT2RSS_SUBSCRIPTION_MISSING');
    const raw = await this.get(matches[0].feedUrl.replace(/\.xml$/, '.json'));
    return selectWechat2RssSingleCache(raw, articleUrl);
  }

  async fetchArticles(
    feedId: string,
    expectedName?: string,
  ): Promise<ProviderPage> {
    if (!/^MP_WXS_\d{5,15}$/.test(feedId))
      throw new Error('WECHAT2RSS_FEED_ID_INVALID');
    const matches = (await this.listSubscriptions()).filter(
      (v) => v.feedId === feedId,
    );
    if (matches.length !== 1)
      throw new Error('WECHAT2RSS_SUBSCRIPTION_MISSING');
    if (expectedName && matches[0].name !== expectedName)
      throw new Error('WECHAT2RSS_SUBSCRIPTION_NAME_CHANGED');
    const path = matches[0].feedUrl.replace(/\.xml$/, '.json');
    return parseWechat2RssJsonFeed(await this.get(path), feedId);
  }
}
