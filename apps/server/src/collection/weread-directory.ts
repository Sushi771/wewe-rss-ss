import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { articleContentHtml, articleIdentity } from './article-page';
import { canonicalArticleUrl } from './collection-format';
import { allowedImageUrl, decodeInlineImage } from './image-fetch';
import { assertProviderPage, ProviderArticle } from './subscription-provider';

export type WereadDirectoryArticle = {
  reviewId: string;
  originalId: string;
  mpId: string;
  name: string;
  title: string;
  publishTime: number;
  picUrl: string;
};

/** Raw group offsets belong to Web /mp/articles; response synckey is not a cursor.
 * clearAll resets the upstream client's directory, never our saved articles.
 * A short originalId remains a discovery identity until a body proves biz/mid/idx.
 */
export function parseWereadDirectory(
  raw: unknown,
  expected: { mpId: string; name: string },
) {
  if (
    !/^MP_WXS_\d{5,15}$/.test(expected.mpId) ||
    !expected.name.trim() ||
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw['reviews']) ||
    raw['reviews'].length > 1000 ||
    [raw['errCode'], raw['errcode'], raw['code']].some(Boolean)
  )
    throw new Error('WEREAD_DIRECTORY_INVALID');
  const articles: WereadDirectoryArticle[] = [];
  const seen = new Map<string, WereadDirectoryArticle>();
  for (const group of raw['reviews']) {
    if (!group || !Array.isArray(group.subReviews) || !group.subReviews.length)
      throw new Error('WEREAD_DIRECTORY_GROUP_INVALID');
    for (const entry of group.subReviews) {
      const review = entry?.review;
      const info = review?.mpInfo;
      const originalId = info?.originalId;
      const reviewId = entry?.reviewId;
      // bookId is empty in the successful official samples; belongBookId owns MP reviews.
      if (
        review?.belongBookId !== expected.mpId ||
        (review.bookId && review.bookId !== expected.mpId) ||
        review.type !== 16 ||
        typeof originalId !== 'string' ||
        !/^[A-Za-z0-9_~-]{22}$/.test(originalId) ||
        reviewId !== review.reviewId ||
        reviewId !== `${expected.mpId}_${originalId}` ||
        typeof info.title !== 'string' ||
        !info.title.trim() ||
        info.title.length > 1000 ||
        typeof info.mp_name !== 'string' ||
        normalize(info.mp_name) !== normalize(expected.name) ||
        !Number.isSafeInteger(info.time) ||
        info.time < 946684800 ||
        info.time > Math.floor(Date.now() / 1000) + 300
      )
        throw new Error('WEREAD_DIRECTORY_ARTICLE_INVALID');
      const article: WereadDirectoryArticle = {
        reviewId,
        originalId,
        mpId: expected.mpId,
        name: info.mp_name,
        title: info.title,
        publishTime: info.time,
        picUrl: typeof info.pic_url === 'string' ? info.pic_url : '',
      };
      const previous = seen.get(reviewId);
      if (previous) {
        // Optional cover changes must not create another article.
        if (
          previous.originalId !== article.originalId ||
          previous.publishTime !== article.publishTime ||
          normalize(previous.title) !== normalize(article.title)
        )
          throw new Error('WEREAD_DIRECTORY_DUPLICATE_CONFLICT');
        continue;
      }
      seen.set(reviewId, article);
      articles.push(article);
      if (articles.length > 1000) throw new Error('WEREAD_DIRECTORY_TOO_LARGE');
    }
  }
  return {
    articles,
    groupCount: raw['reviews'].length,
    // Kept as upstream metadata only. No consumer may interpret this as deletion.
    clearAll: raw['clearAll'],
    synckey: raw['synckey'],
  };
}

function normalize(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, '');
}

export type SavedWereadBody = {
  /** Actual reviewId recorded for this content response, not guessed from its title. */
  reviewId: string;
  html: string;
  sha256: string;
  capturedAt: string;
  images: Array<{ url: string; inline: string; sha256: string }>;
};

