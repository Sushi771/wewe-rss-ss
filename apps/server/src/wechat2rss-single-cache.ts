import { canonicalArticleUrl } from './collection/collection-format';
import { parseWechat2RssJsonFeed } from './collection/provider-article';
import { assertProviderPage } from './collection/subscription-provider';
import { downloadArticleUrl, inertDownloadBody } from './article-download';
import { load } from 'cheerio';

/** Match the original stable identity before cleaning the selected cached body.
 * Short URLs require an exact alias and stable original in the same feed item.
 * No title/date guessing, publisher scan, article request or subscription write.
 */
export function selectWechat2RssSingleCache(raw: unknown, requested: string) {
  const short = new URL(requested).pathname.startsWith('/s/');
  const identity = short ? null : canonicalArticleUrl(requested);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw['items']))
    throw new Error('WECHAT2RSS_FEED_INVALID');
  if (raw['items'].length > 1000) throw new Error('WECHAT2RSS_FEED_TOO_LARGE');
  const matches = raw['items'].filter((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    return ['url', 'external_url', 'id'].some((key) => {
      try {
        return short
          ? downloadArticleUrl(item[key]) === requested
          : canonicalArticleUrl(item[key]).id === identity!.id;
      } catch {
        return false;
      }
    });
  });
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('WECHAT2RSS_SINGLE_CACHE_CONFLICT');
  const selected = matches[0];
  const originals = ['url', 'external_url', 'id'].flatMap((key) => {
    try {
      return [canonicalArticleUrl(selected[key])];
    } catch {
      return [];
    }
  });
  const original = identity || originals[0];
  if (!original) throw new Error('WECHAT2RSS_SINGLE_SHORT_IDENTITY_UNVERIFIED');
  // Generic feed cleaning removes players. Inspect before that information is lost.
  if (typeof selected.content_html === 'string' && selected.content_html.trim())
    inertDownloadBody(`<div id="js_content">${selected.content_html}</div>`);
  const page = assertProviderPage(
    parseWechat2RssJsonFeed({ items: [selected] }, original.mpId),
    original.mpId,
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
  return {
    ...page.articles[0],
    ...(short ? { shortUrl: requested } : {}),
  };
}
