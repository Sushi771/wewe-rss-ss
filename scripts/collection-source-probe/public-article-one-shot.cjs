// One bounded, anonymous public Tencent article check. Never stores the response.
// Example: node public-article-one-shot.cjs preflight <album-json> <index> <built-parser> <saved-html>...
//          node public-article-one-shot.cjs probe     <album-json> <index> <built-parser>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { createRequire } = require('node:module');

const [mode, albumPath, indexRaw, parserPath, ...savedHtmlPaths] = process.argv.slice(2);
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const TARGET_BIZ = 'Mzg5NTQzMTQxMg=='; // Public account identity, not a credential.
const KNOWN_ALBUM_IDS = new Set(['2527940920407949313', '3588220544052641807']);

function fail(reason) {
  console.log(JSON.stringify({ result: 'stopped', reason }));
  process.exitCode = 1;
}

function digestIdentity(query) {
  return crypto.createHash('sha256')
    .update(['__biz', 'mid', 'idx', 'sn'].map((key) => query.get(key) || '').join('\0'))
    .digest('hex').slice(0, 16);
}

function fieldsFromUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'mp.weixin.qq.com' ||
      url.port || url.username || url.password || url.pathname !== '/s')
    throw new Error('invalid_official_article_url');
  const q = url.searchParams;
  if (q.get('__biz') !== TARGET_BIZ || !/^\d+$/.test(q.get('mid') || '') ||
      !/^[1-9]\d*$/.test(q.get('idx') || '') || !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || ''))
    throw new Error('invalid_article_identity_seed');
  for (const key of ['__biz', 'mid', 'idx', 'sn'])
    if (q.getAll(key).length !== 1) throw new Error('ambiguous_article_identity_seed');
  url.protocol = 'https:';
  url.hash = '';
  return url;
}

function loadSeed() {
  if (!['preflight', 'probe'].includes(mode) || !albumPath || !indexRaw || !parserPath)
    throw new Error('arguments');
  const index = Number(indexRaw);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('index');
  const json = JSON.parse(fs.readFileSync(albumPath, 'utf8'));
  if (json.base_resp?.ret !== 0) throw new Error('album_business_status');
  const items = json.getalbum_resp?.article_list;
  if (!Array.isArray(items) || index >= items.length) throw new Error('album_item');
  const item = items[index];
  const url = fieldsFromUrl(item.url);
  if (String(item.msgid) !== url.searchParams.get('mid') ||
      String(item.itemidx) !== url.searchParams.get('idx'))
    throw new Error('album_item_identity_mismatch');
  if (!Number.isSafeInteger(Number(item.create_time))) throw new Error('album_time');
  return { item, url, digest: digestIdentity(url.searchParams) };
}

function historicalComparison(savedHtmlPaths, parserPath, albumPath) {
  const parser = require(path.resolve(parserPath));
  const albumFiles = fs.readdirSync(path.dirname(albumPath))
    .filter((name) => /^wewe-target-album(?:-page[12]-data|2-page[12])-20260927\.json$/.test(name));
  const entries = albumFiles.flatMap((name) => {
    const album = JSON.parse(fs.readFileSync(path.join(path.dirname(albumPath), name), 'utf8'));
    if (album.base_resp?.ret !== 0) throw new Error('historical_album_business_status');
    return album.getalbum_resp?.article_list || [];
  });
  let matchedTriples = 0;
  let matchingSn = 0;
  let mismatchingSn = 0;
  let missingSn = 0;
  for (const file of savedHtmlPaths) {
    const identity = parser.articleIdentity(fs.readFileSync(file, 'utf8'));
    const actual = new URL(identity.url).searchParams;
    const matches = entries.map((item) => fieldsFromUrl(item.url).searchParams)
      .filter((expected) => ['__biz', 'mid', 'idx']
        .every((key) => expected.get(key) === actual.get(key)));
    if (!matches.length) continue;
    matchedTriples++;
    for (const expected of matches) {
      if (!actual.get('sn')) missingSn++;
      else if (actual.get('sn') === expected.get('sn')) matchingSn++;
      else mismatchingSn++;
    }
  }
  return { historicalAlbumFiles: albumFiles.length, historicalArticleEntries: entries.length,
    matchedTriples, matchingSn, mismatchingSn, missingSn };
}

