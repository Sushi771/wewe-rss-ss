import { load } from 'cheerio';
import {
  decodeInlineImage,
  fetchAllowedImage,
  ImageRequestBlockedError,
} from './image-fetch';
import { ProviderArticle, ProviderPage } from './subscription-provider';

// Only this successful archive may supply bytes for supplementing an existing
// body. Keep provenance in memory rather than trusting adapter-supplied fields.
const archivedSources = new WeakMap<ProviderArticle, Map<string, string>>();
const attemptedSources = new WeakMap<ProviderArticle, Set<string>>();

/** Retry only exact sources still missing from an identity-verified saved body.
 * Existing inline bytes and all user text stay in the input; never infer image
 * identity by order, title, or the number of images. */
export function savedBodyMediaInput(
  savedHtml: string,
  article: ProviderArticle,
): ProviderArticle {
  const incoming = load(article.contentHtml || '');
  const sources = new Set(
    incoming('img')
      .toArray()
      .map(
        (image) =>
          incoming(image).attr('data-src') || incoming(image).attr('src') || '',
      ),
  );
  const saved = load(savedHtml);
  for (const image of saved('img').toArray()) {
    const node = saved(image);
    const src = node.attr('src') || '';
    if (src.startsWith('data:image/')) continue;
    const source = node.attr('data-src') || src;
    if (source && !sources.has(source))
      throw new Error('SAVED_BODY_IMAGE_SOURCE_CONFLICT');
  }
  return { ...article, contentHtml: savedHtml };
}

/** Preserve the saved body and replace only its exact matching remote images
 * with bytes already fetched by the shared archive. No additional requests. */
