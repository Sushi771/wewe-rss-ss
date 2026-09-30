// Offline only. Summarize six private, validated Tencent album page records.
// node public-third-album-chain-audit.cjs <read-only-db> <saved-official-json-dir>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const [dbPath, savedDir] = process.argv.slice(2);
const DIGEST = '9beb4db841a9c11c';
const BIZ = 'Mzg5NTQzMTQxMg==';
const MP_ID = 'MP_WXS_3895431412';
const TMP = os.tmpdir();
const SOURCE = path.join(TMP, `wewe-public-album-source-${DIGEST}.json`);
const FILE = (n) => path.join(TMP, `wewe-third-album-cursor-${DIGEST}-page${n}.json`);
const MARKER = (n) => n === 1 ?
  path.join(TMP, `wewe-third-album-cursor-two-page-${DIGEST}.attempted`) :
  n === 2 ? path.join(TMP, `wewe-third-album-cursor-page2-${DIGEST}.attempted`) :
    path.join(TMP, `wewe-third-album-cursor-${DIGEST}-page${n}.attempted`);
const OLD = [
  ['wewe-target-album-page1-data-20260927.json', 'wewe-target-album-page2-data-20260927.json'],
  ['wewe-target-album2-page1-20260927.json', 'wewe-target-album2-page2-20260927.json'],
];
const PAGE_FIELDS = ['albumId', 'articleDigest', 'articles', 'biz', 'capturedUtc',
  'continueFlag', 'declaredArticleCount', 'nextCursor', 'pageIndex', 'previousSha256',
  'requestCursor', 'schemaVersion', 'source'];
const ARTICLE_FIELDS = ['chksm', 'createTime', 'itemidx', 'msgid', 'sn'];

