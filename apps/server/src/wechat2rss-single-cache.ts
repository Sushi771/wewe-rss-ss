import { canonicalArticleUrl } from './collection/collection-format';
import { parseWechat2RssJsonFeed } from './collection/provider-article';
import { assertProviderPage } from './collection/subscription-provider';
import { inertDownloadBody } from './article-download';
import { load } from 'cheerio';

/** Match the original stable identity before cleaning the selected cached body.
 * No title/date guessing, publisher scan, article request or subscription write.
 */
export function selectWechat2RssSingleCache(raw: unknown, requested: string) {
  const identity = canonicalArticleUrl(requested);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw['items']))
    throw new Error('WECHAT2RSS_FEED_INVALID');
  if (raw['items'].length > 1000) throw new Error('WECHAT2RSS_FEED_TOO_LARGE');
  const matches = raw['items'].filter((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    return ['url', 'external_url', 'id'].some((key) => {
      try {
        return canonicalArticleUrl(item[key]).id === identity.id;
      } catch {
        return false;
      }
    });
  });
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('WECHAT2RSS_SINGLE_CACHE_CONFLICT');
  const selected = matches[0];
  // Generic feed cleaning removes players. Inspect before that information is lost.
  if (typeof selected.content_html === 'string' && selected.content_html.trim())
    inertDownloadBody(`<div id="js_content">${selected.content_html}</div>`);
  const page = assertProviderPage(
    parseWechat2RssJsonFeed({ items: [selected] }, identity.mpId),
    identity.mpId,
  );
  if (page.imageBlocked)
    throw new Error('WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE');
  // An original article URL disguised as an image must not reopen page fetching.
  for (const image of load(page.articles[0].contentHtml || '')(
    'img',
  ).toArray()) {
    const source = new URL(image.attribs.src);
    if (
      source.hostname === 'mp.weixin.qq.com' &&
      /^\/s(?:\/|$)/.test(source.pathname)
    )
      throw new Error('WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE');
  }
  return page.articles[0];
}
