// One reviewed, anonymous Tencent getalbum first-page request. No pagination.
// Reads the article-owned album ID from a private file; never logs ID or JSON.
// node public-third-album-page1-one-shot.cjs preflight <read-only-db> <saved-temp-dir>
// node public-third-album-page1-one-shot.cjs probe <read-only-db> <saved-temp-dir> --execute-reviewed-9beb4db841a9c11c
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const [mode, dbPath, savedDir, reviewFlag] = process.argv.slice(2);
const ARTICLE_DIGEST = '9beb4db841a9c11c';
const REVIEW_FLAG = `--execute-reviewed-${ARTICLE_DIGEST}`;
const BIZ = 'Mzg5NTQzMTQxMg==';
const MP_ID = 'MP_WXS_3895431412';
const FIELDS = ['__biz', 'mid', 'idx', 'sn'];
const KNOWN_ALBUM_IDS = new Set(['2527940920407949313', '3588220544052641807']);
const PRIVATE_SOURCE = path.join(os.tmpdir(), `wewe-public-album-source-${ARTICLE_DIGEST}.json`);
const SOURCE_MARKER = path.join(os.tmpdir(), `wewe-public-shortpath-album-${ARTICLE_DIGEST}.attempted`);
const PROBE_MARKER = path.join(os.tmpdir(), `wewe-public-third-album-page1-${ARTICLE_DIGEST}.attempted`);
const OLD_PAGES = [
  'wewe-target-album-page1-data-20260927.json',
  'wewe-target-album-page2-data-20260927.json',
  'wewe-target-album2-page1-20260927.json',
  'wewe-target-album2-page2-20260927.json',
];
const MAX_BYTES = 2 * 1024 * 1024;

function emit(result, extra = {}, failure = false) {
  console.log(JSON.stringify({ result, requests: 0, ...extra }));
  if (failure) process.exitCode = 1;
}

function digest(query) {
  return crypto.createHash('sha256')
    .update(FIELDS.map((field) => query.get(field) || '').join('\0'))
    .digest('hex').slice(0, 16);
}

function verifiedArticleUrl(raw) {
  const url = new URL(raw);
  const q = url.searchParams;
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' ||
      url.pathname !== '/s' || url.port || url.username || url.password || url.hash ||
      [...q.keys()].some((key) => !FIELDS.includes(key)) ||
      FIELDS.some((key) => q.getAll(key).length !== 1) ||
      q.get('__biz') !== BIZ || !/^\d{8,15}$/.test(q.get('mid') || '') ||
      !/^[1-9]\d*$/.test(q.get('idx') || '') ||
      !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || ''))
    throw new Error('verified_article_shape');
  return url;
}

function readPrivateSource() {
  const before = fs.lstatSync(PRIVATE_SOURCE);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 30 || before.size > 2048)
    throw new Error('private_source_shape');
  const fd = fs.openSync(PRIVATE_SOURCE, 'r');
  let data;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== before.size) throw new Error('private_source_changed');
    data = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        Buffer.byteLength(data, 'utf8') !== opened.size)
      throw new Error('private_source_changed');
  } finally { fs.closeSync(fd); }
  const value = JSON.parse(data);
  const keys = Object.keys(value || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'albumIds', 'articleDigest', 'biz', 'observedUtc', 'sourceField']) ||
      value.articleDigest !== ARTICLE_DIGEST || value.biz !== BIZ ||
      value.sourceField !== 'inline_var_album_info_list' ||
      !Array.isArray(value.albumIds) || value.albumIds.length !== 1 ||
      !/^\d{10,24}$/.test(value.albumIds[0]) ||
      KNOWN_ALBUM_IDS.has(value.albumIds[0]) ||
      typeof value.observedUtc !== 'string' ||
      !Number.isFinite(Date.parse(value.observedUtc)) ||
      new Date(value.observedUtc).toISOString() !== value.observedUtc ||
      Date.parse(value.observedUtc) < Date.UTC(2026, 8, 29) ||
      Date.parse(value.observedUtc) > Date.now() + 300000)
    throw new Error('private_source_identity');
  const prior = fs.lstatSync(SOURCE_MARKER);
  if (!prior.isFile() || prior.isSymbolicLink()) throw new Error('source_marker_missing');
  return value.albumIds[0];
}

