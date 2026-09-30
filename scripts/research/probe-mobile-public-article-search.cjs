#!/usr/bin/env node
// One read-only, anonymous request to Sogou's public mobile article search.
// A per-account private sentinel prevents accidental repeat requests.
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ENDPOINT = 'https://weixin.sogou.com/weixinwap';
const MAX_BODY_BYTES = 128 * 1024;
const TIMEOUT_MS = 8000;
const PRIVATE_DIR = path.join(os.homedir(), '.wewe-rss-private', 'mobile-public-search');
const VERIFICATION = /验证码|安全验证|请输入验证码|captcha|antispider|verifycode/i;
const RATE_LIMIT = /访问过于频繁|操作频繁|请求过于频繁|rate.limit|too many requests/i;

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

function pathsFor(accountName, directory) {
  const id = createHash('sha256').update(accountName, 'utf8').digest('hex').slice(0, 20);
  return {
    id,
    sentinel: path.join(directory, `${id}.json`),
    rawPath: path.join(directory, `${id}.html`),
  };
}

async function syncedNewFile(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableSummary(sentinel, result) {
  const next = `${sentinel}.next`;
  await syncedNewFile(next, JSON.stringify(result, null, 2));
  await fs.rename(next, sentinel);
  // The file is fsynced before rename. Some platforms also permit syncing the
  // directory entry; Windows may reject opening a directory as a file.
  try {
    const directory = await fs.open(path.dirname(sentinel), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!['EPERM', 'EISDIR', 'EINVAL', 'EACCES'].includes(error.code)) throw error;
  }
}

function responseState(response, html, redirect, truncated) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || null;
  const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
  if (VERIFICATION.test(html + (redirect?.path || ''))) return 'verification-stop';
  if ([403, 429, 503].includes(response.status) || RATE_LIMIT.test(html)) return 'rate-limit-stop';
  if (response.status >= 300 && response.status < 400) return 'redirect-stop';
  if (response.status !== 200) return 'http-stop';
  if (!isHtml) return 'non-html-stop';
  if (truncated) return 'oversize-stop';
  return 'completed';
}

function decodeBody(bytes, contentType) {
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(contentType || '')?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

async function runProbe(accountName, { directory = PRIVATE_DIR, fetchFn = globalThis.fetch } = {}) {
  const { id, sentinel, rawPath } = pathsFor(accountName, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const started = { state: 'started', at: new Date().toISOString(), endpoint: ENDPOINT, targetHash: id };
  try {
    await syncedNewFile(sentinel, JSON.stringify(started, null, 2));
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
    const response = await fetchFn(url, {
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
    const html = decodeBody(bytes, response.headers.get('content-type'));
    const redirect = redirectShape(response.headers.get('location'), url);
    const state = responseState(response, html, redirect, truncated);
    const saveRaw = state === 'completed' && bytes.length > 0;
    if (saveRaw) await syncedNewFile(rawPath, bytes);
    result = {
      state,
      at: new Date().toISOString(),
      endpoint: ENDPOINT,
      targetHash: id,
      status: response.status,
      contentType: response.headers.get('content-type')?.split(';')[0] || null,
      redirect,
      bytesRead: bytes.length,
      bytesSaved: saveRaw ? bytes.length : 0,
      truncated,
      shape: state === 'completed' ? shapeOfHtml(html) : null,
      rawFile: saveRaw ? rawPath : null,
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
  await durableSummary(sentinel, result);
  return { result, sentinel, rawPath };
}

async function selfTest() {
  const root = path.join(os.homedir(), '.wewe-rss-private');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'mobile-search-self-test-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Self-test attempted real network access');
  };
  let fakeCalls = 0;
  const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
  const cases = [
    {
      name: '200-card',
      response: () => new Response('<ul class="news-list"><li id="sogou_vr_1"><div class="txt-box"><h3><a href="/link?url=x">Article</a></h3></div></li></ul>', { status: 200, headers: htmlHeaders }),
      state: 'completed',
      raw: true,
    },
    { name: '302', response: () => new Response(null, { status: 302, headers: { location: '/other/?x=secret' } }), state: 'redirect-stop' },
    { name: '302-captcha', response: () => new Response(null, { status: 302, headers: { location: '/antispider/?x=secret' } }), state: 'verification-stop' },
    { name: 'captcha', response: () => new Response('<html>请输入验证码</html>', { status: 200, headers: htmlHeaders }), state: 'verification-stop' },
    { name: 'rate-limit', response: () => new Response('<html>访问过于频繁</html>', { status: 200, headers: htmlHeaders }), state: 'rate-limit-stop' },
    { name: '429', response: () => new Response('<html>wait</html>', { status: 429, headers: htmlHeaders }), state: 'rate-limit-stop' },
    { name: 'json', response: () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }), state: 'non-html-stop' },
    { name: 'truncated', response: () => new Response('A'.repeat(MAX_BODY_BYTES + 1), { status: 200, headers: htmlHeaders }), state: 'oversize-stop' },
  ];
  try {
    for (const item of cases) {
      const account = `offline-${item.name}`;
      const fakeFetch = async (url, options) => {
        fakeCalls++;
        assert.equal(url.hostname, 'weixin.sogou.com');
        assert.equal(options.redirect, 'manual');
        const started = JSON.parse(await fs.readFile(pathsFor(account, directory).sentinel, 'utf8'));
        assert.equal(started.state, 'started');
        return item.response();
      };
      const { result, sentinel, rawPath } = await runProbe(account, { directory, fetchFn: fakeFetch });
      assert.equal(result.state, item.state);
      const persisted = JSON.parse(await fs.readFile(sentinel, 'utf8'));
      assert.equal(persisted.state, item.state);
      assert.equal(result.rawFile !== null, !!item.raw);
      if (item.raw) {
        const stat = await fs.stat(rawPath);
        assert.ok(stat.size > 0 && stat.size <= MAX_BODY_BYTES);
      } else {
        await assert.rejects(fs.stat(rawPath), { code: 'ENOENT' });
      }
      if (item.name === '200-card') assert.equal(result.shape.articleListItems, 1);
      const beforeRepeat = fakeCalls;
      await assert.rejects(runProbe(account, { directory, fetchFn: fakeFetch }), /sentinel already exists/i);
      assert.equal(fakeCalls, beforeRepeat);
    }
    assert.equal(fakeCalls, cases.length);
    process.stdout.write('offline self-test passed: 200 card, 302, captcha, limit, truncation, duplicate sentinel; real network calls: 0\n');
  } finally {
    globalThis.fetch = realFetch;
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') return selfTest();
  const accountName = accountNameFromArgs(process.argv.slice(2));
  const { result, sentinel } = await runProbe(accountName);
  process.stdout.write(`${result.state}; evidence: ${sentinel}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
