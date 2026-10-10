import { ArticleDownloadError, downloadArticleUrl } from './article-download';
import { canonicalArticleUrl } from './collection/collection-format';
import { wechat2RssProvider } from './collection/provider-registry';
import { assertProviderPage } from './collection/subscription-provider';

/** Only a server-bound accepted task may supply the publisher. Read existing
 * cache, return stable identities, never resolve the user's short URL by title. */
export async function readWechat2RssSingleCandidates(feedId: string) {
  try {
    if (!/^MP_WXS_\d{5,15}$/.test(feedId)) throw new Error();
    const provider = wechat2RssProvider();
    // Collection-account availability cannot invalidate existing authorized
    // cache. This path only reads the same publisher's list/feed and verifies it.
    const page = assertProviderPage(
      await provider.fetchArticles(feedId),
      feedId,
    );
    return page.articles
      .filter((a) => Boolean(a.contentHtml))
      .sort((a, b) => b.publishTime - a.publishTime || a.id.localeCompare(b.id))
      .slice(0, 20)
      .map((a) => {
        const url = downloadArticleUrl(a.url);
        if (canonicalArticleUrl(url).id !== a.id) throw new Error();
        return {
          articleId: a.id,
          title: a.title,
          publishTime: a.publishTime,
          url,
        };
      });
  } catch (error) {
    if (error instanceof ArticleDownloadError) throw error;
    throw new ArticleDownloadError(
      '该公众号可验证缓存暂不可读取；未重新订阅、更新或保存。',
      409,
      { code: 'SINGLE_CANDIDATES_UNAVAILABLE' },
    );
  }
}
