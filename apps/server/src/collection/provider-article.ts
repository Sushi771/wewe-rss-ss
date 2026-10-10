import { load } from 'cheerio';
import { canonicalArticleUrl } from './collection-format';
import { ProviderArticle, ProviderPage } from './subscription-provider';

type JsonFeedItem = Record<string, unknown>;

function originalIdentity(item: JsonFeedItem) {
  const candidates = [item.url, item.external_url, item.id]
    .filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
    .flatMap((v) => {
      try {
        return [canonicalArticleUrl(v)];
      } catch {
        return [];
      }
    });
  if (!candidates.length || candidates.some((v) => v.id !== candidates[0].id))
    throw new Error('WECHAT2RSS_ARTICLE_IDENTITY_UNVERIFIED');
  return candidates[0];
}

function safeImage(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      /(^|\.)(qpic\.cn|qlogo\.cn|qq\.com)$/.test(url.hostname)
    )
      return url.toString();
  } catch {
    // Malformed images cannot be fetched or exported.
  }
  return null;
}

/** Clean untrusted feed HTML before it can reach RSS, Markdown, or the browser. */
function cleanBody(raw: unknown): {
  html: string | null;
  imageBlocked: number;
  cover: string;
} {
  if (typeof raw !== 'string' || !raw.trim())
    return { html: null, imageBlocked: 0, cover: '' };
  if (Buffer.byteLength(raw, 'utf8') > 2_000_000)
    throw new Error('WECHAT2RSS_BODY_TOO_LARGE');
  const $ = load(`<div id="provider-body">${raw}</div>`);
  const body = $('#provider-body');
  body
    .find(
      'script,style,iframe,object,embed,form,input,button,link,meta,svg,base',
    )
    .remove();
  let imageBlocked = 0;
  let cover = '';
  for (const element of body.find('*').toArray()) {
    const node = $(element);
    const source = node.attr('data-src') || node.attr('src') || '';
    const href = node.attr('href') || '';
    for (const attr of Object.keys(element['attribs'] || {}))
      if (!['alt', 'title', 'colspan', 'rowspan'].includes(attr))
        node.removeAttr(attr);
    if (element['tagName'] === 'img') {
      const image = safeImage(source);
      if (image) {
        node.attr('src', image);
        if (!cover) cover = image;
      } else {
        node.remove();
        imageBlocked++;
      }
    } else if (element['tagName'] === 'a') {
      try {
        const link = new URL(href);
        if (
          link.protocol === 'https:' &&
          link.hostname === 'mp.weixin.qq.com' &&
          !link.port &&
          !link.username &&
          !link.password
        )
          node.attr('href', link.toString());
      } catch {
        // Drop invalid links.
      }
    }
  }
  if (!body.text().trim() && !body.find('img[src]').length)
    return { html: null, imageBlocked, cover };
  return {
    // Keep incomplete-image provenance after sanitization; removing an unsafe
    // or source-less tag must not turn it into a complete offline article.
    html: `<div class="rich_media_content" id="js_content"${imageBlocked ? ` data-wewe-image-pending="${imageBlocked}"` : ''}>${body.html()}</div>`,
    imageBlocked,
    cover,
  };
}

/** JSON Feed is a candidate input. A real private instance must still prove its fields. */
export function parseWechat2RssJsonFeed(
  raw: unknown,
  feedId: string,
): ProviderPage {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw['items']))
    throw new Error('WECHAT2RSS_FEED_INVALID');
  const items = raw['items'] as JsonFeedItem[];
  if (items.length > 1000) throw new Error('WECHAT2RSS_FEED_TOO_LARGE');
  const seen = new Set<string>();
  const articles: ProviderArticle[] = [];
  let bodyMissing = 0;
  let imageBlocked = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object')
      throw new Error('WECHAT2RSS_ITEM_INVALID');
    const identity = originalIdentity(item);
    if (identity.mpId !== feedId || seen.has(identity.id))
      throw new Error('WECHAT2RSS_ARTICLE_IDENTITY_CONFLICT');
    seen.add(identity.id);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const date = item.date_published;
    if (
      !title ||
      title.length > 1000 ||
      typeof date !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
        date,
      )
    )
      throw new Error('WECHAT2RSS_ARTICLE_METADATA_INVALID');
    const timestamp = Date.parse(date);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < 946684800000 ||
      timestamp > Date.now() + 300000
    )
      throw new Error('WECHAT2RSS_ARTICLE_DATE_INVALID');
    const body = cleanBody(item.content_html);
    if (!body.html) bodyMissing++;
    imageBlocked += body.imageBlocked;
    const image = typeof item.image === 'string' ? safeImage(item.image) : null;
    articles.push({
      ...identity,
      title,
      publishTime: Math.floor(timestamp / 1000),
      contentHtml: body.html,
      picUrl: image || body.cover,
    });
  }
  return {
    articles,
    coverage: 'recent-window',
    upstreamCount: items.length,
    bodyMissing,
    imageBlocked,
  };
}
