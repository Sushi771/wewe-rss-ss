/** WeWe host parameters only; these do not define a supplier's API contract. */
export type XhsSelfHostedConfigInput = {
  XHS_SELF_HOSTED_BASE_URL?: unknown;
  XHS_SELF_HOSTED_API_KEY?: unknown;
};

export type XhsSelfHostedConfigIssue =
  | 'XHS_SELF_HOSTED_BASE_URL_MISSING'
  | 'XHS_SELF_HOSTED_BASE_URL_INVALID'
  | 'XHS_SELF_HOSTED_API_KEY_MISSING'
  | 'XHS_SELF_HOSTED_API_KEY_INVALID';

export type XhsSelfHostedConfigCandidate = {
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  configured: boolean;
  sourceReviewed: false;
  verifiedBodySource: false;
  canRefresh: false;
  issues: XhsSelfHostedConfigIssue[];
};

const blank = (value: unknown) =>
  value === undefined || (typeof value === 'string' && !value.trim());

function loopbackBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return null;
  const raw = value.trim();
  // Reject WHATWG's permissive URL repairs and even empty query/fragment or
  // userinfo delimiters. No DNS lookup is needed for the literal allowlist.
  if (/[\s\\?#]/.test(raw)) return null;
  const authority = /^https?:\/\/([^/]+)/i.exec(raw)?.[1];
  if (!authority || authority.includes('@')) return null;
  const rawHost = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(authority)?.[1];
  if (!rawHost) return null;
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const ipv4 = rawHost.split('.');
    const standardLoopbackIpv4 =
      ipv4.length === 4 &&
      ipv4[0] === '127' &&
      ipv4.every(
        (part) =>
          /^\d+$/.test(part) &&
          Number(part) <= 255 &&
          String(Number(part)) === part,
      );
    if (
      rawHost.toLowerCase() !== 'localhost' &&
      !standardLoopbackIpv4 &&
      !(rawHost.startsWith('[') && url.hostname === '[::1]')
    )
      return null;
    return url.href;
  } catch {
    // URL errors may contain their input. Never forward the original error.
    return null;
  }
}

/** Pure offline preflight. No defaults, process.env, I/O, auth mapping or route
 * registration. Parameters cannot attest to reviewed source or article bodies.
 * The opaque secret is checked locally and never returned, including on error.
 */
export function parseXhsSelfHostedConfig(
  env: XhsSelfHostedConfigInput,
): XhsSelfHostedConfigCandidate {
  const issues: XhsSelfHostedConfigIssue[] = [];
  const inputBaseUrl = env.XHS_SELF_HOSTED_BASE_URL;
  const baseUrl = loopbackBaseUrl(inputBaseUrl);
  if (blank(inputBaseUrl)) issues.push('XHS_SELF_HOSTED_BASE_URL_MISSING');
  else if (!baseUrl) issues.push('XHS_SELF_HOSTED_BASE_URL_INVALID');

  const key = env.XHS_SELF_HOSTED_API_KEY;
  let apiKeyConfigured = false;
  if (blank(key)) issues.push('XHS_SELF_HOSTED_API_KEY_MISSING');
  else if (typeof key !== 'string' || /[\x00-\x1f\x7f]/.test(key))
    issues.push('XHS_SELF_HOSTED_API_KEY_INVALID');
  else apiKeyConfigured = true;

  return {
    baseUrl,
    apiKeyConfigured,
    configured: Boolean(baseUrl && apiKeyConfigured),
    sourceReviewed: false,
    verifiedBodySource: false,
    canRefresh: false,
    issues,
  };
}

/** Use this for reports rather than serializing the candidate's private URL.
 * A base path can itself contain sensitive data, so even valid URLs are omitted.
 */
export function summarizeXhsSelfHostedConfig(
  candidate: XhsSelfHostedConfigCandidate,
) {
  return {
    baseUrlConfigured: candidate.baseUrl !== null,
    apiKeyConfigured: candidate.apiKeyConfigured,
    configured: candidate.configured,
    sourceReviewed: false as const,
    verifiedBodySource: false as const,
    canRefresh: false as const,
    issues: [...candidate.issues],
  };
}
