#!/usr/bin/env node
// One read-only, anonymous request to Sogou's public mobile article search.
// A per-account private sentinel prevents accidental repeat requests.
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ENDPOINT = 'https://weixin.sogou.com/weixinwap';
const MAX_BODY_BYTES = 128 * 1024;
const TIMEOUT_MS = 8000;
const PRIVATE_DIR = path.join(os.homedir(), '.wewe-rss-private', 'mobile-public-search');

function accountNameFromArgs(args) {
  if (args.length !== 2 || args[0] !== '--account-name') {
    throw new Error('Usage: node probe-mobile-public-article-search.cjs --account-name "公众号名称"');
  }
  const name = args[1].trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Account name must be 1–100 printable characters.');
  }
  return name;
}

function redirectShape(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return {
      host: url.hostname,
      path: url.pathname.slice(0, 120),
    };
  } catch {
    return { malformed: true };
  }
}

async function boundedBody(response) {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = MAX_BODY_BYTES - length;
      if (value.length > remaining) {
        if (remaining) parts.push(Buffer.from(value.subarray(0, remaining)));
        length += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      parts.push(Buffer.from(value));
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(parts, length), truncated };
}

function shapeOfHtml(html) {
  const count = (pattern) => [...html.matchAll(pattern)].length;
  return {
    newsListMarkers: count(/\bnews-list\b/gi),
    articleListItems: count(/<li\b[^>]*\bid=["']?sogou_vr_/gi),
    titleBoxMarkers: count(/\btxt-box\b/gi),
    wechatArticleLinks: count(/https?:\/\/mp\.weixin\.qq\.com\/s(?:\?|\/)/gi),
    sogouRedirectLinks: count(/(?:https?:\/\/weixin\.sogou\.com)?\/link\?url=/gi),
    paginationMarkers: count(/\b(?:pagebar|totalPages|nextPage)\b/gi),
  };
}

async function main() {
  const accountName = accountNameFromArgs(process.argv.slice(2));
  const id = createHash('sha256').update(accountName, 'utf8').digest('hex').slice(0, 20);
  const sentinel = path.join(PRIVATE_DIR, `${id}.json`);
  const rawPath = path.join(PRIVATE_DIR, `${id}.html`);
  await fs.mkdir(PRIVATE_DIR, { recursive: true, mode: 0o700 });
  const started = { state: 'started', at: new Date().toISOString(), endpoint: ENDPOINT, targetHash: id };
  try {
    await fs.writeFile(sentinel, JSON.stringify(started, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Private sentinel already exists: ${sentinel}. No request was sent.`);
    }
    throw error;
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set('type', '2');
  url.searchParams.set('query', accountName);
  let result;
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://weixin.sogou.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      },
    });
    const { bytes, truncated } = await boundedBody(response);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const redirect = redirectShape(response.headers.get('location'), url);
    const verification = /验证码|安全验证|访问过于频繁|请输入验证码|captcha|antispider|verifycode/i.test(
      html.slice(0, 32000) + (redirect?.path || ''),
    );
    if (bytes.length) await fs.writeFile(rawPath, bytes, { flag: 'wx', mode: 0o600 });
    result = {
      state: verification ? 'verification-stop' : 'completed',
      at: new Date().toISOString(),
      endpoint: ENDPOINT,
      targetHash: id,
      status: response.status,
      contentType: response.headers.get('content-type')?.split(';')[0] || null,
      redirect,
      bytesSaved: bytes.length,
      truncated,
      shape: shapeOfHtml(html),
      rawFile: bytes.length ? rawPath : null,
      note: 'Single request; redirects disabled; no article links opened.',
    };
  } catch (error) {
    result = {
      state: 'request-error',
      at: new Date().toISOString(),
      endpoint: ENDPOINT,
      targetHash: id,
      errorClass: error?.name || 'Error',
      note: 'No automatic retry. Review sentinel before any further request.',
    };
  }
  await fs.writeFile(sentinel, JSON.stringify(result, null, 2), { mode: 0o600 });
  process.stdout.write(`${result.state}; evidence: ${sentinel}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
