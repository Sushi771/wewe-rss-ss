import * as https from 'node:https';
import type { SafeSourceStage } from './xhs-source-receipt';
import { IncomingMessage, ClientRequest } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { XhsMediaError, mediaHttpError } from './xhs-media-error';
import { RedbookPauseError, RedbookTransport } from './redbook-client';
import {
  redbookErrorSummary,
  REDBOOK_ERROR_MAX_BYTES,
} from './redbook-error-summary';
import {
  allowedRedbookMediaUrl,
  allowedRedbookVideoUrl,
  RedbookMediaTransport,
} from './redbook-response';

export type XhsHttpsRequest = typeof https.request;
const API_HOST = 'edith.xiaohongshu.com';
const METHODS: Record<string, string> = {
  '/api/sns/web/v2/comment/page': 'GET',
  '/api/sns/web/v2/comment/sub/page': 'GET',
  '/api/sns/web/v1/user/otherinfo': 'GET',
  '/api/sns/web/v1/user_posted': 'GET',
  '/api/sns/web/v1/feed': 'POST',
};
const API_HEADERS = new Set([
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
const stop = () => new RedbookPauseError('transport');
function contentLength(res: IncomingMessage, limit: number) {
  const value = res.headers['content-length'];
  if (
    value !== undefined &&
    (!/^\d+$/.test(String(value)) || Number(value) > limit)
  )
    throw stop();
}

/** Native HTTPS never follows redirects. Only the three reviewed reading routes
 * may carry Cookie; no fallback endpoint, proxy, retry or ambient browser auth. */
export function createRedbookHttpTransport(
  request: XhsHttpsRequest = https.request,
  observe?: (stage: SafeSourceStage, status?: number, notSent?: boolean) => void,
): RedbookTransport {
  return (input) =>
    new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(input.url);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== API_HOST ||
          url.port ||
          url.username ||
          url.password ||
          url.hash ||
          /^https:\/\/[^/]*:\d+(?:\/|$)/i.test(input.url) ||
          METHODS[url.pathname] !== input.method ||
          input.redirect !== 'error'
        )
          throw stop();
        if (
          !Number.isSafeInteger(input.timeoutMs) ||
          input.timeoutMs <= 0 ||
          input.timeoutMs > 15000 ||
          !Number.isSafeInteger(input.maxResponseBytes) ||
          input.maxResponseBytes <= 0 ||
          input.maxResponseBytes > 8 * 1024 * 1024
        )
          throw stop();
        for (const [key, value] of Object.entries(input.headers))
          if (
            !API_HEADERS.has(key.toLowerCase()) ||
            typeof value !== 'string' ||
            /[\r\n\x00]/.test(value)
          )
            throw stop();
        if (
          input.body &&
          (input.method !== 'POST' || Buffer.byteLength(input.body) > 65536)
        )
          throw stop();
        input.signal?.throwIfAborted();
      } catch {
        observe?.('transport',undefined,true);
        reject(stop());
        return;
      }
      let req: ClientRequest | undefined,
        res: IncomingMessage | undefined,
        timer: NodeJS.Timeout | undefined,
        done = false;
      const chunks: Buffer[] = [];
      let length = 0;
      let errorStatus: number | undefined;
      const clear = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        for (const b of chunks) b.fill(0);
        chunks.length = 0;
      };
      const fail = () => {
        if (done) return;
        done = true;
        clear();
        res?.destroy();
        req?.destroy();
        // Once an HTTP rejection is known, preserve its stop semantics even if
        // its optional diagnostic body is invalid, slow, interrupted or huge.
        if (errorStatus !== undefined)
          resolve({ status: errorStatus, url: input.url, body: {} });
        else reject(stop());
      };
      const abort = () => fail();
      try {
        req = request(
          url,
          { method: input.method, headers: { ...input.headers }, agent: false },
          (incoming) => {
            res = incoming;
            if (done) {
              res.destroy();
              return;
            }
            const status = res.statusCode ?? 502;
            observe?.('response',status);
            const rejected = status < 200 || status >= 300;
            if (rejected) errorStatus = status;
            // Redirects never need body inspection and are never followed.
            if (status >= 300 && status < 400) {
              fail();
              return;
            }
            const limit = rejected
              ? Math.min(input.maxResponseBytes, REDBOOK_ERROR_MAX_BYTES)
              : input.maxResponseBytes;
            try {
              contentLength(res, limit);
              if (
                !/^application\/json(?:;|$)/i.test(
                  String(res.headers['content-type'] ?? ''),
                )
              )
                throw stop();
            } catch {
              fail();
              return;
            }
            res.on('data', (part: Buffer) => {
              if (done) return;
              length += part.length;
              if (length > limit) {
                part.fill(0);
                fail();
                return;
              }
              chunks.push(Buffer.from(part));
            });
            res.on('error', fail);
            res.on('aborted', fail);
            res.on('end', () => {
              if (done) return;
              let bytes: Buffer | undefined;
              try {
                input.signal?.throwIfAborted();
                bytes = Buffer.concat(chunks);
                observe?.('parse');
                const body: unknown = JSON.parse(bytes.toString('utf8'));
                done = true;
                clear();
                resolve({
                  status,
                  url: input.url,
                  body: rejected ? redbookErrorSummary(body) : body,
                });
              } catch {
                fail();
              } finally {
                bytes?.fill(0);
              }
            });
          },
        );
        req.on('error', fail);
        req.once('finish', () => { if (!done) observe?.('sent'); });
        timer = setTimeout(fail, input.timeoutMs);
        timer.unref?.();
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) fail();
        else req.end(input.body);
      } catch {
        if (!req) observe?.('transport',undefined,true);
        fail();
      }
    });
}

