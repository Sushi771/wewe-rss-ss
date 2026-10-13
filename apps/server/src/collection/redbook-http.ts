import * as https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import {
  RedbookRequest,
  RedbookResponse,
  RedbookTransport,
} from './redbook-client';
import {
  allowedRedbookMediaUrl,
  RedbookMediaTransport,
} from './redbook-response';

/** No target override, proxy, redirect, fallback or retry configuration. */
function bytes(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  limit: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('REDBOOK_HTTP_ABORTED'));
    let finished = false;
    const request = https.request(
      url,
      { method, headers, agent: false },
      (response) => {
        const status = response.statusCode || 0;
        if (status !== 200) {
          response.destroy();
          finish(undefined, {
            status,
            headers: response.headers,
            body: Buffer.alloc(0),
          });
          return;
        }
        const declared = response.headers['content-length'];
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
          finish(new Error('REDBOOK_HTTP_SIZE'));
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > limit) {
            finish(new Error('REDBOOK_HTTP_SIZE'));
            response.destroy();
            request.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        response.on('error', () => finish(new Error('REDBOOK_HTTP_TRANSPORT')));
        response.on('aborted', () =>
          finish(new Error('REDBOOK_HTTP_TRANSPORT')),
        );
        response.on('end', () =>
          finish(undefined, {
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    function finish(
      error?: Error,
      result?: { status: number; headers: IncomingHttpHeaders; body: Buffer },
    ) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    }
    function abort() {
      finish(new Error('REDBOOK_HTTP_ABORTED'));
      request.destroy();
    }
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      finish(new Error('REDBOOK_HTTP_TIMEOUT'));
      request.destroy();
    }, timeout);
    request.on('error', () => finish(new Error('REDBOOK_HTTP_TRANSPORT')));
    request.end(body);
  });
}

export function createRedbookHttpTransport(
  signal?: AbortSignal,
): RedbookTransport {
  return async (request: RedbookRequest): Promise<RedbookResponse> => {
    const url = new URL(request.url);
    if (
      !request.url.startsWith('https://edith.xiaohongshu.com/') ||
      url.href !== request.url ||
      url.origin !== 'https://edith.xiaohongshu.com' ||
      url.username ||
      url.password ||
      url.hash ||
      !(
        (request.method === 'GET' &&
          url.pathname === '/api/sns/web/v2/user_posted') ||
        (request.method === 'POST' &&
          url.pathname === '/api/sns/web/v1/feed' &&
          !url.search)
      ) ||
      request.redirect !== 'error'
    )
      throw new Error('REDBOOK_HTTP_TARGET');
    if (
      !Number.isSafeInteger(request.maxResponseBytes) ||
      request.maxResponseBytes < 1 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1
    )
      throw new Error('REDBOOK_HTTP_LIMITS');
    const allowed = new Set([
      'user-agent',
      'content-type',
      'origin',
      'referer',
      'cookie',
      'x-s',
      'x-s-common',
      'x-t',
      'x-b3-traceid',
      'x-xray-traceid',
    ]);
    if (
      Object.keys(request.headers).some(
        (key) => !allowed.has(key.toLowerCase()),
      )
    )
      throw new Error('REDBOOK_HTTP_HEADERS');
    const result = await bytes(
      url,
      request.method,
      request.headers,
      request.body,
      Math.min(8 * 1024 * 1024, request.maxResponseBytes),
      Math.min(15000, request.timeoutMs),
      signal,
    );
    let body: unknown = {};
    if (result.status === 200) {
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          String(result.headers['content-type'] || ''),
        )
      )
        throw new Error('REDBOOK_HTTP_CONTENT_TYPE');
      try {
        body = JSON.parse(result.body.toString('utf8'));
      } catch {
        throw new Error('REDBOOK_HTTP_JSON');
      }
    }
    return { status: result.status, url: request.url, body };
  };
}

export function createRedbookMediaHttpTransport(
  sessionSignal?: AbortSignal,
): RedbookMediaTransport {
  return async (url, options) => {
    allowedRedbookMediaUrl(url.href);
    if (
      options.redirect !== 'manual' ||
      options.credentials !== 'omit' ||
      Object.keys(options.headers).some((key) => key !== 'accept')
    )
      throw new Error('REDBOOK_HTTP_MEDIA_HEADERS');
    const signal = sessionSignal
      ? AbortSignal.any([sessionSignal, options.signal])
      : options.signal;
    const result = await bytes(
      url,
      'GET',
      { accept: options.headers.accept },
      undefined,
      10_000_000,
      10000,
      signal,
    );
    const response = new Response(Uint8Array.from(result.body), {
      status: result.status,
      headers: { 'content-type': String(result.headers['content-type'] || '') },
    });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
}
