// One reviewed, anonymous article check seeded by five saved target article bodies.
// Preflight never makes a request. Probe needs an explicit review flag and writes only
// a private attempt marker before the single request. No URL or response is persisted.
// node public-interlink-one-shot.cjs preflight <saved-temp-dir> <built-parser>
// node public-interlink-one-shot.cjs probe <saved-temp-dir> <built-parser> --execute-reviewed-1c9ac9e993100643
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const [mode, savedDir, parserPath, reviewFlag] = process.argv.slice(2);
const TARGET_BIZ = 'Mzg5NTQzMTQxMg=='; // Public account identity.
const TARGET_MP_ID = 'MP_WXS_3895431412';
const CHOSEN_DIGEST = '1c9ac9e993100643';
const REVIEW_FLAG = `--execute-reviewed-${CHOSEN_DIGEST}`;
const FIELDS = ['__biz', 'mid', 'idx', 'sn'];
const MAX_BYTES = 6 * 1024 * 1024;
const SOURCE_EXTRA_FILES = [
  'wewe-target-second-article-20260927.html',
  'wewe-target-proxy-article-20260927.html',
];
const ALBUM_FILES = [
  'wewe-target-album-page1-data-20260927.json',
  'wewe-target-album-page2-data-20260927.json',
  'wewe-target-album2-page1-20260927.json',
  'wewe-target-album2-page2-20260927.json',
];
const KNOWN_ALBUM_IDS = new Set(['2527940920407949313', '3588220544052641807']);

function emit(result, extra = {}, failure = false) {
  console.log(JSON.stringify({ result, requests: 0, ...extra }));
  if (failure) process.exitCode = 1;
}

function unsafeEnvironment(env) {
  return [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NODE_OPTIONS',
    'NODE_DEBUG',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'SSLKEYLOGFILE',
  ].some((key) => typeof env[key] === 'string' && env[key].trim());
}

function identityDigest(q) {
  return crypto
    .createHash('sha256')
    .update(FIELDS.map((field) => q.get(field) || '').join('\0'))
    .digest('hex')
    .slice(0, 16);
}

function articleUrl(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.pathname !== '/s' ||
    url.port ||
    url.username ||
    url.password ||
    !['', '#wechat_redirect'].includes(url.hash)
  )
    throw new Error('article_url_shape');
  const q = url.searchParams;
  if (
    [...q.keys()].some((key) => ![...FIELDS, 'scene'].includes(key)) ||
    [...FIELDS, 'scene'].some((key) => q.getAll(key).length !== 1) ||
    q.get('__biz') !== TARGET_BIZ ||
    !/^\d{8,15}$/.test(q.get('mid') || '') ||
    !/^[1-9]\d*$/.test(q.get('idx') || '') ||
    !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || '')
  )
    throw new Error('article_identity_seed');
  url.hash = '';
  return url;
}

function oldPageCheck(html, name, records, albumKeys, parser, cheerio) {
  const source = records.find((item) => path.basename(item.htmlFile) === name);
  if (!source || !source.hasContent || !source.matchesCurrentRow)
    throw new Error('old_source_record');
  const parsed = parser.articleIdentity(html);
  const url = new URL(parsed.url);
  const q = url.searchParams;
  if (
    parsed.mpId !== TARGET_MP_ID ||
    q.get('__biz') !== TARGET_BIZ ||
    FIELDS.some(
      (field) =>
        String(source[field === '__biz' ? 'biz' : field]) !== q.get(field),
    ) ||
    !albumKeys.has(`${q.get('mid')}|${q.get('idx')}`)
  )
    throw new Error('old_source_identity');
  const ct = parser.articlePublishTime(html);
  const literalCt = html.match(/\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/);
  if (!ct || ct !== Number(source.ct) || ct !== Number(literalCt?.[1]))
    throw new Error('old_source_ct');
  const $ = cheerio.load(html);
  if ($('#js_content').length !== 1 || !parser.articleContentHtml(html))
    throw new Error('old_source_body');
  return { body: $('#js_content'), ct };
}

