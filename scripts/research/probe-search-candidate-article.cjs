#!/usr/bin/env node
'use strict';

// One reviewed, anonymous HTTPS GET of a private search candidate. No loop.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { sqliteApi, within } = require('./probe-mobile-refresh-preflight.cjs');
const { recoveryGate, environmentGate } =
  require('./probe-refreshed-mobile-web-health.cjs');
const { readPrivateRecord } = require('./probe-search-url-identity.cjs');

const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const TARGET_MP_ID = 'MP_WXS_3895431412';
// These four fixed files were previously verified as the two known albums.
// Their response bodies identify the target account but do not repeat album_id.
const ALBUM_FILES = [
  'wewe-target-album-page1-data-20260927.json',
  'wewe-target-album-page2-data-20260927.json',
  'wewe-target-album2-page1-20260927.json',
  'wewe-target-album2-page2-20260927.json',
];
const ALBUM_SHA256 = [
  '87e26fbd97bc66255168bcb3a5a4c715ed13f67bce17250652933cbd3117c12a',
  '76bc61cbf5a0f4f7647c08f94ec412cd513d6bd7867780d08634cb4a69e47b12',
  'c3ae9cc7f53948632bac3d09c78e6cfae26fe03ce5c93d837aa77d55249a231b',
  '49d5e32480a00c9941e27cc69c4c1dd5905042ac8e2094da2fdd5856d54eabad',
];
const OLD_REQUEST_DIGESTS = new Set([
  'e28e53cb45b7c1eb', '792e0623ba3ee739',
  '8c460d508c0aae1b', '5e44e0d46c308fe2',
  '1c9ac9e993100643', '175910fb92f9e063',
]);
const MAX_BODY = 6 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function digest(value, length = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function options(argv) {
  if (argv.length === 1 && argv[0] === '--plan') return { mode: '--plan' };
  if (argv.length === 3 && argv[0] === '--self-test' &&
      argv[1] === '--parser' && path.isAbsolute(argv[2]))
    return { mode: '--self-test', parserPath: argv[2] };
  if (!['--preflight', '--execute'].includes(argv[0]))
    throw Error('usage_gate');
  const mode = argv[0];
  const flags = new Map();
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || i + 1 >= argv.length ||
        flags.has(argv[i])) throw Error('usage_gate');
    flags.set(argv[i], argv[i + 1]);
  }
  const required = ['--db', '--run-dir', '--album-dir', '--parser'];
  if (required.some((key) => !path.isAbsolute(flags.get(key) ?? '')))
    throw Error('usage_gate');
  const allowed = mode === '--execute' ?
    [...required, '--index', '--digest', '--reviewed'] :
    [...required, '--index'];
  if ([...flags.keys()].some((key) => !allowed.includes(key)))
    throw Error('usage_gate');
  let index = null;
  if (flags.has('--index')) {
    if (!/^(0|[1-9]\d*)$/.test(flags.get('--index')))
      throw Error('usage_gate');
    index = Number(flags.get('--index'));
    if (!Number.isSafeInteger(index)) throw Error('usage_gate');
  }
  if (mode === '--execute' && (index === null ||
      !/^[a-f0-9]{16}$/.test(flags.get('--digest') ?? '') ||
      flags.get('--reviewed') !== 'yes')) throw Error('usage_gate');
  return { mode, dbPath: flags.get('--db'), runDir: flags.get('--run-dir'),
    albumDir: flags.get('--album-dir'), parserPath: flags.get('--parser'),
    index, reviewedDigest: flags.get('--digest') };
}

function articleKey(query) {
  const mid = query.get('mid'), idx = query.get('idx');
  if (query.getAll('__biz').length !== 1 ||
      query.get('__biz') !== TARGET_BIZ ||
      query.getAll('mid').length !== 1 || !/^\d+$/.test(mid ?? '') ||
      query.getAll('idx').length !== 1 || !/^[1-9]\d*$/.test(idx ?? ''))
    throw Error('article_key_gate');
  return `${mid}\0${idx}`;
}

