#!/usr/bin/env node
// One anonymous, read-only page-2 request derived from a fixed Sogou HTML/JS pair.
// Never executes Sogou's JS, follows redirects, resolves /link, or calls /approve.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const FIRST_PAGE_HTML_HASH = '169880e6c825d70cc7c0258150414426265af5d0eaab745055ceee1152dbd13b';
const PAGE_SCRIPT_HASH = 'a2c62f23a3e989914fd45795a5eab98b13a82bc365ec660c8621ebb9833935c7';
const TARGET_HASH = 'e6599d7bcd694430da5c';
const FIRST_PAGE_HTML = path.join(os.homedir(), '.wewe-rss-private', 'mobile-public-search', `${TARGET_HASH}.html`);
const PAGE_SCRIPT = path.join(os.homedir(), '.codex', 'research-sogou-next-page-20200326.js');
const PRIVATE_DIR = path.join(os.homedir(), '.wewe-rss-private', 'mobile-public-search-page2');
const ENDPOINT = 'https://weixin.sogou.com/weixinwap';
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
const VERIFICATION = /验证码|安全验证|请输入验证码|captcha|antispider|seccoderight|anti\.min\.css/i;
const RATE_LIMIT = /访问过于频繁|操作频繁|请求过于频繁|rate.limit|too many requests/i;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') return { mode: 'self-test' };
  if (args.length !== 3 || !['--preflight', '--run'].includes(args[0]) || args[1] !== '--account-name') {
    throw new Error('Usage: node probe-mobile-public-article-page2.cjs --preflight|--run --account-name "公众号名称"');
  }
  const accountName = args[2].trim().normalize('NFC');
  if (!accountName || accountName.length > 100 || /[\u0000-\u001f\u007f]/u.test(accountName)) {
    throw new Error('Account name must be 1–100 printable characters.');
  }
  return { mode: args[0], accountName };
}

function firstPageUrl(accountName) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('type', '2');
  url.searchParams.set('query', accountName);
  return url;
}

function derivePage2Url(firstUrl) {
  // Exact expression in next_page.min.js?v=20200326, with curPageNum=1:
  // append &, then replace the first ? with ?page=2&_rtype=json&.
  let href = firstUrl.href;
  href += href.includes('?') ? '&' : '?';
  href = href.replace('#?', '?').replace('?', '?page=2&_rtype=json&');
  const url = new URL(href);
  if (url.origin !== 'https://weixin.sogou.com' || url.pathname !== '/weixinwap') {
    throw new Error('Derived page-2 URL left the reviewed Tencent-owned endpoint.');
  }
  if (url.searchParams.get('page') !== '2' || url.searchParams.get('_rtype') !== 'json') {
    throw new Error('Derived page-2 URL lacks the reviewed pagination fields.');
  }
  return url;
}