function loadArticleSeed(dbFile) {
  const db = new DatabaseSync(path.resolve(dbFile), { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`select id, mp_id, source_url, verified_source_url, publish_time,
      case when content_html is not null and length(content_html) > 0 then 1 else 0 end as has_body
      from articles where mp_id = ? and verified_source_url is not null`).all(MP_ID);
  } finally { db.close(); }
  const matches = rows.filter((row) => {
    try { return digest(verifiedArticleUrl(row.verified_source_url).searchParams) === ARTICLE_DIGEST; }
    catch { return false; }
  });
  if (matches.length !== 1) throw new Error('candidate_uniqueness');
  const row = matches[0];
  const url = verifiedArticleUrl(row.verified_source_url);
  const q = url.searchParams;
  const short = new URL(row.source_url);
  if (row.mp_id !== MP_ID || row.id !== `WX_3895431412_${q.get('mid')}_${q.get('idx')}` ||
      short.protocol !== 'https:' || short.hostname !== 'mp.weixin.qq.com' ||
      !/^\/s\/[A-Za-z0-9_-]{22}$/.test(short.pathname) || short.search || short.hash ||
      short.port || short.username || short.password || row.has_body !== 1 ||
      !Number.isSafeInteger(row.publish_time) ||
      new Date(row.publish_time * 1000).toISOString().slice(0, 10) !== '2026-09-24')
    throw new Error('candidate_identity');
  return { mid: q.get('mid'), idx: q.get('idx') };
}

function itemSummary(item, seed) {
  const msgid = String(item?.msgid ?? '');
  const itemidx = String(item?.itemidx ?? '');
  const pairPresent = /^\d{8,15}$/.test(msgid) && /^\d+$/.test(itemidx);
  const keyPresent = (typeof item?.key === 'string' && item.key.length > 0) ||
    (typeof item?.key === 'number' && Number.isFinite(item.key));
  const ct = String(item?.create_time ?? '');
  const createTimePresent = /^\d{10}$/.test(ct) && Number(ct) <= Date.now() / 1000 + 300;
  let urlBizMatch = false, urlPairMatch = false, urlArticleIdentityPresent = false;
  try {
    const url = new URL(item.url);
    const q = url.searchParams;
    if (['http:', 'https:'].includes(url.protocol) && url.hostname === 'mp.weixin.qq.com' &&
        url.pathname === '/s' && !url.username && !url.password) {
      urlBizMatch = q.getAll('__biz').length === 1 && q.get('__biz') === BIZ;
      urlPairMatch = q.getAll('mid').length === 1 && q.getAll('idx').length === 1 &&
        q.get('mid') === msgid && q.get('idx') === itemidx;
      urlArticleIdentityPresent = q.getAll('sn').length === 1 && Boolean(q.get('sn'));
    }
  } catch { /* only a Boolean is reported */ }
  const selectedPair = pairPresent && msgid === seed.mid && itemidx === seed.idx;
  return { pairPresent, keyPresent, createTimePresent, urlBizMatch,
    urlPairMatch, urlArticleIdentityPresent, selectedPair };
}

function assessAlbumResponse(value, seed) {
  const ret = value?.base_resp?.ret;
  if (!Number.isInteger(ret)) return { result: 'response_shape_stop', retPresent: false };
  if (ret !== 0) return { result: 'tencent_ret_stop', ret };
  const response = value?.getalbum_resp;
  if (!Array.isArray(response?.article_list) || response.article_list.length > 10)
    return { result: 'response_shape_stop', ret, articleListPresent: false };
  const items = response.article_list.map((item) => itemSummary(item, seed));
  const target = items.filter((item) => item.selectedPair);
  const hasMore = String(response.continue_flag) === '1' ? true :
    String(response.continue_flag) === '0' ? false : null;
  const declaredRaw = String(response.base_info?.article_count ?? '');
  const declaredCount = /^\d{1,6}$/.test(declaredRaw) ? Number(declaredRaw) : null;
  const allItemIdentityMatch = items.length > 0 && items.every((item) =>
    item.pairPresent && item.urlBizMatch && item.urlPairMatch);
  const targetConfirmed = allItemIdentityMatch && target.length === 1 && target[0].urlBizMatch &&
    target[0].urlPairMatch && target[0].urlArticleIdentityPresent;
  const uniquePairs = new Set(response.article_list.map((item) =>
    `${String(item?.msgid ?? '')}|${String(item?.itemidx ?? '')}`)).size === items.length;
  const completeSinglePage = hasMore === false && declaredCount !== null &&
    declaredCount === items.length && uniquePairs && allItemIdentityMatch;
  return {
    result: 'page1_parsed', ret, itemCount: items.length,
    itemPairPresentCount: items.filter((item) => item.pairPresent).length,
    itemKeyPresentCount: items.filter((item) => item.keyPresent).length,
    itemCreateTimePresentCount: items.filter((item) => item.createTimePresent).length,
    itemUrlBizMatchCount: items.filter((item) => item.urlBizMatch).length,
    itemUrlPairMatchCount: items.filter((item) => item.urlPairMatch).length,
    itemUrlSnPresentCount: items.filter((item) => item.urlArticleIdentityPresent).length,
    continueFlagPresent: hasMore !== null, hasMore,
    declaredArticleCount: declaredCount,
    targetPairCount: target.length,
    targetPairOnFirstPage: target.length > 0,
    targetUrlIdentityMatch: targetConfirmed,
    targetCreateTimePresent: target.length === 1 && target[0].createTimePresent,
    membershipConclusion: targetConfirmed ? 'confirmed_on_first_page' :
      target.length > 0 ? 'target_key_seen_identity_unclosed' :
        completeSinglePage ? 'absent_from_complete_single_page' : 'undetermined_after_first_page',
  };
}

