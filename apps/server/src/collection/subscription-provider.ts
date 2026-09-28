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
