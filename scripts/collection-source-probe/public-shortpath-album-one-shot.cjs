// Review-gated, single anonymous GET of a distinct stored official /s/<token> URL.
// Production SQLite is opened read-only. Neither URL nor HTML is logged or saved.
// A confirmed article album tag is saved only to a private no-overwrite file.
// node public-shortpath-album-one-shot.cjs preflight <db> <built-parser> <saved-temp-dir>
// node public-shortpath-album-one-shot.cjs probe <db> <built-parser> <saved-temp-dir> --execute-reviewed-9beb4db841a9c11c
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const [mode, dbPath, parserPath, savedDir, reviewFlag] = process.argv.slice(2);
const DIGEST = '9beb4db841a9c11c';
const REVIEW_FLAG = `--execute-reviewed-${DIGEST}`;
const MP_ID = 'MP_WXS_3895431412';
const BIZ = 'Mzg5NTQzMTQxMg=='; // Public account identity.
const FIELDS = ['__biz', 'mid', 'idx', 'sn'];
const MAX_BYTES = 6 * 1024 * 1024;
const ALBUM_FILES = [
  'wewe-target-album-page1-data-20260927.json',
  'wewe-target-album-page2-data-20260927.json',
  'wewe-target-album2-page1-20260927.json',
  'wewe-target-album2-page2-20260927.json',
];
const EXTRA_OLD_HTML = [
  'wewe-target-second-article-20260927.html',
  'wewe-target-proxy-article-20260927.html',
];
const KNOWN_ALBUM_IDS = new Set(['2527940920407949313', '3588220544052641807']);

function emit(result, extra = {}, failed = false) {
  console.log(JSON.stringify({ result, requests: 0, ...extra }));
  if (failed) process.exitCode = 1;
}

function digest(q) {
  return crypto.createHash('sha256')
    .update(FIELDS.map((field) => q.get(field) || '').join('\0'))
    .digest('hex').slice(0, 16);
}

function verifiedUrl(raw) {
  const url = new URL(raw);
  const q = url.searchParams;
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' ||
      url.pathname !== '/s' || url.port || url.username || url.password || url.hash ||
      [...q.keys()].some((key) => !FIELDS.includes(key)) ||
      FIELDS.some((key) => q.getAll(key).length !== 1) ||
      q.get('__biz') !== BIZ || !/^\d{8,15}$/.test(q.get('mid') || '') ||
      !/^[1-9]\d*$/.test(q.get('idx') || '') ||
      !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || ''))
    throw new Error('verified_url_shape');
  return url;
}

function shortUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' ||
      !/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname) || url.search || url.hash ||
      url.port || url.username || url.password)
    throw new Error('short_url_shape');
  return url;
}

function oldParserPreflight(parser, cheerio) {
  const records = JSON.parse(fs.readFileSync(
    path.join(savedDir, 'wewe-short-long-identities-20260927.json'), 'utf8')).articles;
  if (!Array.isArray(records)) throw new Error('old_records');
  const names = fs.readdirSync(savedDir)
    .filter((name) => /^wewe-identity-[A-Za-z0-9_-]+-20260927\.html$/.test(name))
    .sort().concat(EXTRA_OLD_HTML);
  if (names.length !== 8 || new Set(names).size !== 8) throw new Error('old_file_count');
  for (const name of names) {
    const html = fs.readFileSync(path.join(savedDir, name), 'utf8');
    const record = records.find((row) => path.basename(row.htmlFile) === name);
    if (!record || !record.hasContent || !record.matchesCurrentRow)
      throw new Error('old_record_missing');
    const identity = parser.articleIdentity(html);
    const actual = new URL(identity.url).searchParams;
    if (identity.mpId !== MP_ID ||
        FIELDS.some((field) => actual.get(field) !== String(record[field === '__biz' ? 'biz' : field])))
      throw new Error('old_identity');
    const ct = parser.articlePublishTime(html);
    const literal = html.match(/\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/);
    if (!ct || ct !== Number(record.ct) || ct !== Number(literal?.[1]) ||
        !parser.articleContentHtml(html) || cheerio.load(html)('#js_content').length !== 1)
      throw new Error('old_ct_or_body');
    const staged = analyze(html, { parser, cheerio,
      verified: verifiedUrl(record.canonicalUrl), short: shortUrl(record.ogUrl),
      dbPublishTime: Number(record.ct) });
    const declared = articleAlbumTags(html);
    if (staged.result !== 'identity_ct_body_pass' ||
        staged.explicitKnownAlbumCount !== 1 || staged.explicitNewAlbumCount !== 0 ||
        declared.state !== 'declared_article_album_tags' ||
        declared.ids.length !== 1 || !KNOWN_ALBUM_IDS.has(declared.ids[0]))
      throw new Error('old_staged_diagnostic');
  }
  return names.length;
}