function candidateSeed(candidate, index) {
  const raw = candidate.originalDocUrl;
  if (typeof raw !== 'string' ||
      !/^https?:\/\/mp\.weixin\.qq\.com\/s\?/i.test(raw) ||
      /[\s\\\x00-\x1f\x7f]/.test(raw)) throw Error('candidate_url_gate');
  const httpsRaw = raw.replace(/^http:\/\//i, 'https://');
  const url = new URL(httpsRaw);
  if (url.href !== httpsRaw || url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' || url.pathname !== '/s' ||
      url.username || url.password || url.port ||
      (url.hash && !/^#[A-Za-z0-9_-]{1,64}$/.test(url.hash)))
    throw Error('candidate_url_gate');
  const query = url.searchParams;
  const allowed = new Set(['__biz', 'mid', 'idx', 'sn', 'chksm']);
  if ([...query.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => query.getAll(key).length > 1))
    throw Error('candidate_url_gate');
  const key = articleKey(query);
  const sn = query.get('sn');
  const chksm = query.get('chksm');
  if ((sn !== null && !/^[a-fA-F0-9]{16,64}$/.test(sn)) ||
      (chksm !== null && !/^[a-fA-F0-9]{16,128}$/.test(chksm)) ||
      candidate.urlBizMatchesTarget !== true ||
      candidate.sourceNameMatched !== true ||
      candidate.originalBizAndCtVerified !== false)
    throw Error('candidate_identity_gate');
  const identityDigest = digest([TARGET_BIZ, query.get('mid'),
    query.get('idx'), sn ?? ''].join('\0'));
  return { index, url, key, identityDigest, urlDigest: digest(raw, 24),
    displayDigest: digest(raw), hasSn: sn !== null,
    indexTimestamp: candidate.indexTimestamp };
}

function loadAlbumKeys(albumDir) {
  const resolved = fs.realpathSync(albumDir);
  if (!fs.statSync(resolved).isDirectory()) throw Error('album_dir_gate');
  const keys = new Set();
  for (let i = 0; i < ALBUM_FILES.length; i++) {
    const file = path.join(resolved, ALBUM_FILES[i]);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw Error('album_file_gate');
    const bytes = fs.readFileSync(file);
    if (digest(bytes, 64) !== ALBUM_SHA256[i])
      throw Error('album_source_hash_gate');
    const data = JSON.parse(bytes.toString('utf8'));
    if (data.base_resp?.ret !== 0 ||
        !Array.isArray(data.getalbum_resp?.article_list))
      throw Error('album_response_gate');
    if (i % 2 === 0) {
      const link = new URL(data.getalbum_resp.base_info?.public_tag_link);
      if (link.hostname !== 'mp.weixin.qq.com' ||
          link.pathname !== '/mp/publictag' || link.username ||
          link.password || link.port ||
          data.getalbum_resp.base_info?.nickname !== '妈妈部落畅聊阁' ||
          Number(data.getalbum_resp.base_info?.article_count) !==
            [13, 19][i / 2])
        throw Error('album_identity_gate');
    }
    for (const item of data.getalbum_resp.article_list) {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) ||
          url.hostname !== 'mp.weixin.qq.com' || url.pathname !== '/s' ||
          url.username || url.password || url.port)
        throw Error('album_item_gate');
      const key = articleKey(url.searchParams);
      if (String(item.msgid) !== url.searchParams.get('mid') ||
          String(item.itemidx) !== url.searchParams.get('idx'))
        throw Error('album_item_gate');
      keys.add(key);
    }
  }
  if (keys.size !== 32) throw Error('album_count_gate');
  return keys;
}

function loadOldDbKeys(dbPath) {
  const { DatabaseSync } = sqliteApi();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const rows = db.prepare('SELECT id, source_url, verified_source_url ' +
      'FROM articles WHERE mp_id = ?').all(TARGET_MP_ID);
    const keys = new Set();
    for (const row of rows) {
      const id = /^WX_3895431412_(\d+)_(\d+)$/.exec(row.id ?? '');
      if (id) keys.add(`${id[1]}\0${id[2]}`);
      for (const raw of [row.source_url, row.verified_source_url]) {
        try {
          const url = new URL(raw);
          if (url.hostname === 'mp.weixin.qq.com' &&
              url.pathname === '/s' && !url.username && !url.password &&
              !url.port) keys.add(articleKey(url.searchParams));
        } catch { /* Opaque old rows cannot be ruled out. */ }
      }
    }
    return { keys, oldRowCount: rows.length };
  } finally { db.close(); }
}

