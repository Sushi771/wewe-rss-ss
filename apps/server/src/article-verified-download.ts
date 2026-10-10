import { load } from 'cheerio';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Article } from '@prisma/client';
import type { PreparedArticle } from './article-local-save';
import {
  ArticleDownloadError,
  downloadArticleUrl,
  inertDownloadBody,
} from './article-download';
import { buildArticleMarkdown } from './article-export';
import { canonicalArticleUrl } from './collection/collection-format';
import { decodeInlineImage } from './collection/image-fetch';
import {
  assertProviderPage,
  ProviderArticle,
} from './collection/subscription-provider';

const unavailable = () =>
  new ArticleDownloadError(
    '已取得文章的正文或本地图片尚未完整核验，未保存，也未重试原文。',
    422,
    { code: 'VERIFIED_ARTICLE_UNAVAILABLE' },
  );

/** An internal content boundary, never a browser upload or a network fallback. */
export function verifiedDownloadBody(
  html: unknown,
  allowUnconfirmedMedia = false,
): string {
  // Includes up to 20 MB of base64 image bytes plus the bounded article body.
  if (typeof html !== 'string' || Buffer.byteLength(html) > 35_000_000)
    throw unavailable();
  const $ = load(html);
  if (
    $(
      '#js_verify, #verify, .weui_msg, iframe[src*="captcha."], form[action*="/mp/verify"], form[action*="login"], input[type="password"]',
    ).length
  )
    throw unavailable();
  const body = $('#js_content, .rich_media_content').first();
  const images = body.find('img').toArray();
  if (
    !body.length ||
    (!body.text().trim() && !images.length) ||
    (allowUnconfirmedMedia
      ? images.filter((image) => $(image).attr('src')).length
      : images.length) > 60
  )
    throw unavailable();
  try {
    let totalBytes = 0;
    let encodedBytes = 0;
    for (const image of images) {
      if (
        allowUnconfirmedMedia &&
        $(image).attr('data-wewe-image-unconfirmed') === 'true' &&
        !$(image).attr('src') &&
        !$(image).attr('data-src')
      ) {
        $(image).remove();
        continue;
      }
      // A visible image or CDN URL is not proof that its bytes are available.
      const source = $(image).attr('src') || '';
      totalBytes += decodeInlineImage(source).bytes.length;
      encodedBytes += Buffer.byteLength(source);
      if (totalBytes > 20_000_000) throw unavailable();
    }
    if (Buffer.byteLength($.html(body)) - encodedBytes > 5_000_000)
      throw unavailable();
    const content = inertDownloadBody($.html(body));
    const clean = load(content)('#js_content');
    if (!clean.text().trim() && !clean.find('img').length) throw unavailable();
    return content;
  } catch {
    throw unavailable();
  }
}

type DownloadArticle = Pick<
  Article,
  'id' | 'title' | 'contentHtml' | 'lastBodyStatus' | 'metrics' | 'publishTime'
>;

/** Both the existing cache and verified provider completion use this exporter. */
export async function buildCompleteArticleDownload(
  article: DownloadArticle,
  source: string,
  directory: string,
  allowUnconfirmedMedia = false,
): Promise<PreparedArticle> {
  if (article.lastBodyStatus === 'unavailable') throw unavailable();
  const mediaComplete =
    article.lastBodyStatus !== 'images-pending' &&
    !article.contentHtml?.includes('data-wewe-image-pending=');
  const contentHtml = verifiedDownloadBody(
    article.contentHtml,
    allowUnconfirmedMedia,
  );
  const { markdown } = await buildArticleMarkdown(
    {
      ...article,
      contentHtml,
      sourceUrl: null,
      lastBodyStatus: mediaComplete ? article.lastBodyStatus : 'images-pending',
    },
    '',
    directory,
    async () => {
      throw unavailable();
    },
    'image',
  );
  const title = article.title.replace(/[\r\n]/g, ' ').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );
  await writeFile(
    join(directory, 'index.md'),
    `# ${title}\n\n原文来源：${source}\n\n${markdown}\n`,
  );
  return {
    articleId: article.id,
    title: article.title,
    sourceUrl: source,
    imageCount: load(contentHtml)('img[src]').length,
    ...(mediaComplete ? {} : { mediaComplete: false }),
  };
}

/** Called only with a server-side, already verified and archived provider result.
 * No cookies, raw response HTML, image fetcher, database or file path in the input.
 * Snapshot before publication so a producer cannot mutate a pending completion.
 */
export function prepareVerifiedProviderDownload(
  raw: unknown,
  result: ProviderArticle,
  allowUnconfirmedMedia = false,
) {
  const requested = downloadArticleUrl(raw);
  try {
    assertProviderPage(
      {
        articles: [result],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: result.contentHtml ? 0 : 1,
        imageBlocked: 0,
      },
      result.mpId,
    );
    const matches =
      new URL(requested).pathname === '/s'
        ? canonicalArticleUrl(requested).url === result.url
        : requested === result.shortUrl;
    if (!matches) throw new Error();
  } catch {
    throw new ArticleDownloadError(
      '正常取文结果与输入文章身份不一致，未保存，也未重试原文。',
      422,
      { code: 'VERIFIED_ARTICLE_MISMATCH' },
    );
  }
  const article: DownloadArticle = {
    id: result.id,
    title: result.title,
    publishTime: result.publishTime,
    contentHtml: verifiedDownloadBody(
      result.contentHtml,
      allowUnconfirmedMedia,
    ),
    lastBodyStatus: result.contentHtml?.includes('data-wewe-image-pending=')
      ? 'images-pending'
      : 'available',
    metrics: null,
  };
  const source = result.url;
  return (directory: string) =>
    buildCompleteArticleDownload(
      article,
      source,
      directory,
      allowUnconfirmedMedia,
    );
}
