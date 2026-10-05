import axios from 'axios';
import { load } from 'cheerio';
import { lookup } from 'node:dns/promises';
import { LookupAddress } from 'node:dns';
import { buildArticleMarkdown } from './article-export';
import { Agent } from 'node:https';
import { isIP } from 'node:net';
import { articleContentHtml, articleIdentity } from './collection/article-page';
import { canonicalArticleUrl } from './collection/collection-format';
import { publicArticleRequestUrl } from './collection/public-album';
import { allowedImageUrl, decodeInlineImage } from './collection/image-fetch';

type RedirectKind = 'verification' | 'login' | 'article' | 'other' | 'missing';
export type DownloadDiagnostic = {
  code: string;
  stage?: 'article' | 'image';
  upstreamStatus?: number;
  redirectKind?: RedirectKind;
};

export class ArticleDownloadError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly diagnostic: DownloadDiagnostic = { code: 'DOWNLOAD_FAILED' },
  ) {
    super(message);
  }
}

export function downloadArticleUrl(raw: unknown): string {
  try {
    if (typeof raw !== 'string' || raw.length > 2000) throw new Error();
    const input = raw.trim();
    if (/[\\\s\x00-\x1f\x7f]/.test(input)) throw new Error();
    const url = new URL(input);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error();
    if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname))
      return `${url.origin}${url.pathname}`;
    if (
      ['__biz', 'mid', 'idx', 'sn', 'chksm', 'appmsgid', 'itemidx'].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    )
      throw new Error();
    const result = publicArticleRequestUrl(input);
    if (
      !/^[a-fA-F0-9]{4,64}$/.test(new URL(result).searchParams.get('sn') || '')
    )
      throw new Error();
    return result;
  } catch {
    throw new ArticleDownloadError(
      '请粘贴有效的 HTTPS 微信公众号文章链接（mp.weixin.qq.com/s）。',
      400,
      { code: 'INVALID_ARTICLE_URL', stage: 'article' },
    );
  }
}

/** Deny local, reserved, mapped and transition addresses before connecting. */
export function publicDownloadAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // A conservative global-unicast allowlist also denies IPv4-mapped IPv6.
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^(2001|2002|3ffe|3fff):/i.test(address)
  );
}

export async function resolveDownloadAddress(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicDownloadAddress(address))
  )
    throw new ArticleDownloadError('目标地址不符合公开网络安全限制。');
  return addresses[0];
}

type DownloadResponse = {
  bytes: Buffer;
  type: string;
  status: number;
  redirectKind?: RedirectKind;
};
type DownloadRequest = (
  url: string,
  maxBytes: number,
) => Promise<DownloadResponse>;

/** Classify Location without exposing it, following it, or carrying its credentials. */
export function downloadRedirectKind(
  raw: unknown,
  source: string,
): RedirectKind {
  if (typeof raw !== 'string' || !raw) return 'missing';
  try {
    const target = new URL(raw, source);
    if (target.username || target.password) return 'other';
    if (
      target.hostname === 'mp.weixin.qq.com' &&
      /(?:captcha|verify)/i.test(target.pathname)
    )
      return 'verification';
    if (
      ['mp.weixin.qq.com', 'open.weixin.qq.com'].includes(target.hostname) &&
      /(?:login|oauth|connect)/i.test(target.pathname)
    )
      return 'login';
    downloadArticleUrl(target.toString());
    return 'article';
  } catch {
    return 'other';
  }
}

