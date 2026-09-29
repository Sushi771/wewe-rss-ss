import { canonicalArticleUrl } from './collection-format';

/** Article identities must come from a verifiable original URL, never a title or position. */
export type ProviderArticle = {
  id: string;
  mpId: string;
  url: string;
  title: string;
  publishTime: number;
  contentHtml: string | null;
  picUrl: string;
};

export type ProviderPage = {
  articles: ProviderArticle[];
  coverage: 'recent-window' | 'stored-history-window';
  upstreamCount: number;
  bodyMissing: number;
  imageBlocked: number;
};

/** Reject an adapter's malformed page before image requests or article writes. */
export function assertProviderPage(
  page: ProviderPage,
  expectedMpId: string,
): ProviderPage {
  if (
    !page ||
    !Array.isArray(page.articles) ||
    page.articles.length > 1000 ||
    !['recent-window', 'stored-history-window'].includes(page.coverage) ||
    ![page.upstreamCount, page.bodyMissing, page.imageBlocked].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    page.upstreamCount < page.articles.length ||
    page.bodyMissing > page.articles.length
  )
    throw new Error('PROVIDER_PAGE_INVALID');
  const ids = new Set<string>();
  for (const article of page.articles) {
    let identity: ReturnType<typeof canonicalArticleUrl>;
    try {
      identity = canonicalArticleUrl(article?.url);
    } catch {
      throw new Error('PROVIDER_ARTICLE_IDENTITY_INVALID');
    }
    if (
      article.id !== identity.id ||
      article.mpId !== expectedMpId ||
      identity.mpId !== expectedMpId ||
      ids.has(identity.id)
    )
      throw new Error('PROVIDER_ARTICLE_IDENTITY_INVALID');
    ids.add(identity.id);
    if (
      typeof article.title !== 'string' ||
      !article.title.trim() ||
      article.title.length > 1000 ||
      !Number.isSafeInteger(article.publishTime) ||
      article.publishTime < 946684800 ||
      article.publishTime > Math.floor(Date.now() / 1000) + 300 ||
      !(
        article.contentHtml === null || typeof article.contentHtml === 'string'
      ) ||
      typeof article.picUrl !== 'string'
    )
      throw new Error('PROVIDER_ARTICLE_METADATA_INVALID');
  }
  return page;
}

export interface SubscriptionProvider {
  readonly id: 'wechat2rss';
  addSubscription(articleUrl: string): Promise<{
    feedId: string;
    name: string;
    accepted: true;
  }>;
  listSubscriptions(): Promise<
    Array<{ feedId: string; name: string; feedUrl: string }>
  >;
  checkAccountStatus(): Promise<{
    available: boolean;
    challenged: boolean;
    retryAfter?: string;
  }>;
  refreshSubscription(
    feedId: string,
  ): Promise<{ accepted: true; pending: true }>;
  fetchArticles(feedId: string, expectedName?: string): Promise<ProviderPage>;
}
