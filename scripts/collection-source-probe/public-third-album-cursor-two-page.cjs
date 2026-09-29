// Reviewed maximum: one bounded first-page reacquisition for a real Tencent
// cursor, then one cursor page. No retries, redirects, proxy, or further pages.
// Private page files contain only validated article identity fields and cursors.
// node public-third-album-cursor-two-page.cjs preflight <read-only-db> <saved-temp-dir>
// node public-third-album-cursor-two-page.cjs probe <read-only-db> <saved-temp-dir> --execute-reviewed-9beb4db841a9c11c
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const [mode, dbPath, savedDir, reviewFlag] = process.argv.slice(2);
const DIGEST = '9beb4db841a9c11c';
const REVIEW_FLAG = `--execute-reviewed-${DIGEST}`;
const BIZ = 'Mzg5NTQzMTQxMg==';
const MP_ID = 'MP_WXS_3895431412';
const FIELDS = ['__biz', 'mid', 'idx', 'sn'];
const SOURCE_FILE = path.join(
  os.tmpdir(),
  `wewe-public-album-source-${DIGEST}.json`,
);
const SOURCE_MARKER = path.join(
  os.tmpdir(),
  `wewe-public-shortpath-album-${DIGEST}.attempted`,
);
const PRIOR_PAGE1_MARKER = path.join(
  os.tmpdir(),
  `wewe-public-third-album-page1-${DIGEST}.attempted`,
);
const RUN_MARKER = path.join(
  os.tmpdir(),
  `wewe-third-album-cursor-two-page-${DIGEST}.attempted`,
);
const PAGE2_MARKER = path.join(
  os.tmpdir(),
  `wewe-third-album-cursor-page2-${DIGEST}.attempted`,
);
const PAGE1_FILE = path.join(
  os.tmpdir(),
  `wewe-third-album-cursor-${DIGEST}-page1.json`,
);
const PAGE2_FILE = path.join(
  os.tmpdir(),
  `wewe-third-album-cursor-${DIGEST}-page2.json`,
);
const OLD_FILES = [
  [
    'wewe-target-album-page1-data-20260927.json',
    'wewe-target-album-page2-data-20260927.json',
  ],
  [
    'wewe-target-album2-page1-20260927.json',
    'wewe-target-album2-page2-20260927.json',
  ],
];
const MAX_BYTES = 2 * 1024 * 1024;

function emit(result, details = {}, failure = false) {
  console.log(JSON.stringify({ result, requests: 0, ...details }));
  if (failure) process.exitCode = 1;
}

function readSmallPrivate(file, maxBytes = 2048) {
  const before = fs.lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 10 ||
    before.size > maxBytes
  )
    throw new Error('private_file_shape');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== before.size)
      throw new Error('private_file_changed');
    const body = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      Buffer.byteLength(body, 'utf8') !== opened.size
    )
      throw new Error('private_file_changed');
    return body;
  } finally {
    fs.closeSync(fd);
  }
}

function privateAlbumId() {
  const source = JSON.parse(readSmallPrivate(SOURCE_FILE));
  const keys = Object.keys(source || {}).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify([
        'albumIds',
        'articleDigest',
        'biz',
        'observedUtc',
        'sourceField',
      ]) ||
    source.articleDigest !== DIGEST ||
    source.biz !== BIZ ||
    source.sourceField !== 'inline_var_album_info_list' ||
    !Array.isArray(source.albumIds) ||
    source.albumIds.length !== 1 ||
    !/^\d{10,24}$/.test(source.albumIds[0]) ||
    ['2527940920407949313', '3588220544052641807'].includes(
      source.albumIds[0],
    ) ||
    typeof source.observedUtc !== 'string' ||
    !Number.isFinite(Date.parse(source.observedUtc)) ||
    new Date(source.observedUtc).toISOString() !== source.observedUtc
  )
    throw new Error('private_source_identity');
  for (const marker of [SOURCE_MARKER, PRIOR_PAGE1_MARKER]) {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('prior_marker_missing');
  }
  return source.albumIds[0];
}

