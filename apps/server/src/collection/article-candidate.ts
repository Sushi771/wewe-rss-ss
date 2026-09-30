import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import {
  articleContentHtml,
  articleIdentity,
  articlePublishTime,
} from './article-page';
import { canonicalArticleUrl } from './collection-format';
import { ProviderArticle } from './subscription-provider';

/** An index date is kept for selection/diagnosis, never for persistence as publishTime. */
export type ArticleCandidate = ReturnType<typeof canonicalArticleUrl> & {
  title: string;
  indexTimestamp: number | null;
  discovery: { source: 'owner-web-search'; capturedAt: string; page: number };
};
export type OriginalEvidence = {
  source: 'official-public-original';
  requestedUrl: string;
  capturedAt: string;
  sha256: string;
  transport: 'verified-cache' | 'live-original';
};

export class CandidateVerificationError extends Error {
  constructor(
    public readonly code:
      | 'access_challenge'
      | 'identity_conflict'
      | 'invalid_original'
      | 'cache_hash_mismatch',
  ) {
    super(code);
  }
}

export function searchArticleCandidates(
  items: unknown[],
  config: { name: string; biz: string },
  discovery: ArticleCandidate['discovery'],
): ArticleCandidate[] {
  if (
    !Array.isArray(items) ||
    items.length > 100 ||
    !Number.isFinite(Date.parse(discovery.capturedAt)) ||
    !Number.isSafeInteger(discovery.page) ||
    discovery.page < 1
  )
    throw new Error('SEARCH_CANDIDATES_INVALID');
  const found = new Map<string, ArticleCandidate>();
  for (const raw of items) {
    const item = raw as any;
    if (item?.source?.title !== config.name) continue;
    let identity: ReturnType<typeof canonicalArticleUrl>;
    try {
      const url = new URL(item.doc_url);
      if (url.searchParams.get('__biz') !== config.biz) continue;
      if (
        /[\s\\]/.test(item.doc_url) ||
        url.pathname !== '/s' ||
        ['__biz', 'mid', 'idx', 'sn'].some(
          (k) => url.searchParams.getAll(k).length !== 1,
        ) ||
        !/^[a-fA-F0-9]{4,64}$/.test(url.searchParams.get('sn') || '')
      )
        throw new Error();
      identity = canonicalArticleUrl(item.doc_url);
    } catch {
      throw new Error('SEARCH_CANDIDATE_IDENTITY_INVALID');
    }
    if (
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 1000
    )
      throw new Error('SEARCH_CANDIDATE_TITLE_INVALID');
    const candidate: ArticleCandidate = {
      ...identity,
      title: item.title,
      indexTimestamp:
        Number.isSafeInteger(item.timestamp) && item.timestamp > 0
          ? item.timestamp
          : null,
      discovery,
    };
    const previous = found.get(candidate.id);
    if (
      previous &&
      (previous.url !== candidate.url || previous.title !== candidate.title)
    )
      throw new CandidateVerificationError('identity_conflict');
    found.set(candidate.id, candidate);
  }
  return [...found.values()];
}

/** A hash authenticates cache bytes against the recorded response; it is not discovery input. */
export function verifyCandidateOriginal(
  candidate: ArticleCandidate,
  html: string,
  evidence: OriginalEvidence,
) {
  if (
    evidence.source !== 'official-public-original' ||
    !['verified-cache', 'live-original'].includes(evidence.transport) ||
    !Number.isFinite(Date.parse(evidence.capturedAt)) ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
    Buffer.byteLength(html) > 10 * 1024 * 1024
  )
    throw new CandidateVerificationError('invalid_original');
  if (createHash('sha256').update(html).digest('hex') !== evidence.sha256)
    throw new CandidateVerificationError('cache_hash_mismatch');
  const $ = load(html);
  if (
    $(
      'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
    ).length ||
    /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
      html,
    )
  )
    throw new CandidateVerificationError('access_challenge');
  let identity: ReturnType<typeof articleIdentity>;
  let shortRequest = false;
  try {
    const requested = new URL(evidence.requestedUrl);
    shortRequest = /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{22}$/.test(
      evidence.requestedUrl,
    );
    if (
      !shortRequest &&
      (requested.protocol !== 'https:' ||
        requested.pathname !== '/s' ||
        canonicalArticleUrl(evidence.requestedUrl).url !== candidate.url)
    )
      throw new Error();
    identity = articleIdentity(html);
  } catch {
    throw new CandidateVerificationError('identity_conflict');
  }
  const title = $('#activity-name').text().trim();
  const publishTime = articlePublishTime(html);
  const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '');
  if (!title || !publishTime || !identity.canonical)
    throw new CandidateVerificationError('invalid_original');
  if (
    identity.id !== candidate.id ||
    identity.mpId !== candidate.mpId ||
    identity.url !== candidate.url ||
    normalize(title) !== normalize(candidate.title)
  )
    throw new CandidateVerificationError('identity_conflict');
  if (shortRequest && identity.canonical !== evidence.requestedUrl)
    throw new CandidateVerificationError('identity_conflict');
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
      )
        throw new Error();
    } catch {
      throw new CandidateVerificationError('identity_conflict');
    }
  }
  const contentHtml = articleContentHtml(html);
  if (!contentHtml) throw new CandidateVerificationError('invalid_original');
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
    original: evidence,
    canonical: identity.canonical,
  };
}
