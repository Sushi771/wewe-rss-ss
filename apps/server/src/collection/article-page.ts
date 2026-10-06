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
  if (matches.length > 1) throw new Error('原文 CGI 字段重复或冲突');
  return matches.length === 1 ? matches[0][2] : undefined;
}

/** 只读取原文结构中的发布时间；正文是否可缓存由独立检查判断。 */
export function articlePublishTime(html: string): number | null {
  const $ = load(html);
  if (!$('#js_content, .rich_media_content').length) return null;
  // Body prose/index metadata cannot supply ct. All reviewed page fields must
  // agree; a first regex match must not hide a conflicting original timestamp.
  const script = $('script')
    .toArray()
    .map((node) => $(node).html() || '')
    .join('\n');
  let values: string[];
  try {
    values = [
      ...[
        ...script.matchAll(
          /\b(?:create_time|ct|CreateTime)\b["']?\s*[:=]\s*['"]?(\d{10})(?!\d)['"]?/gi,
        ),
      ].map((m) => m[1]),
      ...['ori_create_time', 'ori_send_time', 'create_timestamp']
        .map((name) => cgiDataNewField(script, name, '\\d{10}'))
        .filter((v): v is string => Boolean(v)),
    ];
  } catch {
    return null;
  }
  if (new Set(values).size !== 1) return null;
  const timestamp = Number(values[0]);
  return timestamp >= 946684800 && timestamp <= Date.now() / 1000 + 300
    ? timestamp
    : null;
}

/** Read page-supplied public article links only; never derive a link from IDs. */
export function articleOriginalLink(html: string): string | undefined {
  const $ = load(html);
  const values = $('meta[property="og:url"]')
    .toArray()
    .map((node) => $(node).attr('content') || '');
  const scripts = $('script')
    .toArray()
    .map((node) => $(node).html() || '')
    .join('\n');
  for (const match of scripts.matchAll(
    /\bvar\s+msg_link\s*=\s*(["'])([^"'\\\r\n]{0,4096})\1\s*;/g,
  ))
    values.push(match[2]);
  if (
    (scripts.match(/\bvar\s+msg_link\s*=/g) || []).length !==
    values.length - $('meta[property="og:url"]').length
  )
    throw new Error('原文链接表达式无法静态核验');
  const links = values.filter(Boolean).map((value) => {
    const decoded = load('<span></span>')('span').html(value).text().trim();
    if (decoded.length > 4096) throw new Error('原文链接无效');
    const link = new URL(decoded);
    if (
      link.protocol !== 'https:' ||
      link.hostname !== 'mp.weixin.qq.com' ||
      link.port ||
      link.username ||
      link.password
    )
      throw new Error('原文链接无效');
    if (link.pathname === '/s') {
      const allowed = new Set(['__biz', 'mid', 'idx', 'sn', 'chksm']);
      for (const key of link.searchParams.keys())
        if (!allowed.has(key) || link.searchParams.getAll(key).length !== 1)
          throw new Error('原文链接参数无效');
      if (link.hash && link.hash !== '#rd') throw new Error('原文链接无效');
      if (
        link.searchParams.has('sn') &&
        !/^[a-fA-F0-9]+$/.test(link.searchParams.get('sn')!)
      )
        throw new Error('原文链接签名无效');
      if (
        link.searchParams.has('chksm') &&
        !/^[A-Za-z0-9_-]{1,256}$/.test(link.searchParams.get('chksm')!)
      )
        throw new Error('原文链接参数无效');
      return {
        provided: link.toString(),
        comparison: canonicalArticleUrl(link.toString()).url,
      };
    }
    if (
      !/^\/s\/[A-Za-z0-9_-]{1,256}$/.test(link.pathname) ||
      link.search ||
      link.hash
    )
      throw new Error('原文链接无效');
    return { provided: link.toString(), comparison: link.toString() };
  });
  if (new Set(links.map((link) => link.comparison)).size > 1)
    throw new Error('原文链接字段冲突');
  return links[0]?.provided;
}

export function articleIdentity(html: string) {
  const $ = load(html);
  if (!$('#js_content').length) throw new Error('没有可核验的原文结构');
  const value = (name: string, pattern: string) => {
    // Tencent also emits empty-literal fallbacks: var sn = "" || "hex" || "".
    // Read complete literal-only assignments, never evaluate JavaScript or accept a partial expression.
    const values: string[] = [];
    const assignment = new RegExp(
      `\\bvar\\s+${name}\\s*=\\s*([^;\\r\\n]+)(?=;|[\\r\\n]|$)`,
      'g',
    );
    for (const match of html.matchAll(assignment)) {
      const expression = match[1].trim();
      if (['mid', 'idx'].includes(name) && /^\d+$/.test(expression)) {
        values.push(expression);
        continue;
      }
      // Bundled functions reuse names such as mid for local calculations. They
      // are not page identity literals; do not evaluate or collect them.
      if (!/^["']/.test(expression)) continue;
      const literal = `(?:"[^"\\\\]*"|'[^'\\\\]*')`;
      if (
        !new RegExp(`^${literal}(?:\\s*\\|\\|\\s*${literal})*$`).test(
          expression,
        )
      )
        throw new Error('原文身份表达式无法静态核验');
      for (const candidate of expression.matchAll(/["']([^"']*)["']/g)) {
        if (!candidate[1]) continue;
        if (!new RegExp(`^(?:${pattern})$`).test(candidate[1]))
          throw new Error('原文身份字段无效');
        values.push(candidate[1]);
      }
    }
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
  const identity = canonicalArticleUrl(url.toString());
  const canonical = articleOriginalLink(html);
  if (canonical && new URL(canonical).pathname === '/s') {
    const supplied = canonicalArticleUrl(canonical);
    if (
      supplied.id !== identity.id ||
      supplied.mpId !== identity.mpId ||
      (sn && new URL(supplied.url).searchParams.get('sn') !== sn)
    )
      throw new Error('原文链接与静态身份冲突');
    // Keep the genuine supplied link, normalized by the existing URL policy.
    // A page-provided sn need not be invented as a separate body scalar.
    identity.url = supplied.url;
  }
  return {
    ...identity,
    canonical,
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