/** Verify a saved content response; never use a title to guess an old WX identity.
 * No HTTP transport, authentication, signature generation, or implicit image fetch.
 */
export function verifyWereadArticleBody(
  candidate: WereadDirectoryArticle,
  html: string,
): ProviderArticle {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 15 * 1024 * 1024)
    throw new Error('WEREAD_BODY_INVALID');
  const $ = load(html);
  if (
    $(
      'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
    ).length ||
    /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
      html,
    )
  )
    throw new Error('WEREAD_BODY_ACCESS_CHALLENGE');
  const identity = articleIdentity(html);
  const originalUrl = `https://mp.weixin.qq.com/s/${candidate.originalId.replace(/~/g, '_')}`;
  const title = $('#activity-name').text().trim();
  // Tencent may expose a signed /s?biz/mid/idx canonical while the directory
  // supplies a short token. The recorded content reviewId binds these identities;
  // the canonical must independently agree with the body fields.
  if (identity.canonical !== originalUrl) {
    let canonical: ReturnType<typeof canonicalArticleUrl>;
    try {
      const url = new URL(identity.canonical || '');
      if (url.protocol !== 'https:' || url.pathname !== '/s') throw new Error();
      canonical = canonicalArticleUrl(url.toString());
    } catch {
      throw new Error('WEREAD_BODY_IDENTITY_CONFLICT');
    }
    if (canonical.url !== identity.url)
      throw new Error('WEREAD_BODY_IDENTITY_CONFLICT');
  }
  if (
    identity.mpId !== candidate.mpId ||
    identity.publishTime !== candidate.publishTime ||
    normalize(title) !== normalize(candidate.title) ||
    normalize($('#js_name').text()) !== normalize(candidate.name)
  )
    throw new Error('WEREAD_BODY_IDENTITY_CONFLICT');
  const contentHtml = articleContentHtml(html);
  if (!contentHtml) throw new Error('WEREAD_BODY_MISSING');
  const clean = load(contentHtml);
  const originals = $('#js_content').find('img').toArray();
  const images = clean('img').toArray();
  if (originals.length !== images.length)
    throw new Error('WEREAD_BODY_IMAGE_INVALID');
  images.forEach((image, index) => {
    const src = $(originals[index]).attr('src') || '';
    // Saved content responses can already embed bytes while retaining the old
    // CDN data-src. Validate those bytes instead of requesting the image again.
    const source = src.startsWith('data:')
      ? src
      : $(originals[index]).attr('data-src') || src;
    if (source.startsWith('data:')) decodeInlineImage(source);
    else allowedImageUrl(source);
    clean(image).attr('src', source);
  });
  let picUrl = '';
  if (candidate.picUrl) {
    try {
      picUrl = allowedImageUrl(candidate.picUrl).toString();
    } catch {
      // A missing/invalid optional cover never replaces a saved cover.
    }
  }
  return {
    id: identity.id,
    mpId: identity.mpId,
    url: identity.url,
    shortUrl: originalUrl,
    title,
    publishTime: identity.publishTime!,
    contentHtml: clean.html(clean('#js_content')),
    picUrl,
  };
}

