import { fetchPublicAlbums } from '../public-album';
import {
  ProviderPage,
  SubscriptionProvider,
  assertProviderPage,
} from '../subscription-provider';

/** Tencent's selected public albums. No account credential or third-party relay is required. */
export class PublicAlbumProvider implements SubscriptionProvider {
  readonly id = 'public-album' as const;
  constructor(
    private readonly mpId: string,
    private readonly albumIds: string[],
  ) {}

  async addSubscription(): Promise<never> {
    throw new Error('公开合集须显式绑定已核验的公众号与合集 ID');
  }
  async listSubscriptions() {
    return [{ feedId: this.mpId, name: '所选官方合集订阅', feedUrl: '' }];
  }
  async checkAccountStatus() {
    // There is no account to check. Availability is proven only by a successful fetchArticles.
    return { available: false, challenged: false };
  }
  async refreshSubscription(
    feedId: string,
  ): Promise<{ accepted: true; pending: true }> {
    void feedId;
    throw new Error('公开合集同步读取，无异步更新任务；请调用 fetchArticles');
  }
  async fetchArticles(feedId: string): Promise<ProviderPage> {
    if (feedId !== this.mpId) throw new Error('公开合集公众号绑定不一致');
    const result = await fetchPublicAlbums(feedId, this.albumIds);
    return assertProviderPage(
      {
        articles: result.articles.map((item) => ({
          ...item,
          contentHtml: null,
        })),
        coverage: 'selected-albums',
        upstreamCount: result.articles.length,
        bodyMissing: result.articles.length,
        imageBlocked: 0,
        pages: result.pages,
        albums: result.albums,
      },
      feedId,
    );
  }
}