function previousRequest(seed, runDir) {
  const marker = path.join(runDir,
    `search-article-${seed.identityDigest}-${seed.urlDigest}.attempted`);
  const names = [
    ...fs.readdirSync(os.tmpdir()), ...fs.readdirSync(runDir) ];
  return { marker, attempted: OLD_REQUEST_DIGESTS.has(seed.identityDigest) ||
    names.some((name) => name.endsWith('.attempted') &&
      (name.includes(seed.identityDigest) ||
       name.includes(seed.urlDigest))) || fs.existsSync(marker) };
}

function loadParser(parserPath) {
  const resolved = fs.realpathSync(parserPath);
  if (!fs.statSync(resolved).isFile() ||
      !path.basename(resolved).startsWith('article-page.'))
    throw Error('parser_gate');
  const parser = require(resolved);
  if (['articleIdentity', 'articlePublishTime', 'articleContentHtml']
    .some((name) => typeof parser[name] !== 'function'))
    throw Error('parser_gate');
  const cheerio = createRequire(resolved)('cheerio');
  if (typeof cheerio.load !== 'function') throw Error('parser_gate');
  return { parser, cheerio };
}

function loadCandidates(config) {
  // Validates the recovered mobile account against read-only production and
  // its original/rehearsal backups. No token is used in the article request.
  recoveryGate(config.dbPath, config.runDir, 'present');
  const runDir = fs.realpathSync(config.runDir);
  const marker = JSON.parse(fs.readFileSync(path.join(runDir,
    'search-url-identity-attempt.json'), 'utf8'));
  const record = readPrivateRecord(runDir, marker.attemptedAt);
  const albums = loadAlbumKeys(config.albumDir);
  const oldDb = loadOldDbKeys(config.dbPath);
  const entries = record.candidates.map((candidate, index) => {
    const seed = candidateSeed(candidate, index);
    const prior = previousRequest(seed, runDir);
    return { seed, marker: prior.marker,
      priorAttempt: prior.attempted,
      knownAlbum: albums.has(seed.key), oldDbRecognized: oldDb.keys.has(seed.key) };
  });
  if (new Set(entries.map((item) => item.seed.key)).size !== entries.length)
    throw Error('candidate_duplicate_article_key');
  return { runDir, entries, oldRowCount: oldDb.oldRowCount };
}

function choose(loaded, requestedIndex) {
  if (requestedIndex !== null) {
    const item = loaded.entries[requestedIndex];
    if (!item) throw Error('candidate_index_gate');
    return item;
  }
  const available = loaded.entries.filter((item) => !item.priorAttempt);
  if (!available.length) throw Error('no_unattempted_candidate');
  available.sort((a, b) => {
    const score = (x) => Number(!x.knownAlbum) + Number(!x.oldDbRecognized);
    return score(b) - score(a) ||
      (b.seed.indexTimestamp ?? 0) - (a.seed.indexTimestamp ?? 0) ||
      a.seed.index - b.seed.index;
  });
  return available[0];
}

function summary(loaded, selected) {
  const entries = loaded.entries;
  return { candidateCount: entries.length,
    unattemptedCount: entries.filter((item) => !item.priorAttempt).length,
    outsideKnownAlbumsCount: entries.filter((item) => !item.knownAlbum).length,
    outsideRecognizedOldDbKeysCount:
      entries.filter((item) => !item.oldDbRecognized).length,
    outsideBothCount: entries.filter((item) =>
      !item.knownAlbum && !item.oldDbRecognized).length,
    oldDbRowCount: loaded.oldRowCount,
    selected: { index: selected.seed.index,
      digest: selected.seed.displayDigest,
      priorAttempt: selected.priorAttempt,
      knownAlbumKey: selected.knownAlbum,
      recognizedOldDbKey: selected.oldDbRecognized,
      outsideBothKnownKeySets: !selected.knownAlbum &&
        !selected.oldDbRecognized,
      urlHasSn: selected.seed.hasSn,
      indexTimePresent: selected.seed.indexTimestamp !== null,
      originalBizAndCtVerified: false } };
}

