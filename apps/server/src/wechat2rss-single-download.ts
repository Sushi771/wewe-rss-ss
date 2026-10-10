import { ArticleDownloadError, downloadArticleUrl } from './article-download';
import { canonicalArticleUrl } from './collection/collection-format';
import { wechat2RssProvider } from './collection/provider-registry';
import { archiveProviderImages } from './collection/archive-provider-images';
import { prepareVerifiedProviderDownload } from './article-verified-download';

const fail = (code: string, message: string, status = 422) =>
  new ArticleDownloadError(message, status, { code, stage: 'article' });

/** The normal tool's only article source is the configured private Wechat2RSS
 * cache. Media archiving is separate; it never fetches an article's public page.
 */
export async function prepareWechat2RssSingleDownload(
  raw: unknown,
  feedId?: string,
) {
  const requested = downloadArticleUrl(raw);
  const short = new URL(requested).pathname !== '/s';
  const identity = short ? null : canonicalArticleUrl(requested);
  let article;
  try {
    article = await wechat2RssProvider().fetchSingleCachedArticle(
      requested,
      feedId,
    );
  } catch (error) {
    if (error instanceof ArticleDownloadError) throw error;
    const code = error instanceof Error ? error.message : '';
    if (
      code === 'WECHAT2RSS_DISABLED' ||
      code === 'WECHAT2RSS_PRIVATE_CONFIG_INVALID'
    )
      throw fail(
        'WECHAT2RSS_SINGLE_UNCONFIGURED',
        'Wechat2RSS 未启用或配置不可用；未保存，不使用其他来源。',
        409,
      );
    if (code === 'WECHAT2RSS_SUBSCRIPTION_MISSING')
      throw fail(
        'WECHAT2RSS_SINGLE_NOT_SUBSCRIBED',
        'Wechat2RSS 尚未订阅该公众号，需先完成按需订阅后读取缓存正文。',
        409,
      );
    if (code === 'WECHAT2RSS_SINGLE_SHORT_IDENTITY_UNVERIFIED')
      throw fail(
        'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
        'Wechat2RSS 缓存没有该短链接与原文的可靠映射，未保存。公众号缓存就绪后需明确选择目标文章。',
        409,
      );
    if (code === 'WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE')
      throw fail(
        'WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE',
        'Wechat2RSS 缓存中的图片链接无法核验，未保存正文或图片。',
      );
    throw fail(
      'WECHAT2RSS_SINGLE_CACHE_READ_FAILED',
      'Wechat2RSS 缓存读取或文章身份核验失败；未保存，不重试或切换来源。',
    );
  }
  if (!article)
    throw fail(
      short
        ? 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE'
        : 'WECHAT2RSS_SINGLE_CACHE_MISS',
      short
        ? 'Wechat2RSS 缓存没有该短链接与原文的可靠映射，未保存。公众号缓存就绪后需明确选择目标文章。'
        : '该文章不在 Wechat2RSS 当前缓存中；需先完成按需订阅后核对，服务不保证历史文章。',
      409,
    );
  if (!article.contentHtml)
    throw fail(
      'WECHAT2RSS_SINGLE_BODY_MISSING',
      'Wechat2RSS 已有文章记录，但缓存正文尚未完整取得；未保存，不使用其他来源。',
      409,
    );
  // Verify selected identity before any media resource request.
  if (short ? article.shortUrl !== requested : article.url !== identity!.url)
    throw fail(
      'WECHAT2RSS_SINGLE_IDENTITY_MISMATCH',
      'Wechat2RSS 缓存原文与输入链接不一致；未保存，不猜测文章身份。',
    );
  let archived;
  try {
    archived = await archiveProviderImages(
      {
        articles: [article],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: 0,
        imageBlocked: 0,
      },
      { stopOnFailure: true },
    );
  } catch {
    throw fail(
      'WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE',
      'Wechat2RSS 正文已匹配，但图片资源下载或字节校验失败；未保存正文或图片。',
    );
  }
  const prepare = prepareVerifiedProviderDownload(
    requested,
    archived.articles[0],
    true,
  );
  return async (directory: string) => ({
    ...(await prepare(directory)),
    source: 'wechat2rss' as const,
  });
}
