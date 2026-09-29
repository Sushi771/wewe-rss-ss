import { load } from 'cheerio';
import { fetchAllowedImage } from './image-fetch';
import { ProviderPage } from './subscription-provider';

/** Store provider body images inside SQLite so restart and ZIP export do not depend on the CDN. */
export async function archiveProviderImages(
  page: ProviderPage,
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
          const result = await fetchAllowedImage(source);
          totalBytes += result.bytes.length;
          if (totalBytes > 20_000_000)
            throw new Error('ARTICLE_IMAGES_TOO_LARGE');
          inline = `data:${result.type};base64,${result.bytes.toString('base64')}`;
          cached.set(source, inline);
        }
        $(image).attr('src', inline);
      } catch {
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