function canonicalShort(raw) {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname === 'mp.weixin.qq.com' && !url.username &&
      !url.password && !url.port && !url.search && !url.hash &&
      /^\/s\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname);
  } catch { return false; }
}

function inspectHtml(html, seed, loadedParser) {
  const out = { decision: 'stop_html_shape',
    originalBizMatch: false, midMatch: false, idxMatch: false,
    urlSnPresent: seed.hasSn, snMatch: null,
    canonicalShortValid: false, literalCtPresent: false,
    literalCtPlausible: false, parserTimeMatchesLiteralCt: false,
    indexTimeEqualsOriginalCt: null,
    bodyNodePresent: false, bodyNonempty: false,
    imageCount: 0, dataSrcImageCount: 0,
    sanitizedBodyPresent: false, sanitizedImageCount: 0 };
  if (/<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)[^<]*<\/title>|wappoc_appmsgcaptcha|verify\.html/i.test(html)) {
    out.decision = 'stop_verification_or_limit'; return out;
  }
  const { parser, cheerio } = loadedParser;
  const $ = cheerio.load(html);
  const body = $('#js_content');
  out.bodyNodePresent = body.length === 1;
  if (!out.bodyNodePresent) {
    out.decision = /验证码|访问过于频繁|captcha/i.test(html) ?
      'stop_verification_or_limit' : 'stop_body_node';
    return out;
  }
  let identity;
  try { identity = parser.articleIdentity(html); }
  catch { out.decision = 'stop_identity_parser'; return out; }
  let parsed;
  try { parsed = new URL(identity.url); }
  catch { out.decision = 'stop_identity_parser'; return out; }
  const expected = seed.url.searchParams, actual = parsed.searchParams;
  out.originalBizMatch = actual.get('__biz') === TARGET_BIZ &&
    identity.mpId === TARGET_MP_ID;
  out.midMatch = actual.get('mid') === expected.get('mid');
  out.idxMatch = actual.get('idx') === expected.get('idx');
  out.snMatch = seed.hasSn ? actual.get('sn') === expected.get('sn') : null;
  if (!out.originalBizMatch || !out.midMatch || !out.idxMatch ||
      out.snMatch === false) {
    out.decision = 'stop_identity_mismatch'; return out;
  }
  out.canonicalShortValid = canonicalShort(identity.canonical);
  if (!out.canonicalShortValid) {
    out.decision = 'stop_canonical_short'; return out;
  }
  const scripts = $('script').toArray().map((node) => $(node).html() ?? '');
  const ctValues = scripts.flatMap((script) => [...script.matchAll(
    /\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/g)]
    .map((match) => Number(match[1])));
  out.literalCtPresent = ctValues.length === 1;
  const ct = out.literalCtPresent ? ctValues[0] : null;
  out.literalCtPlausible = ct !== null && ct >= 946684800 &&
    ct <= Date.now() / 1000 + 300;
  out.parserTimeMatchesLiteralCt = out.literalCtPlausible &&
    parser.articlePublishTime(html) === ct && identity.publishTime === ct;
  if (out.literalCtPlausible && seed.indexTimestamp !== null)
    out.indexTimeEqualsOriginalCt = seed.indexTimestamp === ct;
  if (!out.literalCtPlausible || !out.parserTimeMatchesLiteralCt) {
    out.decision = 'stop_original_ct'; return out;
  }
  const images = body.find('img');
  out.imageCount = images.length;
  out.dataSrcImageCount = images.filter((_, node) =>
    Boolean($(node).attr('data-src'))).length;
  out.bodyNonempty = Boolean(body.text().trim() || images.length);
  if (!out.bodyNonempty) { out.decision = 'stop_body_empty'; return out; }
  let cleaned;
  try { cleaned = parser.articleContentHtml(html); }
  catch { out.decision = 'stop_body_parser'; return out; }
  out.sanitizedBodyPresent = typeof cleaned === 'string' && !!cleaned;
  out.sanitizedImageCount = out.sanitizedBodyPresent ?
    cheerio.load(cleaned)('#js_content img[src]').length : 0;
  out.decision = out.sanitizedBodyPresent ? 'article_verified' :
    'stop_sanitized_body_empty';
  return out;
}

