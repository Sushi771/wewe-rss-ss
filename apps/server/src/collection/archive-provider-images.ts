import { load } from 'cheerio';
import { decodeInlineImage, fetchAllowedImage } from './image-fetch';
import { ProviderPage } from './subscription-provider';

/** Store provider body images inside SQLite so restart and ZIP export do not depend on the CDN. */
export async function archiveProviderImages(
  page: ProviderPage,
  options: { stopOnFailure?: boolean } = {},
): Promise<ProviderPage> {
  let imageBlocked = page.imageBlocked;
  let bodyMissing = page.bodyMissing;
  const articles: ProviderPage['articles'] = [];
  for (const article of page.articles) {
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
      }
    }
    if (failed) {
      // Keep the old cached body, if any. A later refresh can retry the images.
      bodyMissing++;
      articles.push({ ...article, contentHtml: null });
    } else {
      articles.push({
        ...article,
        contentHtml: $.html($('.rich_media_content').first()),
      });
    }
  }
  return { ...page, articles, imageBlocked, bodyMissing };
}
