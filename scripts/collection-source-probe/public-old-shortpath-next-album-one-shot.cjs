// One reviewed GET of a stored official short article URL. Never writes SQLite.
// node public-old-shortpath-next-album-one-shot.cjs preflight <main-workspace-root>
// node public-old-shortpath-next-album-one-shot.cjs selftest <main-workspace-root>
// node public-old-shortpath-next-album-one-shot.cjs probe <main-workspace-root> --execute-reviewed-5e44e0d46c308fe2
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const [mode, rootArgument, reviewFlag] = process.argv.slice(2);
const DIGEST = '5e44e0d46c308fe2';
const BIZ = 'Mzg5NTQzMTQxMg=='; // Public account identity, not a credential.
const MP_ID = 'MP_WXS_3895431412';
const FIELDS = ['__biz', 'mid', 'idx', 'sn'];
const MAX_BYTES = 6 * 1024 * 1024;
const REVIEW_FLAG = `--execute-reviewed-${DIGEST}`;
const OLD_TWO_ALBUMS = new Set(['2527940920407949313', '3588220544052641807']);
const BACKUP_NAME = 'before-collection-20260929T031527Z-160e7e28';

function fail(reason) {
  throw new Error(reason);
}
function safeResult(result, extra = {}, error = false) {
  console.log(JSON.stringify({ result, requests: 0, ...extra }));
  if (error) process.exitCode = 1;
}
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function identityDigest(query) {
  return sha256(FIELDS.map((name) => query.get(name) || '').join('\0')).slice(
    0,
    16,
  );
}
function officialLong(raw) {
  const url = new URL(raw),
    q = url.searchParams;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.pathname !== '/s' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    [...q.keys()].some((name) => !FIELDS.includes(name)) ||
    FIELDS.some((name) => q.getAll(name).length !== 1) ||
    q.get('__biz') !== BIZ ||
    !/^\d{8,15}$/.test(q.get('mid') || '') ||
    !/^[1-9]\d*$/.test(q.get('idx') || '') ||
    !/^[a-fA-F0-9]{16,64}$/.test(q.get('sn') || '')
  )
    fail('long_url_shape');
  return url;
}
function officialShort(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    !/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.port ||
    url.username ||
    url.password
  )
    fail('short_url_shape');
  return url;
}
function candidateRow(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  let rows;
  try {
    if (Object.values(db.prepare('pragma quick_check').get())[0] !== 'ok')
      fail('db_integrity');
    rows = db
      .prepare(
        `select id, mp_id, source_url, verified_source_url, publish_time,
      case when content_html is not null and length(content_html)>0 then 1 else 0 end has_body
      from articles where mp_id=? and verified_source_url is not null`,
      )
      .all(MP_ID);
  } finally {
    db.close();
  }
  const matches = rows.filter((row) => {
    try {
      return (
        identityDigest(officialLong(row.verified_source_url).searchParams) ===
        DIGEST
      );
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) fail('candidate_uniqueness');
  const row = matches[0],
    verified = officialLong(row.verified_source_url);
  const short = officialShort(row.source_url),
    q = verified.searchParams;
  if (
    row.mp_id !== MP_ID ||
    row.id !== `WX_3895431412_${q.get('mid')}_${q.get('idx')}` ||
    row.has_body !== 1 ||
    !Number.isSafeInteger(row.publish_time) ||
    new Date(row.publish_time * 1000).toISOString().slice(0, 10) !==
      '2026-09-28'
  )
    fail('saved_identity');
  return { row, verified, short };
}
function loadSeed(root) {
  if (
    !['preflight', 'selftest', 'probe'].includes(mode) ||
    !rootArgument ||
    !path.isAbsolute(rootArgument)
  )
    fail('arguments');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  if (!/^private-data\/$/m.test(ignore)) fail('private_ignore');
  const dbFile = path.join(root, 'apps/server/data/wewe-rss.db');
  const backupDir = path.join(
    root,
    'output/subscription-implementation/backups',
    BACKUP_NAME,
  );
  const backupFile = path.join(backupDir, 'wewe-rss.db');
  const verification = JSON.parse(
    fs.readFileSync(path.join(backupDir, 'verification.json'), 'utf8'),
  );
  if (
    verification.integrityCheck !== 'ok' ||
    path.resolve(verification.source) !== dbFile ||
    path.resolve(verification.backup) !== backupFile ||
    verification.sha256 !== sha256(fs.readFileSync(backupFile))
  )
    fail('backup_verification');
  const live = candidateRow(dbFile),
    backup = candidateRow(backupFile);
  for (const name of [
    'id',
    'mp_id',
    'source_url',
    'verified_source_url',
    'publish_time',
  ])
    if (live.row[name] !== backup.row[name]) fail('backup_seed_difference');
  const parserFile = path.join(
    root,
    'apps/server/dist/apps/server/src/collection/article-page.js',
  );
  const parser = require(parserFile),
    cheerio = createRequire(parserFile)('cheerio');
  if (
    typeof parser.articleIdentity !== 'function' ||
    typeof parser.articlePublishTime !== 'function' ||
    typeof parser.articleContentHtml !== 'function'
  )
    fail('parser_unavailable');
  const report = fs.readFileSync(
    path.join(root, 'docs/coordination/PUBLIC_PAGE_DISCOVERY.md'),
    'utf8',
  );
  if (
    !report.includes(DIGEST) ||
    !report.includes('单次 302') ||
    !report.includes('175910fb92f9e063') ||
    !report.includes('9beb4db841a9c11c')
  )
    fail('history_evidence');
  const privateRoot = path.join(root, 'private-data');
  const evidenceDir = path.join(privateRoot, 'public-page-probes');
  for (const existing of [privateRoot, evidenceDir]) {
    if (fs.existsSync(existing) && fs.lstatSync(existing).isSymbolicLink())
      fail('private_symlink');
  }
  const marker = path.join(evidenceDir, `short-${DIGEST}.attempted.json`);
  const evidence = path.join(evidenceDir, `short-${DIGEST}.evidence.json`);
  const htmlFile = path.join(evidenceDir, `short-${DIGEST}.html`);
  const legacyShortMarkers = [
    path.join(os.tmpdir(), `wewe-public-shortpath-${DIGEST}.attempted`),
    path.join(os.tmpdir(), `wewe-public-shortpath-album-${DIGEST}.attempted`),
  ];
  return {
    root,
    parser,
    cheerio,
    live,
    marker,
    evidence,
    htmlFile,
    attempted: [marker, evidence, htmlFile, ...legacyShortMarkers].some(
      (file) => fs.existsSync(file),
    ),
  };
}

// The Tencent page declares a JavaScript literal, not guaranteed strict JSON.
// Read only a small balanced array and literal string fields. Never evaluate it.
function balancedArray(source, start) {
  const stack = [],
    pairs = { ']': '[', '}': '{', ')': '(' };
  let quote = '',
    escape = false,
    lineComment = false,
    blockComment = false;
  for (let i = start; i < Math.min(source.length, start + 131072); i++) {
    const c = source[i],
      next = source[i + 1];
    if (lineComment) {
      if (c === '\n' || c === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (c === '`') return null;
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if ('[{('.includes(c)) stack.push(c);
    else if (Object.hasOwn(pairs, c)) {
      if (stack.pop() !== pairs[c]) return null;
      if (!stack.length) return source.slice(start, i + 1);
    }
  }
  return null;
}
function topLevelParts(source) {
  const parts = [],
    stack = [],
    pairs = { ']': '[', '}': '{', ')': '(' };
  let quote = '',
    escape = false,
    start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '`') return null;
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if ('[{('.includes(c)) stack.push(c);
    else if (Object.hasOwn(pairs, c)) {
      if (stack.pop() !== pairs[c]) return null;
    } else if (c === ',' && !stack.length) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote || stack.length) return null;
  const tail = source.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}
function staticJsString(expression) {
  const raw = expression.trim(),
    quote = raw[0];
  if (quote !== '"' && quote !== "'") return null;
  let output = '';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === quote) return raw.slice(i + 1).trim() ? null : output;
    if (c === '\n' || c === '\r') return null;
    if (c !== '\\') {
      output += c;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) return null;
    const simple = {
      '\\': '\\',
      '"': '"',
      "'": "'",
      '/': '/',
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
    };
    if (Object.hasOwn(simple, next)) {
      output += simple[next];
      continue;
    }
    if (next === 'x' || next === 'u') {
      const count = next === 'x' ? 2 : 4,
        hex = raw.slice(i + 1, i + 1 + count);
      if (!new RegExp(`^[a-fA-F0-9]{${count}}$`).test(hex)) return null;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      i += count;
      continue;
    }
    return null;
  }
  return null;
}
function articleAlbumTags(html) {
  const scripts = [
    ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi),
  ];
  const matches = scripts.flatMap((script) =>
    [...script[1].matchAll(/\bvar\s+album_info_list\s*=\s*\[/g)].map(
      (match) => ({
        source: script[1],
        start: match.index + match[0].lastIndexOf('['),
      }),
    ),
  );
  if (matches.length !== 1)
    return { state: matches.length ? 'ambiguous' : 'absent', ids: [] };
  const array = balancedArray(matches[0].source, matches[0].start);
  if (!array) return { state: 'malformed', ids: [] };
  const after = matches[0].source
    .slice(matches[0].start + array.length)
    .trimStart();
  if (!after.startsWith(';')) return { state: 'malformed', ids: [] };
  const ids = new Set(),
    entries = topLevelParts(array.slice(1, -1));
  if (!entries || entries.length > 32) return { state: 'malformed', ids: [] };
  for (const entry of entries) {
    if (!entry.startsWith('{') || !entry.endsWith('}'))
      return { state: 'malformed', ids: [] };
    const properties = topLevelParts(entry.slice(1, -1));
    if (!properties) return { state: 'malformed', ids: [] };
    const values = new Map();
    for (const property of properties) {
      const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]*)$/.exec(
        property,
      );
      if (!match) return { state: 'malformed', ids: [] };
      if (['link', 'albumId', 'albumIdStr'].includes(match[1])) {
        if (values.has(match[1])) return { state: 'malformed', ids: [] };
        values.set(match[1], staticJsString(match[2]));
      }
    }
    const id = values.get('albumId'),
      duplicate = values.get('albumIdStr');
    const rawLink = values.get('link');
    if (
      !/^\d{10,24}$/.test(id || '') ||
      duplicate !== id ||
      !rawLink ||
      rawLink.length > 8192
    )
      return { state: 'malformed', ids: [] };
    let link;
    try {
      link = new URL(rawLink.replace(/&amp;|&#38;|&#x26;/gi, '&'));
    } catch {
      return { state: 'malformed', ids: [] };
    }
    const q = link.searchParams;
    if (
      link.protocol !== 'https:' ||
      link.hostname !== 'mp.weixin.qq.com' ||
      link.pathname !== '/mp/appmsgalbum' ||
      link.port ||
      link.username ||
      link.password ||
      q.getAll('__biz').length !== 1 ||
      q.get('__biz') !== BIZ ||
      q.getAll('action').length !== 1 ||
      q.get('action') !== 'getalbum' ||
      q.getAll('album_id').length !== 1 ||
      q.get('album_id') !== id ||
      ['uin', 'key', 'pass_ticket', 'appmsg_token'].some((name) => q.has(name))
    )
      return { state: 'malformed', ids: [] };
    ids.add(id);
  }
  return {
    state: entries.length ? 'declared_article_album_tags' : 'empty',
    ids: [...ids].sort(),
  };
}
function analyze(html, seed) {
  const { parser, cheerio } = seed;
  const $ = cheerio.load(html),
    body = $('#js_content');
  if (body.length !== 1) return { result: 'body_node_stop' };
  let identity;
  try {
    identity = parser.articleIdentity(html);
  } catch {
    return { result: 'identity_parser_stop' };
  }
  let actual;
  try {
    actual = officialLong(identity.url);
  } catch {
    return { result: 'identity_url_stop' };
  }
  const expected = seed.live.verified.searchParams,
    observed = actual.searchParams;
  const fieldMatch = Object.fromEntries(
    FIELDS.map((name) => [name, observed.get(name) === expected.get(name)]),
  );
  let canonicalMatch = false;
  try {
    canonicalMatch =
      officialShort(identity.canonical).toString() ===
      seed.live.short.toString();
  } catch {
    /* malformed canonical */
  }
  const accountMatch = identity.mpId === MP_ID;
  const stage = { fieldMatch, accountMatch, canonicalMatch };
  if (
    !accountMatch ||
    !canonicalMatch ||
    Object.values(fieldMatch).some((value) => !value)
  )
    return { result: 'identity_mismatch_stop', ...stage };
  let parsedCt;
  try {
    parsedCt = parser.articlePublishTime(html);
  } catch {
    return { result: 'publish_parser_stop', ...stage };
  }
  const literalCt = html.match(/\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/);
  const originalCtMatch = Boolean(
    literalCt &&
    parsedCt === Number(literalCt[1]) &&
    parsedCt === identity.publishTime &&
    parsedCt === seed.live.row.publish_time,
  );
  if (!originalCtMatch)
    return {
      result: 'original_ct_stop',
      ...stage,
      originalCtPresent: Boolean(literalCt),
      originalCtMatch: false,
    };
  const imageCount = body.find('img').length;
  const imageDataSrcCount = body
    .find('img')
    .filter((_, el) => Boolean($(el).attr('data-src'))).length;
  let content;
  try {
    content = parser.articleContentHtml(html);
  } catch {
    return { result: 'body_parser_stop', ...stage };
  }
  if (!content) return { result: 'body_content_stop', ...stage };
  const albums = articleAlbumTags(html);
  return {
    result: 'identity_ct_body_pass',
    ...stage,
    originalCtPresent: true,
    originalCtMatch: true,
    bodyPresent: true,
    imageCount,
    imageDataSrcCount,
    albumTagState: albums.state,
    albumIds: albums.ids,
  };
}
function atomicNoReplace(file, bytes) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, file); // Atomic no-overwrite create, also on Windows.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* private path never logged */
    }
  }
}
function writeMarker(file) {
  atomicNoReplace(
    file,
    Buffer.from(
      `${JSON.stringify({
        articleDigest: DIGEST,
        requestShape: 'GET https://mp.weixin.qq.com/s/<stored-token>',
        attemptedUtc: new Date().toISOString(),
      })}\n`,
    ),
  );
}
function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.request(
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
      (response) => {
        const status = response.statusCode || 0;
        if (status !== 200) {
          response.destroy();
          done(null, { status });
          return;
        }
        if (
          !/^text\/html\b/i.test(
            String(response.headers['content-type'] || ''),
          ) ||
          !['', 'identity'].includes(
            String(response.headers['content-encoding'] || ''),
          ) ||
          Number(response.headers['content-length'] || 0) > MAX_BYTES
        ) {
          response.destroy();
          done(null, { status, formatStop: true });
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            done(null, { status, sizeStop: true });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          done(null, { status, html: Buffer.concat(chunks).toString('utf8') }),
        );
        response.on('error', () => done(new Error('response_error')));
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) =>
      done(
        new Error(error.message === 'timeout' ? 'timeout' : 'network_error'),
      ),
    );
    request.end();
  });
}
async function runOnce(seed, fetcher, store) {
  if (
    seed.attempted ||
    [store.marker, store.evidence, store.htmlFile].some(fs.existsSync)
  )
    return { result: 'already_attempted_stop', requests: 0 };
  try {
    writeMarker(store.marker);
  } catch {
    return { result: 'marker_stop', requests: 0 };
  }
  let response;
  try {
    response = await fetcher(seed.live.short);
  } catch (error) {
    return {
      result: error.message === 'timeout' ? 'timeout_stop' : 'network_stop',
      requests: 1,
    };
  }
  const base = { requests: 1, httpStatus: response.status || 0 };
  if (response.status !== 200)
    return {
      ...base,
      result:
        response.status >= 300 && response.status < 400
          ? 'redirect_stop'
          : 'http_stop',
    };
  if (
    response.formatStop ||
    response.sizeStop ||
    typeof response.html !== 'string' ||
    Buffer.byteLength(response.html) > MAX_BYTES
  )
    return { ...base, result: 'response_format_or_limit_stop' };
  if (
    /wappoc_appmsgcaptcha|appmsgcaptcha|请输入验证码|为了你的帐号安全|访问过于频繁|环境异常|安全验证|操作频繁/.test(
      response.html,
    )
  )
    return { ...base, result: 'verification_or_limit_stop' };
  const htmlBytes = Buffer.from(response.html);
  try {
    atomicNoReplace(store.htmlFile, htmlBytes);
  } catch {
    return { ...base, result: 'private_html_save_stop' };
  }
  const stored = {
    ...base,
    privateHtmlSaved: true,
    privateHtmlPath: store.htmlFile,
  };
  let finding;
  try {
    finding = analyze(response.html, seed);
  } catch {
    return { ...stored, result: 'page_parse_stop' };
  }
  const { result, albumIds = [], ...details } = finding;
  if (result !== 'identity_ct_body_pass')
    return { ...stored, result, ...details };
  const publicFinding = {
    ...stored,
    result,
    ...details,
    declaredAlbumCount: albumIds.length,
    knownOldTwoCount: albumIds.filter((id) => OLD_TWO_ALBUMS.has(id)).length,
    otherAlbumCount: albumIds.filter((id) => !OLD_TWO_ALBUMS.has(id)).length,
  };
  const privateFinding = {
    articleDigest: DIGEST,
    observedUtc: new Date().toISOString(),
    source: 'official_public_short_article',
    accountBiz: BIZ,
    fieldsMatch: details.fieldMatch,
    originalCtMatch: details.originalCtMatch,
    imageCount: details.imageCount,
    imageDataSrcCount: details.imageDataSrcCount,
    albumTagState: details.albumTagState,
    albumIds,
    htmlSha256: sha256(htmlBytes),
  };
  try {
    atomicNoReplace(
      store.evidence,
      Buffer.from(`${JSON.stringify(privateFinding)}\n`),
    );
  } catch {
    return { ...publicFinding, result: 'private_save_stop' };
  }
  return {
    ...publicFinding,
    privateEvidenceSaved: true,
    privateEvidencePath: store.evidence,
  };
}
function fakePage(seed, { mismatch = false, captcha = false } = {}) {
  const q = seed.live.verified.searchParams;
  const album = '1'.repeat(12);
  const link = `https://mp.weixin.qq.com/mp/appmsgalbum?__biz=${BIZ}&amp;action=getalbum&amp;album_id=${album}`;
  return `<html><head><meta property="og:url" content="${seed.live.short}"></head><body>
    <div id="js_content"><p>Saved article body</p><img data-src="https://mmbiz.qpic.cn/example"></div>
    <script>var biz="${BIZ}";var mid="${mismatch ? '9999999999' : q.get('mid')}";
    var idx="${q.get('idx')}";var sn="${q.get('sn')}";var ct="${seed.live.row.publish_time}";
    var album_info_list=[{albumId:"${album}",albumIdStr:"${album}",link:"${link}"}];</script>
    ${captcha ? 'appmsgcaptcha' : ''}</body></html>`;
}
async function selftest(seed) {
  const names = [],
    outcomes = [];
  const makeStore = () => {
    const prefix = path.join(
      os.tmpdir(),
      `wewe-short-fake-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    );
    const store = {
      marker: `${prefix}.attempted`,
      htmlFile: `${prefix}.html`,
      evidence: `${prefix}.json`,
    };
    names.push(...Object.values(store));
    return store;
  };
  try {
    for (const [label, reply, expected] of [
      ['redirect', { status: 302 }, 'redirect_stop'],
      [
        'format',
        { status: 200, formatStop: true },
        'response_format_or_limit_stop',
      ],
      [
        'captcha',
        { status: 200, html: fakePage(seed, { captcha: true }) },
        'verification_or_limit_stop',
      ],
      [
        'mismatch',
        { status: 200, html: fakePage(seed, { mismatch: true }) },
        'identity_mismatch_stop',
      ],
      [
        'parser_stop',
        { status: 200, html: '<html><body>plain page</body></html>' },
        'body_node_stop',
      ],
      [
        'success',
        { status: 200, html: fakePage(seed) },
        'identity_ct_body_pass',
      ],
    ]) {
      const store = makeStore();
      let calls = 0;
      const result = await runOnce(
        { ...seed, attempted: false },
        async () => {
          if (!fs.existsSync(store.marker)) fail('fake_marker_order');
          calls++;
          return reply;
        },
        store,
      );
      const shouldSaveHtml = ['mismatch', 'parser_stop', 'success'].includes(
        label,
      );
      if (
        calls !== 1 ||
        result.requests !== 1 ||
        result.result !== expected ||
        !fs.existsSync(store.marker) ||
        fs.existsSync(store.htmlFile) !== shouldSaveHtml ||
        fs.existsSync(store.evidence) !== (label === 'success') ||
        (shouldSaveHtml &&
          (result.privateHtmlSaved !== true ||
            result.privateHtmlPath !== store.htmlFile ||
            fs.readFileSync(store.htmlFile, 'utf8') !== reply.html))
      )
        fail('fake_network_case');
      const repeated = await runOnce(
        { ...seed, attempted: false },
        async () => {
          calls++;
          return reply;
        },
        store,
      );
      if (repeated.requests !== 0 || calls !== 1) fail('fake_repeat_gate');
      outcomes.push(label);
    }
    const networkStore = makeStore();
    let networkCalls = 0;
    const network = await runOnce(
      { ...seed, attempted: false },
      async () => {
        networkCalls++;
        throw new Error('network_error');
      },
      networkStore,
    );
    if (
      network.result !== 'network_stop' ||
      network.requests !== 1 ||
      networkCalls !== 1 ||
      !fs.existsSync(networkStore.marker)
    )
      fail('fake_network_failure_gate');
    outcomes.push('network_failure');
    const blocked = makeStore();
    atomicNoReplace(blocked.evidence, Buffer.from('{}'));
    const result = await runOnce(
      { ...seed, attempted: false },
      async () => {
        fail('fake_unexpected_request');
      },
      blocked,
    );
    if (result.requests !== 0 || fs.existsSync(blocked.marker))
      fail('fake_existing_evidence_gate');
    const saveFailure = makeStore();
    saveFailure.htmlFile = path.join(
      os.tmpdir(),
      `wewe-short-fake-missing-${crypto.randomBytes(8).toString('hex')}`,
      'page.html',
    );
    let saveFailureCalls = 0;
    const failedSave = await runOnce(
      { ...seed, attempted: false },
      async () => {
        saveFailureCalls++;
        return { status: 200, html: fakePage(seed) };
      },
      saveFailure,
    );
    if (
      failedSave.result !== 'private_html_save_stop' ||
      failedSave.requests !== 1 ||
      saveFailureCalls !== 1 ||
      !fs.existsSync(saveFailure.marker) ||
      fs.existsSync(saveFailure.evidence)
    )
      fail('fake_private_save_failure');
    outcomes.push('private_save_failure');
    const invalid = articleAlbumTags(
      '<script>var album_info_list=[{albumId:process.exit()}]</script>',
    );
    const dynamic = articleAlbumTags(
      '<script>var album_info_list=[{albumId:"123456789012"+evil}]</script>',
    );
    const duplicate = articleAlbumTags(
      '<script>var album_info_list=[{albumId:"123456789012",albumId:"123456789012"}]</script>',
    );
    const transformed = articleAlbumTags(
      '<script>var album_info_list=[] .map(()=>evil);</script>',
    );
    if (
      [invalid, dynamic, duplicate, transformed].some(
        (item) => item.state !== 'malformed',
      )
    )
      fail('fake_album_parser');
    return outcomes;
  } finally {
    for (const file of names)
      try {
        fs.unlinkSync(file);
      } catch {
        /* synthetic only */
      }
  }
}
async function main() {
  let seed;
  try {
    seed = loadSeed(path.resolve(rootArgument || '.'));
  } catch (error) {
    const safe = new Set([
      'arguments',
      'private_ignore',
      'db_integrity',
      'candidate_uniqueness',
      'saved_identity',
      'backup_verification',
      'backup_seed_difference',
      'parser_unavailable',
      'history_evidence',
      'private_symlink',
      'long_url_shape',
      'short_url_shape',
    ]);
    safeResult(
      'preflight_stop',
      { reason: safe.has(error.message) ? error.message : 'local_read_error' },
      true,
    );
    return;
  }
  if (mode === 'preflight') {
    safeResult('preflight_pass', {
      digest: DIGEST,
      requestPathShape: '/s/<stored-token>',
      savedUtcDate: '2026-09-28',
      backupVerified: true,
      shortShapePrivateMarkerExists: seed.attempted,
      historicalShortVisit: 'not_proven_by_absent_marker',
      thirdAlbumMembership: 'unverified',
      networkRequests: 0,
    });
    return;
  }
  if (mode === 'selftest') {
    try {
      safeResult('selftest_pass', {
        cases: await selftest(seed),
        networkRequests: 0,
      });
    } catch {
      safeResult(
        'selftest_stop',
        { reason: 'fake_network_or_atomic_test' },
        true,
      );
    }
    return;
  }
  if (reviewFlag !== REVIEW_FLAG || seed.attempted) {
    safeResult('review_or_attempt_gate_stop', {}, true);
    return;
  }
  const privateRoot = path.join(seed.root, 'private-data');
  const evidenceDir = path.join(privateRoot, 'public-page-probes');
  try {
    fs.mkdirSync(privateRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      safeResult('private_dir_stop', {}, true);
      return;
    }
  }
  let privateRootValid = false;
  try {
    const stat = fs.lstatSync(privateRoot);
    privateRootValid = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    /* fail closed */
  }
  if (!privateRootValid) {
    safeResult('private_dir_stop', {}, true);
    return;
  }
  try {
    fs.mkdirSync(evidenceDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      safeResult('private_dir_stop', {}, true);
      return;
    }
  }
  let evidenceDirValid = false;
  try {
    const stat = fs.lstatSync(evidenceDir);
    evidenceDirValid = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    /* fail closed */
  }
  if (!evidenceDirValid) {
    safeResult('private_dir_stop', {}, true);
    return;
  }
  const result = await runOnce(seed, fetchOnce, seed);
  const success = result.result === 'identity_ct_body_pass';
  safeResult(
    result.result,
    { ...result, digest: DIGEST, thirdAlbumMembership: 'unverified' },
    !success &&
      ![
        'redirect_stop',
        'verification_or_limit_stop',
        'http_stop',
        'identity_mismatch_stop',
        'original_ct_stop',
      ].includes(result.result),
  );
}
main();