/** Cookie-free, bounded/backpressured media stream, restricted to the original
 * two CDN hosts. The source mapper separately validates actual image bytes. */
export function createXhsMediaTransport(
  request: XhsHttpsRequest = https.request,
): RedbookMediaTransport {
  return (url, options) =>
    new Promise((resolve, reject) => {
      try {
        const video = options.headers.accept === 'video/mp4';
        if ((video ? allowedRedbookVideoUrl(url.href).href : allowedRedbookMediaUrl(url.href).href) !== url.href)
          throw stop();
      } catch {
        reject(new XhsMediaError('XHS_MEDIA_URL_REJECTED'));
        return;
      }
      try {
        if (
          options.redirect !== 'manual' ||
          options.credentials !== 'omit' ||
          Object.keys(options.headers).some((k) => k !== 'accept')
        )
          throw stop();
      } catch {
        reject(new XhsMediaError('XHS_MEDIA_REQUEST_REJECTED'));
        return;
      }
      if (options.signal.aborted) {
        reject(new XhsMediaError(options.signal.reason?.name === 'TimeoutError' ? 'XHS_MEDIA_TIMEOUT' : 'XHS_MEDIA_ABORTED'));
        return;
      }
      const video = options.headers.accept === 'video/mp4';
      const mediaLimit = video ? 100_000_000 : 10_000_000;
      let req: ClientRequest | undefined,
        res: IncomingMessage | undefined,
        limiter: Transform | undefined;
      let timer: NodeJS.Timeout | undefined,
        returned = false,
        ended = false,
        length = 0;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
      };
      const fail = (error = new XhsMediaError('XHS_MEDIA_TRANSPORT_FAILED')) => {
        if (ended) return;
        ended = true;
        cleanup();
        res?.destroy();
        req?.destroy();
        limiter?.destroy(error);
        if (!returned) reject(error);
      };
      const abort = () => fail(new XhsMediaError(options.signal.reason?.name === 'TimeoutError' ? 'XHS_MEDIA_TIMEOUT' : 'XHS_MEDIA_ABORTED'));
      try {
        req = request(
          url,
          {
            method: 'GET',
            headers: { accept: options.headers.accept },
            agent: false,
          },
          (incoming) => {
            res = incoming;
            if (ended) {
              res.destroy();
              return;
            }
            try {
              if (res.statusCode !== 200) throw mediaHttpError(res.statusCode ?? 0);
              const rawLength = res.headers['content-length'];
              if (rawLength !== undefined && !/^\d+$/.test(String(rawLength)))
                throw new XhsMediaError('XHS_MEDIA_RESPONSE_INVALID');
              if (rawLength !== undefined && Number(rawLength) > mediaLimit)
                throw new XhsMediaError('XHS_MEDIA_SIZE_REJECTED');
              const mime = String(res.headers['content-type'] ?? '')
                .split(';')[0]
                .trim()
                .toLowerCase();
              if (video ? mime !== 'video/mp4' : !/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new XhsMediaError('XHS_MEDIA_TYPE_REJECTED');
              if (video && rawLength === undefined) throw new XhsMediaError('XHS_MEDIA_RESPONSE_INVALID');
              limiter = new Transform({
                transform(part: Buffer, _encoding, callback) {
                  length += part.length;
                  if (length > mediaLimit) callback(new XhsMediaError('XHS_MEDIA_SIZE_REJECTED'));
                  else callback(null, part);
                },
              });
              limiter.on('error', () => {
                res?.destroy();
                req?.destroy();
                cleanup();
              });
              limiter.on('close', () => {
                if (!ended) {
                  ended = true;
                  res?.destroy();
                  req?.destroy();
                  cleanup();
                }
              });
              res.on('error', () => fail());
              res.on('aborted', () => fail());
              res.on('end', () => {
                ended = true;
                cleanup();
              });
              const response = new Response(
                Readable.toWeb(res.pipe(limiter)) as ReadableStream<Uint8Array>,
                { status: 200, headers: { 'content-type': mime, ...(rawLength === undefined ? {} : {'content-length': String(rawLength)}) } },
              );
              Object.defineProperty(response, 'url', { value: url.href });
              returned = true;
              resolve(response);
            } catch (error) {
              fail(error instanceof XhsMediaError ? error : undefined);
            }
          },
        );
        req.on('error', () => fail());
        timer = setTimeout(() => fail(new XhsMediaError('XHS_MEDIA_TIMEOUT')), 10000);
        timer.unref?.();
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
        else req.end();
      } catch {
        fail();
      }
    });
}
