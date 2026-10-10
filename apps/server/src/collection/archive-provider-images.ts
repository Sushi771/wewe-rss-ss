import { load } from 'cheerio';
import { decodeInlineImage, fetchAllowedImage } from './image-fetch';
import { ProviderArticle, ProviderPage } from './subscription-provider';

// Only this successful archive may supply bytes for supplementing an existing
// body. Keep provenance in memory rather than trusting adapter-supplied fields.
const archivedSources = new WeakMap<ProviderArticle, Map<string, string>>();

/** Preserve the saved body and replace only its exact matching remote images
 * with bytes already fetched by the shared archive. No additional requests. */
export function supplementSavedBodyImages(
  savedHtml: string,
  article: ProviderArticle,
): string | undefined {
  const sources = archivedSources.get(article);
  if (!sources) return undefined;
  const $ = load(savedHtml);
  const body = $('.rich_media_content, #js_content').first();
  if (!body.length) return undefined;
  let changed = false;
  for (const image of body.find('img').toArray()) {
    const el = $(image);
    const src = el.attr('src') || '';
    if (src.startsWith('data:image/')) continue;
    const original = el.attr('data-src') || src;
    const inline = sources.get(original);
    if (!inline) throw new Error('SAVED_BODY_IMAGE_SOURCE_CONFLICT');
    decodeInlineImage(inline);
    el.attr('src', inline);
    el.removeAttr('data-src');
    changed = true;
  }
  if (
    changed &&
    body.attr('data-wewe-image-retryable') === 'true' &&
    !article.contentHtml?.includes('data-wewe-image-pending=')
  ) {
    body.removeAttr('data-wewe-image-pending');
    body.removeAttr('data-wewe-image-retryable');
  }
  return changed ? $.html(body) : undefined;
}

/** Store provider body images inside SQLite so restart and ZIP export do not depend on the CDN. */
export async function archiveProviderImages(
  page: ProviderPage,
  options: {
    stopOnFailure?: boolean;
    preserveTextOnImageFailure?: boolean;
  } = {},
): Promise<ProviderPage> {
  let imageBlocked = page.imageBlocked;
  let bodyMissing = page.bodyMissing;
  const articles: ProviderPage['articles'] = [];
  for (const article of page.articles) {
    const blockedBefore = imageBlocked;
    if (!article.contentHtml) {
      articles.push(article);
      continue;
    }
    const $ = load(article.contentHtml);
    const images = $('img[src]').toArray();
    if (images.length > 60) {
      if (options.stopOnFailure)
        throw new Error('公开合集正文图片超过上限，本批未写入');
      imageBlocked += images.length;
      if (
        options.preserveTextOnImageFailure &&
        $('.rich_media_content, #js_content').first().text().trim()
      ) {
        const body = $('.rich_media_content, #js_content').first();
        body.attr('data-wewe-image-pending', String(images.length));
        body.find('img').remove();
        articles.push({ ...article, contentHtml: $.html(body) });
        continue;
      }
      bodyMissing++;
      articles.push({ ...article, contentHtml: null });
      continue;
    }
    const cached = new Map<string, string>();
    let totalBytes = 0;
    let failed = false;
    for (const image of images) {
      const source = $(image).attr('src') || '';
      try {
        let inline = cached.get(source);
        if (!inline) {
          const result = source.startsWith('data:')
            ? decodeInlineImage(source)
            : await fetchAllowedImage(source);
          totalBytes += result.bytes.length;
          if (totalBytes > 20_000_000)
            throw new Error('ARTICLE_IMAGES_TOO_LARGE');
          inline = `data:${result.type};base64,${result.bytes.toString('base64')}`;
          cached.set(source, inline);
        }
        $(image).attr('src', inline);
        $(image).removeAttr('data-src');
      } catch {
        if (options.stopOnFailure)
          throw new Error(
            '公开合集图片请求受限或内容无效，已停止后续请求；本批未写入',
          );
        failed = true;
        imageBlocked++;
        if (options.preserveTextOnImageFailure)
          $(image).removeAttr('src').attr('data-src', source);
      }
    }
    if (failed) {
      if (
        options.preserveTextOnImageFailure &&
        $('.rich_media_content, #js_content').first().text().trim()
      ) {
        const body = $('.rich_media_content, #js_content').first();
        const previous = Number(body.attr('data-wewe-image-pending') || 0);
        if (!previous) body.attr('data-wewe-image-retryable', 'true');
        body.attr(
          'data-wewe-image-pending',
          String(previous + imageBlocked - blockedBefore),
        );
        articles.push({ ...article, contentHtml: $.html(body) });
        continue;
      }
      // Keep the old cached body, if any. A later refresh can retry the images.
      bodyMissing++;
      articles.push({ ...article, contentHtml: null });
    } else {
      const archived = {
        ...article,
        contentHtml: $.html($('.rich_media_content').first()),
      };
      archivedSources.set(archived, cached);
      articles.push(archived);
    }
  }
  return { ...page, articles, imageBlocked, bodyMissing };
}
