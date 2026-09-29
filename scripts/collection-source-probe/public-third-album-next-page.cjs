// One reviewed Tencent getalbum cursor page per run. No previous-page reread.
// node public-third-album-next-page.cjs preflight <read-only-db>
// node public-third-album-next-page.cjs probe <read-only-db> --execute-reviewed-page-3
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');

const [mode, dbPath, reviewFlag] = process.argv.slice(2);
const DIGEST = '9beb4db841a9c11c';
const BIZ = 'Mzg5NTQzMTQxMg==';
const MP_ID = 'MP_WXS_3895431412';
const MAX_PAGE = 6; // Initial Tencent first page declared 54 articles.
const MAX_BYTES = 2 * 1024 * 1024;
const TEMP = os.tmpdir();
const SOURCE_FILE = path.join(TEMP, `wewe-public-album-source-${DIGEST}.json`);
const SHORT_MARKER = path.join(TEMP, `wewe-public-shortpath-album-${DIGEST}.attempted`);
const FIRST_ALBUM_MARKER = path.join(TEMP, `wewe-public-third-album-page1-${DIGEST}.attempted`);
const CURSOR_RUN_MARKER = path.join(TEMP, `wewe-third-album-cursor-two-page-${DIGEST}.attempted`);
const SECOND_MARKER = path.join(TEMP, `wewe-third-album-cursor-page2-${DIGEST}.attempted`);
const PAGE_FILE = (n) => path.join(TEMP, `wewe-third-album-cursor-${DIGEST}-page${n}.json`);
const PAGE_MARKER = (n) => path.join(TEMP, `wewe-third-album-cursor-${DIGEST}-page${n}.attempted`);
const RECORD_FIELDS = ['albumId', 'articleDigest', 'articles', 'biz', 'capturedUtc',
  'continueFlag', 'declaredArticleCount', 'nextCursor', 'pageIndex', 'previousSha256',
  'requestCursor', 'schemaVersion', 'source'];
const ARTICLE_FIELDS = ['chksm', 'createTime', 'itemidx', 'msgid', 'sn'];

