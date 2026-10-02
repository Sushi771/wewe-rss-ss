import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import {
  articleContentHtml,
  articleIdentity,
  articlePublishTime,
} from './article-page';
import { canonicalArticleUrl } from './collection-format';
import { ProviderArticle, ProviderPage } from './subscription-provider';
import { ArticleCandidate } from './article-candidate';

/** Distinct evidence type for owner-confirmed browser DOM observation.
 * Must not be mislabeled as backend HTTP/live-original or reuse official-public-original.
 */
export type BrowserDomEvidence = {
  source: 'owner-confirmed-browser-dom';
  capturedAt: string;
  sha256: string;
  rawUrl?: string;
  observationKind: 'owner-confirmed-browser-dom';
};

export class BrowserDomVerificationError extends Error {
  constructor(
    public readonly code:
      | 'access_challenge'
      | 'identity_conflict'
      | 'invalid_dom_evidence'
      | 'dom_hash_mismatch'
      | 'invalid_article_dom',
  ) {
    super(code);
  }
}

export type VerifiedBrowserDomArticle = {
  article: ProviderArticle;
  discovery: ArticleCandidate['discovery'];
  indexTimestamp: number | null;
  evidence: BrowserDomEvidence;
  canonical: string;
};

/** Strictly verify an owner-confirmed browser page against an independently discovered candidate.
 * Extracts articleIdentity, articlePublishTime, and articleContentHtml with zero backend HTTP requests.
 * Explicitly guards against using candidate.indexTimestamp as article publishTime.
 */
export function verifyBrowserDomArticle(
  candidate: ArticleCandidate,
  html: string,
  evidence: BrowserDomEvidence,
): VerifiedBrowserDomArticle {
  if (
    !evidence ||
    evidence.source !== 'owner-confirmed-browser-dom' ||
    evidence.observationKind !== 'owner-confirmed-browser-dom' ||
    !Number.isFinite(Date.parse(evidence.capturedAt)) ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
    Buffer.byteLength(html) > 10 * 1024 * 1024
  ) {
    throw new BrowserDomVerificationError('invalid_dom_evidence');
  }

  if (createHash('sha256').update(html).digest('hex') !== evidence.sha256) {
    throw new BrowserDomVerificationError('dom_hash_mismatch');
  }

  const $ = load(html);
  if (
    $(
      'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
    ).length ||
    /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
      html,
    )
  ) {
    throw new BrowserDomVerificationError('access_challenge');
  }

  let identity: ReturnType<typeof articleIdentity>;
  try {
    if (evidence.rawUrl) {
      const rawCanonical = canonicalArticleUrl(evidence.rawUrl);
      if (rawCanonical.url !== candidate.url) {
        throw new Error();
      }
    }
    identity = articleIdentity(html);
  } catch {
    throw new BrowserDomVerificationError('identity_conflict');
  }

  if (
    identity.id !== candidate.id ||
    identity.mpId !== candidate.mpId ||
    identity.url !== candidate.url
  ) {
    throw new BrowserDomVerificationError('identity_conflict');
  }

  if (!identity.canonical) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }

  if (
    !/^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{22}$/.test(
      identity.canonical,
    )
  ) {
    try {
      const canonical = new URL(identity.canonical);
      if (
        canonical.protocol !== 'https:' ||
        canonical.pathname !== '/s' ||
        canonicalArticleUrl(identity.canonical).url !== candidate.url
      ) {
        throw new Error();
      }
    } catch {
      throw new BrowserDomVerificationError('identity_conflict');
    }
  }

  const title = $('#activity-name').text().trim();
  const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '');
  if (!title) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }
  if (normalize(title) !== normalize(candidate.title)) {
    throw new BrowserDomVerificationError('identity_conflict');
  }

  // Strict publishTime extraction from DOM; never synthesize or fabricate from candidate indexTimestamp.
  const publishTime = articlePublishTime(html);
  if (!publishTime || publishTime < 946684800) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }

  const contentHtml = articleContentHtml(html);
  if (!contentHtml) {
    throw new BrowserDomVerificationError('invalid_article_dom');
  }

  const article: ProviderArticle = {
    id: identity.id,
    mpId: identity.mpId,
    url: identity.url,
    title,
    publishTime,
    contentHtml,
    picUrl: '',
  };

  return {
    article,
    discovery: candidate.discovery,
    indexTimestamp: candidate.indexTimestamp,
    evidence,
    canonical: identity.canonical,
  };
}

/** Prepares a verified ProviderPage from genuine browser DOM for isolated SQLite insertion. */
export function prepareBrowserDomReplay(
  candidate: ArticleCandidate,
  html: string,
  evidence: BrowserDomEvidence,
) {
  const verified = verifyBrowserDomArticle(candidate, html, evidence);
  // Browser DOM contains source URLs, not archived image bytes. The copy-only
  // rehearsal may preserve them, but they are not available for offline export.
  const $ = load(verified.article.contentHtml || '');
  const unarchivedImages = $('img[src]')
    .toArray()
    .filter(
      (image) => !($(image).attr('src') || '').startsWith('data:'),
    ).length;
  const page: ProviderPage = {
    articles: [verified.article],
    coverage: 'search-results',
    upstreamCount: 1,
    bodyMissing: 0,
    imageBlocked: unarchivedImages,
  };

  return {
    page,
    verified,
    discovery: 'owner-confirmed-browser-dom' as const,
    networkRequests: 0 as const,
    unarchivedImages,
    complete: false as const,
  };
}
