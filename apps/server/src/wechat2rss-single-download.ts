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
export async function prepareWechat2RssSingleDownload(raw: unknown) {
  const requested = downloadArticleUrl(raw);
  if (new URL(requested).pathname !== '/s')
    throw fail(
      'WECHAT2RSS_SINGLE_LONG_URL_REQUIRED',
      '仅使用 Wechat2RSS 下载；此短链接没有可核验的缓存身份映射，请使用含 __biz、mid、idx 的完整原文链接。不会直连原页或自动新增公众号。',
      409,
    );
  const identity = canonicalArticleUrl(requested);
  let article;
  try {
    article = await wechat2RssProvider().fetchSingleCachedArticle(requested);
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
        'Wechat2RSS 尚未订阅该公众号；本工具不会自动订阅整个号或触发更新，未保存。',
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
      'WECHAT2RSS_SINGLE_CACHE_MISS',
      '该文章不在 Wechat2RSS 当前订阅缓存中；未保存，不直连原页、自动新增或强制更新。',
      409,
    );
  if (!article.contentHtml)
    throw fail(
      'WECHAT2RSS_SINGLE_BODY_MISSING',
      'Wechat2RSS 已有文章记录，但缓存正文尚未完整取得；未保存，不使用其他来源。',
      409,
    );
  // Verify selected identity before any media resource request.
  if (article.url !== identity.url)
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
  );
  return async (directory: string) => ({
    ...(await prepare(directory)),
    source: 'wechat2rss' as const,
  });
}