function markAttempt(item) {
  const fd = fs.openSync(item.marker, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ kind: 'search-candidate-article',
      endpoint: 'https://mp.weixin.qq.com/s',
      urlDigest: item.seed.urlDigest,
      identityDigest: item.seed.identityDigest,
      attemptedAt: new Date().toISOString() }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function classifyLocation(raw) {
  const out = { locationPresent: typeof raw === 'string' && !!raw,
    locationTencentDomain: false, locationSameArticleHost: false,
    locationPath: 'unknown', locationHasAuthParams: false,
    locationHttps: false };
  if (!out.locationPresent || raw.length > 8192 ||
      /[\x00-\x1f\x7f]/.test(raw)) return out;
  try {
    const url = new URL(raw, 'https://mp.weixin.qq.com');
    out.locationHttps = url.protocol === 'https:';
    out.locationSameArticleHost = url.hostname === 'mp.weixin.qq.com';
    out.locationTencentDomain = url.hostname === 'qq.com' ||
      url.hostname.endsWith('.qq.com');
    out.locationPath = url.pathname === '/s' ? 'long_s' :
      /^\/s\/[^/]+$/.test(url.pathname) ? 'short_s' :
      /(?:verify|captcha|login|security)/i.test(url.pathname) ?
        'verification_or_login' : 'other';
    const authNames = new Set(['key', 'pass_ticket', 'appmsg_token',
      'token', 'access_token', 'authkey', 'uin', 'session']);
    out.locationHasAuthParams = [...url.searchParams.keys()]
      .some((name) => authNames.has(name.toLowerCase()));
  } catch { /* A malformed Location is an unknown shape, never followed. */ }
  return out;
}

function fetchOnce(seed) {
  return new Promise((resolve) => {
    let done = false, request;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    request = https.request(seed.url, { method: 'GET', agent: false,
      timeout: TIMEOUT_MS, headers: { Accept: 'text/html',
        'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT } }, (response) => {
      const httpStatus = response.statusCode ?? 0;
      if (httpStatus !== 200) {
        const redirect = httpStatus >= 300 && httpStatus < 400;
        const location = redirect ?
          classifyLocation(response.headers.location) : null;
        response.destroy();
        finish({ httpStatus, decision: httpStatus >= 300 &&
          httpStatus < 400 ?
            location.locationPath === 'verification_or_login' ?
              'stop_verification_or_limit' : 'stop_redirect' :
          httpStatus === 429 ? 'stop_rate_limit' :
          [401, 403].includes(httpStatus) ? 'stop_auth_or_access' :
          'stop_http_status', ...(location ?? {}) });
        return;
      }
      if (!/^text\/html\b/i.test(String(response.headers['content-type'] ?? '')) ||
          ![undefined, 'identity'].includes(response.headers['content-encoding'])) {
        response.destroy(); finish({ httpStatus, decision: 'stop_content_type' });
        return;
      }
      const declared = Number(response.headers['content-length'] ?? 0);
      if (declared > MAX_BODY) {
        response.destroy(); finish({ httpStatus, decision: 'stop_body_limit' });
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          response.destroy(); finish({ httpStatus, decision: 'stop_body_limit' });
        } else chunks.push(chunk);
      });
      response.on('end', () => finish({ httpStatus,
        html: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => finish({ httpStatus,
        decision: 'stop_transport' }));
    });
    request.on('timeout', () => { request.destroy();
      finish({ decision: 'stop_timeout' }); });
    request.on('error', () => finish({ decision: 'stop_transport' }));
    request.end();
  });
}

async function executeOne(item, loadedParser, requester = fetchOnce) {
  if (item.priorAttempt) throw Error('already_attempted');
  markAttempt(item);
  let result;
  try { result = await requester(item.seed); }
  catch { result = { decision: 'stop_transport' }; }
  const out = { decision: result.decision ?? 'stop_response',
    requestCount: 1, candidateIndex: item.seed.index,
    candidateDigest: item.seed.displayDigest,
    knownAlbumKey: item.knownAlbum,
    recognizedOldDbKey: item.oldDbRecognized,
    outsideBothKnownKeySets: !item.knownAlbum && !item.oldDbRecognized,
    httpStatus: result.httpStatus ?? null,
    ...(result.locationPresent === undefined ? {} : {
      locationPresent: result.locationPresent,
      locationTencentDomain: result.locationTencentDomain,
      locationSameArticleHost: result.locationSameArticleHost,
      locationPath: result.locationPath,
      locationHasAuthParams: result.locationHasAuthParams,
      locationHttps: result.locationHttps }) };
  if (typeof result.html !== 'string') return out;
  try { return { ...out, ...inspectHtml(result.html, item.seed, loadedParser) }; }
  catch { return { ...out, decision: 'stop_parse' }; }
}

async function selfTest(parserPath) {
  const loadedParser = loadParser(parserPath);
  const raw = `http://mp.weixin.qq.com/s?__biz=${TARGET_BIZ}&mid=123` +
    '&idx=1&sn=' + 'a'.repeat(32) + '&chksm=' + 'b'.repeat(76) + '#rd';
  const candidate = { originalDocUrl: raw, sourceNameMatched: true,
    urlBizMatchesTarget: true, originalBizAndCtVerified: false,
    indexTimestamp: 1780000000 };
  const seed = candidateSeed(candidate, 0);
  assert.equal(seed.url.protocol, 'https:');
  assert.equal(seed.url.hash, '#rd');
  assert.throws(() => candidateSeed({ ...candidate,
    originalDocUrl: raw.replace('mp.weixin.qq.com',
      'mp.weixin.qq.com.evil.example') }, 0), /candidate_url_gate/);
  const ct = '1780000000';
  const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/abc123"><div id="js_content"><p>fixture</p><img data-src="https://mmbiz.qpic.cn/x"></div><script>var biz="${TARGET_BIZ}";var mid="123";var idx="1";var sn="${'a'.repeat(32)}";var ct="${ct}";</script>`;
  const valid = inspectHtml(html, seed, loadedParser);
  assert.equal(valid.decision, 'article_verified');
  assert.equal(valid.originalBizMatch, true);
  assert.equal(valid.literalCtPresent, true);
  assert.equal(valid.imageCount, 1);
  assert.equal(inspectHtml(html.replace('var mid="123"',
    'var mid="999"'), seed, loadedParser).decision,
  'stop_identity_mismatch');
  assert.equal(inspectHtml('<title>请完成验证</title>', seed,
    loadedParser).decision, 'stop_verification_or_limit');
  const redirectShape = classifyLocation(
    `https://mp.weixin.qq.com/s/other?key=secret-fixture`);
  assert.equal(redirectShape.locationTencentDomain, true);
  assert.equal(redirectShape.locationPath, 'short_s');
  assert.equal(redirectShape.locationHasAuthParams, true);
  assert.equal(JSON.stringify(redirectShape).includes('secret-fixture'), false);
  assert.equal(classifyLocation('https://mp.weixin.qq.com.evil.example/s/x')
    .locationTencentDomain, false);
  assert.equal(classifyLocation('/mp/verify?token=fixture').locationPath,
    'verification_or_login');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),
    'mobile-refresh-article-test-'));
  try {
    const marker = path.join(root,
      `search-article-${seed.identityDigest}-${seed.urlDigest}.attempted`);
    const item = { seed, marker, priorAttempt: false,
      knownAlbum: false, oldDbRecognized: false };
    let calls = 0;
    const requester = async (s) => {
      calls++;
      assert.equal(s.url.protocol, 'https:');
      assert.equal(s.url.hostname, 'mp.weixin.qq.com');
      return { httpStatus: 200, html };
    };
    const result = await executeOne(item, loadedParser, requester);
    assert.equal(result.decision, 'article_verified');
    assert.equal(result.requestCount, 1);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(marker), true);
    assert.throws(() => markAttempt(item), /EEXIST/);
    const sameIdentityVariant = candidateSeed({ ...candidate,
      originalDocUrl: raw.replace('#rd', '#rr') }, 2);
    assert.equal(previousRequest(sameIdentityVariant, root).attempted, true);
    assert.equal(/mp\.weixin\.qq\.com|fixture|1780000000|Mzg5/.test(
      JSON.stringify(result)), false);
    const redirectSeed = candidateSeed({ ...candidate,
      originalDocUrl: raw.replace('mid=123', 'mid=124') }, 1);
    const redirectItem = { ...item, seed: redirectSeed,
      marker: path.join(root,
        `search-article-${redirectSeed.identityDigest}-${redirectSeed.urlDigest}.attempted`) };
    const redirect = await executeOne(redirectItem, loadedParser,
      async () => ({ httpStatus: 302, decision: 'stop_redirect',
        ...classifyLocation('https://mp.weixin.qq.com/s/other?key=secret-fixture') }));
    assert.equal(redirect.locationPath, 'short_s');
    assert.equal(redirect.locationHasAuthParams, true);
    assert.equal(JSON.stringify(redirect).includes('secret-fixture'), false);
  } finally {
    const temp = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(root);
    if (!within(temp, resolved) ||
        !path.basename(resolved).startsWith('mobile-refresh-article-test-'))
      throw Error('self_test_cleanup_gate');
    fs.rmSync(resolved, { recursive: true });
  }
  return { decision: 'self_test_passed', fakeRequests: 2,
    realNetworkRequests: 0, productionWrites: 0 };
}