function articleSeed(dbFile) {
  const db = new DatabaseSync(path.resolve(dbFile), { readOnly: true });
  let rows;
  try {
    rows = db
      .prepare(
        `select id, source_url, verified_source_url, publish_time,
      case when content_html is not null and length(content_html)>0 then 1 else 0 end as has_body
      from articles where mp_id=? and verified_source_url is not null`,
      )
      .all(MP_ID);
  } finally {
    db.close();
  }
  const matches = rows.filter((row) => {
    try {
      const u = new URL(row.verified_source_url);
      return (
        crypto
          .createHash('sha256')
          .update(FIELDS.map((k) => u.searchParams.get(k) || '').join('\0'))
          .digest('hex')
          .slice(0, 16) === DIGEST
      );
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) throw new Error('article_seed_unique');
  const row = matches[0];
  const long = new URL(row.verified_source_url),
    q = long.searchParams;
  const short = new URL(row.source_url);
  if (
    long.protocol !== 'https:' ||
    long.hostname !== 'mp.weixin.qq.com' ||
    long.pathname !== '/s' ||
    long.port ||
    long.username ||
    long.password ||
    long.hash ||
    [...q.keys()].some((key) => !FIELDS.includes(key)) ||
    FIELDS.some((key) => q.getAll(key).length !== 1) ||
    q.get('__biz') !== BIZ ||
    !/^\d{8,15}$/.test(q.get('mid') || '') ||
    !/^[1-9]\d*$/.test(q.get('idx') || '') ||
    !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || '') ||
    row.id !== `WX_3895431412_${q.get('mid')}_${q.get('idx')}` ||
    short.protocol !== 'https:' ||
    short.hostname !== 'mp.weixin.qq.com' ||
    !/^\/s\/[A-Za-z0-9_-]{22}$/.test(short.pathname) ||
    short.search ||
    short.hash ||
    row.has_body !== 1 ||
    !Number.isSafeInteger(row.publish_time) ||
    new Date(row.publish_time * 1000).toISOString().slice(0, 10) !==
      '2026-09-24'
  )
    throw new Error('article_seed_identity');
  return { mid: q.get('mid'), idx: q.get('idx') };
}

function validatePage(value, albumId, seed, isFirst) {
  const ret = value?.base_resp?.ret;
  if (!Number.isInteger(ret))
    return { stop: 'response_shape_stop', retPresent: false };
  if (ret !== 0) return { stop: 'tencent_ret_stop', ret };
  const response = value?.getalbum_resp;
  const list = response?.article_list;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > 10 ||
    !['0', '1'].includes(String(response.continue_flag))
  )
    return {
      stop: 'response_shape_stop',
      ret,
      itemCount: Array.isArray(list) ? list.length : null,
    };
  const articles = [];
  let keyCount = 0,
    timeCount = 0,
    bizCount = 0,
    urlKeyCount = 0,
    targetCount = 0;
  for (const item of list) {
    const msgid = String(item?.msgid ?? ''),
      itemidx = String(item?.itemidx ?? '');
    const createTime = String(item?.create_time ?? '');
    if (
      !/^\d{8,15}$/.test(msgid) ||
      !/^\d+$/.test(itemidx) ||
      !/^\d{10}$/.test(createTime) ||
      Number(createTime) > Date.now() / 1000 + 300
    )
      return { stop: 'item_identity_stop', ret };
    timeCount++;
    const keyPresent =
      (typeof item.key === 'string' && item.key.length > 0) ||
      (typeof item.key === 'number' && Number.isFinite(item.key));
    if (keyPresent) keyCount++;
    let url;
    try {
      url = new URL(item.url);
    } catch {
      return { stop: 'item_url_stop', ret };
    }
    const q = url.searchParams;
    const allowed = ['__biz', 'mid', 'idx', 'sn', 'chksm'];
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.pathname !== '/s' ||
      url.username ||
      url.password ||
      !['', '#rd'].includes(url.hash) ||
      [...q.keys()].some((name) => !allowed.includes(name)) ||
      allowed.some((name) => q.getAll(name).length !== 1) ||
      q.get('__biz') !== BIZ ||
      q.get('mid') !== msgid ||
      q.get('idx') !== itemidx ||
      !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || '') ||
      !/^[a-fA-F0-9]{16,128}$/.test(q.get('chksm') || '')
    )
      return { stop: 'item_url_identity_stop', ret };
    bizCount++;
    urlKeyCount++;
    if (msgid === seed.mid && itemidx === seed.idx) targetCount++;
    articles.push({
      msgid,
      itemidx,
      createTime,
      sn: q.get('sn'),
      chksm: q.get('chksm'),
    });
  }
  const keys = articles.map((item) => `${item.msgid}|${item.itemidx}`);
  if (new Set(keys).size !== keys.length)
    return { stop: 'duplicate_within_page_stop', ret };
  if (
    articles.some(
      (item, index) =>
        index > 0 &&
        Number(item.createTime) > Number(articles[index - 1].createTime),
    )
  )
    return { stop: 'page_order_stop', ret };
  const declaredRaw = String(response.base_info?.article_count ?? '');
  const declaredArticleCount = /^\d{1,6}$/.test(declaredRaw)
    ? Number(declaredRaw)
    : null;
  if (isFirst && declaredArticleCount === null)
    return { stop: 'declared_count_stop', ret };
  return {
    ret,
    articles,
    itemCount: articles.length,
    keyCount,
    timeCount,
    bizCount,
    urlKeyCount,
    targetCount,
    declaredArticleCount,
    hasMore: String(response.continue_flag) === '1',
  };
}