function loadSeed() {
  if (!['preflight', 'probe'].includes(mode) || !dbPath || !parserPath || !savedDir ||
      !fs.existsSync(dbPath)) throw new Error('arguments');
  const parser = require(path.resolve(parserPath));
  const cheerio = createRequire(path.resolve(parserPath))('cheerio');
  const oldParserPassCount = oldParserPreflight(parser, cheerio);
  const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`select id, mp_id, source_url, verified_source_url, publish_time,
      case when content_html is not null and length(content_html) > 0 then 1 else 0 end as has_body
      from articles where mp_id = ? and verified_source_url is not null`).all(MP_ID);
  } finally { db.close(); }
  const matches = rows.filter((row) => {
    try { return digest(verifiedUrl(row.verified_source_url).searchParams) === DIGEST; }
    catch { return false; }
  });
  if (matches.length !== 1) throw new Error('candidate_uniqueness');
  const row = matches[0];
  const verified = verifiedUrl(row.verified_source_url);
  const short = shortUrl(row.source_url);
  const q = verified.searchParams;
  if (row.mp_id !== MP_ID || row.id !== `WX_3895431412_${q.get('mid')}_${q.get('idx')}` ||
      !Number.isSafeInteger(row.publish_time) || row.publish_time < 946684800 ||
      row.publish_time > Date.now() / 1000 + 300 ||
      new Date(row.publish_time * 1000).toISOString().slice(0, 10) !== '2026-09-24' ||
      row.has_body !== 1)
    throw new Error('candidate_saved_record');
  const albumKeys = new Set();
  for (const name of ALBUM_FILES) {
    const data = JSON.parse(fs.readFileSync(path.join(savedDir, name), 'utf8'));
    if (data.base_resp?.ret !== 0 || !Array.isArray(data.getalbum_resp?.article_list))
      throw new Error('old_album_data');
    for (const item of data.getalbum_resp.article_list)
      albumKeys.add(`${item.msgid}|${item.itemidx}`);
  }
  if (albumKeys.size !== 32 || albumKeys.has(`${q.get('mid')}|${q.get('idx')}`))
    throw new Error('candidate_album_overlap');
  const marker = path.join(os.tmpdir(), `wewe-public-shortpath-album-${DIGEST}.attempted`);
  const albumSource = path.join(os.tmpdir(), `wewe-public-album-source-${DIGEST}.json`);
  const attempted = fs.readdirSync(os.tmpdir())
    .some((name) => name.endsWith('.attempted') && name.includes(DIGEST));
  return { parser, cheerio, short, verified, dbPublishTime: row.publish_time,
    marker, albumSource, albumSourceExists: fs.existsSync(albumSource),
    attempted, oldParserPassCount };
}