function responseFailure(
  response: DownloadResponse,
  stage: 'article' | 'image',
) {
  const subject = stage === 'article' ? '原文' : '图片';
  const upstreamStatus = response.status;
  const failure = (
    message: string,
    code: string,
    redirectKind?: RedirectKind,
  ) =>
    new ArticleDownloadError(message, 422, {
      code,
      stage,
      upstreamStatus,
      ...(redirectKind ? { redirectKind } : {}),
    });
  if (upstreamStatus >= 300 && upstreamStatus < 400) {
    const kind = response.redirectKind || 'missing';
    const reason = {
      verification: '跳转到验证页面，请先在微信官方页面处理验证',
      login: '跳转到登录页面，本工具不使用微信登录凭据',
      article: '跳转到文章链接，请复制官方页面最终显示的文章链接',
      other: '发生未支持的跳转，请先在官方页面检查链接',
      missing: '返回跳转状态但没有可确认的目标，请先在官方页面检查链接',
    }[kind];
    return failure(
      `${subject}${reason}（HTTP ${upstreamStatus}）；请求已停止，未生成下载文件。`,
      kind === 'verification'
        ? 'VERIFICATION_REDIRECT'
        : kind === 'login'
          ? 'LOGIN_REDIRECT'
          : 'UNSUPPORTED_REDIRECT',
      kind,
    );
  }
  if (upstreamStatus !== 200) {
    const reason =
      upstreamStatus === 429
        ? '访问被限流，请暂勿重复点击'
        : upstreamStatus === 401
          ? '要求登录，本工具不使用微信登录凭据'
          : upstreamStatus === 403
            ? '服务器拒绝访问，请先在官方页面确认文章是否公开可读'
            : upstreamStatus === 404 || upstreamStatus === 410
              ? '链接不可用或文章已移除，请在官方页面核对链接'
              : '服务器返回异常状态，请先查看官方页面';
    return failure(
      `${subject}${reason}（HTTP ${upstreamStatus}），未生成下载文件。`,
      upstreamStatus === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP_ERROR',
    );
  }
}

function transportFailure(error: unknown, stage: 'article' | 'image') {
  if (error instanceof ArticleDownloadError) return error;
  const code = (error as { code?: string })?.code;
  const subject = stage === 'article' ? '原文' : '图片';
  if (
    code === 'ERR_BAD_RESPONSE' &&
    /maxContentLength/.test((error as Error)?.message || '')
  )
    return new ArticleDownloadError(
      `${subject}超过单次下载的安全大小限制，未生成下载文件。`,
      422,
      { code: 'RESOURCE_TOO_LARGE', stage },
    );
  const timeout = ['ECONNABORTED', 'ETIMEDOUT'].includes(code || '');
  const dns = ['ENOTFOUND', 'EAI_AGAIN'].includes(code || '');
  return new ArticleDownloadError(
    `${subject}${timeout ? '连接超时' : dns ? '域名解析失败' : '网络连接失败'}，未收到有效响应，未生成下载文件。`,
    422,
    {
      code: timeout
        ? 'NETWORK_TIMEOUT'
        : dns
          ? 'DNS_FAILURE'
          : 'NETWORK_FAILURE',
      stage,
    },
  );
}

/** No proxy, cookies, redirects or retries. DNS validation pins the actual socket lookup. */
export const requestDownloadResource: DownloadRequest = async (
  raw,
  maxBytes,
) => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new ArticleDownloadError('目标链接不符合安全限制。');
  if (url.hostname !== 'mp.weixin.qq.com') allowedImageUrl(raw);
  const agent = new Agent({
    keepAlive: false,
    lookup(hostname, _options, callback) {
      resolveDownloadAddress(hostname).then(
        ({ address, family }) => {
          if (typeof _options === 'object' && 'all' in _options && _options.all)
            (
              callback as (
                error: Error | null,
                addresses: LookupAddress[],
              ) => void
            )(null, [{ address, family }]);
          else callback(null, address, family);
        },
        (error) => callback(error, '', 4),
      );
    },
  });
  try {
    const response = await axios.get<Buffer>(raw, {
      proxy: false,
      httpsAgent: agent,
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        referer: 'https://mp.weixin.qq.com/',
      },
    });
    return {
      bytes: Buffer.from(response.data),
      status: response.status,
      type: String(response.headers['content-type'] || '')
        .split(';')[0]
        .toLowerCase(),
      ...(response.status >= 300 && response.status < 400
        ? { redirectKind: downloadRedirectKind(response.headers.location, raw) }
        : {}),
    };
  } catch (error) {
    throw transportFailure(
      error,
      url.hostname === 'mp.weixin.qq.com' ? 'article' : 'image',
    );
  } finally {
    agent.destroy();
  }
};

