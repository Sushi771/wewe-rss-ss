// One anonymous, bounded GET of a uniquely identified public article.
// Only sanitized summaries leave this process. The response stays in memory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const TARGET_MP_ID = 'MP_WXS_3895431412';
const SEED_DIGEST = '5e44e0d46c308fe2';
const SEED_DAY = '2026-09-28';
const KNOWN_ALBUMS = new Set(['2527940920407949313', '3588220544052641807']);
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 12000;

function digest(q) {
  return crypto
    .createHash('sha256')
    .update(['__biz', 'mid', 'idx', 'sn'].map((k) => q.get(k) || '').join('\0'))
    .digest('hex')
    .slice(0, 16);
}

function officialSeed(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== 'https:' ||
    u.hostname !== 'mp.weixin.qq.com' ||
    u.pathname !== '/s' ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    [...u.searchParams.keys()].length !== 4 ||
    [...u.searchParams.keys()].some(
      (k) => !['__biz', 'mid', 'idx', 'sn'].includes(k),
    ) ||
    ['__biz', 'mid', 'idx', 'sn'].some(
      (k) => u.searchParams.getAll(k).length !== 1,
    ) ||
    u.searchParams.get('__biz') !== TARGET_BIZ ||
    !/^\d+$/.test(u.searchParams.get('mid') || '') ||
    !/^[1-9]\d*$/.test(u.searchParams.get('idx') || '') ||
    !/^[a-fA-F0-9]{16,64}$/.test(u.searchParams.get('sn') || '') ||
    digest(u.searchParams) !== SEED_DIGEST
  )
    throw new Error('seed_gate');
  return u;
}

function loadSeed(dbPath) {
  if (!path.isAbsolute(dbPath) || !fs.statSync(dbPath).isFile())
    throw new Error('db_gate');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const rows = db
      .prepare(
        'SELECT mp_id, verified_source_url, publish_time FROM articles WHERE mp_id = ? AND verified_source_url IS NOT NULL',
      )
      .all(TARGET_MP_ID);
    const matches = [];
    for (const row of rows) {
      try {
        const u = officialSeed(row.verified_source_url);
        matches.push({ url: u, publishTime: Number(row.publish_time) });
      } catch {
        /* Other old rows are not the requested seed. */
      }
    }
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].publishTime) ||
      new Date(matches[0].publishTime * 1000).toISOString().slice(0, 10) !==
        SEED_DAY
    )
      throw new Error('unique_seed_gate');
    return matches[0];
  } finally {
    db.close();
  }
}

function receiptPaths() {
  return [
    'wewe-public-article-',
    'wewe-public-reference-',
    'wewe-verified-seed-',
  ].map((prefix) =>
    path.join(os.tmpdir(), `${prefix}${SEED_DIGEST}.attempted`),
  );
}

function scalar(script, name, pattern, type = 'var') {
  const expression =
    type === 'var'
      ? new RegExp(`\\bvar\\s+${name}\\s*=\\s*["'](${pattern})["']`, 'g')
      : new RegExp(
          `(?:^|[,{])\\s*(?:["']${name}["']|${name})\\s*:\\s*["'](${pattern})["']`,
          'g',
        );
  const values = [...script.matchAll(expression)].map((m) => m[1]);
  return values.length === 1 ? values[0] : undefined;
}