function albumCounts(html) {
  const ids = new Set();
  for (const match of html.matchAll(/(?:https?:\/\/mp\.weixin\.qq\.com)?\/mp\/appmsgalbum[^\s"'<>]*/g)) {
    const raw = match[0].replace(/\\x26/gi, '&').replace(/&amp;/g, '&');
    let url;
    try { url = new URL(raw, 'https://mp.weixin.qq.com'); } catch { continue; }
    if (url.hostname !== 'mp.weixin.qq.com' || url.pathname !== '/mp/appmsgalbum' ||
        url.searchParams.get('__biz') !== BIZ) continue;
    const id = url.searchParams.get('album_id');
    if (/^\d{10,24}$/.test(id || '')) ids.add(id);
  }
  return { albumMarkerPresent: /\b(?:appmsgalbuminfo|album_info_list)\b/.test(html),
    explicitKnownAlbumCount: [...ids].filter((id) => KNOWN_ALBUM_IDS.has(id)).length,
    explicitNewAlbumCount: [...ids].filter((id) => !KNOWN_ALBUM_IDS.has(id)).length };
}

// The first-party page emits this as JavaScript, not strict JSON. Parse only
// bounded literal syntax; never evaluate a page script or infer an ID from a URL.
function balanced(source, start, limit = 131072) {
  const pair = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = start; i < Math.min(source.length, start + limit); i++) {
    const c = source[i], next = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === '`') return null;
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push(c); continue; }
    if (Object.hasOwn(pair, c)) {
      if (stack.pop() !== pair[c]) return null;
      if (stack.length === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function topLevelParts(source) {
  const parts = [];
  const pair = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let quote = '', escaped = false, start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '`') return null;
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push(c); continue; }
    if (Object.hasOwn(pair, c)) { if (stack.pop() !== pair[c]) return null; continue; }
    if (c === ',' && stack.length === 0) { parts.push(source.slice(start, i).trim()); start = i + 1; }
  }
  if (quote || stack.length) return null;
  const tail = source.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function staticJsString(expr) {
  const raw = expr.trim();
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return null;
  let output = '';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === quote) return raw.slice(i + 1).trim() ? null : output;
    if (c === '\n' || c === '\r') return null;
    if (c !== '\\') { output += c; continue; }
    const next = raw[++i];
    if (next === undefined) return null;
    const simple = { '\\': '\\', '"': '"', "'": "'", '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    if (Object.hasOwn(simple, next)) { output += simple[next]; continue; }
    if (next === 'x' || next === 'u') {
      const count = next === 'x' ? 2 : 4;
      const hex = raw.slice(i + 1, i + 1 + count);
      if (!new RegExp(`^[a-fA-F0-9]{${count}}$`).test(hex)) return null;
      output += String.fromCharCode(Number.parseInt(hex, 16)); i += count; continue;
    }
    return null;
  }
  return null;
}

function articleAlbumTags(html) {
  const assignments = [];
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    for (const match of script[1].matchAll(/\bvar\s+album_info_list\s*=\s*\[/g))
      assignments.push({ source: script[1], open: match.index + match[0].lastIndexOf('[') });
  }
  if (assignments.length !== 1)
    return { state: assignments.length ? 'ambiguous' : 'absent', ids: [] };
  const array = balanced(assignments[0].source, assignments[0].open);
  if (!array || array[0] !== '[' || array.at(-1) !== ']') return { state: 'malformed', ids: [] };
  const entries = topLevelParts(array.slice(1, -1));
  if (!entries || entries.length > 32) return { state: 'malformed', ids: [] };
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.startsWith('{') || !entry.endsWith('}')) return { state: 'malformed', ids: [] };
    const properties = topLevelParts(entry.slice(1, -1));
    if (!properties) return { state: 'malformed', ids: [] };
    const values = new Map();
    for (const property of properties) {
      const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]*)$/.exec(property);
      if (!match) return { state: 'malformed', ids: [] };
      if (['link', 'albumId', 'albumIdStr'].includes(match[1])) {
        if (values.has(match[1])) return { state: 'malformed', ids: [] };
        values.set(match[1], staticJsString(match[2]));
      }
    }
    const id = values.get('albumId');
    if (!/^\d{10,24}$/.test(id || '') || id !== values.get('albumIdStr'))
      return { state: 'malformed', ids: [] };
    const rawLink = values.get('link');
    if (!rawLink || rawLink.length > 8192) return { state: 'malformed', ids: [] };
    let link;
    try { link = new URL(rawLink.replace(/&amp;|&#38;|&#x26;/gi, '&')); }
    catch { return { state: 'malformed', ids: [] }; }
    if (link.protocol !== 'https:' || link.hostname !== 'mp.weixin.qq.com' ||
        link.pathname !== '/mp/appmsgalbum' || link.port || link.username || link.password ||
        link.searchParams.getAll('__biz').length !== 1 ||
        link.searchParams.get('__biz') !== BIZ ||
        link.searchParams.getAll('album_id').length !== 1 ||
        link.searchParams.get('album_id') !== id ||
        link.searchParams.getAll('action').length !== 1 ||
        link.searchParams.get('action') !== 'getalbum' ||
        ['uin', 'key', 'pass_ticket', 'appmsg_token'].some((key) => link.searchParams.has(key)))
      return { state: 'malformed', ids: [] };
    ids.add(id);
  }
  return { state: entries.length ? 'declared_article_album_tags' : 'empty', ids: [...ids].sort() };
}

function albumParserSelftest() {
  const id = '1'.repeat(12);
  const link = `https://mp.weixin.qq.com/mp/appmsgalbum?__biz=${BIZ}&amp;action=getalbum&amp;album_id=${id}`;
  const literal = `<script>var album_info_list = [{ albumId: "${id}", albumIdStr: "${id}", link: "${link}" }];</script>`;
  const valid = articleAlbumTags(literal);
  const foreign = articleAlbumTags(literal.replace('mp.weixin.qq.com', 'example.invalid'));
  const expression = articleAlbumTags(literal.replace(`albumId: "${id}"`, 'albumId: process.exit()'));
  const conflicting = articleAlbumTags(literal.replace(`albumIdStr: "${id}"`,
    `albumIdStr: "${'2'.repeat(12)}"`));
  if (valid.state !== 'declared_article_album_tags' || valid.ids.length !== 1 ||
      valid.ids[0] !== id || foreign.state !== 'malformed' ||
      expression.state !== 'malformed' || conflicting.state !== 'malformed')
    throw new Error('album_parser_test');
}

function writePrivateAtomic(destination, payload) {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(temporary, destination); // Atomic create, never replaces an existing file.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* no private value is logged */ }
  }
}