async function preflight(accountName) {
  if (sha256(Buffer.from(accountName, 'utf8')).slice(0, 20) !== TARGET_HASH) {
    throw new Error('Account does not match the saved first-page evidence; no request sent.');
  }
  const [htmlBytes, jsBytes] = await Promise.all([fs.readFile(FIRST_PAGE_HTML), fs.readFile(PAGE_SCRIPT)]);
  if (sha256(htmlBytes) !== FIRST_PAGE_HTML_HASH || sha256(jsBytes) !== PAGE_SCRIPT_HASH) {
    throw new Error('Saved first-page HTML or fixed pagination JS changed; no request sent.');
  }
  const html = htmlBytes.toString('utf8');
  const js = jsBytes.toString('utf8');
  if (!/totalPages\s*=\s*4\b/.test(html) || !html.includes('/new/wap/js/next_page.min.js?v=20200326')) {
    throw new Error('Saved page does not match the reviewed pagination context.');
  }
  if (html.includes('moreResultUrl') || html.includes('curPageNum')) {
    throw new Error('Page overrides a pagination default that this probe assumes.');
  }
  if (
    !js.includes('window.moreResultUrl=window.location.href') ||
    !js.includes('window.curPageNum=1') ||
    !js.includes('"?page="+(window.curPageNum+1)+"&_rtype=json&"') ||
    !js.includes('$.ajax({url:b,dataType:"json"')
  ) {
    throw new Error('Static JS pagination expression differs from the reviewed version.');
  }
  const first = firstPageUrl(accountName);
  const next = derivePage2Url(first);
  let sentinelExists = false;
  try {
    await fs.access(path.join(PRIVATE_DIR, `${TARGET_HASH}-page2.json`));
    sentinelExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    next,
    targetHash: TARGET_HASH,
    report: {
      sourceHtmlSha256: FIRST_PAGE_HTML_HASH,
      sourceJsSha256: PAGE_SCRIPT_HASH,
      endpoint: ENDPOINT,
      page2QueryKeys: [...next.searchParams.keys()],
      hasStaticNextButton: /id=["']next_page["']/.test(html),
      cookiesCapturedFromFirstResponse: false,
      requestSession: 'anonymous-only; browser same-origin Cookie state is unavailable',
      page2SentinelExists: sentinelExists,
      readyForSingleAnonymousProbe: !sentinelExists,
    },
  };
}

async function syncedNewFile(file, data) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableSummary(sentinel, result) {
  const next = `${sentinel}.next`;
  await syncedNewFile(next, JSON.stringify(result, null, 2));
  await fs.rename(next, sentinel);
  try {
    const dir = await fs.open(path.dirname(sentinel), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    if (!['EPERM', 'EISDIR', 'EINVAL', 'EACCES'].includes(error.code)) throw error;
  }
}

async function boundedBody(response) {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_BYTES - length;
      if (value.length > remaining) {
        if (remaining) chunks.push(Buffer.from(value.subarray(0, remaining)));
        length += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, length), truncated };
}

function redirectShape(location, base) {
  if (!location) return null;
  try {
    const url = new URL(location, base);
    return { host: url.hostname, path: url.pathname.slice(0, 120) };
  } catch {
    return { malformed: true };
  }
}

function classify(response, body, truncated, redirect) {
  if (VERIFICATION.test(body + (redirect?.path || ''))) return { state: 'verification-stop' };
  if ([403, 429, 503].includes(response.status) || RATE_LIMIT.test(body)) return { state: 'rate-limit-stop' };
  if (response.status >= 300 && response.status < 400) return { state: 'redirect-stop' };
  if (response.status !== 200) return { state: 'http-stop' };
  if (truncated) return { state: 'oversize-stop' };
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { state: 'invalid-json-stop' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json) || !Array.isArray(json.items)) {
    return { state: 'schema-stop' };
  }
  if (json.anti) return { state: 'verification-stop' };
  const items = json.items.slice(0, 100);
  return {
    state: 'completed',
    shape: {
      items: json.items.length,
      totalPages: Number.isSafeInteger(Number(json.totalPages)) ? Number(json.totalPages) : null,
      xmlFieldCounts: Object.fromEntries(
        ['docid', 'lastModified', 'sourcename', 'openid', 'encArticleUrl', 'url'].map((field) => [
          field,
          items.filter((item) => typeof item === 'string' && item.includes(`<${field}>`)).length,
        ]),
      ),
      hasApproveToken: typeof json.token === 'string' && json.token.length > 0,
    },
  };
}