function fail(reason) { throw new Error(reason); }
function fieldsMatch(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function stableRead(file, max = 65536) {
  const first = fs.lstatSync(file);
  if (!first.isFile() || first.isSymbolicLink() || first.size < 10 || first.size > max)
    fail('file_shape');
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (bytes.length !== first.size || before.size !== first.size ||
        before.mtimeMs !== first.mtimeMs || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs) fail('file_changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function marker(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('marker_shape');
}
function key(item) { return `${item.msgid}|${item.itemidx}`; }
function cursor(item) { return { msgid: item.msgid, itemidx: item.itemidx }; }
function sameCursor(a, b) {
  return fieldsMatch(a, ['msgid', 'itemidx']) && a.msgid === b.msgid &&
    a.itemidx === b.itemidx;
}
function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
function validArticle(item) {
  return fieldsMatch(item, ARTICLE_FIELDS) && /^\d{8,15}$/.test(item.msgid) &&
    /^[1-9]\d*$/.test(item.itemidx) && /^\d{10}$/.test(item.createTime) &&
    Number(item.createTime) <= Date.now() / 1000 + 300 &&
    /^[a-fA-F0-9]{16,64}$/.test(item.sn) &&
    /^[a-fA-F0-9]{16,128}$/.test(item.chksm);
}
function privateAlbumId() {
  const value = JSON.parse(stableRead(SOURCE, 2048).toString('utf8'));
  if (!fieldsMatch(value, ['albumIds', 'articleDigest', 'biz', 'observedUtc', 'sourceField']) ||
      value.articleDigest !== DIGEST || value.biz !== BIZ ||
      value.sourceField !== 'inline_var_album_info_list' || !iso(value.observedUtc) ||
      !Array.isArray(value.albumIds) || value.albumIds.length !== 1 ||
      typeof value.albumIds[0] !== 'string' || !/^\d{10,24}$/.test(value.albumIds[0]) ||
      ['2527940920407949313', '3588220544052641807'].includes(value.albumIds[0]))
    fail('source_identity');
  return value.albumIds[0];
}
function privatePages(albumId) {
  const records = [], keys = new Set();
  let earliest = Infinity, latest = -Infinity, previousHash = null;
  for (let n = 1; n <= 6; n++) {
    marker(MARKER(n));
    const bytes = stableRead(FILE(n));
    const page = JSON.parse(bytes.toString('utf8'));
    if (!fieldsMatch(page, PAGE_FIELDS) || page.schemaVersion !== 1 ||
        page.articleDigest !== DIGEST || page.biz !== BIZ || page.albumId !== albumId ||
        page.source !== 'official_getalbum' || page.pageIndex !== n || !iso(page.capturedUtc) ||
        page.continueFlag !== (n < 6) || page.declaredArticleCount !== (n === 1 ? 54 : null) ||
        page.previousSha256 !== previousHash ||
        !Array.isArray(page.articles) || page.articles.length !== (n < 6 ? 10 : 4) ||
        !page.articles.every(validArticle)) fail('page_identity');
    if (n === 1 ? page.requestCursor !== null :
      !sameCursor(page.requestCursor, records.at(-1).nextCursor)) fail('request_cursor');
    if (n < 6 ? !sameCursor(page.nextCursor, cursor(page.articles.at(-1))) :
      page.nextCursor !== null) fail('next_cursor');
    if (page.articles.some((item, i) => i > 0 &&
        Number(item.createTime) > Number(page.articles[i - 1].createTime))) fail('page_order');
    if (n > 1 && (Number(page.articles[0].createTime) >
        Number(records.at(-1).articles.at(-1).createTime) ||
        Date.parse(page.capturedUtc) - Date.parse(records.at(-1).capturedUtc) < 2300))
      fail('cross_page_order');
    for (const item of page.articles) {
      if (keys.has(key(item))) fail('duplicate_key');
      keys.add(key(item));
      earliest = Math.min(earliest, Number(item.createTime));
      latest = Math.max(latest, Number(item.createTime));
    }
    previousHash = crypto.createHash('sha256').update(bytes).digest('hex');
    records.push(page);
  }
  if (keys.size !== 54) fail('declared_count_mismatch');
  return { keys, counts: records.map((page) => page.articles.length),
    earliestUtcDate: new Date(earliest * 1000).toISOString().slice(0, 10),
    latestUtcDate: new Date(latest * 1000).toISOString().slice(0, 10) };
}
function oldAlbums(directory, newAlbumId) {
  const keys = new Set(), counts = [];
  for (const pair of OLD) {
    let albumCount = 0;
    for (const filename of pair) {
      const data = JSON.parse(stableRead(path.join(directory, filename), 2 * 1024 * 1024)
        .toString('utf8'));
      if (data?.base_resp?.ret !== 0 || !Array.isArray(data?.getalbum_resp?.article_list))
        fail('old_response_shape');
      for (const item of data.getalbum_resp.article_list) {
        let u;
        try { u = new URL(item.url); } catch { fail('old_url_shape'); }
        const q = u.searchParams;
        if (u.hostname !== 'mp.weixin.qq.com' || u.pathname !== '/s' ||
            q.get('__biz') !== BIZ || q.get('mid') !== String(item.msgid) ||
            q.get('idx') !== String(item.itemidx) ||
            !/^\d{10}$/.test(String(item.create_time))) fail('old_identity');
        if (keys.has(`${item.msgid}|${item.itemidx}`)) fail('old_duplicate');
        keys.add(`${item.msgid}|${item.itemidx}`);
        albumCount++;
      }
    }
    counts.push(albumCount);
  }
  if (newAlbumId === '2527940920407949313' ||
      newAlbumId === '3588220544052641807' || keys.size !== 32 ||
      counts[0] !== 13 || counts[1] !== 19) fail('old_album_baseline');
  return { keys, counts };
}
function databaseKeys(file) {
  const db = new DatabaseSync(path.resolve(file), { readOnly: true });
  let rows;
  try {
    rows = db.prepare('select id, verified_source_url from articles where mp_id=?').all(MP_ID);
  } finally { db.close(); }
  const keys = new Set();
  let idRecognizable = 0, verifiedRecognizable = 0;
  for (const row of rows) {
    const match = String(row.id).match(/^WX_3895431412_(\d{8,15})_([1-9]\d*)$/);
    if (match) { keys.add(`${match[1]}|${match[2]}`); idRecognizable++; }
    if (row.verified_source_url) {
      let u;
      try { u = new URL(row.verified_source_url); } catch { fail('db_url_shape'); }
      const q = u.searchParams, mid = q.get('mid'), idx = q.get('idx');
      if (u.hostname !== 'mp.weixin.qq.com' || u.pathname !== '/s' ||
          q.get('__biz') !== BIZ || !/^\d{8,15}$/.test(mid || '') ||
          !/^[1-9]\d*$/.test(idx || '')) fail('db_identity');
      keys.add(`${mid}|${idx}`); verifiedRecognizable++;
    }
  }
  return { keys, rows: rows.length, idRecognizable, verifiedRecognizable };
}
function main() {
  try {
    if (!dbPath || !savedDir) fail('arguments');
    const albumId = privateAlbumId();
    const third = privatePages(albumId);
    const old = oldAlbums(savedDir, albumId);
    const db = databaseKeys(dbPath);
    const intersect = (against) => [...third.keys].filter((item) => against.has(item)).length;
    const oldIntersection = intersect(old.keys), dbIntersection = intersect(db.keys);
    console.log(JSON.stringify({ result: 'offline_chain_verified', requests: 0,
      pages: third.counts.length, pageItemCounts: third.counts,
      declaredArticleCount: 54, uniqueThirdAlbumKeys: third.keys.size,
      privateChainBizAndIdentityFieldsValidated: true,
      firstTwoAlbumCounts: old.counts, oldAlbumUniqueKeys: old.keys.size,
      overlapWithFirstTwoAlbums: oldIntersection,
      oldDatabaseRows: db.rows, oldDatabaseNumericIdCount: db.idRecognizable,
      oldDatabaseVerifiedUrlCount: db.verifiedRecognizable,
      oldDatabaseRecognizableUniqueKeys: db.keys.size,
      overlapWithOldDatabaseRecognizableKeys: dbIntersection,
      outsideOldDatabaseRecognizableKeys: third.keys.size - dbIntersection,
      listCreateTimeUtcDateRange: [third.earliestUtcDate, third.latestUtcDate],
      lastContinueFlag: false, originalCtCheckedByThisAudit: false }));
  } catch (error) {
    const reasons = new Set(['arguments', 'file_shape', 'file_changed', 'marker_shape',
      'source_identity', 'page_identity', 'request_cursor', 'next_cursor',
      'page_order', 'cross_page_order', 'duplicate_key', 'declared_count_mismatch',
      'old_response_shape', 'old_url_shape', 'old_identity', 'old_duplicate',
      'old_album_baseline', 'db_url_shape', 'db_identity']);
    console.log(JSON.stringify({ result: 'offline_audit_stop', requests: 0,
      reason: reasons.has(error.message) ? error.message : 'local_read_error' }));
    process.exitCode = 1;
  }
}
main();