function offlineSamples(directory, albumId, seed) {
  let tested = 0;
  for (const pair of OLD_FILES) {
    const first = JSON.parse(
      fs.readFileSync(path.join(directory, pair[0]), 'utf8'),
    );
    const next = JSON.parse(
      fs.readFileSync(path.join(directory, pair[1]), 'utf8'),
    );
    const a = validatePage(first, albumId, seed, true);
    const b = validatePage(next, albumId, seed, false);
    if (
      a.stop ||
      b.stop ||
      a.itemCount !== 10 ||
      b.itemCount < 1 ||
      !a.hasMore ||
      b.hasMore ||
      a.targetCount ||
      b.targetCount ||
      Number(b.articles[0].createTime) > Number(a.articles.at(-1).createTime)
    )
      throw new Error('old_pagination_shape');
    const seen = new Set(
      a.articles.map((item) => `${item.msgid}|${item.itemidx}`),
    );
    if (b.articles.some((item) => seen.has(`${item.msgid}|${item.itemidx}`)))
      throw new Error('old_pagination_overlap');
    tested += 2;
  }
  return tested;
}

function atomicPrivateWrite(destination, value) {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, destination); // no-overwrite atomic create on one volume
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never log private content */
    }
  }
}

function atomicSelftest() {
  const file = path.join(
    os.tmpdir(),
    `wewe-album-cursor-selftest-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`,
  );
  try {
    atomicPrivateWrite(file, { test: 1 });
    let rejected = false;
    try {
      atomicPrivateWrite(file, { test: 2 });
    } catch (error) {
      rejected = error.code === 'EEXIST';
    }
    if (!rejected || fs.readFileSync(file, 'utf8') !== '{"test":1}\n')
      throw new Error('atomic_selftest');
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* synthetic only */
    }
  }
}