async function runOnce(next, targetHash, { directory = PRIVATE_DIR, fetchFn = globalThis.fetch } = {}) {
  if (next.origin !== 'https://weixin.sogou.com' || next.pathname !== '/weixinwap') {
    throw new Error('URL outside reviewed same-origin mobile search endpoint.');
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const sentinel = path.join(directory, `${targetHash}-page2.json`);
  const rawFile = path.join(directory, `${targetHash}-page2.json.raw`);
  try {
    await syncedNewFile(sentinel, JSON.stringify({ state: 'started', at: new Date().toISOString(), targetHash, page: 2 }));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Private page-2 sentinel already exists: ${sentinel}. No request was sent.`);
    throw error;
  }
  let result;
  try {
    const response = await fetchFn(next, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json, text/javascript, */*;q=0.01' },
    });
    const { bytes, truncated } = await boundedBody(response);
    const body = bytes.toString('utf8');
    const redirect = redirectShape(response.headers.get('location'), next);
    const verdict = classify(response, body, truncated, redirect);
    const saveRaw = verdict.state === 'completed';
    if (saveRaw) await syncedNewFile(rawFile, bytes);
    result = {
      state: verdict.state,
      at: new Date().toISOString(),
      endpoint: ENDPOINT,
      targetHash,
      page: 2,
      status: response.status,
      contentType: response.headers.get('content-type')?.split(';')[0] || null,
      redirect,
      bytesRead: bytes.length,
      bytesSaved: saveRaw ? bytes.length : 0,
      truncated,
      shape: verdict.shape || null,
      rawFile: saveRaw ? rawFile : null,
      note: 'Single anonymous GET; redirects, retries, /approve, /link and original articles disabled.',
    };
  } catch (error) {
    result = {
      state: 'request-error',
      at: new Date().toISOString(),
      endpoint: ENDPOINT,
      targetHash,
      page: 2,
      errorClass: error?.name || 'Error',
      note: 'No automatic retry; private sentinel remains.',
    };
  }
  await durableSummary(sentinel, result);
  return { result, sentinel, rawFile };
}

async function selfTest() {
  const root = path.join(os.homedir(), '.wewe-rss-private');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'mobile-page2-self-test-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Real network attempted in self-test'); };
  let calls = 0;
  const next = derivePage2Url(firstPageUrl('offline'));
  assert.equal(next.searchParams.get('page'), '2');
  assert.equal(next.searchParams.get('_rtype'), 'json');
  const cases = [
    { label: 'json', response: () => new Response(JSON.stringify({ items: ['<docid>x</docid><lastModified>1</lastModified>'], totalPages: 4 }), { status: 200, headers: { 'content-type': 'application/json' } }), state: 'completed', raw: true },
    { label: '302', response: () => new Response(null, { status: 302, headers: { location: '/other?opaque=sample' } }), state: 'redirect-stop' },
    { label: 'captcha', response: () => new Response('<html>请输入验证码</html>', { status: 200 }), state: 'verification-stop' },
    { label: '429', response: () => new Response('wait', { status: 429 }), state: 'rate-limit-stop' },
    { label: 'invalid', response: () => new Response('<html>not json</html>', { status: 200 }), state: 'invalid-json-stop' },
    { label: 'oversize', response: () => new Response('x'.repeat(MAX_BYTES + 1), { status: 200 }), state: 'oversize-stop' },
  ];
  try {
    for (const item of cases) {
      const id = sha256(item.label).slice(0, 20);
      const fakeFetch = async (url, options) => {
        calls++;
        assert.equal(url.hostname, 'weixin.sogou.com');
        assert.equal(options.redirect, 'manual');
        assert.equal(JSON.parse(await fs.readFile(path.join(directory, `${id}-page2.json`), 'utf8')).state, 'started');
        return item.response();
      };
      const { result, sentinel, rawFile } = await runOnce(next, id, { directory, fetchFn: fakeFetch });
      assert.equal(result.state, item.state);
      assert.equal(JSON.parse(await fs.readFile(sentinel, 'utf8')).state, item.state);
      if (item.raw) assert.ok((await fs.stat(rawFile)).size > 0);
      else await assert.rejects(fs.stat(rawFile), { code: 'ENOENT' });
      const beforeDuplicate = calls;
      await assert.rejects(runOnce(next, id, { directory, fetchFn: fakeFetch }), /sentinel already exists/i);
      assert.equal(calls, beforeDuplicate);
    }
    assert.equal(calls, cases.length);
    process.stdout.write('offline page-2 self-test passed; real network calls: 0\n');
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'self-test') return selfTest();
  const checked = await preflight(args.accountName);
  if (args.mode === '--preflight') {
    process.stdout.write(`${JSON.stringify(checked.report, null, 2)}\n`);
    return;
  }
  const { result, sentinel } = await runOnce(checked.next, checked.targetHash);
  process.stdout.write(`${result.state}; private evidence: ${sentinel}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