/** Connect a public link to the existing Markdown + local attachments exporter. */
/** Same inert body policy for remote articles and already verified local bodies. */
export function inertDownloadBody(content: string) {
  const $ = load(content);
  const body = $('#js_content, .rich_media_content').first();
  if (!body.length)
    throw new ArticleDownloadError('未取得有效文章正文，未生成下载文件。');
  const tags = new Set(
    'div section p span br h1 h2 h3 h4 h5 h6 strong b em i u s del blockquote ul ol li table thead tbody tfoot tr th td hr a img pre code figure figcaption'.split(
      ' ',
    ),
  );
  for (const element of body.find('*').toArray().reverse()) {
    const node = $(element);
    if (!tags.has(element['tagName'])) {
      node.remove();
      continue;
    }
    node.removeAttr('href');
    for (const attr of Object.keys(element['attribs'] || {}))
      if (!['src', 'alt', 'title'].includes(attr)) node.removeAttr(attr);
  }
  for (const attr of Object.keys(body.get(0)?.attribs || {}))
    body.removeAttr(attr);
  body.attr('id', 'js_content');
  return $.html(body);
}

export async function buildArticleDownload(
  raw: unknown,
  directory: string,
  request: DownloadRequest = requestDownloadResource,
  options: {
    imageDirectory?: 'attachments' | 'image';
    markdownOnly?: boolean;
  } = {},
) {
  const url = downloadArticleUrl(raw);
  try {
    const response = await request(url, 5_000_000).catch((error) => {
      throw transportFailure(error, 'article');
    });
    const failure = responseFailure(response, 'article');
    if (failure) throw failure;
    if (response.type !== 'text/html')
      throw new ArticleDownloadError(
        '原文返回的不是 HTML 文章页面（HTTP 200），请检查原文链接；未生成下载文件。',
        422,
        { code: 'NON_HTML_RESPONSE', stage: 'article', upstreamStatus: 200 },
      );
    if (response.bytes.length > 5_000_000)
      throw new ArticleDownloadError(
        '原文超过 5 MB 安全大小限制，未生成下载文件。',
        422,
        { code: 'ARTICLE_TOO_LARGE', stage: 'article', upstreamStatus: 200 },
      );
    const html = response.bytes.toString('utf8');
    const page = load(html);
    if (
      page(
        '#js_verify, #verify, .weui_msg, iframe[src*="captcha."], form[action*="/mp/verify"], form[action*="login"], input[type="password"]',
      ).length
    )
      throw new ArticleDownloadError(
        '原文页面要求登录或验证，请先在微信官方页面处理；未生成下载文件。',
        422,
        {
          code: 'AUTH_OR_VERIFICATION_PAGE',
          stage: 'article',
          upstreamStatus: 200,
        },
      );
    let identity: ReturnType<typeof articleIdentity>;
    let content: string | undefined;
    try {
      identity = articleIdentity(html);
      content = articleContentHtml(html);
    } catch {
      throw new ArticleDownloadError(
        '未取得有效文章正文，可能需要登录或验证；未生成下载文件。',
      );
    }
    if (!content)
      throw new ArticleDownloadError('未取得有效文章正文，未生成下载文件。');
    if (new URL(url).pathname === '/s') {
      if (canonicalArticleUrl(url).url !== identity.url)
        throw new ArticleDownloadError(
          '原文身份与链接不一致，未生成下载文件。',
        );
    } else if (identity.canonical !== url) {
      throw new ArticleDownloadError('原文身份与链接不一致，未生成下载文件。');
    }
    const title =
      page('#activity-name, .rich_media_title').first().text().trim() ||
      page('meta[property="og:title"]').attr('content')?.trim();
    if (!title || title.length > 1000)
      throw new ArticleDownloadError('未取得有效文章标题，未生成下载文件。');
    // Markdown can retain raw HTML; share the same inert policy with cached saves.
    const $ = load(inertDownloadBody(content));
    const images = $('#js_content img').toArray();
    if (images.length > 60 || images.some((image) => !$(image).attr('src')))
      throw new ArticleDownloadError(
        '文章图片超过安全限制或无法保存，未生成下载文件。',
      );
    const body = $('#js_content');
    if (!body.text().replace(/[\s\u200b-\u200d\ufeff]/gu, '') && !images.length)
      throw new ArticleDownloadError('未取得有效文章正文，未生成下载文件。');
    // Embedded bytes bypass the remote image fetcher but share its article budget.
    let totalBytes = images.reduce((total, image) => {
      const source = $(image).attr('src')!;
      return (
        total +
        (source.startsWith('data:')
          ? decodeInlineImage(source).bytes.length
          : 0)
      );
    }, 0);
    // The shared exporter deliberately replaces image errors with its generic message.
    // Preserve this tool's safe diagnostic without changing subscription export behavior.
    let imageFailure: ArticleDownloadError | undefined;
    const { markdown, contentHtml } = await buildArticleMarkdown(
      {
        id: identity.id,
        title,
        sourceUrl: null,
        contentHtml: $.html(body),
        lastBodyStatus: null,
        metrics: null,
        publishTime: identity.publishTime || 0,
      },
      '',
      directory,
      async (source) => {
        try {
          allowedImageUrl(source);
          const result = await request(source, 10_000_000).catch((error) => {
            throw transportFailure(error, 'image');
          });
          const failure = responseFailure(result, 'image');
          if (failure) throw failure;
          const image = decodeInlineImage(
            `data:${result.type};base64,${result.bytes.toString('base64')}`,
          );
          totalBytes += image.bytes.length;
          if (totalBytes > 20_000_000) throw new Error();
          return image;
        } catch (error) {
          const failure =
            error instanceof ArticleDownloadError &&
            error.diagnostic.stage === 'image'
              ? error
              : new ArticleDownloadError(
                  '图片下载失败或超出安全限制，未生成下载文件。',
                  422,
                  { code: 'IMAGE_DOWNLOAD_FAILED', stage: 'image' },
                );
          imageFailure ??= failure;
          throw failure;
        }
      },
      options.imageDirectory,
    ).catch((error) => {
      throw imageFailure || error;
    });
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const escapeHtml = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (char) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[char]!,
      );
    await writeFile(
      join(directory, 'index.md'),
      `# ${escapeHtml(title.replace(/[\r\n]/g, ' '))}\n\n原文来源：${identity.url}\n\n${markdown}\n`,
    );
    // Same sanitized/localized body as the existing Markdown exporter, with a small offline reading shell.
    if (!options.markdownOnly)
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>body{max-width:760px;margin:40px auto;padding:0 20px;font:17px/1.8 sans-serif;overflow-wrap:anywhere;color:#222}img{max-width:100%;height:auto}pre{white-space:pre-wrap}footer{margin-top:32px;font-size:14px}</style></head><body><h1>${escapeHtml(title)}</h1>${contentHtml}<footer>原文来源：<a href="${escapeHtml(identity.url)}" rel="noreferrer noopener">${escapeHtml(identity.url)}</a></footer></body></html>`,
      );
    return {
      filename: `${
        Array.from(
          title
            .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-')
            .replace(/[. ]+$/g, ''),
        )
          .slice(0, 75)
          .join('') || '文章'
      }.zip`,
      imageCount: images.length,
      articleId: identity.id,
      title,
    };
  } catch (error) {
    if (error instanceof ArticleDownloadError) throw error;
    throw new ArticleDownloadError('下载文件生成失败，未生成下载文件。', 500, {
      code: 'FILE_GENERATION_FAILED',
    });
  }
}