function loadSeed() {
  if (!['preflight', 'probe'].includes(mode) || !savedDir || !parserPath)
    throw new Error('arguments');
  const parser = require(path.resolve(parserPath));
  const cheerio = createRequire(path.resolve(parserPath))('cheerio');
  const records = JSON.parse(
    fs.readFileSync(
      path.join(savedDir, 'wewe-short-long-identities-20260927.json'),
      'utf8',
    ),
  ).articles;
  if (!Array.isArray(records)) throw new Error('old_source_records');
  const oldNames = fs
    .readdirSync(savedDir)
    .filter((name) =>
      /^wewe-identity-[A-Za-z0-9_-]+-20260927\.html$/.test(name),
    )
    .sort()
    .concat(SOURCE_EXTRA_FILES);
  if (oldNames.length !== 8 || new Set(oldNames).size !== 8)
    throw new Error('old_source_count');
  const albumKeys = new Set();
  for (const name of ALBUM_FILES) {
    const data = JSON.parse(fs.readFileSync(path.join(savedDir, name), 'utf8'));
    if (
      data.base_resp?.ret !== 0 ||
      !Array.isArray(data.getalbum_resp?.article_list)
    )
      throw new Error('album_data');
    for (const item of data.getalbum_resp.article_list)
      albumKeys.add(`${item.msgid}|${item.itemidx}`);
  }
  if (albumKeys.size !== 32) throw new Error('album_key_count');
  const hits = [];
  const sourceDates = new Set();
  for (const name of oldNames) {
    const html = fs.readFileSync(path.join(savedDir, name), 'utf8');
    const old = oldPageCheck(html, name, records, albumKeys, parser, cheerio);
    const staged = analyze(html, {
      parser,
      cheerio,
      url: new URL(parser.articleIdentity(html).url),
    });
    if (staged.result !== 'identity_ct_body_pass')
      throw new Error('old_source_stage');
    if (
      staged.explicitKnownAlbumCount !== 1 ||
      staged.explicitNewAlbumCount !== 0
    )
      throw new Error('old_source_album');
    const $ = cheerio.load(html);
    old.body.find('a[href]').each((_, el) => {
      const raw = $(el).attr('href');
      let url;
      try {
        url = articleUrl(raw);
      } catch {
        return;
      }
      if (identityDigest(url.searchParams) !== CHOSEN_DIGEST) return;
      hits.push({ name, raw: url.toString() });
      sourceDates.add(new Date(old.ct * 1000).toISOString().slice(0, 10));
    });
  }
  if (
    hits.length !== 5 ||
    new Set(hits.map((hit) => hit.name)).size !== 5 ||
    new Set(hits.map((hit) => hit.raw)).size !== 1
  )
    throw new Error(
      `candidate_provenance_${hits.length}_${new Set(hits.map((hit) => hit.name)).size}_${new Set(hits.map((hit) => hit.raw)).size}`,
    );
  const url = articleUrl(hits[0].raw);
  if (
    albumKeys.has(
      `${url.searchParams.get('mid')}|${url.searchParams.get('idx')}`,
    )
  )
    throw new Error('candidate_already_in_album');
  const marker = path.join(
    os.tmpdir(),
    `wewe-public-interlink-${CHOSEN_DIGEST}.attempted`,
  );
  return { url, parser, cheerio, marker, sourceDates: [...sourceDates].sort() };
}

function explicitAlbumCounts(html) {
  const ids = new Set();
  for (const match of html.matchAll(
    /(?:https?:\/\/mp\.weixin\.qq\.com)?\/mp\/appmsgalbum[^\s"'<>]*/g,
  )) {
    const raw = match[0].replace(/\\x26/gi, '&').replace(/&amp;/g, '&');
    let url;
    try {
      url = new URL(raw, 'https://mp.weixin.qq.com');
    } catch {
      continue;
    }
    if (
      url.hostname !== 'mp.weixin.qq.com' ||
      url.pathname !== '/mp/appmsgalbum' ||
      url.searchParams.get('__biz') !== TARGET_BIZ
    )
      continue;
    const id = url.searchParams.get('album_id');
    if (/^\d{10,24}$/.test(id || '')) ids.add(id);
  }
  return {
    albumMarkerPresent: /\b(?:appmsgalbuminfo|album_info_list)\b/.test(html),
    explicitKnownAlbumCount: [...ids].filter((id) => KNOWN_ALBUM_IDS.has(id))
      .length,
    explicitNewAlbumCount: [...ids].filter((id) => !KNOWN_ALBUM_IDS.has(id))
      .length,
  };
}

function analyze(html, seed) {
  const { parser, cheerio, url } = seed;
  const stage = { hasJsContent: false };
  const $ = cheerio.load(html);
  const body = $('#js_content');
  stage.hasJsContent = body.length === 1;
  if (!stage.hasJsContent) return { result: 'body_node_stop', ...stage };
  let identity;
  try {
    identity = parser.articleIdentity(html);
  } catch {
    return { result: 'identity_parser_stop', ...stage };
  }
  let actual;
  try {
    actual = new URL(identity.url);
  } catch {
    return { result: 'identity_url_stop', ...stage };
  }
  stage.identityFieldsPresent = Object.fromEntries(
    FIELDS.map((field) => [field, Boolean(actual.searchParams.get(field))]),
  );
  stage.identityFieldsMatch = Object.fromEntries(
    FIELDS.map((field) => [
      field,
      actual.searchParams.get(field) === url.searchParams.get(field),
    ]),
  );
  stage.accountMatch = identity.mpId === TARGET_MP_ID;
  if (
    actual.hostname !== 'mp.weixin.qq.com' ||
    actual.pathname !== '/s' ||
    !stage.accountMatch ||
    Object.values(stage.identityFieldsMatch).some((matched) => !matched)
  )
    return { result: 'identity_mismatch_stop', ...stage };
  let ct;
  try {
    ct = parser.articlePublishTime(html);
  } catch {
    return { result: 'publish_parser_stop', ...stage };
  }
  const literal = html.match(/\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/);
  stage.originalCtPresent = Boolean(literal);
  stage.originalCtMatch = Boolean(
    ct && ct === Number(literal?.[1]) && ct === identity.publishTime,
  );
  if (!stage.originalCtMatch) return { result: 'original_ct_stop', ...stage };
  const images = body.find('img');
  stage.bodyTextPresent = Boolean(body.text().trim());
  stage.imageCount = images.length;
  stage.imageDataSrcCount = images.filter((_, el) =>
    Boolean($(el).attr('data-src')),
  ).length;
  let content;
  try {
    content = parser.articleContentHtml(html);
  } catch {
    return { result: 'body_parser_stop', ...stage };
  }
  stage.sanitizedBodyPresent = Boolean(content);
  if (!stage.sanitizedBodyPresent)
    return { result: 'body_content_stop', ...stage };
  return {
    result: 'identity_ct_body_pass',
    ...stage,
    originalCtUtcDate: new Date(ct * 1000).toISOString().slice(0, 10),
    ...explicitAlbumCounts(html),
  };
}

async function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const req = https.request(
      url,
      {
        method: 'GET',
        timeout: 12000,
        agent: false,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://mp.weixin.qq.com/',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          res.destroy();
          done(null, { status });
          return;
        }
        if (!/^text\/html\b/i.test(String(res.headers['content-type'] || ''))) {
          res.destroy();
          done(null, { status, nonHtml: true });
          return;
        }
        if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
          res.destroy();
          done(null, { status, tooLarge: true });
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            res.destroy();
            done(null, { status, tooLarge: true });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          done(null, { status, html: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', () => done(new Error('response_error')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) =>
      done(new Error(err.message === 'timeout' ? 'timeout' : 'network_error')),
    );
    req.end();
  });
}

