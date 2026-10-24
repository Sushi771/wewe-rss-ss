import * as https from 'node:https';
import { IncomingMessage, ClientRequest } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { RedbookPauseError, RedbookTransport } from './redbook-client';
import {
  allowedRedbookMediaUrl,
  RedbookMediaTransport,
} from './redbook-response';

export type XhsHttpsRequest = typeof https.request;
const API_HOST = 'edith.xiaohongshu.com';
const METHODS: Record<string, string> = {
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
        reject(stop());
        return;
      }
      let req: ClientRequest | undefined,
        res: IncomingMessage | undefined,
        timer: NodeJS.Timeout | undefined,
        done = false;
      const chunks: Buffer[] = [];
      let length = 0;
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
        reject(stop());
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
            // Preserve only status for non-success responses; never retain platform
            // error text, verification URLs or echoing request parameters.
            if (status < 200 || status >= 300) {
              done = true;
              clear();
              res.destroy();
              resolve({ status, url: input.url, body: {} });
              return;
            }
            try {
              contentLength(res, input.maxResponseBytes);
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
              if (length > input.maxResponseBytes) {
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
                const body: unknown = JSON.parse(bytes.toString('utf8'));
                done = true;
                clear();
                resolve({ status, url: input.url, body });
              } catch {
                fail();
              } finally {
                bytes?.fill(0);
              }
            });
          },
        );
        req.on('error', fail);
        timer = setTimeout(fail, input.timeoutMs);
        timer.unref?.();
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) fail();
        else req.end(input.body);
      } catch {
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
        if (
          allowedRedbookMediaUrl(url.href).href !== url.href ||
          options.redirect !== 'manual' ||
          options.credentials !== 'omit' ||
          Object.keys(options.headers).some((k) => k !== 'accept')
        )
          throw stop();
        options.signal.throwIfAborted();
      } catch {
        reject(stop());
        return;
      }
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
      const fail = () => {
        if (ended) return;
        ended = true;
        cleanup();
        res?.destroy();
        req?.destroy();
        limiter?.destroy(stop());
        if (!returned) reject(stop());
      };
      const abort = () => fail();
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
              if (res.statusCode !== 200) throw stop();
              contentLength(res, 10_000_000);
              const mime = String(res.headers['content-type'] ?? '')
                .split(';')[0]
                .trim()
                .toLowerCase();
              if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw stop();
              limiter = new Transform({
                transform(part: Buffer, _encoding, callback) {
                  length += part.length;
                  if (length > 10_000_000) callback(stop());
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
              res.on('error', fail);
              res.on('aborted', fail);
              res.on('end', () => {
                ended = true;
                cleanup();
              });
              const response = new Response(
                Readable.toWeb(res.pipe(limiter)) as ReadableStream<Uint8Array>,
                { status: 200, headers: { 'content-type': mime } },
              );
              Object.defineProperty(response, 'url', { value: url.href });
              returned = true;
              resolve(response);
            } catch {
              fail();
            }
          },
        );
        req.on('error', fail);
        timer = setTimeout(fail, 10000);
        timer.unref?.();
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) fail();
        else req.end();
      } catch {
        fail();
      }
    });
}
