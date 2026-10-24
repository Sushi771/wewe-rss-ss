import { buildGetUri, signMainApi, USER_AGENT } from './redbook-vendor/signing';

export type RedbookPauseReason =
  | 'configuration'
  | 'authentication'
  | 'verification'
  | 'permission'
  | 'signature'
  | 'rate_limit'
  | 'transport'
  | 'response';

/** Deliberately excludes server text, URL, cookies, tokens and raw response. */
export class RedbookPauseError extends Error {
  readonly paused = true;
  constructor(readonly reason: RedbookPauseReason) {
    super(`Redbook scan paused: ${reason}`);
    this.name = 'RedbookPauseError';
  }
}

export interface RedbookRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  redirect: 'error';
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export interface RedbookResponse {
  status: number;
  /** Required even for injected transports; redirected/cross-host results fail closed. */
  url: string;
  body: unknown;
}

/** Transport implementations must enforce timeout/size, no redirects and no retries. */
export type RedbookTransport = (
  request: RedbookRequest,
) => Promise<RedbookResponse>;

export interface RedbookClientOptions {
  transport?: RedbookTransport;
  /** Explicit in-memory credential handoff only. Never populated from env or browser. */
  cookies?: () => Record<string, string>;
}

export interface RedbookUserPageOptions {
  xsecToken?: string | null;
  xsecSource?: string | null;
  signal?: AbortSignal;
}

const HOST = 'https://edith.xiaohongshu.com';
// The pinned upstream also supports v1; v2 returned HTTP 404 in the bounded
// acceptance. Choose the reviewed route explicitly, without automatic retries.
const LIST_PATH = '/api/sns/web/v1/user_posted';
const DETAIL_PATH = '/api/sns/web/v1/feed';
const PROFILE_PATH = '/api/sns/web/v1/user/otherinfo';

function checkedText(value: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new RedbookPauseError('configuration');
  }
  return value;
}

function checkedId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new RedbookPauseError('configuration');
  return value;
}

function reasonFor(
  status: number,
  code?: unknown,
): RedbookPauseReason | undefined {
  if (status === 461 || status === 471) return 'verification';
  if (status === 406 || code === 300015) return 'signature';
  if (status === 429 || code === 300012) return 'rate_limit';
  if (status === 401 || code === -100 || code === -101) return 'authentication';
  if (status === 403 || code === -104) return 'permission';
  return undefined;
}

/** Audited read endpoints only. No network transport is enabled by default. */
export class RedbookClient {
  constructor(private readonly options: RedbookClientOptions = {}) {}

  getUserInfo(
    userId: string,
    options: RedbookUserPageOptions = {},
  ): Promise<unknown> {
    return this.request(
      'GET',
      PROFILE_PATH,
      {
        target_user_id: checkedId(userId),
        xsec_token: checkedText(options.xsecToken ?? '', 4096),
        xsec_source: checkedText(options.xsecSource ?? '', 128),
      },
      undefined,
      options.signal,
    );
  }

  getUserNotes(
    userId: string,
    cursor = '',
    options: RedbookUserPageOptions = {},
  ): Promise<unknown> {
    return this.request(
      'GET',
      LIST_PATH,
      {
        num: 30,
        cursor: checkedText(cursor, 2048),
        user_id: checkedId(userId),
        image_formats: 'jpg,webp',
        xsec_token: checkedText(options.xsecToken ?? '', 4096),
        xsec_source: checkedText(options.xsecSource ?? '', 128),
      },
      undefined,
      options.signal,
    );
  }

  getNoteById(
    noteId: string,
    xsecToken: string,
    xsecSource = 'pc_feed',
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      'POST',
      DETAIL_PATH,
      undefined,
      {
        source_note_id: checkedId(noteId),
        image_formats: ['jpg', 'webp'],
        extra: { need_body_topic: 1 },
        xsec_source: checkedText(xsecSource, 128),
        xsec_token: checkedText(xsecToken, 4096),
      },
      signal,
    );
  }

  private async request(
    method: 'GET' | 'POST',
    path: typeof LIST_PATH | typeof DETAIL_PATH | typeof PROFILE_PATH,
    params?: Record<string, string | number | string[]>,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.options.transport || !this.options.cookies)
      throw new RedbookPauseError('configuration');
    let response: RedbookResponse;
    const uri = method === 'GET' ? buildGetUri(path, params) : path;
    try {
      signal?.throwIfAborted();
      const cookies = { ...this.options.cookies() };
      if (
        !cookies.a1 ||
        !cookies.web_session ||
        Object.keys(cookies).length > 100
      ) {
        throw new RedbookPauseError('authentication');
      }
      for (const [key, value] of Object.entries(cookies)) {
        if (
          !/^[a-zA-Z0-9_-]{1,128}$/.test(key) ||
          !value ||
          value.length > 8192 ||
          /[;\s\x00-\x1f\x7f]/.test(value)
        ) {
          throw new RedbookPauseError('authentication');
        }
      }
      response = await this.options.transport({
        url: HOST + uri,
        method,
        headers: {
          'user-agent': USER_AGENT,
          'content-type': 'application/json',
          origin: 'https://www.xiaohongshu.com',
          referer: 'https://www.xiaohongshu.com/',
          cookie: Object.entries(cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; '),
          ...signMainApi(method, path, cookies, params, payload),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: 'error',
        timeoutMs: 15_000,
        maxResponseBytes: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof RedbookPauseError) throw error;
      throw new RedbookPauseError('transport');
    }
    if (response.url !== HOST + uri) throw new RedbookPauseError('transport');
    const statusReason = reasonFor(response.status);
    if (statusReason) throw new RedbookPauseError(statusReason);
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    )
      throw new RedbookPauseError('response');
    const envelope = response.body;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      throw new RedbookPauseError('response');
    const data = envelope as Record<string, unknown>;
    const codeReason = reasonFor(response.status, data.code);
    if (codeReason) throw new RedbookPauseError(codeReason);
    if (
      data.success !== true ||
      (data.code !== undefined && data.code !== 0) ||
      !data.data ||
      typeof data.data !== 'object' ||
      Array.isArray(data.data)
    ) {
      throw new RedbookPauseError('response');
    }
    return data.data;
  }
}