async function main() {
  let config;
  try { config = options(process.argv.slice(2)); }
  catch { console.log(JSON.stringify({ decision: 'usage_gate',
    requestCount: 0 })); process.exitCode = 2; return; }
  if (config.mode === '--plan') {
    console.log(JSON.stringify({ decision: 'plan_only', requestMax: 1,
      requestHost: 'mp.weixin.qq.com', requestProtocol: 'https',
      redirects: false, retries: false, cookies: false, proxy: false,
      timeoutMs: TIMEOUT_MS, responseLimitBytes: MAX_BODY,
      markerPerCandidate: true, productionWrites: 0,
      realNetworkRequests: 0 })); return;
  }
  if (config.mode === '--self-test') {
    try { console.log(JSON.stringify(await selfTest(config.parserPath))); }
    catch { console.log(JSON.stringify({ decision: 'self_test_failed',
      realNetworkRequests: 0 })); process.exitCode = 1; }
    return;
  }
  try { environmentGate(process.env); }
  catch { console.log(JSON.stringify({ decision: 'environment_gate',
    requestCount: 0 })); process.exitCode = 1; return; }
  let loaded, parser, selected;
  try {
    loaded = loadCandidates(config);
    parser = loadParser(config.parserPath);
    selected = choose(loaded, config.index);
  } catch (error) {
    const allowed = new Set(['candidate_index_gate',
      'no_unattempted_candidate', 'candidate_url_gate',
      'candidate_identity_gate', 'album_count_gate']);
    console.log(JSON.stringify({ decision: allowed.has(error.message) ?
      error.message : 'preflight_gate', requestCount: 0 }));
    process.exitCode = 1; return;
  }
  const selection = summary(loaded, selected);
  if (config.mode === '--preflight') {
    console.log(JSON.stringify({ decision: 'preflight_ready', ...selection,
      requestCount: 0, productionWrites: 0 })); return;
  }
  if (selected.priorAttempt ||
      selected.seed.displayDigest !== config.reviewedDigest) {
    console.log(JSON.stringify({ decision: 'review_or_attempt_gate',
      requestCount: 0 })); process.exitCode = 1; return;
  }
  try {
    const result = await executeOne(selected, parser);
    console.log(JSON.stringify(result));
    if (result.decision !== 'article_verified') process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ decision: 'execute_gate',
      requestCount: 0 })); process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { candidateSeed, articleKey, inspectHtml, choose,
  loadAlbumKeys, loadOldDbKeys, previousRequest };