function balanced(text, marker, open, close) {
  const at = text.search(marker);
  if (at < 0) return null;
  const start = text.indexOf(open, at);
  if (start < 0 || start - at > 120) return null;
  const limit = Math.min(text.length, start + 1_000_000);
  let depth = 0,
    quote = '',
    escaped = false,
    line = false,
    block = false;
  for (let i = start; i < limit; i++) {
    const c = text[i],
      next = text[i + 1];
    if (line) {
      if (c === '\n' || c === '\r') line = false;
      continue;
    }
    if (block) {
      if (c === '*' && next === '/') {
        block = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '/') {
      line = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      block = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function albumCounts(scripts) {
  const sections = scripts.flatMap((s) =>
    [
      balanced(s, /\balbum_info_list\s*[:=]/, '[', ']'),
      balanced(s, /\bappmsgalbuminfo\s*[:=]/, '{', '}'),
    ].filter(Boolean),
  );
  const ids = new Set();
  for (const section of sections) {
    for (const match of section.matchAll(
      /(?:["']?link["']?)\s*:\s*["']([^"']{1,4096})["']/g,
    )) {
      const raw = match[1]
        .replace(/\\\//g, '/')
        .replace(/\\u0026|\\x26|&amp;/gi, '&');
      let u;
      try {
        u = new URL(raw, 'https://mp.weixin.qq.com');
      } catch {
        continue;
      }
      if (
        u.protocol === 'https:' &&
        u.hostname === 'mp.weixin.qq.com' &&
        !u.port &&
        !u.username &&
        !u.password &&
        u.pathname === '/mp/appmsgalbum' &&
        u.searchParams.getAll('__biz').length === 1 &&
        u.searchParams.get('__biz') === TARGET_BIZ &&
        u.searchParams.getAll('album_id').length === 1 &&
        /^\d{10,24}$/.test(u.searchParams.get('album_id') || '')
      )
        ids.add(u.searchParams.get('album_id'));
    }
  }
  return {
    albumSectionCount: sections.length,
    sameAccountAlbumCount: ids.size,
    knownAlbumCount: [...ids].filter((id) => KNOWN_ALBUMS.has(id)).length,
    newAlbumCount: [...ids].filter((id) => !KNOWN_ALBUMS.has(id)).length,
  };
}

function inspect(html, seed, parserPath) {
  const cheerio = createRequire(path.resolve(parserPath))('cheerio');
  const $ = cheerio.load(html);
  const body = $('#js_content').first();
  const result = {
    http: 200,
    html: true,
    bodyNodePresent: body.length === 1,
    verificationDetected: false,
  };
  if (
    /<title[^>]*>[^<]*(?:请完成验证|访问过于频繁|安全验证|环境异常)[^<]*<\/title>|<(?:div|form)[^>]*(?:id|class)=["'][^"']*(?:captcha|verify-page)[^"']*["']/i.test(
      html,
    )
  ) {
    result.verificationDetected = true;
    result.stop = 'verification';
    return result;
  }
  if (!result.bodyNodePresent) {
    result.verificationDetected =
      /验证码|请完成验证|访问过于频繁|captcha|verify\.html|环境异常/i.test(
        html,
      );
    result.stop = result.verificationDetected ? 'verification' : 'body_absent';
    return result;
  }
  const scripts = $('script')
    .toArray()
    .map((el) => $(el).html() || '')
    .filter((s) => s.length <= 1_000_000);
  const modern = scripts
    .map((s) => balanced(s, /\bwindow\.cgiDataNew\s*=\s*\{/, '{', '}'))
    .filter(Boolean);
  const expected = seed.url.searchParams;
  const fields = [
    ['biz', '__biz', '[A-Za-z0-9+/=]+', 'bizuin'],
    ['mid', 'mid', '\\d+', 'mid'],
    ['idx', 'idx', '\\d+', 'idx'],
    ['sn', 'sn', '[a-fA-F0-9]+', 'sn'],
  ];
  const legacyFields = {},
    modernFields = {};
  let closed = true;
  for (const [legacyName, queryName, pattern, modernName] of fields) {
    const oldValues = scripts
      .map((s) => scalar(s, legacyName, pattern))
      .filter(Boolean);
    const newValues = modern
      .map((s) => scalar(s, modernName, pattern, 'object'))
      .filter(Boolean);
    const old = oldValues.length === 1 ? oldValues[0] : undefined;
    const fresh = newValues.length === 1 ? newValues[0] : undefined;
    legacyFields[queryName] = {
      present: Boolean(old),
      matches: old ? old === expected.get(queryName) : null,
    };
    modernFields[queryName] = {
      present: Boolean(fresh),
      matches: fresh ? fresh === expected.get(queryName) : null,
    };
    if (
      (!old && !fresh) ||
      (old && old !== expected.get(queryName)) ||
      (fresh && fresh !== expected.get(queryName))
    )
      closed = false;
  }
  result.legacyFields = legacyFields;
  result.modernFields = modernFields;
  result.identityClosed = closed;
  if (!closed) {
    result.stop = 'identity_unclosed';
    return result;
  }
  const ctValues = scripts
    .map((s) => scalar(s, 'ct', '\\d{10}'))
    .filter(Boolean);
  const rawCt = ctValues.length === 1 ? Number(ctValues[0]) : null;
  const modernTimes = modern.flatMap((s) =>
    ['ori_create_time', 'ori_send_time', 'create_timestamp']
      .map((name) => scalar(s, name, '\\d{10}', 'object'))
      .filter(Boolean)
      .map(Number),
  );
  const validCt =
    rawCt !== null && rawCt >= 946684800 && rawCt <= Date.now() / 1000 + 300;
  const modernConsistent = modernTimes.every((t) => t === rawCt);
  result.originalCtPresent = rawCt !== null;
  result.originalCtPlausible = validCt;
  result.originalCtMatchesDb = validCt ? rawCt === seed.publishTime : null;
  result.modernTimeConsistent = modernConsistent;
  result.timeClosed = validCt && modernConsistent;
  if (!result.timeClosed) {
    result.stop = 'time_unclosed';
    return result;
  }
  const images = body.find('img');
  result.bodyNonempty = Boolean(body.text().trim() || images.length);
  result.imageCount = images.length;
  result.dataSrcImageCount = images.filter((_, el) =>
    Boolean($(el).attr('data-src')),
  ).length;
  result.srcImageCount = images.filter((_, el) =>
    Boolean($(el).attr('src')),
  ).length;
  if (!result.bodyNonempty) {
    result.stop = 'body_empty';
    return result;
  }
  Object.assign(result, albumCounts(scripts));
  result.stop = null;
  return result;
}

function requestOnce(seed) {
  return new Promise((resolve) => {
    let done = false;
    let req;
    const deadline = setTimeout(() => {
      req?.destroy();
      finish({ stop: 'timeout' });
    }, TIMEOUT_MS);
    const finish = (value) => {
      if (!done) {
        done = true;
        clearTimeout(deadline);
        resolve(value);
      }
    };
    req = https.request(
      seed.url,
      {
        method: 'GET',
        timeout: TIMEOUT_MS,
        agent: false,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          res.destroy();
          finish({
            http: status,
            stop: status >= 300 && status < 400 ? 'redirect' : 'http_status',
          });
          return;
        }
        if (!/^text\/html\b/i.test(String(res.headers['content-type'] || ''))) {
          res.destroy();
          finish({ http: status, stop: 'content_type' });
          return;
        }
        if (
          res.headers['content-encoding'] &&
          res.headers['content-encoding'] !== 'identity'
        ) {
          res.destroy();
          finish({ http: status, stop: 'content_encoding' });
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            res.destroy();
            finish({ http: status, stop: 'response_size' });
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          finish({
            http: status,
            html: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () => finish({ http: status, stop: 'transport' }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ stop: 'timeout' });
    });
    req.on('error', () => finish({ stop: 'transport' }));
    req.end();
  });
}

function selfTest(parserPath) {
  const q = new URLSearchParams({
    __biz: TARGET_BIZ,
    mid: '123',
    idx: '1',
    sn: 'a'.repeat(32),
  });
  const fake = {
    url: new URL(`https://mp.weixin.qq.com/s?${q}`),
    publishTime: 1780000000,
  };
  const html = `<div id="js_content"><img data-src="https://mmbiz.qpic.cn/x"></div><script>var biz="${TARGET_BIZ}";var mid="123";var idx="1";var sn="${'a'.repeat(32)}";var ct="1780000000";window.cgiDataNew={bizuin:"${TARGET_BIZ}",mid:"123",idx:"1",sn:"${'a'.repeat(32)}",ori_create_time:"1780000000"};var album_info_list=[{link:"https://mp.weixin.qq.com/mp/appmsgalbum?__biz=${encodeURIComponent(TARGET_BIZ)}&album_id=3588220544052641807"},{link:"https://evil.example/mp/appmsgalbum?__biz=${TARGET_BIZ}&album_id=1234567890"}];</script>`;
  const ok = inspect(html, fake, parserPath);
  const mismatch = inspect(
    html.replace('var mid="123"', 'var mid="999"'),
    fake,
    parserPath,
  );
  const challenge = inspect('<html>请完成验证</html>', fake, parserPath);
  if (
    !ok.identityClosed ||
    !ok.timeClosed ||
    ok.knownAlbumCount !== 1 ||
    ok.newAlbumCount !== 0 ||
    ok.imageCount !== 1 ||
    mismatch.stop !== 'identity_unclosed' ||
    challenge.stop !== 'verification' ||
    !/^https:\/\/mp\.weixin\.qq\.com\/s\?/.test(fake.url.toString())
  )
    throw new Error('self_test');
  return {
    result: 'self_test_passed',
    sqliteReads: 0,
    networkRequests: 0,
    cases: 3,
  };
}

async function main() {
  const [mode, dbPath, parserPath, reviewed] = process.argv.slice(2);
  if (mode === '--plan')
    return {
      mode: 'plan',
      sqliteReads: 0,
      networkRequests: 0,
      executeMaximumRequests: 1,
      timeoutMs: TIMEOUT_MS,
      responseLimitBytes: MAX_BYTES,
      credentialSource: 'none',
      responseStorage: 'memory_only',
      redirects: false,
      retries: false,
    };
  if (mode === '--self-test') {
    if (!dbPath || !path.isAbsolute(dbPath)) throw new Error('parser_gate');
    return selfTest(dbPath);
  }
  if (
    !['--preflight', '--execute'].includes(mode) ||
    !dbPath ||
    !parserPath ||
    !path.isAbsolute(parserPath) ||
    !fs.statSync(parserPath).isFile()
  )
    throw new Error('arguments');
  if (process.env.NODE_USE_ENV_PROXY === '1') throw new Error('proxy_gate');
  const seed = loadSeed(dbPath);
  const attempted = receiptPaths().some((p) => fs.existsSync(p));
  const preflight = {
    mode: mode.slice(2),
    uniqueSeed: true,
    targetAccount: true,
    seedUtcDayMatchesExpected: true,
    priorAttemptMarkerPresent: attempted,
    requestMaximum: mode === '--execute' ? 1 : 0,
  };
  if (mode === '--preflight') return preflight;
  if (reviewed !== '--reviewed' || attempted) throw new Error('execution_gate');
  // Create before request; even a transport failure must not invite a replay.
  const fd = fs.openSync(receiptPaths()[2], 'wx');
  try {
    fs.writeSync(fd, `${new Date().toISOString()}\n`);
  } finally {
    fs.closeSync(fd);
  }
  const response = await requestOnce(seed);
  if (typeof response.html !== 'string')
    return { mode: 'execute', requestCount: 1, ...response };
  return {
    mode: 'execute',
    requestCount: 1,
    ...inspect(response.html, seed, parserPath),
  };
}

main()
  .then((value) => console.log(JSON.stringify(value)))
  .catch((error) => {
    // Never expose exception text, stack, DB path, URL, response, or credentials.
    const allowed = new Set([
      'seed_gate',
      'db_gate',
      'unique_seed_gate',
      'parser_gate',
      'arguments',
      'proxy_gate',
      'execution_gate',
      'self_test',
    ]);
    console.log(
      JSON.stringify({
        result: 'stopped',
        reason: allowed.has(error.message) ? error.message : 'local_failure',
      }),
    );
    process.exitCode = 1;
  });
