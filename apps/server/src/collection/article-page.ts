import got from 'got';
import { load } from 'cheerio';
import { canonicalArticleUrl } from './collection-format';

export const articlePageRequest = got.extend({
  retry: { limit: 3, methods: ['GET'] },
  timeout: 8 * 1e3,
  headers: {
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'max-age=0',
    'sec-ch-ua':
      '" Not A;Brand";v="99", "Chromium";v="101", "Google Chrome";v="101"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36',
  },
});

/** Read simple scalar fields from the public page's CGI object without executing page JS. */
function cgiDataNewField(
  html: string,
  name: string,
  valuePattern: string,
): string | undefined {
  const marker = /\bwindow\.cgiDataNew\s*=\s*\{/.exec(html);
  if (!marker || marker.index === undefined) return undefined;
  const start = marker.index + marker[0].lastIndexOf('{');
  const scriptEnd = html.indexOf('</script>', start);
  const limit = Math.min(
    scriptEnd < 0 ? html.length : scriptEnd,
    start + 1_000_000,
  );
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let end = -1;
  for (let i = start; i < limit; i++) {
    const char = html[i];
    const next = html[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
    } else if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
    } else if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '/' && next === '/') {
      lineComment = true;
      i++;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) return undefined;
  const script = html.slice(start, end);
  const expression = new RegExp(
    `(?:^|[,{])\\s*(?:["']${name}["']|${name})\\s*:\\s*(["'])(${valuePattern})\\1`,
    'g',
  );
  const matches = [...script.matchAll(expression)];
  return matches.length === 1 ? matches[0][2] : undefined;
}

/** 只读取原文结构中的发布时间；正文是否可缓存由独立检查判断。 */
export function articlePublishTime(html: string): number | null {
  const $ = load(html);
  if (!$('#js_content, .rich_media_content').length) return null;
  const match = html.match(
    /\b(?:create_time|ct|CreateTime)\b["']?\s*[:=]\s*['"]?(\d{10})(?!\d)['"]?/i,
  );
  const cgiTime =
    cgiDataNewField(html, 'ori_create_time', '\\d{10}') ||
    cgiDataNewField(html, 'ori_send_time', '\\d{10}') ||
    cgiDataNewField(html, 'create_timestamp', '\\d{10}');
  if (match && cgiTime && match[1] !== cgiTime) return null;
  const timestamp = Number(match?.[1] || cgiTime);
  return timestamp >= 946684800 && timestamp <= Date.now() / 1000 + 300
    ? timestamp
    : null;
}

export function articleIdentity(html: string) {
  const $ = load(html);
  if (!$('#js_content').length) throw new Error('没有可核验的原文结构');
  const value = (name: string, pattern: string) => {
    // Repeated page variables must agree before they can identify an article.
    const values = [
      ...html.matchAll(
        new RegExp(`\\bvar\\s+${name}\\s*=\\s*["'](${pattern})["']`, 'g'),
      ),
    ].map((match) => match[1]);
    if (new Set(values).size > 1) throw new Error('原文身份字段冲突');
    return values[0];
  };
  const choose = (legacy: string | undefined, modern: string | undefined) => {
    if (legacy && modern && legacy !== modern)
      throw new Error('原文身份字段冲突');
    return legacy || modern;
  };
  const biz = choose(
    value('biz', '[A-Za-z0-9+/=]+'),
    cgiDataNewField(html, 'bizuin', '[A-Za-z0-9+/=]+'),
  );
  const mid = choose(
    value('mid', '\\d+'),
    cgiDataNewField(html, 'mid', '\\d+'),
  );
  const idx = choose(
    value('idx', '\\d+'),
    cgiDataNewField(html, 'idx', '\\d+'),
  );
  const sn = choose(
    value('sn', '[a-fA-F0-9]+'),
    cgiDataNewField(html, 'sn', '[a-fA-F0-9]+'),
  );
  if (!biz || !mid || !idx) throw new Error('未取得原文 biz/mid/idx 身份');
  const url = new URL('https://mp.weixin.qq.com/s');
  for (const [key, val] of [
    ['__biz', biz],
    ['mid', mid],
    ['idx', idx],
    ['sn', sn || ''],
  ])
    if (val) url.searchParams.set(key, val);
  return {
    ...canonicalArticleUrl(url.toString()),
    canonical: $('meta[property="og:url"]').attr('content'),
    publishTime: articlePublishTime(html),
  };
}

/** Cache only the article body, without page scripts, event handlers or trackers. */
export function articleContentHtml(html: string): string | undefined {
  const $ = load(html);
  const content = $('#js_content, .rich_media_content').first();
  if (
    !content.length ||
    (!content.text().trim() && !content.find('img').length)
  )
    return undefined;
  content
    .find(
      'script,style,iframe,object,embed,form,input,button,link,meta,svg,base',
    )
    .remove();
  for (const element of content.find('*').toArray()) {
    const node = $(element);
    const source = node.attr('data-src') || node.attr('src');
    for (const attr of Object.keys(element['attribs'] || {}))
      if (!['href', 'alt', 'title', 'colspan', 'rowspan'].includes(attr))
        node.removeAttr(attr);
    const href = node.attr('href');
    if (href && !/^https?:\/\//i.test(href)) node.removeAttr('href');
    if (element['tagName'] === 'img' && source) {
      try {
        const url = new URL(source);
        if (
          ['http:', 'https:'].includes(url.protocol) &&
          /(^|\.)(qpic\.cn|qlogo\.cn|qq\.com)$/.test(url.hostname) &&
          !url.port &&
          !url.username &&
          !url.password
        )
          node.attr('src', url.toString());
      } catch {
        /* Ignore malformed image sources. */
      }
    }
  }
  // 在清洗之后判断：脚本、被拒绝的图片和空白容器不算已取得正文。
  if (
    !content.text().replace(/[\s\u200b-\u200d\ufeff]/gu, '') &&
    !content.find('img[src]').length
  )
    return undefined;
  return `<div class="rich_media_content" id="js_content">${content.html()}</div>`;
}

export const BODY_UNAVAILABLE_MESSAGE =
  '正文暂不可用，已保存核验后的文章信息；可在本机文章列表重试正文或更新订阅。';
