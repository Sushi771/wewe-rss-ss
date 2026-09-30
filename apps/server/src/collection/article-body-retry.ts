import axios from 'axios';
import { load } from 'cheerio';
import {
  articleContentHtml,
  articleIdentity,
  articlePublishTime,
} from './article-page';
import { canonicalArticleUrl } from './collection-format';

type SavedArticle = {
  id: string;
  mpId: string;
  title: string;
  publishTime: number;
  sourceUrl: string | null;
  verifiedSourceUrl: string | null;
};
type Identity = ReturnType<typeof canonicalArticleUrl>;
const SHORT_URL = /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{22}$/;
const CANONICAL_ID = /^WX_\d{5,15}_\d+_[1-9]\d*$/;
const UNVERIFIED =
  '尚无可核验的原文身份，请先通过订阅采集核验；不能按标题补正文。';

export class BodyRetryBlockedError extends Error {}

/** 同一旧记录的所有已知身份必须一致，不能借短链命中重绑到另一篇。 */
export function assertSavedArticleIdentity(
  article: SavedArticle,
  identity: Identity & { shortUrl?: string },
) {
  if (
    article.mpId !== identity.mpId ||
    (CANONICAL_ID.test(article.id) && article.id !== identity.id)
  )
    throw new BodyRetryBlockedError(
      '已保存文章与原文身份冲突，本次未修改文章。',
    );
  for (const url of [article.verifiedSourceUrl, article.sourceUrl]) {
    if (!url) continue;
    if (SHORT_URL.test(url)) {
      if (identity.shortUrl && url !== identity.shortUrl)
        throw new BodyRetryBlockedError(
          '已保存短链与原文身份冲突，本次未修改文章。',
        );
    } else {
      let stored: Identity;
      try {
        stored = canonicalArticleUrl(url);
      } catch {
        throw new BodyRetryBlockedError(UNVERIFIED);
      }
      if (stored.id !== identity.id || stored.mpId !== identity.mpId)
        throw new BodyRetryBlockedError(
          '已保存来源与原文身份冲突，本次未修改文章。',
        );
    }
  }
}

export function bodyRetryTarget(article: SavedArticle) {
  let identity: Identity;
  if (article.verifiedSourceUrl) {
    // 新绑定只能是完整身份链接，短链本身不提供 biz/mid/idx。
    try {
      identity = canonicalArticleUrl(article.verifiedSourceUrl);
    } catch {
      throw new BodyRetryBlockedError(UNVERIFIED);
    }
  } else if (CANONICAL_ID.test(article.id) && article.sourceUrl) {
    // 旧规范 ID 还须有相同身份的已存完整来源，不能仅按字符串拼请求。
    try {
      identity = canonicalArticleUrl(article.sourceUrl);
    } catch {
      throw new BodyRetryBlockedError(UNVERIFIED);
    }
  } else throw new BodyRetryBlockedError(UNVERIFIED);
  assertSavedArticleIdentity(article, identity);
  if (!article.title.trim() || article.publishTime < 946684800)
    throw new BodyRetryBlockedError('文章标题或日期尚未核验，请先更新订阅。');
  return identity;
}

export function bodyRetryAvailability(article: SavedArticle, isLocal = true) {
  if (!isLocal)
    return { allowed: false, reason: '正文重试需在服务器本机页面执行。' };
  try {
    bodyRetryTarget(article);
    return { allowed: true, reason: '' };
  } catch (error) {
    return { allowed: false, reason: (error as Error).message };
  }
}

export const bodyRetryMessages = {
  available: '本篇原文已核验，正文可用；已有正文保持不变。',
  unavailable: '本篇原文身份已核验，但未取得正文；已有缓存保持不变。',
  request_failed: '原文请求失败，请检查网络或上游访问状态；旧正文保持不变。',
  invalid_page: '原文返回验证、错误页面或缺少核验信息；旧正文保持不变。',
  identity_mismatch: '原文身份、标题或日期与已存记录不一致；旧正文保持不变。',
  save_failed: '本次正文结果未能保存；请重新读取文章状态。',
} as const;
export type BodyRetryResult = {
  status: 'available' | 'unavailable' | 'failed';
  code: keyof typeof bodyRetryMessages;
  attemptedAt: number;
  cached: boolean;
  filled: boolean;
  message: string;
};

export function readBodyRetryResult(raw: string | null) {
  try {
    const value = JSON.parse(raw || '') as BodyRetryResult;
    if (
      !value ||
      !['available', 'unavailable', 'failed'].includes(value.status) ||
      !Object.prototype.hasOwnProperty.call(bodyRetryMessages, value.code) ||
      !Number.isSafeInteger(value.attemptedAt) ||
      typeof value.cached !== 'boolean' ||
      typeof value.filled !== 'boolean'
    )
      return null;
    return { ...value, message: bodyRetryMessages[value.code] };
  } catch {
    return null;
  }
}

