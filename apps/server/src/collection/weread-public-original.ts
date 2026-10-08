import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load } from 'cheerio';
import {
  downloadArticleUrl,
  publicArticleRedirect,
  PublicRedirectDiagnostic,
  requestDownloadResource,
} from '../article-download';
import {
  articleVerificationLocation,
  TimedArticleVerification,
  ARTICLE_VERIFICATION_TTL_MS,
} from '../../../../packages/shared/src/article-verification';
import { canonicalArticleUrl } from './collection-format';
import { articleIdentity } from './article-page';
import { ownerConfigFile } from './owner-weread-binding';
import { NativeWereadAccount } from './owner-weread-account';
import {
  assertNativeWereadCandidateAccount,
  wereadPublisherCandidateFromOriginal,
} from './weread-publisher-validation';

type Candidate = ReturnType<typeof wereadPublisherCandidateFromOriginal>;
export type ReviewedWereadPublicOriginal = {
  status: 'reviewed-original';
  requestedUrl: string;
  sha256: string;
  candidate: Candidate;
  /** Server-only, nonenumerable: never return the raw page through HTTP. */
  readonly html: string;
};
export type WereadPublicOriginalResult =
  | ReviewedWereadPublicOriginal
  | {
      status: 'verification-required' | 'blocked';
      code: string;
      requestedUrl: string;
      upstreamStatus?: number;
      redirectKind?: string;
      redirectDiagnostic?: PublicRedirectDiagnostic;
      /** Only safe, observed Location; never included in diagnostic serialization. */
      readonly officialVerification?: TimedArticleVerification;
    };
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const maxBytes = 10 * 1024 * 1024;
const redirectKinds = ['verification', 'login', 'article', 'other', 'missing'];
function validDiagnostic(
  value: PublicRedirectDiagnostic | undefined,
): value is PublicRedirectDiagnostic {
  return (
    !!value &&
    ['official-article', 'official-login', 'other', 'missing'].includes(
      value.hostKind,
    ) &&
    redirectKinds.includes(value.pathKind) &&
    Object.keys(value).every((key) =>
      ['hostKind', 'pathKind', 'verificationReason'].includes(key),
    ) &&
    (!value.verificationReason ||
      ['missing-location', 'unsafe-location', 'sensitive-location'].includes(
        value.verificationReason,
      ))
  );
}
function originalRequest(
  result: ReviewedWereadPublicOriginal,
  requestedUrl: string,
): ReviewedWereadPublicOriginal {
  const original = { ...result, requestedUrl };
  Object.defineProperty(original, 'html', {
    value: result.html,
    enumerable: false,
  });
  return Object.freeze(original);
}

function reviewed(
  requestedUrl: string,
  html: string,
): ReviewedWereadPublicOriginal {
  const candidate = wereadPublisherCandidateFromOriginal(html);
  const identity = articleIdentity(html);
  if (new URL(requestedUrl).pathname === '/s') {
    if (canonicalArticleUrl(requestedUrl).url !== identity.url)
      throw new Error('PUBLIC_IDENTITY_CONFLICT');
  } else if (
    new URL(candidate.publicArticleUrl).pathname !== '/s' &&
    candidate.publicArticleUrl !== requestedUrl
  )
    throw new Error('PUBLIC_IDENTITY_CONFLICT');
  const result = {
    status: 'reviewed-original' as const,
    requestedUrl,
    sha256: hash(html),
    candidate,
  };
  Object.defineProperty(result, 'html', { value: html, enumerable: false });
  return Object.freeze(result) as ReviewedWereadPublicOriginal;
}

/** One explicit public identity read, independent of an existing feed/binding.
 * Reuses the current URL policy + DNS-pinned no-cookie/no-redirect requester.
 * A retained public refusal is never retried; good cache bytes are reverified.
 * An ordinary short-to-long public article redirect permits exactly one hop.
 * No images, files exported, directory request, credentials, browser or pairing.
 */
