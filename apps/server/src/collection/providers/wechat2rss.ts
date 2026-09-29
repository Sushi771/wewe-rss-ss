import { isIP } from 'node:net';
import { parseWechat2RssJsonFeed } from '../provider-article';
import { ProviderPage, SubscriptionProvider } from '../subscription-provider';

type ListedFeed = { id: number | string; name: string; link: string };

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
  ): Promise<unknown> {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    url.searchParams.set('k', this.token);
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
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
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
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

  async listSubscriptions() {
    const feeds: Array<{ feedId: string; name: string; feedUrl: string }> = [];
    let total: number | null = null;
    for (let page = 1; page <= 20; page++) {
      const raw = this.envelope(
        await this.get('/list', { page: String(page), size: '50' }),
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

  async checkAccountStatus() {
    const raw = this.envelope(await this.get('/login/list'));
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

  async addSubscription(articleUrl: string) {
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
    const matches = (await this.listSubscriptions()).filter(
      (v) => v.feedUrl === accepted.pathname,
    );
    if (matches.length !== 1) throw new Error('WECHAT2RSS_ACCEPTED_ID_PENDING');
    return {
      feedId: matches[0].feedId,
      name: matches[0].name,
      accepted: true as const,
    };
  }

  async refreshSubscription(feedId: string) {
    if (!/^MP_WXS_\d{5,15}$/.test(feedId))
      throw new Error('WECHAT2RSS_FEED_ID_INVALID');
    if (!(await this.listSubscriptions()).some((v) => v.feedId === feedId))
      throw new Error('WECHAT2RSS_SUBSCRIPTION_MISSING');
    this.envelope(await this.get(`/add/${feedId.slice(7)}`));
    return { accepted: true as const, pending: true as const };
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