class BodyRetryError extends Error {
  constructor(public readonly code: keyof typeof bodyRetryMessages) {
    super(bodyRetryMessages[code]);
  }
}

export function bodyRetryFailure(error: unknown) {
  return error instanceof BodyRetryError ? error.code : 'save_failed';
}

/** 一次显式请求，只访问保存且可证明身份的第一方原文，不启动桌面或读取会话。 */
export async function fetchArticleBody(
  article: SavedArticle,
  requestUrl?: string,
) {
  const target = bodyRetryTarget(article);
  if (
    requestUrl &&
    (new URL(requestUrl).protocol !== 'https:' ||
      new URL(requestUrl).pathname !== '/s' ||
      canonicalArticleUrl(requestUrl).url !== target.url)
  )
    throw new BodyRetryBlockedError('原文请求链接与已核验身份不一致');
  let html: string;
  try {
    let proxy: false | { protocol: string; host: string; port: number } = false;
    if (process.env.WECHAT_PUBLIC_PROXY_URL) {
      const url = new URL(process.env.WECHAT_PUBLIC_PROXY_URL);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username ||
        url.password
      )
        throw new Error();
      proxy = {
        protocol: 'http',
        host: url.hostname,
        port: Number(url.port || 80),
      };
    }
    const response = await axios.get<string>(requestUrl || target.url, {
      proxy,
      timeout: 15000,
      maxContentLength: 10 * 1024 * 1024,
      maxRedirects: 0,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      },
    });
    if (response.status !== 200 || typeof response.data !== 'string')
      throw new Error();
    html = response.data;
  } catch {
    throw new BodyRetryError('request_failed');
  }
  const $ = load(html);
  if (
    $(
      'iframe[src*="captcha."], form[action*="/mp/verify"], #js_verify, #verify, .weui_msg',
    ).length
  )
    throw new BodyRetryError('invalid_page');
  let identity: ReturnType<typeof articleIdentity>;
  try {
    identity = articleIdentity(html);
  } catch {
    throw new BodyRetryError('invalid_page');
  }
  const publishTime = articlePublishTime(html);
  const title = $('#activity-name').text().trim();
  const normalizedTitle = (text: string) =>
    text.normalize('NFKC').replace(/\s+/gu, '');
  if (!publishTime || !title || !identity.canonical)
    throw new BodyRetryError('invalid_page');
  const shortCanonical = SHORT_URL.test(identity.canonical);
  if (!shortCanonical) {
    // Current official originals also expose /s?... as og:url. This is valid
    // only for a canonical-ID row and the exact signed target identity. Legacy
    // short IDs still require their own 22-character canonical short URL.
    if (!CANONICAL_ID.test(article.id))
      throw new BodyRetryError('invalid_page');
    let canonical: Identity;
    try {
      const url = new URL(identity.canonical);
      if (url.protocol !== 'https:' || url.pathname !== '/s') throw new Error();
      canonical = canonicalArticleUrl(identity.canonical);
    } catch {
      throw new BodyRetryError('invalid_page');
    }
    if (canonical.url !== target.url)
      throw new BodyRetryError('identity_mismatch');
  }
  if (
    identity.id !== target.id ||
    new URL(identity.url).searchParams.get('sn') !==
      new URL(target.url).searchParams.get('sn') ||
    identity.mpId !== article.mpId ||
    (publishTime !== article.publishTime &&
      // Album create_time is a list timestamp; a verified original ct can
      // differ by seconds. Never relax a previously verified article date.
      !(
        CANONICAL_ID.test(article.id) &&
        !article.verifiedSourceUrl &&
        Math.abs(publishTime - article.publishTime) <= 60
      )) ||
    normalizedTitle(title) !== normalizedTitle(article.title)
  )
    throw new BodyRetryError('identity_mismatch');
  try {
    assertSavedArticleIdentity(article, {
      ...identity,
      ...(shortCanonical ? { shortUrl: identity.canonical } : {}),
    });
    if (
      !CANONICAL_ID.test(article.id) &&
      /^[A-Za-z0-9_-]{22}$/.test(article.id) &&
      identity.canonical.split('/').at(-1) !== article.id
    )
      throw new Error();
  } catch {
    throw new BodyRetryError('identity_mismatch');
  }
  return {
    verifiedSourceUrl: target.url,
    originalPublishTime: publishTime,
    contentHtml: articleContentHtml(html),
  };
}
