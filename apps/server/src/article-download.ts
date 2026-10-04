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

export class ArticleDownloadError extends Error {
  constructor(
    message: string,
    readonly status = 422,
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

type DownloadResponse = { bytes: Buffer; type: string; status: number };
type DownloadRequest = (
  url: string,
  maxBytes: number,
) => Promise<DownloadResponse>;

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
    };
  } finally {
    agent.destroy();
  }
};

/** Connect a public link to the existing Markdown + local attachments exporter. */
export async function buildArticleDownload(
  raw: unknown,
  directory: string,
  request: DownloadRequest = requestDownloadResource,
) {
  const url = downloadArticleUrl(raw);
  try {
    const response = await request(url, 5_000_000);
    if (
      response.status !== 200 ||
      response.type !== 'text/html' ||
      response.bytes.length > 5_000_000
    )
      throw new ArticleDownloadError(
        '原文访问失败或发生跳转，未生成下载文件。',
      );
    const html = response.bytes.toString('utf8');
    const page = load(html);
    if (
      page(
        '#js_verify, #verify, .weui_msg, iframe[src*="captcha."], form[action*="/mp/verify"], form[action*="login"], input[type="password"]',
      ).length
    )
      throw new ArticleDownloadError('原文需要登录或验证，未生成下载文件。');
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
    const $ = load(content);
    // Markdown converters can retain raw HTML for unsupported tags. Keep only inert article elements.
    const tags = new Set(
      'div section p span br h1 h2 h3 h4 h5 h6 strong b em i u s del blockquote ul ol li table thead tbody tfoot tr th td hr a img pre code figure figcaption'.split(
        ' ',
      ),
    );
    for (const element of $('#js_content *').toArray().reverse()) {
      const node = $(element);
      if (!tags.has(element['tagName'])) {
        node.remove();
        continue;
      }
      node.removeAttr('href'); // Only the canonical source is exported as an outgoing link.
      for (const attr of Object.keys(element['attribs'] || {}))
        if (!['src', 'alt', 'title'].includes(attr)) node.removeAttr(attr);
    }
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
          const result = await request(source, 10_000_000);
          if (result.status !== 200) throw new Error();
          const image = decodeInlineImage(
            `data:${result.type};base64,${result.bytes.toString('base64')}`,
          );
          totalBytes += image.bytes.length;
          if (totalBytes > 20_000_000) throw new Error();
          return image;
        } catch {
          throw new ArticleDownloadError(
            '图片下载失败或超出安全限制，未生成下载文件；请稍后重试。',
          );
        }
      },
    );
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
    };
  } catch (error) {
    if (error instanceof ArticleDownloadError) throw error;
    throw new ArticleDownloadError(
      '文章或图片下载失败，请检查链接或稍后重试；未生成下载文件。',
    );
  }
}
