// One reviewed anonymous Tencent publictag page classification. No page JS runs.
// node publictag-page-one-shot.cjs preflight <saved-temp-dir>
// node publictag-page-one-shot.cjs probe <saved-temp-dir> --execute-reviewed-publictag-c3ae9cc7
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const [mode, savedDir, reviewFlag] = process.argv.slice(2);
const BIZ = 'Mzg5NTQzMTQxMg==';
const SOURCE_NAME = 'wewe-target-album2-page1-20260927.json';
const SOURCE_SHA256 =
  'c3ae9cc7f53948632bac3d09c78e6cfae26fe03ce5c93d837aa77d55249a231b';
const REVIEW_FLAG = '--execute-reviewed-publictag-c3ae9cc7';
const THIRD_SOURCE = path.join(
  os.tmpdir(),
  'wewe-public-album-source-9beb4db841a9c11c.json',
);
const OLD_ALBUM_IDS = new Set(['2527940920407949313', '3588220544052641807']);
const MAX_BYTES = 2 * 1024 * 1024;

function emit(result, fields = {}, failure = false) {
  console.log(JSON.stringify({ result, requests: 0, ...fields }));
  if (failure) process.exitCode = 1;
}
function sameKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}
function stableRead(file, max = MAX_BYTES) {
  const before = fs.lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 10 ||
    before.size > max
  )
    throw new Error('source_file_shape');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd),
      bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd);
    if (
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      throw new Error('source_file_changed');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function sourceLink(directory) {
  const bytes = stableRead(path.join(directory, SOURCE_NAME));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== SOURCE_SHA256)
    throw new Error('source_sha_mismatch');
  const data = JSON.parse(bytes.toString('utf8'));
  const response = data?.getalbum_resp;
  if (
    data?.base_resp?.ret !== 0 ||
    !Array.isArray(response?.article_list) ||
    response.article_list.length !== 10 ||
    String(response.base_info?.article_count) !== '19' ||
    String(response.base_info?.public_tag_content_num) !== '13'
  )
    throw new Error('source_response_shape');
  const raw = response.base_info.public_tag_link;
  if (typeof raw !== 'string' || raw.length > 512)
    throw new Error('tag_link_shape');
  const url = new URL(raw);
  const q = url.searchParams;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.pathname !== '/mp/publictag' ||
    url.port ||
    url.username ||
    url.password ||
    !['', '#wechat_redirect'].includes(url.hash) ||
    [...q.keys()].sort().join(',') !== 'action,tag_id' ||
    q.getAll('action').length !== 1 ||
    q.get('action') !== 'get' ||
    q.getAll('tag_id').length !== 1 ||
    !/^\d{8,24}$/.test(q.get('tag_id') || '')
  )
    throw new Error('tag_link_identity');
  url.hash = ''; // A fragment is never sent in HTTP; marker keys the actual request.
  return url;
}
function knownAlbumIds() {
  const value = JSON.parse(stableRead(THIRD_SOURCE, 2048).toString('utf8'));
  if (
    !sameKeys(value, [
      'albumIds',
      'articleDigest',
      'biz',
      'observedUtc',
      'sourceField',
    ]) ||
    value.articleDigest !== '9beb4db841a9c11c' ||
    value.biz !== BIZ ||
    value.sourceField !== 'inline_var_album_info_list' ||
    typeof value.observedUtc !== 'string' ||
    !Number.isFinite(Date.parse(value.observedUtc)) ||
    new Date(value.observedUtc).toISOString() !== value.observedUtc ||
    !Array.isArray(value.albumIds) ||
    value.albumIds.length !== 1 ||
    typeof value.albumIds[0] !== 'string' ||
    !/^\d{10,24}$/.test(value.albumIds[0]) ||
    OLD_ALBUM_IDS.has(value.albumIds[0])
  )
    throw new Error('known_album_source');
  return new Set([...OLD_ALBUM_IDS, value.albumIds[0]]);
}
function markerFor(url) {
  const digest = crypto
    .createHash('sha256')
    .update(url.href)
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), `wewe-publictag-page-${digest}.attempted`);
}
function decodeAttribute(value) {
  return value.replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
}
function staticLinks(html) {
  const withoutScripts = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const urls = [];
  for (const tag of withoutScripts.matchAll(
    /<(?:a|div|section|li)\b[^>]*>/gi,
  )) {
    for (const attr of tag[0].matchAll(
      /(?:^|\s)(?:href|data-url)\s*=\s*(["'])(.*?)\1/gi,
    )) {
      const raw = decodeAttribute(attr[2]);
      if (raw.length > 2048) continue;
      try {
        const url = new URL(raw, 'https://mp.weixin.qq.com');
        if (
          url.protocol === 'https:' &&
          url.hostname === 'mp.weixin.qq.com' &&
          !url.username &&
          !url.password &&
          !url.port
        )
          urls.push(url);
      } catch {
        /* malformed static link is not evidence */
      }
    }
  }
  return { withoutScripts, urls };
}
function analyzeHtml(html, sourceUrl, knownIds) {
  const { withoutScripts, urls } = staticLinks(html);
  const articleLinks = new Set(),
    targetArticles = new Set(),
    otherArticles = new Set();
  const unknownArticles = new Set(),
    targetAlbums = new Set();
  let tagPageLinks = 0,
    paginationLinks = 0,
    tagLinksWithAccountFilter = 0;
  const requestedTagId = sourceUrl.searchParams.get('tag_id');
  for (const url of urls) {
    const q = url.searchParams;
    if (url.pathname === '/s') {
      const biz = q.get('__biz'),
        mid = q.get('mid'),
        idx = q.get('idx');
      if (biz && /^\d{8,15}$/.test(mid || '') && /^[1-9]\d*$/.test(idx || '')) {
        const key = `${biz}|${mid}|${idx}`;
        articleLinks.add(key);
        if (biz === BIZ) targetArticles.add(key);
        else otherArticles.add(key);
      }
    } else if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname)) {
      unknownArticles.add(url.pathname);
    } else if (
      url.pathname === '/mp/appmsgalbum' &&
      q.get('action') === 'getalbum' &&
      q.get('__biz') === BIZ &&
      /^\d{10,24}$/.test(q.get('album_id') || '')
    ) {
      targetAlbums.add(q.get('album_id'));
    } else if (
      url.pathname === '/mp/publictag' &&
      q.get('action') === 'get' &&
      q.get('tag_id') === requestedTagId
    ) {
      tagPageLinks++;
      const start = q.get('start') || q.get('offset') || q.get('begin');
      if (start !== null && /^\d+$/.test(start) && Number(start) > 0)
        paginationLinks++;
      if (q.get('__biz') === BIZ || q.get('biz') === BIZ)
        tagLinksWithAccountFilter++;
    }
  }
  const bodyTag = /<body\b[^>]*>/i.exec(withoutScripts)?.[0] || '';
  let pageType = 'unclassified_html';
  if (/\bid\s*=\s*["']js_content["']/i.test(withoutScripts))
    pageType = 'article_markup';
  else if (
    /\b(?:class|id)\s*=\s*["'][^"']*(?:js_album_container|js_album_list)[^"']*["']/i.test(
      withoutScripts,
    )
  )
    pageType = 'album_markup';
  else if (
    /publictag|public_tag|tag_page/i.test(bodyTag) ||
    /\b(?:class|id)\s*=\s*["'][^"']*(?:js_publictag|public_tag_list)[^"']*["']/i.test(
      withoutScripts,
    )
  )
    pageType = 'publictag_markup';
  const otherAlbums = [...targetAlbums].filter(
    (id) => !knownIds.has(id),
  ).length;
  return {
    pageType,
    staticArticleLinkCount: articleLinks.size + unknownArticles.size,
    explicitTargetArticleLinkCount: targetArticles.size,
    explicitOtherAccountArticleLinkCount: otherArticles.size,
    shortArticleLinkWithUnknownAccountCount: unknownArticles.size,
    staticListEvidence:
      articleLinks.size + unknownArticles.size >= 2 ||
      /\b(?:class|id)\s*=\s*["'][^"']*(?:js_article_list|js_tag_list)[^"']*["']/i.test(
        withoutScripts,
      ),
    sameTagPageLinkCount: tagPageLinks,
    staticPaginationLinkCount: paginationLinks,
    staticPaginationEvidence: paginationLinks > 0,
    explicitAccountFilterLinkCount: tagLinksWithAccountFilter,
    explicitAccountFilterEvidence: tagLinksWithAccountFilter > 0,
    targetOfficialAlbumLinkCount: targetAlbums.size,
    otherTargetAlbumLinkCount: otherAlbums,
    otherTargetAlbumEvidence: otherAlbums > 0,
  };
}
function classifyResponse(response, sourceUrl, knownIds) {
  if (response.status !== 200 || response.tooLarge)
    return {
      stop:
        response.status >= 300 && response.status < 400
          ? 'redirect_stop'
          : response.tooLarge
            ? 'response_limit_stop'
            : 'http_stop',
      httpStatus: response.status,
    };
  const body = response.body || '';
  if (
    /wappoc_appmsgcaptcha|appmsgcaptcha|请输入验证码|访问过于频繁|环境异常|频繁|verifycode|captcha/i.test(
      body,
    )
  )
    return { stop: 'verification_or_limit_stop', httpStatus: 200 };
  const mime = String(response.contentType || '').toLowerCase();
  if (
    !mime.includes('text/html') ||
    !/<html\b/i.test(body) ||
    !/<body\b/i.test(body)
  )
    return { stop: 'non_html_stop', httpStatus: 200 };
  return { httpStatus: 200, ...analyzeHtml(body, sourceUrl, knownIds) };
}
function fakeNetworkSelftest(sourceUrl, knownIds, directory) {
  const existing = stableRead(
    path.join(directory, 'wewe-target-proxy-album-20260927.html'),
    2 * 1024 * 1024,
  ).toString('utf8');
  if (
    analyzeHtml(existing, sourceUrl, knownIds).pageType === 'publictag_markup'
  )
    throw new Error('saved_html_selftest');
  const synthetic =
    '<!doctype html><html><body class="publictag">' +
    '<a href="https://mp.weixin.qq.com/s?__biz=' +
    encodeURIComponent(BIZ) +
    '&amp;mid=12345678&amp;idx=1">a</a>' +
    '<a href="https://mp.weixin.qq.com/s?__biz=OTHER&amp;mid=12345679&amp;idx=1">b</a>' +
    '<a href="/mp/publictag?action=get&amp;tag_id=' +
    sourceUrl.searchParams.get('tag_id') +
    '&amp;start=10&amp;__biz=' +
    encodeURIComponent(BIZ) +
    '">next</a>' +
    '<a href="/mp/appmsgalbum?action=getalbum&amp;__biz=' +
    encodeURIComponent(BIZ) +
    '&amp;album_id=9999999999999999999">album</a>' +
    '<script>"<a href=\'https://mp.weixin.qq.com/s?__biz=OTHER2&mid=11111111&idx=1\'>"</script>' +
    '</body></html>';
  const fakeRequester = async () => ({
    status: 200,
    contentType: 'text/html',
    body: synthetic,
  });
  return fakeRequester().then((response) => {
    const result = classifyResponse(response, sourceUrl, knownIds);
    if (
      result.stop ||
      result.pageType !== 'publictag_markup' ||
      result.staticArticleLinkCount !== 2 ||
      result.explicitTargetArticleLinkCount !== 1 ||
      result.explicitOtherAccountArticleLinkCount !== 1 ||
      result.staticPaginationLinkCount !== 1 ||
      !result.explicitAccountFilterEvidence ||
      result.otherTargetAlbumLinkCount !== 1
    )
      throw new Error('fake_network_selftest');
    const stopped = classifyResponse({ status: 302 }, sourceUrl, knownIds);
    if (stopped.stop !== 'redirect_stop')
      throw new Error('fake_network_selftest');
    return true;
  });
}
function requestOnce(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const req = https.request(
      url,
      {
        method: 'GET',
        timeout: 12000,
        agent: false,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          res.destroy();
          done(null, { status });
          return;
        }
        if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
          res.destroy();
          done(null, { status, tooLarge: true });
          return;
        }
        let length = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          length += chunk.length;
          if (length > MAX_BYTES) {
            res.destroy();
            done(null, { status, tooLarge: true });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          done(null, {
            status,
            contentType: res.headers['content-type'] || '',
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () => done(new Error('response_error')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) =>
      done(
        new Error(error.message === 'timeout' ? 'timeout' : 'network_error'),
      ),
    );
    req.end();
  });
}
async function main() {
  let url, knownIds, marker;
  try {
    if (!['preflight', 'probe'].includes(mode) || !savedDir)
      throw new Error('arguments');
    url = sourceLink(savedDir);
    knownIds = knownAlbumIds();
    marker = markerFor(url);
    await fakeNetworkSelftest(url, knownIds, savedDir);
  } catch (error) {
    const safe = new Set([
      'arguments',
      'source_file_shape',
      'source_file_changed',
      'source_sha_mismatch',
      'source_response_shape',
      'tag_link_shape',
      'tag_link_identity',
      'known_album_source',
      'saved_html_selftest',
      'fake_network_selftest',
    ]);
    emit(
      'preflight_stop',
      { reason: safe.has(error.message) ? error.message : 'local_read_error' },
      true,
    );
    return;
  }
  if (mode === 'preflight') {
    emit('preflight_pass', {
      sourceShaVerified: true,
      requestShapeValidated: true,
      savedHtmlAndFakeNetworkTests: true,
      markerExists: fs.existsSync(marker),
      noPageJsExecution: true,
    });
    return;
  }
  if (reviewFlag !== REVIEW_FLAG || fs.existsSync(marker)) {
    emit('review_or_attempt_gate_stop', {}, true);
    return;
  }
  try {
    const fd = fs.openSync(marker, 'wx', 0o600);
    fs.writeSync(fd, `${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  } catch {
    emit('attempt_marker_stop', {}, true);
    return;
  }
  let response;
  try {
    response = await requestOnce(url);
  } catch (error) {
    emit(
      error.message === 'timeout' ? 'timeout_stop' : 'network_stop',
      { requests: 1 },
      true,
    );
    return;
  }
  const result = classifyResponse(response, url, knownIds);
  if (result.stop) {
    emit(result.stop, { requests: 1, httpStatus: result.httpStatus }, true);
    return;
  }
  emit('publictag_page_classified', { requests: 1, ...result });
}
main();
