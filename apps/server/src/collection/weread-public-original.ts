import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load } from 'cheerio';
import {
  downloadArticleUrl,
  requestDownloadResource,
} from '../article-download';
import { ArticleVerification } from '../../../../packages/shared/src/article-verification';
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
      /** Only safe, observed Location; never included in diagnostic serialization. */
      readonly officialVerification?: ArticleVerification;
    };
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const maxBytes = 10 * 1024 * 1024;

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
        return reviewed(
          requestedUrl,
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      }
      // No automatic reload/retry, including a crash after reservation.
      return {
        status:
          state.status === 'verification-required'
            ? 'verification-required'
            : 'blocked',
        code: 'RETAINED_PUBLIC_STOP',
        requestedUrl,
        ...(Number.isInteger(state.upstreamStatus)
          ? { upstreamStatus: state.upstreamStatus }
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
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        status: 'reserved',
        requestedUrl,
        attemptedAt: new Date().toISOString(),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    let result: WereadPublicOriginalResult;
    let saved: any;
    try {
      const response = await requestDownloadResource(requestedUrl, maxBytes);
      await fs.writeFile(stateFile + '.response', response.bytes, {
        flag: 'wx',
        mode: 0o600,
      });
      if (response.status >= 300 && response.status < 400) {
        result = {
          status: 'verification-required',
          code: 'PUBLIC_ORIGINAL_REDIRECT',
          requestedUrl,
          upstreamStatus: response.status,
          redirectKind: response.redirectKind || 'missing',
        };
        if (response.officialVerification)
          Object.defineProperty(result, 'officialVerification', {
            value: response.officialVerification,
            enumerable: false,
          });
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
            : reviewed(requestedUrl, html);
      }
      saved = {
        ...result,
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
      saved = result;
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
