/** Candidate client for the documented Rnote public-v2 wire contract. This is
 * not a claim that the separately sold Web/PGY source or trial has these routes.
 * No default host, environment read, source registration, retries or media fetch.
 */
export class RnoteReadError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = 'RnoteReadError';
  }
}
export const rnoteObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(code: string): never {
  throw new RnoteReadError(code);
}
const id = (value: string) => {
  if (!/^[a-f0-9]{24}$/.test(value)) fail('RNOTE_ID_INVALID');
  return value;
};
const integer = (value: number, max: number) => {
  if (!Number.isInteger(value) || value < 1 || value > max)
    fail('RNOTE_PARAMETER_INVALID');
  return value;
};
const seconds = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 86400
    ? value
    : undefined;

export type RnoteCandidateResponse = {
  contract: 'rnote-public-v2';
  productCompatibilityVerified: false;
  evidenceVerified: false;
  /** Unknown business fields stay in memory; never log or send this to the UI. */
  data: Record<string, unknown>;
  billed?: boolean;
};

export class RnotePublicClient {
  private readonly base!: URL;
  private readonly key?: string;
  constructor(
    settings: { baseUrl: string; apiKey?: string },
    private readonly transport: typeof fetch = fetch,
  ) {
    try {
      const raw = settings.baseUrl;
      if (
        !raw ||
        /[\s\\?#\x00-\x1f\x7f]/.test(raw) ||
        !/^https?:\/\//.test(raw)
      )
        throw new Error();
      this.base = new URL(raw);
      const rawHost = /^https?:\/\/(\[[^\]]+\]|[^/:]+)(?::\d+)?\/?$/.exec(
        raw,
      )?.[1];
      if (
        !rawHost ||
        raw.includes('@') ||
        rawHost.toLowerCase() !== this.base.hostname
      )
        throw new Error();
      const host = this.base.hostname;
      // Explicit official public host or literal loopback only. No DNS, inferred
      // supplier host, arbitrary redirect destination or credential-bearing URL.
      if (
        this.base.username ||
        this.base.password ||
        this.base.search ||
        this.base.hash ||
        !(
          (this.base.protocol === 'https:' && host === 'rnote.dev') ||
          ['localhost', '127.0.0.1', '[::1]'].includes(host)
        ) ||
        this.base.pathname !== '/'
      )
        throw new Error();
    } catch {
      fail('RNOTE_BASE_URL_INVALID');
    }
    if (
      settings.apiKey !== undefined &&
      (typeof settings.apiKey !== 'string' ||
        /[\s\x00-\x1f\x7f]/.test(settings.apiKey) ||
        settings.apiKey.length > 1024)
    )
      fail('RNOTE_KEY_INVALID');
    this.key = settings.apiKey || undefined;
  }
  async posted(userId: string, cursor = '', num = 3) {
    id(userId);
    integer(num, 20);
    if (
      typeof cursor !== 'string' ||
      cursor.length > 8192 ||
      /[\x00-\x1f\x7f]/.test(cursor)
    )
      fail('RNOTE_CURSOR_INVALID');
    return this.request('/api/v2/crawler/user/posted', {
      user_id: userId,
      cursor,
      num: String(num),
    });
  }
  image(noteId: string) {
    return this.request('/api/v2/crawler/note/image', { note_id: id(noteId) });
  }
  video(noteId: string) {
    return this.request('/api/v2/crawler/note/video', { note_id: id(noteId) });
  }
  pgyNotes(
    userId: string,
    page = 1,
    size = 3,
    variant: 'notes' | 'notes_v2' = 'notes',
  ) {
    if (!['notes', 'notes_v2'].includes(variant))
      fail('RNOTE_PARAMETER_INVALID');
    return this.request('/api/v2/pgy/blogger/' + variant, undefined, {
      user_id: id(userId),
      page_number: integer(page, 1000),
      page_size: integer(size, 8),
    });
  }
  pgyDetail(noteId: string) {
    return this.request('/api/v2/pgy/note/detail', undefined, {
      note_id: id(noteId),
    });
  }
  private async request(
    route: string,
    query?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<RnoteCandidateResponse> {
    if (!this.key) fail('RNOTE_KEY_MISSING');
    const url = new URL(route, this.base);
    for (const [name, value] of Object.entries(query || {}))
      url.searchParams.set(name, value);
    try {
      const response = await this.transport(url, {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: {
          Accept: 'application/json',
          'X-API-Key': this.key!,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const status = response.status;
      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        throw new RnoteReadError('RNOTE_REDIRECT_REJECTED', status);
      }
      const httpCode: Record<number, string> = {
        401: 'RNOTE_AUTH_INVALID',
        402: 'RNOTE_BALANCE_INSUFFICIENT',
        403: 'RNOTE_SCOPE_DENIED',
        429: 'RNOTE_RATE_LIMITED',
      };
      const header = response.headers.get('retry-after');
      const headerWait =
        header && /^\d+(?:\.\d+)?$/.test(header)
          ? seconds(Number(header))
          : undefined;
      // Do not parse arbitrary authentication/payment error bodies.
      if ([401, 402, 403].includes(status)) {
        await response.body?.cancel();
        throw new RnoteReadError(httpCode[status], status, headerWait);
      }
      if (
        !response.body ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') || '',
        )
      ) {
        await response.body?.cancel();
        throw new RnoteReadError(
          httpCode[status] || 'RNOTE_RESPONSE_INVALID',
          status,
          headerWait,
        );
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 4_000_000) {
          await reader.cancel();
          fail('RNOTE_RESPONSE_TOO_LARGE');
        }
        chunks.push(Buffer.from(part.value));
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new RnoteReadError(
          httpCode[status] || 'RNOTE_RESPONSE_INVALID',
          status,
          headerWait,
        );
      }
      const retry = rnoteObject(envelope)
        ? seconds(envelope.retry_after)
        : undefined;
      if (status !== 200)
        throw new RnoteReadError(
          httpCode[status] || 'RNOTE_HTTP_FAILED',
          status,
          headerWait ?? retry,
        );
      if (!rnoteObject(envelope) || typeof envelope.success !== 'boolean')
        fail('RNOTE_RESPONSE_INVALID');
      if (!envelope.success)
        throw new RnoteReadError(
          'RNOTE_BUSINESS_REJECTED',
          status,
          headerWait ?? retry,
        );
      if (
        !rnoteObject(envelope.data) ||
        (envelope.billed !== undefined && typeof envelope.billed !== 'boolean')
      )
        fail('RNOTE_RESPONSE_INVALID');
      return {
        contract: 'rnote-public-v2',
        productCompatibilityVerified: false,
        evidenceVerified: false,
        data: envelope.data,
        ...(typeof envelope.billed === 'boolean'
          ? { billed: envelope.billed }
          : {}),
      };
    } catch (error) {
      if (error instanceof RnoteReadError) throw error;
      throw new RnoteReadError(
        error instanceof Error &&
          ['TimeoutError', 'AbortError'].includes(error.name)
          ? 'RNOTE_TIMEOUT'
          : 'RNOTE_REQUEST_FAILED',
      );
    }
  }
}