async function requestPage(albumId, cursor) {
  const url = new URL('https://mp.weixin.qq.com/mp/appmsgalbum');
  const q = {
    action: 'getalbum',
    __biz: BIZ,
    album_id: albumId,
    count: '10',
    f: 'json',
  };
  if (cursor) {
    q.begin_msgid = cursor.msgid;
    q.begin_itemidx = cursor.itemidx;
  }
  url.search = new URLSearchParams(q).toString();
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
          Accept: 'application/json,text/plain;q=0.9,*/*;q=0.1',
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
          done(null, { status, body: Buffer.concat(chunks).toString('utf8') }),
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

function parseResponse(response, albumId, seed, isFirst) {
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
  if (
    /wappoc_appmsgcaptcha|appmsgcaptcha|请输入验证码|访问过于频繁|环境异常|频繁/.test(
      response.body,
    )
  )
    return { stop: 'verification_or_limit_stop', httpStatus: response.status };
  let value;
  try {
    value = JSON.parse(response.body);
  } catch {
    return { stop: 'non_json_stop', httpStatus: response.status };
  }
  return {
    ...validatePage(value, albumId, seed, isFirst),
    httpStatus: response.status,
  };
}

function nextCursor(summary) {
  if (!summary.hasMore || !summary.articles.length) return null;
  const last = summary.articles.at(-1);
  return { msgid: last.msgid, itemidx: last.itemidx };
}

function privatePageRecord(
  albumId,
  pageIndex,
  summary,
  requestCursor,
  cursor,
  previousSha256 = null,
) {
  return {
    schemaVersion: 1,
    articleDigest: DIGEST,
    biz: BIZ,
    albumId,
    source: 'official_getalbum',
    capturedUtc: new Date().toISOString(),
    pageIndex,
    requestCursor,
    nextCursor: cursor,
    continueFlag: summary.hasMore,
    declaredArticleCount: summary.declaredArticleCount,
    previousSha256,
    articles: summary.articles,
  };
}

function visibleSummary(summary, phase, requests, extras = {}) {
  return {
    phase,
    requests,
    httpStatus: summary.httpStatus,
    ret: summary.ret,
    itemCount: summary.itemCount,
    keyPresentCount: summary.keyCount,
    createTimePresentCount: summary.timeCount,
    bizMatchCount: summary.bizCount,
    urlKeyMatchCount: summary.urlKeyCount,
    targetOldArticleCount: summary.targetCount,
    declaredArticleCount: summary.declaredArticleCount,
    continueFlag: summary.hasMore,
    ...extras,
  };
}

async function main() {
  let albumId, seed, tested;
  try {
    if (!['preflight', 'probe'].includes(mode) || !dbPath || !savedDir)
      throw new Error('arguments');
    albumId = privateAlbumId();
    seed = articleSeed(dbPath);
    tested = offlineSamples(savedDir, albumId, seed);
  } catch (error) {
    const safe = new Set([
      'arguments',
      'private_file_shape',
      'private_file_changed',
      'private_source_identity',
      'prior_marker_missing',
      'article_seed_unique',
      'article_seed_identity',
      'old_pagination_shape',
      'old_pagination_overlap',
    ]);
    emit(
      'preflight_stop',
      { reason: safe.has(error.message) ? error.message : 'local_read_error' },
      true,
    );
    return;
  }
  if (mode === 'preflight') {
    try {
      atomicSelftest();
    } catch {
      emit('preflight_stop', { reason: 'atomic_selftest' }, true);
      return;
    }
    emit('preflight_pass', {
      articleDigest: DIGEST,
      privateAlbumSourceValidated: true,
      oldPagesTested: tested,
      requests: 0,
      firstPageRereadForCursorOnly: true,
      pageSpacingMinMs: 2000,
      runMarkerExists: fs.existsSync(RUN_MARKER),
      page1PrivateExists: fs.existsSync(PAGE1_FILE),
      page2PrivateExists: fs.existsSync(PAGE2_FILE),
    });
    return;
  }
  if (
    reviewFlag !== REVIEW_FLAG ||
    [RUN_MARKER, PAGE2_MARKER, PAGE1_FILE, PAGE2_FILE].some((file) =>
      fs.existsSync(file),
    )
  ) {
    emit('review_or_attempt_gate_stop', {}, true);
    return;
  }
  try {
    const fd = fs.openSync(RUN_MARKER, 'wx', 0o600);
    fs.writeSync(fd, `${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  } catch {
    emit('attempt_marker_stop', {}, true);
    return;
  }
  let firstResponse;
  try {
    firstResponse = await requestPage(albumId, null);
  } catch (error) {
    emit(
      error.message === 'timeout' ? 'first_timeout_stop' : 'first_network_stop',
      { requests: 1 },
      true,
    );
    return;
  }
  const first = parseResponse(firstResponse, albumId, seed, true);
  if (first.stop) {
    emit(
      first.stop,
      {
        phase: 'first_page_reacquired',
        requests: 1,
        httpStatus: first.httpStatus,
        ret: first.ret,
      },
      true,
    );
    return;
  }
  const cursor = nextCursor(first);
  try {
    atomicPrivateWrite(
      PAGE1_FILE,
      privatePageRecord(albumId, 1, first, null, cursor),
    );
  } catch {
    emit('first_private_save_stop', { requests: 1 }, true);
    return;
  }
  emit(
    'first_page_saved',
    visibleSummary(first, 'first_page_reacquired', 1, {
      runUniqueKeyCount: first.articles.length,
      privateCursorSaved: Boolean(cursor),
    }),
  );
  if (!cursor) return;
  const firstCompletedMs = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 2300));
  if (Date.now() - firstCompletedMs < 2000) {
    emit('spacing_gate_stop', { requests: 1 }, true);
    return;
  }
  try {
    const fd = fs.openSync(PAGE2_MARKER, 'wx', 0o600);
    fs.writeSync(fd, `${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  } catch {
    emit('second_marker_stop', { requests: 1 }, true);
    return;
  }
  let secondResponse;
  try {
    secondResponse = await requestPage(albumId, cursor);
  } catch (error) {
    emit(
      error.message === 'timeout'
        ? 'second_timeout_stop'
        : 'second_network_stop',
      { requests: 2 },
      true,
    );
    return;
  }
  const second = parseResponse(secondResponse, albumId, seed, false);
  if (second.stop) {
    emit(
      second.stop,
      {
        phase: 'second_cursor_page',
        requests: 2,
        httpStatus: second.httpStatus,
        ret: second.ret,
      },
      true,
    );
    return;
  }
  const firstKeys = new Set(
    first.articles.map((item) => `${item.msgid}|${item.itemidx}`),
  );
  const newArticles = second.articles.filter(
    (item) => !firstKeys.has(`${item.msgid}|${item.itemidx}`),
  );
  const chronologyAcrossPage =
    Number(second.articles[0].createTime) <=
    Number(first.articles.at(-1).createTime);
  const candidateNext = nextCursor(second);
  const next =
    newArticles.length === second.articles.length &&
    chronologyAcrossPage &&
    candidateNext &&
    !firstKeys.has(`${candidateNext.msgid}|${candidateNext.itemidx}`)
      ? candidateNext
      : null;
  let priorSha256;
  try {
    priorSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(PAGE1_FILE))
      .digest('hex');
  } catch {
    emit('first_private_read_stop', { requests: 2 }, true);
    return;
  }
  try {
    atomicPrivateWrite(
      PAGE2_FILE,
      privatePageRecord(albumId, 2, second, cursor, next, priorSha256),
    );
  } catch {
    emit('second_private_save_stop', { requests: 2 }, true);
    return;
  }
  emit(
    'second_page_saved',
    visibleSummary(second, 'second_cursor_page', 2, {
      runUniqueKeyCount: firstKeys.size + newArticles.length,
      overlapWithFirstPageCount: second.articles.length - newArticles.length,
      keysNewToRunCount: newArticles.length,
      chronologyAcrossPage,
      privateCursorSaved: Boolean(next),
    }),
  );
}

main();