function privateWriteSelftest() {
  const destination = path.join(os.tmpdir(),
    `wewe-album-atomic-selftest-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
  try {
    writePrivateAtomic(destination, { selftest: true });
    if (fs.readFileSync(destination, 'utf8') !== '{"selftest":true}\n')
      throw new Error('private_atomic_test');
    let refusedOverwrite = false;
    try { writePrivateAtomic(destination, { selftest: false }); }
    catch (error) { refusedOverwrite = error.code === 'EEXIST'; }
    if (!refusedOverwrite || fs.readFileSync(destination, 'utf8') !== '{"selftest":true}\n')
      throw new Error('private_atomic_test');
  } finally {
    try { fs.unlinkSync(destination); } catch { /* only a synthetic self-test file */ }
  }
}

function analyze(html, seed) {
  const { parser, cheerio } = seed;
  const stage = {};
  const $ = cheerio.load(html);
  const body = $('#js_content');
  stage.hasJsContent = body.length === 1;
  if (!stage.hasJsContent) return { result: 'body_node_stop', ...stage };
  let identity;
  try { identity = parser.articleIdentity(html); }
  catch { return { result: 'identity_parser_stop', ...stage }; }
  let actual;
  try { actual = new URL(identity.url); }
  catch { return { result: 'identity_url_stop', ...stage }; }
  stage.identityFieldsPresent = Object.fromEntries(FIELDS.map((key) =>
    [key, Boolean(actual.searchParams.get(key))]));
  stage.identityFieldsMatch = Object.fromEntries(FIELDS.map((key) =>
    [key, actual.searchParams.get(key) === seed.verified.searchParams.get(key)]));
  stage.accountMatch = identity.mpId === MP_ID;
  let canonical;
  try { canonical = shortUrl(identity.canonical); } catch { canonical = null; }
  stage.canonicalShortMatch = Boolean(canonical && canonical.toString() === seed.short.toString());
  if (actual.hostname !== 'mp.weixin.qq.com' || actual.pathname !== '/s' ||
      !stage.accountMatch || !stage.canonicalShortMatch ||
      Object.values(stage.identityFieldsMatch).some((matched) => !matched))
    return { result: 'identity_mismatch_stop', ...stage };
  let ct;
  try { ct = parser.articlePublishTime(html); }
  catch { return { result: 'publish_parser_stop', ...stage }; }
  const literal = html.match(/\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/);
  stage.originalCtPresent = Boolean(literal);
  stage.originalCtSelfConsistent = Boolean(ct && ct === Number(literal?.[1]) &&
    ct === identity.publishTime);
  stage.originalCtMatchesSaved = Boolean(ct && ct === seed.dbPublishTime);
  if (!stage.originalCtSelfConsistent || !stage.originalCtMatchesSaved)
    return { result: 'original_ct_stop', ...stage };
  const images = body.find('img');
  stage.bodyTextPresent = Boolean(body.text().trim());
  stage.imageCount = images.length;
  stage.imageDataSrcCount = images.filter((_, el) => Boolean($(el).attr('data-src'))).length;
  let content;
  try { content = parser.articleContentHtml(html); }
  catch { return { result: 'body_parser_stop', ...stage }; }
  stage.sanitizedBodyPresent = Boolean(content);
  if (!stage.sanitizedBodyPresent) return { result: 'body_content_stop', ...stage };
  return { result: 'identity_ct_body_pass', ...stage,
    originalCtUtcDate: new Date(ct * 1000).toISOString().slice(0, 10), ...albumCounts(html) };
}

async function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };
    const req = https.request(url, {
      method: 'GET', timeout: 12000, agent: false,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://mp.weixin.qq.com/',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status !== 200) { res.destroy(); done(null, { status }); return; }
      if (!/^text\/html\b/i.test(String(res.headers['content-type'] || ''))) {
        res.destroy(); done(null, { status, nonHtml: true }); return;
      }
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
        res.destroy(); done(null, { status, tooLarge: true }); return;
      }
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { res.destroy(); done(null, { status, tooLarge: true }); return; }
        chunks.push(chunk);
      });
      res.on('end', () => done(null, { status, html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => done(new Error('response_error')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done(new Error(err.message === 'timeout' ? 'timeout' : 'network_error')));
    req.end();
  });
}

async function main() {
  let seed;
  try { seed = loadSeed(); }
  catch (error) {
    const safe = new Set(['arguments', 'old_records', 'old_file_count', 'old_record_missing',
      'old_identity', 'old_ct_or_body', 'old_staged_diagnostic',
      'candidate_uniqueness', 'candidate_saved_record',
      'old_album_data', 'candidate_album_overlap', 'short_url_shape', 'verified_url_shape']);
    emit('preflight_stop', { reason: safe.has(error.message) ? error.message : 'local_read_error' }, true);
    return;
  }
  if (mode === 'preflight') {
    try { albumParserSelftest(); privateWriteSelftest(); }
    catch { emit('preflight_stop', { reason: 'local_album_or_atomic_test' }, true); return; }
    emit('preflight_pass', { digest: DIGEST, savedUtcDate:
      new Date(seed.dbPublishTime * 1000).toISOString().slice(0, 10),
    requestPathShape: '/s/<stored-short-token>', oldParserPassCount: seed.oldParserPassCount,
    attemptedMarkerExists: seed.attempted, privateAlbumSourceExists: seed.albumSourceExists,
    albumParserSelftest: true, privateAtomicSelftest: true });
    return;
  }
  if (reviewFlag !== REVIEW_FLAG || seed.attempted || fs.existsSync(seed.marker) ||
      seed.albumSourceExists || fs.existsSync(seed.albumSource)) {
    emit('review_or_attempt_gate_stop', {}, true); return;
  }
  try {
    const fd = fs.openSync(seed.marker, 'wx');
    fs.writeSync(fd, `${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  } catch { emit('attempt_marker_stop', {}, true); return; }
  let response;
  try { response = await fetchOnce(seed.short); }
  catch (error) {
    emit(error.message === 'timeout' ? 'timeout_stop' : 'network_stop', { requests: 1 }, true);
    return;
  }
  const base = { requests: 1, digest: DIGEST, httpStatus: response.status };
  if (response.status !== 200 || response.nonHtml || response.tooLarge) {
    emit(response.status >= 300 && response.status < 400 ? 'redirect_stop' :
      response.nonHtml ? 'non_html_stop' : response.tooLarge ? 'response_limit_stop' : 'http_stop', base);
    return;
  }
  if (/wappoc_appmsgcaptcha|appmsgcaptcha|请输入验证码|为了你的帐号安全|访问过于频繁|环境异常/.test(response.html)) {
    emit('verification_or_limit_stop', base); return;
  }
  let finding;
  try { finding = analyze(response.html, seed); }
  catch { emit('page_parse_stop', base, true); return; }
  const { result, ...details } = finding;
  if (result !== 'identity_ct_body_pass') { emit(result, { ...base, ...details }); return; }
  let declared;
  try { declared = articleAlbumTags(response.html); }
  catch { declared = { state: 'malformed', ids: [] }; }
  const newIds = declared.ids.filter((id) => !KNOWN_ALBUM_IDS.has(id));
  const albumDetail = { articleAlbumTagState: declared.state,
    declaredKnownAlbumCount: declared.ids.length - newIds.length,
    declaredNewAlbumCount: newIds.length, privateAlbumSourceSaved: false };
  if (declared.state === 'declared_article_album_tags' && newIds.length > 0) {
    try {
      writePrivateAtomic(seed.albumSource, { articleDigest: DIGEST, biz: BIZ,
        sourceField: 'inline_var_album_info_list', albumIds: newIds,
        observedUtc: new Date().toISOString() });
      albumDetail.privateAlbumSourceSaved = true;
    } catch { emit('private_save_stop', { ...base, ...details, ...albumDetail }, true); return; }
  }
  emit(result, { ...base, ...details, ...albumDetail });
}

main();