async function main() {
  let seed;
  try {
    seed = loadSeed();
  } catch (error) {
    const allowed = new Set([
      'arguments',
      'old_source_records',
      'old_source_count',
      'album_data',
      'album_key_count',
      'old_source_record',
      'old_source_identity',
      'old_source_ct',
      'old_source_body',
      'old_source_stage',
      'old_source_album',
      'candidate_already_in_album',
    ]);
    emit(
      'preflight_stop',
      {
        reason:
          allowed.has(error.message) ||
          /^candidate_provenance_\d+_\d+_\d+$/.test(error.message)
            ? error.message
            : 'local_provenance_or_parser_check',
      },
      true,
    );
    return;
  }
  if (mode === 'preflight') {
    const historical = SOURCE_EXTRA_FILES.length + 6;
    emit('preflight_pass', {
      digest: CHOSEN_DIGEST,
      savedArticleCount: historical,
      independentLinkSources: seed.sourceDates.length,
      sourceUtcDates: seed.sourceDates,
      attemptedMarkerExists: fs.existsSync(seed.marker),
    });
    return;
  }
  if (unsafeEnvironment(process.env)) {
    emit('environment_gate_stop', {}, true);
    return;
  }
  if (reviewFlag !== REVIEW_FLAG || fs.existsSync(seed.marker)) {
    emit('review_or_attempt_gate_stop', {}, true);
    return;
  }
  try {
    const fd = fs.openSync(seed.marker, 'wx', 0o600);
    try {
      fs.writeSync(fd, `${new Date().toISOString()}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    emit('attempt_marker_stop', {}, true);
    return;
  }
  let response;
  try {
    response = await fetchOnce(seed.url);
  } catch (err) {
    emit(
      err.message === 'timeout' ? 'timeout_stop' : 'network_stop',
      { requests: 1 },
      true,
    );
    return;
  }
  const base = {
    requests: 1,
    digest: CHOSEN_DIGEST,
    httpStatus: response.status,
  };
  if (response.status !== 200 || response.nonHtml || response.tooLarge) {
    emit(
      response.status >= 300 && response.status < 400
        ? 'redirect_stop'
        : response.nonHtml
          ? 'non_html_stop'
          : response.tooLarge
            ? 'response_limit_stop'
            : 'http_stop',
      base,
    );
    return;
  }
  if (
    /wappoc_appmsgcaptcha|appmsgcaptcha|请输入验证码|为了你的帐号安全|访问过于频繁|环境异常/.test(
      response.html,
    )
  ) {
    emit('verification_or_limit_stop', base);
    return;
  }
  const finding = analyze(response.html, seed);
  const { result, ...details } = finding;
  emit(result, { ...base, ...details });
}

main();