function inspect(html, seed, parserPath, requireExpectedIdentity) {
  const parser = require(path.resolve(parserPath));
  const cheerio = createRequire(path.resolve(parserPath))('cheerio');
  const $ = cheerio.load(html);
  const body = $('#js_content').first();
  if (body.length !== 1 || (!body.text().trim() && !body.find('img').length))
    throw new Error('body_node_absent_or_empty');
  const identity = parser.articleIdentity(html);
  const actual = new URL(identity.url);
  const expected = seed?.url.searchParams;
  const differingFields = requireExpectedIdentity
    ? ['__biz', 'mid', 'idx', 'sn'].filter((key) => actual.searchParams.get(key) !== expected.get(key))
    : [];
  if (differingFields.length)
    throw new Error(`article_identity_mismatch_fields_${differingFields.join('_')}`);
  if (actual.searchParams.get('__biz') !== TARGET_BIZ || identity.mpId !== 'MP_WXS_3895431412')
    throw new Error('article_account_mismatch');
  const publishTime = parser.articlePublishTime(html);
  if (!publishTime || publishTime !== identity.publishTime) throw new Error('article_publish_time_missing');
  const ct = html.match(/\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/);
  if (!ct || Number(ct[1]) !== publishTime) throw new Error('original_ct_missing_or_conflicting');
  const content = parser.articleContentHtml(html);
  if (!content) throw new Error('sanitized_body_missing');
  const images = body.find('img');
  const dataSrcCount = images.filter((_, el) => Boolean($(el).attr('data-src'))).length;
  const sanitizedImageCount = cheerio.load(content)('#js_content img[src]').length;
  const albumMatches = [...html.matchAll(/\balbum_id\s*[:=]\s*["'](\d{10,24})["']/g)]
    .map((match) => match[1]);
  const albumIds = new Set(albumMatches);
  return {
    originalCtUtcDate: new Date(publishTime * 1000).toISOString().slice(0, 10),
    originalCtEpoch: publishTime,
    bodyTextNonempty: body.text().trim().length > 0,
    bodyImageCount: images.length,
    dataSrcImageCount: dataSrcCount,
    sanitizedImageCount,
    albumMarkerPresent: /\b(?:appmsgalbuminfo|album_info_list)\b/.test(html),
    distinctAlbumIdCount: albumIds.size,
    knownAlbumIdCount: [...albumIds].filter((id) => KNOWN_ALBUM_IDS.has(id)).length,
    unknownAlbumIdCount: [...albumIds].filter((id) => !KNOWN_ALBUM_IDS.has(id)).length,
    relatedFlagPresent: /\bhas_related_article_info\b/.test(html),
  };
}

async function fetchOnce(seed) {
  const receipt = path.join(os.tmpdir(), `wewe-public-article-${seed.digest}.attempted`);
  const fd = fs.openSync(receipt, 'wx');
  fs.writeSync(fd, `${new Date().toISOString()}\n`);
  fs.closeSync(fd);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(result);
    };
    const req = https.request(seed.url, {
      method: 'GET',
      timeout: 12000,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://mp.weixin.qq.com/',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        done(new Error(`http_${res.statusCode || 'unknown'}`));
        return;
      }
      if (!/^text\/html\b/i.test(String(res.headers['content-type'] || ''))) {
        res.destroy(); done(new Error('non_html_content_type')); return;
      }
      if (Number(res.headers['content-length'] || 0) > MAX_RESPONSE_BYTES) {
        res.destroy(); done(new Error('content_length_limit')); return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy(); done(new Error('response_byte_limit')); return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => done(null, { html: Buffer.concat(chunks).toString('utf8'), bytes: total }));
      res.on('error', () => done(new Error('response_error')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => done(new Error(error.message === 'timeout' ? 'timeout' : 'network_error')));
    req.end();
  });
}

async function main() {
  let seed;
  try { seed = loadSeed(); } catch (error) { fail(`seed_${error.message}`); return; }
  if (mode === 'preflight') {
    if (!savedHtmlPaths.length) { fail('no_saved_html_for_preflight'); return; }
    try {
      const results = savedHtmlPaths.map((file) => inspect(fs.readFileSync(file, 'utf8'), null, parserPath, false));
      const historical = historicalComparison(savedHtmlPaths, parserPath, albumPath);
      console.log(JSON.stringify({ result: 'preflight_pass', savedHtmlCount: results.length,
        parsedIdentityAndCtCount: results.length, candidateDigest: seed.digest,
        candidateAlbumCreateUtcDate: new Date(Number(seed.item.create_time) * 1000).toISOString().slice(0, 10),
        ...historical, requests: 0 }));
    } catch (error) { fail(`preflight_${error.message}`); }
    return;
  }
  try {
    const response = await fetchOnce(seed);
    const html = response.html;
    if (/wappoc_appmsgcaptcha|请输入验证码|为了你的帐号安全|访问过于频繁|环境异常/.test(html))
      throw new Error('verification_or_limit_page');
    const result = inspect(html, seed, parserPath, true);
    console.log(JSON.stringify({ result: 'identity_and_body_pass', candidateDigest: seed.digest,
      requests: 1, httpStatus: 200, bytes: response.bytes,
      albumCreateUtcDate: new Date(Number(seed.item.create_time) * 1000).toISOString().slice(0, 10),
      ctMinusAlbumCreateSeconds: result.originalCtEpoch - Number(seed.item.create_time),
      ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'originalCtEpoch')) }));
  } catch (error) { fail(error.message.startsWith('EEXIST') ? 'already_attempted' : error.message); }
}

main();