function emit(result, fields = {}, error = false) {
  console.log(JSON.stringify({ result, requests: 0, ...fields }));
  if (error) process.exitCode = 1;
}
function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
function stableRead(file, limit = 65536) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 10 || before.size > limit)
    throw new Error('private_file_shape');
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs)
      throw new Error('private_file_changed');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('private_file_changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function markerExists(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('prior_marker_shape');
}
function privateSource() {
  const data = JSON.parse(stableRead(SOURCE_FILE, 2048).toString('utf8'));
  if (!sameKeys(data, ['albumIds', 'articleDigest', 'biz', 'observedUtc', 'sourceField']) ||
      data.articleDigest !== DIGEST || data.biz !== BIZ ||
      data.sourceField !== 'inline_var_album_info_list' || !iso(data.observedUtc) ||
      !Array.isArray(data.albumIds) || data.albumIds.length !== 1 ||
      typeof data.albumIds[0] !== 'string' || !/^\d{10,24}$/.test(data.albumIds[0]) ||
      ['2527940920407949313', '3588220544052641807'].includes(data.albumIds[0]))
    throw new Error('private_source_identity');
  [SHORT_MARKER, FIRST_ALBUM_MARKER, CURSOR_RUN_MARKER, SECOND_MARKER].forEach(markerExists);
  return data.albumIds[0];
}
function articleSeed(dbFile) {
  const db = new DatabaseSync(path.resolve(dbFile), { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`select id, source_url, verified_source_url, publish_time,
      case when content_html is not null and length(content_html)>0 then 1 else 0 end as has_body
      from articles where mp_id=? and verified_source_url is not null`).all(MP_ID);
  } finally { db.close(); }
  const fields = ['__biz', 'mid', 'idx', 'sn'];
  const matches = rows.filter((row) => {
    try {
      const q = new URL(row.verified_source_url).searchParams;
      return crypto.createHash('sha256').update(fields.map((key) =>
        q.get(key) || '').join('\0')).digest('hex').slice(0, 16) === DIGEST;
    } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('article_seed_unique');
  const row = matches[0], long = new URL(row.verified_source_url);
  const q = long.searchParams, short = new URL(row.source_url);
  if (long.protocol !== 'https:' || long.hostname !== 'mp.weixin.qq.com' ||
      long.pathname !== '/s' || long.hash || long.username || long.password || long.port ||
      [...q.keys()].some((key) => !fields.includes(key)) ||
      fields.some((key) => q.getAll(key).length !== 1) || q.get('__biz') !== BIZ ||
      !/^\d{8,15}$/.test(q.get('mid') || '') || !/^[1-9]\d*$/.test(q.get('idx') || '') ||
      !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || '') ||
      row.id !== `WX_3895431412_${q.get('mid')}_${q.get('idx')}` ||
      short.protocol !== 'https:' || short.hostname !== 'mp.weixin.qq.com' ||
      !/^\/s\/[A-Za-z0-9_-]{22}$/.test(short.pathname) || short.search || short.hash ||
      row.has_body !== 1 || !Number.isSafeInteger(row.publish_time) ||
      new Date(row.publish_time * 1000).toISOString().slice(0, 10) !== '2026-09-24')
    throw new Error('article_seed_identity');
  return { msgid: q.get('mid'), itemidx: q.get('idx') };
}
function validArticle(item) {
  return sameKeys(item, ARTICLE_FIELDS) && /^\d{8,15}$/.test(item.msgid) &&
    /^[1-9]\d*$/.test(item.itemidx) && /^\d{10}$/.test(item.createTime) &&
    Number(item.createTime) <= Date.now() / 1000 + 300 &&
    /^[a-fA-F0-9]{16,64}$/.test(item.sn) &&
    /^[a-fA-F0-9]{16,128}$/.test(item.chksm);
}
function key(item) { return `${item.msgid}|${item.itemidx}`; }
function cursorEquals(a, b) {
  return a && b && sameKeys(a, ['msgid', 'itemidx']) &&
    a.msgid === b.msgid && a.itemidx === b.itemidx;
}
function cursorOf(item) { return { msgid: item.msgid, itemidx: item.itemidx }; }
function loadChain(albumId, seed) {
  const pages = [], allKeys = new Set();
  for (let n = 1; n <= MAX_PAGE; n++) {
    const file = PAGE_FILE(n);
    if (!fs.existsSync(file)) {
      if (n <= 2 || fs.existsSync(PAGE_MARKER(n))) throw new Error('chain_gap_or_attempt');
      for (let later = n + 1; later <= MAX_PAGE; later++)
        if (fs.existsSync(PAGE_FILE(later)) || fs.existsSync(PAGE_MARKER(later)))
          throw new Error('chain_gap_or_attempt');
      break;
    }
    if (n >= 3) markerExists(PAGE_MARKER(n));
    const bytes = stableRead(file), page = JSON.parse(bytes.toString('utf8'));
    if (!sameKeys(page, RECORD_FIELDS) || page.schemaVersion !== 1 ||
        page.articleDigest !== DIGEST || page.biz !== BIZ || page.albumId !== albumId ||
        page.source !== 'official_getalbum' || page.pageIndex !== n || !iso(page.capturedUtc) ||
        typeof page.continueFlag !== 'boolean' ||
        !Array.isArray(page.articles) || page.articles.length < 1 || page.articles.length > 10 ||
        !page.articles.every(validArticle) ||
        (n === 1 ? page.declaredArticleCount !== 54 || page.requestCursor !== null ||
          page.previousSha256 !== null : page.declaredArticleCount !== null ||
          !cursorEquals(page.requestCursor, pages[n - 2].record.nextCursor) ||
          page.previousSha256 !== pages[n - 2].sha256))
      throw new Error('chain_record_identity');
    if (n === 1 && !page.articles.some((item) =>
      item.msgid === seed.msgid && item.itemidx === seed.itemidx))
      throw new Error('chain_seed_missing');
    if (page.articles.some((item, i) => i > 0 &&
        Number(item.createTime) > Number(page.articles[i - 1].createTime)))
      throw new Error('chain_page_order');
    if (n > 1 && (Number(page.articles[0].createTime) >
        Number(pages[n - 2].record.articles.at(-1).createTime) ||
        Date.parse(page.capturedUtc) - Date.parse(pages[n - 2].record.capturedUtc) < 2300))
      throw new Error('chain_order_or_spacing');
    for (const item of page.articles) {
      if (allKeys.has(key(item))) throw new Error('chain_duplicate');
      allKeys.add(key(item));
    }
    const last = page.articles.at(-1);
    if (page.continueFlag && n < MAX_PAGE ?
        !cursorEquals(page.nextCursor, cursorOf(last)) : page.nextCursor !== null)
      throw new Error('chain_cursor_identity');
    pages.push({ record: page, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  if (pages.length < 2) throw new Error('chain_missing');
  const previous = pages.at(-1).record;
  if (!previous.continueFlag || !previous.nextCursor || pages.length >= MAX_PAGE)
    throw new Error('chain_not_continuable');
  return { pages, keys: allKeys, nextPage: pages.length + 1, previous };
}
function validateResponse(value) {
  const ret = value?.base_resp?.ret;
  if (!Number.isInteger(ret)) return { stop: 'response_shape_stop' };
  if (ret !== 0) return { stop: 'tencent_ret_stop', ret };
  const resp = value?.getalbum_resp, list = resp?.article_list;
  if (!Array.isArray(list) || list.length < 1 || list.length > 10 ||
      !['0', '1'].includes(String(resp.continue_flag)))
    return { stop: 'response_shape_stop', ret };
  const articles = [];
  let keyPresentCount = 0;
  for (const item of list) {
    const msgid = String(item?.msgid ?? ''), itemidx = String(item?.itemidx ?? '');
    const createTime = String(item?.create_time ?? '');
    if (typeof item.key === 'string' && item.key.length > 0) keyPresentCount++;
    else if (typeof item.key === 'number' && Number.isFinite(item.key)) keyPresentCount++;
    let url;
    try { url = new URL(item.url); } catch { return { stop: 'item_url_stop', ret }; }
    const q = url.searchParams;
    const names = ['__biz', 'mid', 'idx', 'sn', 'chksm'];
    const article = { msgid, itemidx, createTime, sn: q.get('sn'), chksm: q.get('chksm') };
    if (!validArticle(article) || !['http:', 'https:'].includes(url.protocol) ||
        url.hostname !== 'mp.weixin.qq.com' || url.pathname !== '/s' || url.port ||
        url.username || url.password || !['', '#rd'].includes(url.hash) ||
        [...q.keys()].some((name) => !names.includes(name)) ||
        names.some((name) => q.getAll(name).length !== 1) || q.get('__biz') !== BIZ ||
        q.get('mid') !== msgid || q.get('idx') !== itemidx)
      return { stop: 'item_identity_stop', ret };
    articles.push(article);
  }
  const keys = articles.map(key);
  if (new Set(keys).size !== keys.length) return { stop: 'page_duplicate_stop', ret };
  if (articles.some((item, i) => i > 0 &&
      Number(item.createTime) > Number(articles[i - 1].createTime)))
    return { stop: 'page_order_stop', ret };
  return { ret, articles, keyPresentCount, continueFlag: String(resp.continue_flag) === '1' };
}
function requestPage(albumId, cursor) {
  const url = new URL('https://mp.weixin.qq.com/mp/appmsgalbum');
  url.search = new URLSearchParams({ action: 'getalbum', __biz: BIZ, album_id: albumId,
    count: '10', f: 'json', begin_msgid: cursor.msgid, begin_itemidx: cursor.itemidx }).toString();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = https.request(url, { method: 'GET', timeout: 12000, agent: false,
      headers: { Accept: 'application/json,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity', 'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, (res) => {
      const status = res.statusCode || 0;
      if (status !== 200) { res.destroy(); done(null, { status }); return; }
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
        res.destroy(); done(null, { status, tooLarge: true }); return;
      }
      let size = 0; const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(); done(null, { status, tooLarge: true }); return; }
        chunks.push(chunk);
      });
      res.on('end', () => done(null, { status, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => done(new Error('response_error')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => done(new Error(error.message === 'timeout' ? 'timeout' : 'network_error')));
    req.end();
  });
}
function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.linkSync(temp, file); // same-volume, no-overwrite create
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* synthetic or private content never logged */ }
  }
}
function selftest() {
  const test = path.join(TEMP,
    `wewe-third-album-next-selftest-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    atomicWrite(test, { test: 1 });
    let refused = false;
    try { atomicWrite(test, { test: 2 }); } catch (error) { refused = error.code === 'EEXIST'; }
    if (!refused || fs.readFileSync(test, 'utf8') !== '{"test":1}\n')
      throw new Error('atomic_selftest');
  } finally { try { fs.unlinkSync(test); } catch { /* synthetic only */ } }
  const old = JSON.parse(stableRead(path.join(TEMP,
    'wewe-target-album2-page2-20260927.json'), MAX_BYTES).toString('utf8'));
  const parsed = validateResponse(old);
  if (parsed.stop || parsed.articles.length !== 9 || parsed.continueFlag ||
      parsed.keyPresentCount !== 9) throw new Error('old_json_selftest');
}
async function main() {
  let albumId, chain;
  try {
    if (!['preflight', 'probe'].includes(mode) || !dbPath) throw new Error('arguments');
    albumId = privateSource();
    chain = loadChain(albumId, articleSeed(dbPath));
    selftest();
  } catch (error) {
    const safe = new Set(['arguments', 'private_file_shape', 'private_file_changed',
      'private_source_identity', 'prior_marker_shape', 'article_seed_unique',
      'article_seed_identity', 'chain_gap_or_attempt', 'chain_record_identity',
      'chain_seed_missing', 'chain_page_order', 'chain_order_or_spacing',
      'chain_duplicate', 'chain_cursor_identity', 'chain_missing',
      'chain_not_continuable', 'atomic_selftest', 'old_json_selftest']);
    emit('preflight_stop', { reason: safe.has(error.message) ? error.message : 'local_read_error' }, true);
    return;
  }
  const page = chain.nextPage, destination = PAGE_FILE(page), marker = PAGE_MARKER(page);
  if (mode === 'preflight') {
    emit('preflight_pass', { articleDigest: DIGEST, nextPage: page,
      priorPagesValidated: chain.pages.length, priorUniqueKeys: chain.keys.size,
      declaredArticleCount: chain.pages[0].record.declaredArticleCount,
      privateSourceValidated: true, privateCursorValidated: true,
      minSpacingMs: 2300, maxPages: MAX_PAGE,
      nextMarkerExists: fs.existsSync(marker), nextPrivateFileExists: fs.existsSync(destination) });
    return;
  }
  if (reviewFlag !== `--execute-reviewed-page-${page}` ||
      fs.existsSync(marker) || fs.existsSync(destination)) {
    emit('review_or_attempt_gate_stop', { nextPage: page }, true); return;
  }
  const previousTime = Date.parse(chain.previous.capturedUtc);
  const remaining = 2300 - (Date.now() - previousTime);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  if (Date.now() - previousTime < 2300) {
    emit('spacing_gate_stop', { nextPage: page }, true); return;
  }
  try {
    const fd = fs.openSync(marker, 'wx', 0o600);
    fs.writeSync(fd, `${new Date().toISOString()}\n`); fs.closeSync(fd);
  } catch { emit('attempt_marker_stop', { nextPage: page }, true); return; }
  let response;
  try { response = await requestPage(albumId, chain.previous.nextCursor); }
  catch (error) {
    emit(error.message === 'timeout' ? 'timeout_stop' : 'network_stop',
      { nextPage: page, requests: 1 }, true); return;
  }
  if (response.status !== 200 || response.tooLarge) {
    emit(response.status >= 300 && response.status < 400 ? 'redirect_stop' :
      response.tooLarge ? 'response_limit_stop' : 'http_stop',
      { nextPage: page, requests: 1, httpStatus: response.status }, true); return;
  }
  if (/wappoc_appmsgcaptcha|appmsgcaptcha|请输入验证码|访问过于频繁|环境异常|频繁/.test(response.body)) {
    emit('verification_or_limit_stop', { nextPage: page, requests: 1, httpStatus: 200 }, true); return;
  }
  let parsed;
  try { parsed = validateResponse(JSON.parse(response.body)); }
  catch { emit('non_json_stop', { nextPage: page, requests: 1, httpStatus: 200 }, true); return; }
  if (parsed.stop) {
    emit(parsed.stop, { nextPage: page, requests: 1, httpStatus: 200, ret: parsed.ret }, true); return;
  }
  const overlap = parsed.articles.filter((item) => chain.keys.has(key(item))).length;
  const chronology = Number(parsed.articles[0].createTime) <=
    Number(chain.previous.articles.at(-1).createTime);
  const totalUnique = chain.keys.size + parsed.articles.length - overlap;
  const canContinue = parsed.continueFlag && overlap === 0 && chronology &&
    page < MAX_PAGE && totalUnique < chain.pages[0].record.declaredArticleCount;
  const record = { schemaVersion: 1, articleDigest: DIGEST, biz: BIZ, albumId,
    source: 'official_getalbum', capturedUtc: new Date().toISOString(), pageIndex: page,
    requestCursor: chain.previous.nextCursor,
    nextCursor: canContinue ? cursorOf(parsed.articles.at(-1)) : null,
    continueFlag: parsed.continueFlag, declaredArticleCount: null,
    previousSha256: chain.pages.at(-1).sha256, articles: parsed.articles };
  try { atomicWrite(destination, record); }
  catch { emit('private_save_stop', { nextPage: page, requests: 1 }, true); return; }
  emit(canContinue || !parsed.continueFlag ? 'page_saved' : 'page_saved_review_stop',
    { nextPage: page, requests: 1, httpStatus: 200, ret: parsed.ret,
    itemCount: parsed.articles.length, keyPresentCount: parsed.keyPresentCount,
    createTimePresentCount: parsed.articles.length,
    bizMatchCount: parsed.articles.length, urlKeyMatchCount: parsed.articles.length,
    overlapWithPriorCount: overlap, keysNewToRunCount: parsed.articles.length - overlap,
    runUniqueKeyCount: totalUnique, chronologyAcrossPage: chronology,
    declaredArticleCount: chain.pages[0].record.declaredArticleCount,
    continueFlag: parsed.continueFlag, privateCursorSaved: canContinue },
    parsed.continueFlag && !canContinue);
}
main();
