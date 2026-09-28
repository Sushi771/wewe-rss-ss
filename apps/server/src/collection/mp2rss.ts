import got from 'got';
import { load } from 'cheerio';
import {
  articleContentHtml,
  articleIdentity,
  articlePageRequest,
  articlePublishTime,
} from './article-page';

const API = 'https://mp2rss.bugcode.dev/open-api';
const SHORT_URL = /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{22}$/;

export type Mp2RssArticle = ReturnType<typeof articleIdentity> & {
  title: string;
  shortUrl: string | null;
  picUrl: string;
  contentHtml: string | null;
};

type Subscription = { sourceType: string; mpId: number; mpName: string };
type ListedArticle = {
  mpId: number;
  articleId: string;
  title: string;
  originalUrl: string;
  publishedAt: number;
};

function preciseName(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

/** A feed name is only a discovery hint; every returned original page must prove its WeChat mpId. */
export async function fetchMp2RssRecent20(
  mpId: string,
  mpName: string,
): Promise<Mp2RssArticle[]> {
  const key = process.env.MP2RSS_FEED_KEY?.trim();
  if (!key) throw new Error('MP2RSS_FEED_KEY_NOT_CONFIGURED');
  const client = got.extend({
    prefixUrl: API,
    headers: { authorization: `Bearer ${key}` },
    timeout: { request: 20000 },
    retry: { limit: 2, methods: ['GET'] },
  });
  const matching: Subscription[] = [];
  for (let page = 1; page <= 20; page++) {
    const response: any = await client
      .get('subscriptions', {
        searchParams: { sourceType: 'mp', page, pageSize: 50 },
      })
      .json();
    if (!Array.isArray(response?.items))
      throw new Error('MP2RSS_SUBSCRIPTIONS_INVALID');
    matching.push(
      ...response.items.filter(
        (item: Subscription) =>
          item?.sourceType === 'mp' &&
          Number.isSafeInteger(item.mpId) &&
          preciseName(item.mpName || '') === preciseName(mpName),
      ),
    );
    if (response.items.length < 50) break;
    if (page === 20) throw new Error('MP2RSS_SUBSCRIPTIONS_LIMIT');
  }
  if (matching.length !== 1) throw new Error('MP2RSS_ACCOUNT_NOT_UNIQUE');
  const upstreamId = matching[0].mpId;
  const response: any = await client
    .get(`subscriptions/${upstreamId}/articles`, {
      searchParams: { page: 1, pageSize: 20 },
    })
    .json();
  if (!Array.isArray(response?.items) || response.items.length === 0)
    throw new Error('MP2RSS_ARTICLES_EMPTY_OR_INVALID');
  if (response.items.length > 20) throw new Error('MP2RSS_ARTICLES_INVALID');
  const seen = new Set<string>();
  const verified: Mp2RssArticle[] = [];
  for (const item of response.items as ListedArticle[]) {
    if (
      item?.mpId !== upstreamId ||
      !item.articleId ||
      !item.title?.trim() ||
      !Number.isSafeInteger(item.publishedAt) ||
      !item.originalUrl
    )
      throw new Error('MP2RSS_ARTICLES_INVALID');
    const url = new URL(item.originalUrl);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.port ||
      url.username ||
      url.password ||
      (url.pathname !== '/s' && !SHORT_URL.test(item.originalUrl))
    )
      throw new Error('MP2RSS_ORIGINAL_URL_INVALID');
    const html = await articlePageRequest.get(item.originalUrl).text();
    const identity = articleIdentity(html);
    const $ = load(html);
    const title = $('#activity-name').text().trim();
    const publishTime = articlePublishTime(html);
    if (
      identity.mpId !== mpId ||
      preciseName(title) !== preciseName(item.title) ||
      publishTime == null ||
      Math.abs(publishTime * 1000 - item.publishedAt) > 86400000 ||
      seen.has(identity.id)
    )
      throw new Error('MP2RSS_ORIGINAL_IDENTITY_MISMATCH');
    seen.add(identity.id);
    const image = $('meta[property="og:image"]').attr('content') || '';
    let picUrl = '';
    try {
      const parsed = new URL(image);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password)
        picUrl = parsed.toString();
    } catch {
      // A missing cover is allowed; an unverified image is never persisted.
    }
    verified.push({
      ...identity,
      title,
      publishTime,
      shortUrl: SHORT_URL.test(item.originalUrl) ? item.originalUrl : null,
      picUrl,
      contentHtml: articleContentHtml(html) || null,
    });
  }
  return verified;
}