function oldSamplesPreflight(directory, seed) {
  const keys = new Set();
  const counts = [];
  for (const name of OLD_PAGES) {
    const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    const summary = assessAlbumResponse(value, seed);
    if (summary.result !== 'page1_parsed' || summary.ret !== 0 ||
        summary.itemUrlBizMatchCount !== summary.itemCount ||
        summary.itemUrlPairMatchCount !== summary.itemCount ||
        summary.itemKeyPresentCount !== summary.itemCount ||
        summary.itemCreateTimePresentCount !== summary.itemCount ||
        !summary.continueFlagPresent || summary.targetPairOnFirstPage ||
        summary.membershipConclusion !== 'undetermined_after_first_page')
      throw new Error('old_samples_shape');
    const first = value.getalbum_resp.article_list[0];
    const positive = assessAlbumResponse(value, { mid: String(first.msgid),
      idx: String(first.itemidx) });
    if (positive.membershipConclusion !== 'confirmed_on_first_page' ||
        positive.targetPairCount !== 1 || !positive.targetUrlIdentityMatch)
      throw new Error('old_samples_membership');
    counts.push(summary.itemCount);
    for (const item of value.getalbum_resp.article_list)
      keys.add(`${item.msgid}|${item.itemidx}`);
  }
  if (counts.join(',') !== '10,3,10,9' || keys.size !== 32 ||
      keys.has(`${seed.mid}|${seed.idx}`)) throw new Error('old_samples_identity');
  return { oldPageCount: OLD_PAGES.length, oldUniqueArticleKeys: keys.size };
}

async function fetchOnce(albumId) {
  const url = new URL('https://mp.weixin.qq.com/mp/appmsgalbum');
  url.search = new URLSearchParams({ action: 'getalbum', __biz: BIZ,
    album_id: albumId, count: '10', f: 'json' }).toString();
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
      const chunks = []; let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { res.destroy(); done(null, { status, tooLarge: true }); return; }
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

async function main() {
  let albumId, seed, old;
  try {
    if (!['preflight', 'probe'].includes(mode) || !dbPath || !savedDir)
      throw new Error('arguments');
    albumId = readPrivateSource();
    seed = loadArticleSeed(dbPath);
    old = oldSamplesPreflight(savedDir, seed);
  } catch (error) {
    const reasons = new Set(['arguments', 'private_source_shape', 'private_source_changed',
      'private_source_identity', 'source_marker_missing', 'candidate_uniqueness',
      'candidate_identity', 'old_samples_shape', 'old_samples_identity',
      'old_samples_membership']);
    emit('preflight_stop', { reason: reasons.has(error.message) ? error.message : 'local_read_error' }, true);
    return;
  }
  if (mode === 'preflight') {
    emit('preflight_pass', { articleDigest: ARTICLE_DIGEST, privateAlbumSourceValidated: true,
      sourceArticleMarkerPresent: true, probeMarkerExists: fs.existsSync(PROBE_MARKER),
      requestShape: '/mp/appmsgalbum?action=getalbum&__biz=<target>&album_id=<private>&count=10&f=json',
      ...old });
    return;
  }
  if (reviewFlag !== REVIEW_FLAG || fs.existsSync(PROBE_MARKER)) {
    emit('review_or_attempt_gate_stop', {}, true); return;
  }
  try {
    const fd = fs.openSync(PROBE_MARKER, 'wx', 0o600);
    fs.writeSync(fd, `${new Date().toISOString()}\n`); fs.closeSync(fd);
  } catch { emit('attempt_marker_stop', {}, true); return; }
  let response;
  try { response = await fetchOnce(albumId); }
  catch (error) {
    emit(error.message === 'timeout' ? 'timeout_stop' : 'network_stop', { requests: 1 }, true);
    return;
  }
  const base = { requests: 1, articleDigest: ARTICLE_DIGEST, httpStatus: response.status };
  if (response.status !== 200 || response.tooLarge) {
    emit(response.status >= 300 && response.status < 400 ? 'redirect_stop' :
      response.tooLarge ? 'response_limit_stop' : 'http_stop', base); return;
  }
  if (/wappoc_appmsgcaptcha|appmsgcaptcha|请输入验证码|访问过于频繁|环境异常|频繁/.test(response.body)) {
    emit('verification_or_limit_stop', base); return;
  }
  let value;
  try { value = JSON.parse(response.body); }
  catch { emit('non_json_stop', base); return; }
  let summary;
  try { summary = assessAlbumResponse(value, seed); }
  catch { emit('response_shape_stop', base, true); return; }
  const { result, ...details } = summary;
  emit(result, { ...base, ...details });
}

main();
