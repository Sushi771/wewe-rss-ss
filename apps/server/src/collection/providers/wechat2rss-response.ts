/** Decoded response-byte ceilings, independent of Content-Length/compression. */
export const WECHAT2RSS_CONTROL_RESPONSE_LIMIT = 4_000_000;
export const WECHAT2RSS_CACHE_RESPONSE_LIMIT = 16 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
export type Wechat2RssResponseErrorCode =
  | 'WECHAT2RSS_RESPONSE_TOO_LARGE'
  | 'WECHAT2RSS_HTTP_STATUS'
  | 'WECHAT2RSS_RATE_LIMITED'
  | 'WECHAT2RSS_EMPTY_BODY'
  | 'WECHAT2RSS_INVALID_JSON'
  | 'WECHAT2RSS_INVALID_ENCODING'
  | 'WECHAT2RSS_REQUEST_TIMEOUT'
  | 'WECHAT2RSS_NETWORK_ERROR';
type ResponseDetails = {
  phase?: 'headers' | 'body' | 'json';
  httpStatus?: number;
  responseBytes?: number;
  responseLimitBytes?: number;
};
/** Fixed code and numbers only: never retain URL, response text or raw cause. */
export class Wechat2RssResponseError extends Error {
  readonly phase?: 'headers' | 'body' | 'json';
  readonly httpStatus?: number;
  readonly responseBytes?: number;
  readonly responseLimitBytes?: number;
  constructor(
    code: Wechat2RssResponseErrorCode,
    details: ResponseDetails = {},
  ) {
    super(code);
    this.name = 'Wechat2RssResponseError';
    Object.assign(this, details);
  }
}
export function wechat2RssResponseDetails(error: unknown) {
  return error instanceof Wechat2RssResponseError
    ? {
        failureCode: error.message as Wechat2RssResponseErrorCode,
        httpStatus: error.httpStatus,
        responseBytes: error.responseBytes,
        responseLimitBytes: error.responseLimitBytes,
      }
    : {};
}
/** Remove each read's listener when it settles. Racing every chunk against
 * one never-settled abort promise would retain one reaction per tiny chunk. */
export function waitForWechat2RssResponse<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Wechat2RssResponseError('WECHAT2RSS_REQUEST_TIMEOUT'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
/** One reusable byte block and at most ceil(limit/64KiB)+1 string pieces.
 * No complete Buffer copy and no array entry per tiny network chunk.
 * The same deadline covers both fetching headers and draining the body. */
export async function readWechat2RssResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
  deadline: number,
) {
  if (!response.body)
    throw new Wechat2RssResponseError('WECHAT2RSS_EMPTY_BODY');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const block = new Uint8Array(BLOCK_BYTES);
  const parts: string[] = [];
  let size = 0,
    used = 0;
  const decode = (bytes?: Uint8Array, stream = true) => {
    try {
      return decoder.decode(bytes, { stream });
    } catch {
      throw new Wechat2RssResponseError('WECHAT2RSS_INVALID_ENCODING');
    }
  };
  try {
    while (true) {
      if (Date.now() >= deadline)
        throw new Wechat2RssResponseError('WECHAT2RSS_REQUEST_TIMEOUT');
      const { done, value } = await waitForWechat2RssResponse(
        reader.read(),
        signal,
      );
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new Wechat2RssResponseError('WECHAT2RSS_RESPONSE_TOO_LARGE', {
          responseBytes: size,
          responseLimitBytes: limit,
        });
      for (let offset = 0; offset < value.byteLength; ) {
        const count = Math.min(BLOCK_BYTES - used, value.byteLength - offset);
        block.set(value.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used === BLOCK_BYTES) {
          parts.push(decode(block));
          used = 0;
        }
      }
    }
    if (used) parts.push(decode(block.subarray(0, used)));
    parts.push(decode(undefined, false));
    if (Date.now() >= deadline)
      throw new Wechat2RssResponseError('WECHAT2RSS_REQUEST_TIMEOUT');
    if (size === 0)
      throw new Wechat2RssResponseError('WECHAT2RSS_EMPTY_BODY', {
        responseBytes: 0,
        responseLimitBytes: limit,
      });
    return parts.join('');
  } finally {
    // A hostile/failed stream must not turn cancellation into an unbounded wait
    // or replace the original size/timeout diagnostic.
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* A cancelled pending read owns it. */
    }
  }
}