export function supplementSavedBodyImages(
  savedHtml: string,
  article: ProviderArticle,
  options: { preserveFragment?: boolean } = {},
): string | undefined {
  const sources = archivedSources.get(article);
  if (!sources) return undefined;
  const $ = load(savedHtml, undefined, !options.preserveFragment);
  const body = $('.rich_media_content, #js_content').first();
  if (!body.length) return undefined;
  let changed = false;
  for (const image of (options.preserveFragment
    ? $('img')
    : body.find('img')
  ).toArray()) {
    const el = $(image);
    const src = el.attr('src') || '';
    if (src.startsWith('data:image/')) continue;
    const original = el.attr('data-src') || src;
    // Unknown placeholders remain untouched and pending. They cannot prevent
    // saving successful bytes for other exact sources in the same body.
    if (!original) continue;
    const inline = sources.get(original);
    if (!inline) {
      if (attemptedSources.get(article)?.has(original)) continue;
      throw new Error('SAVED_BODY_IMAGE_SOURCE_CONFLICT');
    }
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
  return changed
    ? options.preserveFragment
      ? $.html()
      : $.html(body)
    : undefined;
}

/** Store provider body images inside SQLite so restart and ZIP export do not depend on the CDN. */
export async function archiveProviderImages(
  page: ProviderPage,
  options: {
    stopOnFailure?: boolean;
    /** Explicit maintenance only; normal callers retain the 20 MB default. */
    maxArticleImageBytes?: number;
    preserveTextOnImageFailure?: boolean;
    /** Cache watcher may stop starting CDN downloads at the night boundary. */
    canFetchImage?: () => boolean;
    requestGapMs?: number;
    /** Persist the global restriction before any storage transaction can fail. */
    onMediaBlocked?: () => Promise<void>;
    /** Internal verified local bytes only. Supplying this map forbids HTTP. */
    verifiedImages?: ReadonlyMap<string, string>;
  } = {},
): Promise<ProviderPage> {
  const maxArticleImageBytes = options.maxArticleImageBytes ?? 20_000_000;
  if (
    !Number.isSafeInteger(maxArticleImageBytes) ||
    maxArticleImageBytes <= 0 ||
    maxArticleImageBytes > 30_000_000
  )
    throw new Error('ARTICLE_IMAGE_BUDGET_INVALID');
  let imageBlocked = page.imageBlocked;
  let mediaRequestBlocked = false;
  const sharedCache = new Map<string, string>();
  const failedSources = new Set<string>();
  let lastRequest = 0;
  let bodyMissing = page.bodyMissing;
  const articles: ProviderPage['articles'] = [];
  for (const article of page.articles) {
    const blockedBefore = imageBlocked;
    if (!article.contentHtml) {
      articles.push(article);
      continue;
    }
    const $ = load(article.contentHtml);
    const images = $('img[src], img[data-src]').toArray();
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
    const attempted = new Set<string>();
    let totalBytes = 0;
    let failed = false;
    for (const image of images) {
      const src = $(image).attr('src') || '';
      const source = src.startsWith('data:image/')
        ? src
        : $(image).attr('data-src') || src;
      attempted.add(source);
      try {
        let inline = cached.get(source) || sharedCache.get(source);
        if (options.verifiedImages && inline && !cached.has(source)) {
          totalBytes += decodeInlineImage(inline).bytes.length;
          if (totalBytes > maxArticleImageBytes)
            throw new Error('ARTICLE_IMAGES_TOO_LARGE');
        }
        if (!inline) {
          const verified = options.verifiedImages?.get(source);
          if (failedSources.has(source))
            throw new Error('IMAGE_RETRY_DEFERRED');
          if (
            !verified &&
            options.verifiedImages &&
            !source.startsWith('data:')
          )
            throw new Error('SAVED_MEDIA_SOURCE_NOT_BOUND');
          if (
            !verified &&
            !source.startsWith('data:') &&
            options.requestGapMs
          ) {
            const delay = options.requestGapMs - (Date.now() - lastRequest);
            if (delay > 0)
              await new Promise((resolve) => setTimeout(resolve, delay));
          }
          if (
            !verified &&
            !source.startsWith('data:') &&
            (mediaRequestBlocked || options.canFetchImage?.() === false)
          )
            throw new Error('CACHE_SYNC_NIGHT_WINDOW');
          if (!source.startsWith('data:')) lastRequest = Date.now();
          const result = verified
            ? decodeInlineImage(verified)
            : source.startsWith('data:')
              ? decodeInlineImage(source)
              : await fetchAllowedImage(source);
          totalBytes += result.bytes.length;
          if (totalBytes > maxArticleImageBytes)
            throw new Error('ARTICLE_IMAGES_TOO_LARGE');
          inline = `data:${result.type};base64,${result.bytes.toString('base64')}`;
          sharedCache.set(source, inline);
        }
        cached.set(source, inline);
        $(image).attr('src', inline);
        $(image).removeAttr('data-src');
      } catch (error) {
        failedSources.add(source);
        if (error instanceof ImageRequestBlockedError) {
          mediaRequestBlocked = true;
          // The callback sets the shared in-memory latch before durable I/O.
          // A failed marker write must still prevent further requests.
          try {
            await options.onMediaBlocked?.();
          } catch {
            /* fail closed */
          }
        }
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
        const previous =
          body.attr('data-wewe-image-retryable') === 'true'
            ? 0
            : Number(body.attr('data-wewe-image-pending') || 0);
        if (!previous) body.attr('data-wewe-image-retryable', 'true');
        body.attr(
          'data-wewe-image-pending',
          String(previous + imageBlocked - blockedBefore),
        );
        const archived = { ...article, contentHtml: $.html(body) };
        archivedSources.set(archived, cached);
        attemptedSources.set(archived, attempted);
        articles.push(archived);
        continue;
      }
      // Keep the old cached body, if any. A later refresh can retry the images.
      bodyMissing++;
      articles.push({ ...article, contentHtml: null });
    } else {
      const body = $('.rich_media_content, #js_content').first();
      if (
        body.attr('data-wewe-image-retryable') === 'true' &&
        !body.find('img:not([src])').length
      ) {
        body.removeAttr('data-wewe-image-pending');
        body.removeAttr('data-wewe-image-retryable');
      }
      const archived = {
        ...article,
        contentHtml: $.html($('.rich_media_content, #js_content').first()),
      };
      archivedSources.set(archived, cached);
      articles.push(archived);
    }
  }
  return { ...page, articles, imageBlocked, bodyMissing, mediaRequestBlocked };
}