/** Offline evidence/cache binding only; runtime downloads use archiveProviderImages. */
export function verifyWereadDirectoryBody(
  candidate: WereadDirectoryArticle,
  saved: SavedWereadBody,
): ProviderArticle {
  if (
    saved.reviewId !== candidate.reviewId ||
    !Number.isFinite(Date.parse(saved.capturedAt)) ||
    typeof saved.html !== 'string' ||
    createHash('sha256').update(saved.html).digest('hex') !== saved.sha256
  )
    throw new Error('WEREAD_BODY_EVIDENCE_INVALID');
  const article = verifyWereadArticleBody(candidate, saved.html);
  const $ = load(article.contentHtml!);
  for (const image of $('img[src]').toArray()) {
    const source = $(image).attr('src')!;
    if (source.startsWith('data:')) continue;
    const matches = saved.images.filter((item) => item.url === source);
    if (matches.length !== 1)
      throw new Error('WEREAD_BODY_IMAGE_CACHE_MISSING');
    const cached = matches[0];
    if (
      createHash('sha256')
        .update(decodeInlineImage(cached.inline).bytes)
        .digest('hex') !== cached.sha256
    )
      throw new Error('WEREAD_BODY_IMAGE_HASH_INVALID');
    $(image).attr('src', cached.inline);
  }
  return { ...article, contentHtml: $.html($('#js_content')) };
}

/** Select first, then fetch bodies; never fill missing latest bodies with old ones. */
export function selectWereadLatest(
  pages: unknown[],
  expected: { mpId: string; name: string },
  limit = 10,
) {
  if (
    !pages.length ||
    pages.length > 5 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('WEREAD_DIRECTORY_WINDOW_INVALID');
  const parsed = pages.map((raw) => parseWereadDirectory(raw, expected));
  const seen = new Map<string, WereadDirectoryArticle>();
  for (const article of parsed.flatMap((page) => page.articles)) {
    const previous = seen.get(article.reviewId);
    if (
      previous &&
      (previous.publishTime !== article.publishTime ||
        normalize(previous.title) !== normalize(article.title))
    )
      throw new Error('WEREAD_DIRECTORY_DUPLICATE_CONFLICT');
    if (!previous) seen.set(article.reviewId, article);
  }
  const directory = [...seen.values()];
  if (
    directory.some(
      (item, index) =>
        index > 0 && item.publishTime > directory[index - 1].publishTime,
    )
  )
    throw new Error('WEREAD_DIRECTORY_ORDER_UNVERIFIED');
  return {
    selected: directory.slice(0, limit),
    directory,
    groupCounts: parsed.map((page) => page.groupCount),
  };
}

/** Offline adapter to the existing ProviderPage/persistence contract.
 * Missing bodies remain separate candidates; never substitute older articles to fill ten.
 * It is deliberately not selected by a production refresh route.
 */
export function prepareWereadDirectoryReplay(
  pages: unknown[],
  expected: { mpId: string; name: string },
  bodies: SavedWereadBody[],
  limit = 10,
) {
  const { directory, selected, groupCounts } = selectWereadLatest(
    pages,
    expected,
    limit,
  );
  const verified: Array<{
    reviewId: string;
    originalId: string;
    article: ProviderArticle;
  }> = [];
  const unverified: string[] = [];
  for (const candidate of selected) {
    const matches = bodies.filter(
      (body) => body.reviewId === candidate.reviewId,
    );
    if (matches.length > 1) throw new Error('WEREAD_BODY_CACHE_AMBIGUOUS');
    if (!matches.length) {
      unverified.push(candidate.reviewId);
      continue;
    }
    const article = verifyWereadDirectoryBody(candidate, matches[0]);
    if (verified.some((entry) => entry.article.id === article.id))
      throw new Error('WEREAD_BODY_IDENTITY_ALIAS_CONFLICT');
    verified.push({
      reviewId: candidate.reviewId,
      originalId: candidate.originalId,
      article,
    });
  }
  const page = assertProviderPage(
    {
      articles: verified.map((entry) => entry.article),
      coverage: 'recent-window',
      upstreamCount: directory.length,
      bodyMissing: 0,
      imageBlocked: 0,
      pages: pages.length,
    },
    expected.mpId,
  );
  return {
    discovery: 'saved-weread-directory' as const,
    networkRequests: 0 as const,
    page,
    verified,
    unverified,
    selected,
    groupCounts,
    latestWindowReady: selected.length === limit && unverified.length === 0,
    // Saved samples cannot demonstrate a repeatable live subscription.
    complete: false as const,
  };
}
