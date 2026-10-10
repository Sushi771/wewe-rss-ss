import axios from 'axios';
import { OwnerWebSession } from './owner-web-search';
import { OwnerWebCookieLifecycle } from './owner-web-cookie-lifecycle';

export class WereadNativeRequestError extends Error {
  constructor(
    public readonly code:
      | 'HTTP_STATUS'
      | 'BUSINESS_REFUSED'
      | 'INVALID_RESPONSE',
    public readonly status?: number,
    public readonly businessCode?: number,
  ) {
    super(
      code === 'HTTP_STATUS'
        ? `HTTP ${status}`
        : code === 'BUSINESS_REFUSED'
          ? `业务码 ${businessCode}`
          : '读书响应格式无效',
    );
  }
}

/** Shared existing fixed-endpoint transport. No renewal, redirect, retry or
 * signing. Private response recording precedes status/body parsing.
 */
export function createWereadNativeRequester(
  session: OwnerWebSession,
  ownerVid: string,
  record: (response: { status: number; data: string }) => Promise<void>,
  beforeSend?: () => void,
) {
  const cookies = new OwnerWebCookieLifecycle(session, ownerVid);
  return async (url: string, params: Record<string, string>, html = false) => {
    if (
      ![
        'https://weread.qq.com/web/mp/articles',
        'https://weread.qq.com/web/mp/content',
        'https://weread.qq.com/api/mp/cover',
      ].includes(url)
    )
      throw new WereadNativeRequestError('INVALID_RESPONSE');
    const Cookie = cookies.header(url);
    beforeSend?.();
    const response = await axios.get<string>(url, {
      params,
      headers: {
        Cookie,
        Referer: 'https://weread.qq.com/',
        Origin: 'https://weread.qq.com',
        'User-Agent': 'Mozilla/5.0',
        Accept: html
          ? 'text/html,application/xhtml+xml,*/*'
          : 'application/json, text/plain, */*',
      },
      proxy: false,
      maxRedirects: 0,
      timeout: 20000,
      maxContentLength: 8 * 1024 * 1024,
      responseType: 'text',
      transformResponse: [(value) => value],
      validateStatus: () => true,
    });
    if (typeof response.data !== 'string')
      throw new WereadNativeRequestError('INVALID_RESPONSE');
    await record({ status: response.status, data: response.data });
    if (response.status !== 200)
      throw new WereadNativeRequestError('HTTP_STATUS', response.status);
    cookies.absorb(url, response.headers?.['set-cookie']);
    if (!html || /^\s*[\[{]/.test(response.data)) {
      let data: any;
      try {
        data = JSON.parse(response.data);
      } catch {
        throw new WereadNativeRequestError('INVALID_RESPONSE');
      }
      for (const key of ['errCode', 'errcode', 'code']) {
        const value = data?.[key];
        if (
          value === undefined ||
          value === null ||
          value === 0 ||
          value === '0'
        )
          continue;
        if (
          (typeof value !== 'number' && typeof value !== 'string') ||
          !/^-?\d{1,10}$/.test(String(value))
        )
          throw new WereadNativeRequestError('INVALID_RESPONSE');
        throw new WereadNativeRequestError(
          'BUSINESS_REFUSED',
          undefined,
          Number(value),
        );
      }
    }
    return response.data;
  };
}

export type WereadNativeRequester = ReturnType<
  typeof createWereadNativeRequester
>;