export async function resolveWereadPublisherOriginal(input: {
  url: string;
  account: NativeWereadAccount;
  trigger: 'local-manual';
  /** Internal test/config override, never a client-selected private path. */
  configFile?: string;
}): Promise<WereadPublicOriginalResult> {
  const blocked = (
    requestedUrl: string,
    code: string,
  ): WereadPublicOriginalResult => ({ status: 'blocked', requestedUrl, code });
  if (input.trigger !== 'local-manual') return blocked('', 'MANUAL_ONLY');
  let requestedUrl: string;
  try {
    requestedUrl = downloadArticleUrl(input.url);
  } catch {
    return blocked('', 'INVALID_ARTICLE_URL');
  }
  let configFile: string;
  try {
    configFile = input.configFile || ownerConfigFile();
  } catch {
    return blocked(requestedUrl, 'PRIVATE_STATE_INVALID');
  }
  if (!path.isAbsolute(configFile))
    return blocked(requestedUrl, 'PRIVATE_STATE_INVALID');
  await assertNativeWereadCandidateAccount({
    account: input.account,
    configFile,
    ...(new URL(requestedUrl).pathname === '/s'
      ? { candidateMpId: canonicalArticleUrl(requestedUrl).mpId }
      : {}),
  });
  const stateFile = path.join(
    path.dirname(configFile),
    `candidate-public-original-${hash(requestedUrl).slice(0, 24)}.json`,
  );
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(stateFile + '.lock', 'wx', 0o600);
  } catch {
    return blocked(requestedUrl, 'IN_PROGRESS');
  }
  try {
    try {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (state.requestedUrl !== requestedUrl)
        return blocked(requestedUrl, 'PRIVATE_STATE_INVALID');
      if (state.status === 'reviewed-original') {
        const bytes = await fs.readFile(stateFile + '.response');
        if (bytes.length > maxBytes || hash(bytes) !== state.sha256)
          return blocked(requestedUrl, 'CACHE_INVALID');
        const resolvedUrl = state.resolvedUrl || requestedUrl;
        if (
          resolvedUrl !== requestedUrl &&
          publicArticleRedirect(resolvedUrl, requestedUrl) !== resolvedUrl
        )
          return blocked(requestedUrl, 'CACHE_INVALID');
        const result = reviewed(
          resolvedUrl,
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        return originalRequest(result, requestedUrl);
      }
      // No automatic reload/retry, including a crash after reservation.
      return {
        status:
          state.redirectKind === 'verification' ||
          (state.status === 'verification-required' &&
            !redirectKinds.includes(state.redirectKind))
            ? 'verification-required'
            : 'blocked',
        code: 'RETAINED_PUBLIC_STOP',
        requestedUrl,
        ...(Number.isInteger(state.upstreamStatus)
          ? { upstreamStatus: state.upstreamStatus }
          : {}),
        ...(redirectKinds.includes(state.redirectKind)
          ? { redirectKind: state.redirectKind }
          : {}),
        ...(validDiagnostic(state.redirectDiagnostic)
          ? { redirectDiagnostic: state.redirectDiagnostic }
          : {}),
      };
    } catch (error: any) {
      if (error.code !== 'ENOENT')
        return blocked(requestedUrl, 'PRIVATE_STATE_INVALID');
      // A missing response for an existing state is a damaged cache, not a
      // permission to repeat the public request.
      try {
        await fs.access(stateFile);
        return blocked(requestedUrl, 'CACHE_INVALID');
      } catch (stateError: any) {
        if (stateError.code !== 'ENOENT')
          return blocked(requestedUrl, 'PRIVATE_STATE_INVALID');
      }
    }
    const attemptedAt = new Date().toISOString();
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        status: 'reserved',
        requestedUrl,
        attemptedAt,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    let result: WereadPublicOriginalResult;
    let saved: any;
    let requests = 0;
    const redirectChain: PublicRedirectDiagnostic[] = [];
    try {
      requests++;
      let response = await requestDownloadResource(requestedUrl, maxBytes);
      let resolvedUrl = requestedUrl;
      if (validDiagnostic(response.redirectDiagnostic))
        redirectChain.push(response.redirectDiagnostic);
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.redirectKind === 'article'
      ) {
        const target = publicArticleRedirect(
          response.officialArticleRedirect,
          requestedUrl,
        );
        if (target) {
          await assertNativeWereadCandidateAccount({
            account: input.account,
            configFile,
            candidateMpId: canonicalArticleUrl(target).mpId,
          });
          // Reserve the bounded hop before sending. Crashes never grant a retry.
          await fs.writeFile(
            stateFile,
            JSON.stringify({
              status: 'reserved',
              requestedUrl,
              attemptedAt,
              redirectChain,
              requests: 2,
            }),
            { mode: 0o600 },
          );
          resolvedUrl = target;
          requests++;
          response = await requestDownloadResource(target, maxBytes);
          if (validDiagnostic(response.redirectDiagnostic))
            redirectChain.push(response.redirectDiagnostic);
        }
      }
      await fs.writeFile(stateFile + '.response', response.bytes, {
        flag: 'wx',
        mode: 0o600,
      });
      if (response.status >= 300 && response.status < 400) {
        result = {
          status:
            response.redirectKind === 'verification'
              ? 'verification-required'
              : 'blocked',
          code:
            response.redirectKind === 'verification'
              ? 'PUBLIC_ORIGINAL_REDIRECT'
              : response.redirectKind === 'login'
                ? 'PUBLIC_ORIGINAL_LOGIN_REDIRECT'
                : response.redirectKind === 'article'
                  ? 'PUBLIC_ORIGINAL_ARTICLE_REDIRECT'
                  : 'PUBLIC_ORIGINAL_UNSUPPORTED_REDIRECT',
          requestedUrl,
          upstreamStatus: response.status,
          redirectKind: response.redirectKind || 'missing',
          ...(validDiagnostic(response.redirectDiagnostic)
            ? { redirectDiagnostic: response.redirectDiagnostic }
            : {}),
        };
        if (response.redirectKind === 'verification') {
          const observed = response.officialVerification;
          const checked = articleVerificationLocation(
            observed?.status === 'available' ? observed.url : undefined,
            resolvedUrl,
          );
          const observedAt = Date.parse(
            response.verificationObservedAt || attemptedAt,
          );
          const expires = observedAt + ARTICLE_VERIFICATION_TTL_MS;
          const value: TimedArticleVerification =
            observed?.status === 'unavailable'
              ? {
                  status: 'unavailable',
                  articleUrl: resolvedUrl,
                  reason: [
                    'missing-location',
                    'unsafe-location',
                    'sensitive-location',
                  ].includes(observed.reason)
                    ? observed.reason
                    : 'unsafe-location',
                }
              : checked.status !== 'available'
                ? checked
                : !Number.isFinite(expires) ||
                    expires <= Date.now() ||
                    observedAt > Date.now()
                  ? {
                      status: 'unavailable',
                      articleUrl: resolvedUrl,
                      reason: 'expired',
                    }
                  : { ...checked, expiresAt: new Date(expires).toISOString() };
          Object.defineProperty(result, 'officialVerification', {
            value,
            enumerable: false,
          });
          if (value.status === 'unavailable')
            result.redirectDiagnostic = {
              ...(result.redirectDiagnostic || {
                hostKind: 'missing',
                pathKind: 'verification',
              }),
              ...(value.reason !== 'expired'
                ? { verificationReason: value.reason }
                : {}),
            };
        }
      } else if (response.status !== 200) {
        result = {
          status: 'blocked',
          code: 'PUBLIC_ORIGINAL_HTTP',
          requestedUrl,
          upstreamStatus: response.status,
        };
      } else if (
        response.type !== 'text/html' ||
        response.bytes.length > maxBytes
      ) {
        result = blocked(requestedUrl, 'PUBLIC_ORIGINAL_INVALID');
      } else {
        const html = new TextDecoder('utf-8', { fatal: true }).decode(
          response.bytes,
        );
        const $ = load(html);
        result =
          $(
            '#js_verify,#verify,.weui_msg,iframe[src*="captcha."],form[action*="/mp/verify"],input[type="password"]',
          ).length || /wappoc_appmsgcaptcha|verify\.html/i.test(html)
            ? {
                status: 'verification-required',
                code: 'PUBLIC_ORIGINAL_VERIFICATION_PAGE',
                requestedUrl,
                upstreamStatus: 200,
              }
            : originalRequest(reviewed(resolvedUrl, html), requestedUrl);
      }
      saved = {
        ...result,
        attemptedAt,
        redirectChain,
        requests,
        ...(result.status === 'reviewed-original' &&
        resolvedUrl !== requestedUrl
          ? { resolvedUrl }
          : {}),
        ...(result.status !== 'reviewed-original' && result.officialVerification
          ? {
              verificationLinkStatus: result.officialVerification.status,
              ...(result.officialVerification.status === 'unavailable'
                ? { verificationLinkReason: result.officialVerification.reason }
                : {
                    verificationLinkExpiresAt:
                      result.officialVerification.expiresAt,
                  }),
            }
          : {}),
        ...(result.status === 'reviewed-original'
          ? { sha256: hash(response.bytes) }
          : {}),
      };
    } catch (error) {
      result = blocked(
        requestedUrl,
        error instanceof Error && error.message === 'PUBLIC_IDENTITY_CONFLICT'
          ? 'PUBLIC_IDENTITY_CONFLICT'
          : 'PUBLIC_ORIGINAL_FAILED',
      );
      saved = { ...result, attemptedAt, requests, redirectChain };
    }
    // Neither HTML nor full Location enters public-state diagnostics.
    const pending = stateFile + '.pending';
    await fs.writeFile(pending, JSON.stringify(saved), {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(pending, stateFile);
    return result;
  } catch {
    return blocked(requestedUrl, 'PRIVATE_STATE_INVALID');
  } finally {
    await lock.close();
    await fs.unlink(stateFile + '.lock');
  }
}
