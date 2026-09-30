#!/usr/bin/env node
'use strict';

// Calibrate one public Sogou mobile search card against a known old article.
// Production SQLite is read-only; no WeChat article URL is requested or saved.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const ORIGIN = 'https://weixin.sogou.com';
const SEARCH = `${ORIGIN}/weixinwap`;
const SEED_DIGEST = '7cdccf28c3b4d8e656dc';
const PRIVATE_DIR = path.join(
  os.homedir(),
  '.wewe-rss-private',
  'sogou-mobile-link-calibration',
);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const SEARCH_LIMIT = 128 * 1024;
const LINK_LIMIT = 64 * 1024;
const CHALLENGE_PATH = /antispider|captcha|verify|seccode|approve/i;
const CHALLENGE_TEXT =
  /验证码|安全验证|人机验证|访问过于频繁|操作频繁|captcha|antispider/i;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cli(argv) {
  if (
    argv.length !== 3 ||
    !['--preflight', '--self-test', '--run'].includes(argv[0]) ||
    argv[1] !== '--root' ||
    !path.isAbsolute(argv[2])
  ) {
    throw new Error(
      'Usage: node probe-sogou-mobile-link-calibration.cjs --preflight|--self-test|--run --root <absolute-main-workspace>',
    );
  }
  return { mode: argv[0], root: path.resolve(argv[2]) };
}

function cheerioFromRoot(root) {
  const serverManifest = path.join(root, 'apps/server/package.json');
  return createRequire(serverManifest)('cheerio');
}

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function officialIdentity(raw) {
  const url = new URL(raw);
  const query = url.searchParams;
  const fields = ['__biz', 'mid', 'idx', 'sn'];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.pathname !== '/s' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    fields.some((key) => query.getAll(key).length !== 1) ||
    !/^[A-Za-z0-9+/]+=*$/.test(query.get('__biz') || '') ||
    !/^\d{8,15}$/.test(query.get('mid') || '') ||
    !/^[1-9]\d*$/.test(query.get('idx') || '') ||
    !/^[a-fA-F0-9]{16,64}$/.test(query.get('sn') || '')
  ) {
    throw new Error('seed-official-identity');
  }
  return fields.map((key) => query.get(key));
}

function loadSeed(root) {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(root, 'apps/server/data/wewe-rss.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    db.exec('PRAGMA query_only=ON');
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok')
      throw new Error('db-integrity');
    rows = db
      .prepare(
        `SELECT a.id, a.title, a.verified_source_url, a.publish_time,
                a.mp_id, f.mp_name
         FROM articles a JOIN feeds f ON f.id = a.mp_id
         WHERE a.verified_source_url IS NOT NULL
           AND a.content_html IS NOT NULL AND length(a.content_html)>0`,
      )
      .all();
  } finally {
    db.close();
  }
  const matches = rows.filter(
    (row) =>
      hash(`${row.id}\0${row.title}\0${row.verified_source_url}`).slice(
        0,
        20,
      ) === SEED_DIGEST,
  );
  if (matches.length !== 1) throw new Error('seed-uniqueness');
  const row = matches[0];
  const identity = officialIdentity(row.verified_source_url);
  if (
    !normalize(row.title) ||
    !normalize(row.mp_name) ||
    normalize(row.title) === normalize(row.mp_name) ||
    row.title.length > 100 ||
    row.mp_name.length > 100 ||
    !Number.isSafeInteger(row.publish_time) ||
    row.publish_time <= 0 ||
    /[\u0000-\u001f\u007f]/u.test(row.title + row.mp_name)
  ) {
    throw new Error('seed-fields');
  }
  return {
    title: row.title,
    accountName: row.mp_name,
    identity,
    queryHash: hash(row.title).slice(0, 20),
    publishedMonth: new Date(row.publish_time * 1000).toISOString().slice(0, 7),
  };
}

function searchUrl(title) {
  const url = new URL(SEARCH);
  url.searchParams.set('type', '2');
  url.searchParams.set('query', title);
  return url;
}

function targetShape(raw, base) {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return { host: url.hostname, path: pathShape(url.pathname) };
  } catch {
    return { malformed: true };
  }
}

function pathShape(pathname) {
  if (pathname === '/s' || pathname === '/link') return pathname;
  if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(pathname)) return '/s/<token>';
  if (CHALLENGE_PATH.test(pathname)) return '/challenge';
  return '/other';
}

function contentText(body, header) {
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(
    header || '',
  )?.[1];
  return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(body);
}

function isChallenge($, html, redirect) {
  if (redirect?.path === '/challenge') return true;
  if (
    $('form[name="authform"], #seccodeInput, #verifycode, img[src*="captcha"]')
      .length
  )
    return true;
  return (
    CHALLENGE_TEXT.test($('title').text()) ||
    ($('li[id^="sogou_vr_"]').length === 0 &&
      CHALLENGE_TEXT.test(html.slice(0, 12000)))
  );
}

function cookiesForLink(setCookie, now = Date.now()) {
  if (!Array.isArray(setCookie)) return '';
  const jar = new Map();
  for (const header of setCookie) {
    if (typeof header !== 'string') continue;
    const parts = header.split(';').map((part) => part.trim());
    const pair = parts.shift() || '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (
      separator <= 0 ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      /[\r\n;]/.test(value)
    )
      continue;
    let domain = 'weixin.sogou.com';
    let cookiePath = '/';
    let expired = false;
    for (const part of parts) {
      const [key, ...rest] = part.split('=');
      const attribute = key.toLowerCase();
      const attrValue = rest.join('=').trim();
      if (attribute === 'domain')
        domain = attrValue.replace(/^\./, '').toLowerCase();
      if (attribute === 'path') cookiePath = attrValue;
      if (attribute === 'max-age' && /^-?\d+$/.test(attrValue))
        expired = Number(attrValue) <= 0;
      if (attribute === 'expires' && Date.parse(attrValue) <= now)
        expired = true;
    }
    if (
      !expired &&
      (domain === 'weixin.sogou.com' || domain === 'sogou.com') &&
      cookiePath.startsWith('/') &&
      ('/link' === cookiePath ||
        '/link'.startsWith(`${cookiePath.replace(/\/$/, '')}/`))
    )
      jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function matchingLink(html, seed, cheerio) {
  const $ = cheerio.load(html);
  const cards = $('li[id^="sogou_vr_"]');
  if (isChallenge($, html, null)) return { state: 'verification-stop' };
  const matches = cards.toArray().filter((card) => {
    const item = $(card);
    return (
      normalize(item.find('h4 a').first().text()) === normalize(seed.title) &&
      normalize(item.find('span.s2').first().text()) ===
        normalize(seed.accountName)
    );
  });
  if (matches.length !== 1)
    return {
      state: 'card-mismatch-stop',
      cardCount: cards.length,
      exactMatches: matches.length,
    };
  const href = $(matches[0]).find('h4 a').first().attr('href');
  let link;
  try {
    link = new URL(href, ORIGIN);
  } catch {
    return { state: 'link-shape-stop', cardCount: cards.length };
  }
  const query = link.searchParams;
  if (
    link.origin !== ORIGIN ||
    link.pathname !== '/link' ||
    link.hash ||
    link.username ||
    link.password ||
    link.port ||
    [...query.keys()].sort().join(',') !== 'query,token,type,url' ||
    query.get('type') !== '2' ||
    normalize(query.get('query')) !== normalize(seed.title) ||
    !query.get('url') ||
    !query.get('token')
  ) {
    return { state: 'link-shape-stop', cardCount: cards.length };
  }
  return { state: 'matched', cardCount: cards.length, exactMatches: 1, link };
}

function officialUrlShape(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { complete: false };
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    return { complete: false };
  if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname) && !url.search)
    return {
      complete: true,
      form: 'short',
      host: url.hostname,
      path: '/s/<token>',
    };
  if (url.pathname !== '/s') return { complete: false };
  const q = url.searchParams;
  if (
    ['__biz', 'mid', 'idx', 'sn'].every((key) =>
      Boolean(q.get(key) && q.getAll(key).length === 1),
    )
  )
    return {
      complete: true,
      form: 'four-field',
      host: url.hostname,
      path: url.pathname,
    };
  if (
    ['src', 'timestamp', 'signature'].every((key) =>
      Boolean(q.get(key) && q.getAll(key).length === 1),
    )
  )
    return {
      complete: true,
      form: 'signed',
      host: url.hostname,
      path: url.pathname,
    };
  return { complete: false, host: url.hostname, path: pathShape(url.pathname) };
}

function linkDestination(status, headers, html, cheerio) {
  const redirect = targetShape(headers.location, ORIGIN);
  const $ = cheerio.load(html);
  if ([403, 429, 503].includes(status))
    return { state: 'rate-limit-stop', redirect };
  if (isChallenge($, html, redirect))
    return { state: 'verification-stop', redirect };
  if (status >= 300 && status < 400) {
    const official = officialUrlShape(headers.location);
    return { state: 'redirect-stop', redirect, official };
  }
  if (status !== 200) return { state: 'http-stop', redirect };
  const fragments = [...html.matchAll(/\burl\s*\+=\s*'([^'\r\n]{0,250})'/g)]
    .map((match) => match[1])
    .slice(0, 40);
  let candidate = '';
  if (fragments.length) {
    candidate = fragments.join('').replaceAll('@', '');
    if (candidate && !candidate.startsWith('http'))
      candidate = `https://mp.${candidate}`;
  } else {
    const refresh = $('meta[http-equiv="refresh"]').attr('content') || '';
    const match = /^\d+\s*;\s*url=(.+)$/i.exec(refresh);
    if (match) candidate = match[1];
  }
  // Do not call html.unescape on a signed URL: &timestamp may become ×tamp.
  candidate = candidate
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&')
    .replaceAll('&#x26;', '&');
  const official = officialUrlShape(candidate);
  return {
    state: official.complete ? 'official-url-found' : 'no-official-url',
    redirect,
    official,
    fragmentCount: fragments.length,
  };
}

function requestOnce(url, headers, limit) {
  if (url.origin !== ORIGIN || !['/weixinwap', '/link'].includes(url.pathname))
    throw new Error('request-host-gate');
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        agent: false,
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      (res) => {
        const chunks = [];
        let length = 0;
        let finished = false;
        const done = (truncated) => {
          if (finished) return;
          finished = true;
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks, length),
            truncated,
          });
        };
        res.on('data', (chunk) => {
          if (finished) return;
          const remaining = limit - length;
          if (chunk.length > remaining) {
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            length += Math.max(0, remaining);
            done(true);
            res.destroy();
            return;
          }
          chunks.push(chunk);
          length += chunk.length;
        });
        res.on('end', () => done(false));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function syncedNew(file, data) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const candidate of [
    path.join(os.homedir(), '.wewe-rss-private'),
    directory,
  ]) {
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('private-directory-gate');
  }
}

async function updateSentinel(file, summary) {
  const next = `${file}.next`;
  await syncedNew(next, JSON.stringify(summary, null, 2));
  await fs.rename(next, file);
  try {
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!['EPERM', 'EISDIR', 'EINVAL', 'EACCES'].includes(error.code))
      throw error;
  }
}

async function runProbe(seed, cheerio, { directory, request = requestOnce }) {
  await ensurePrivateDirectory(directory);
  const marker = path.join(directory, `${SEED_DIGEST}.json`);
  const summary = {
    state: 'started',
    at: new Date().toISOString(),
    seedDigest: SEED_DIGEST,
    queryHash: seed.queryHash,
    source: 'read-only verified old article',
    requests: 0,
  };
  try {
    await syncedNew(marker, JSON.stringify(summary, null, 2));
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error('duplicate-sentinel-no-request');
    throw error;
  }
  const search = searchUrl(seed.title);
  try {
    summary.requests = 1;
    summary.search = { state: 'started' };
    await updateSentinel(marker, summary);
    const first = await request(
      search,
      {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${ORIGIN}/`,
        'User-Agent': USER_AGENT,
      },
      SEARCH_LIMIT,
    );
    const firstHtml = contentText(first.body, first.headers['content-type']);
    const firstRedirect = targetShape(first.headers.location, search);
    const first$ = cheerio.load(firstHtml);
    summary.search = {
      status: first.status,
      bytes: first.body.length,
      sha256: hash(first.body),
      truncated: first.truncated,
      redirect: firstRedirect,
      setCookieCount: Array.isArray(first.headers['set-cookie'])
        ? first.headers['set-cookie'].length
        : 0,
    };
    if ([403, 429, 503].includes(first.status))
      summary.state = 'search-rate-limit-stop';
    else if (isChallenge(first$, firstHtml, firstRedirect))
      summary.state = 'search-verification-stop';
    else if (first.status !== 200 || first.truncated)
      summary.state = 'search-http-or-size-stop';
    else if (
      !/^text\/html|^application\/xhtml\+xml/i.test(
        first.headers['content-type'] || '',
      )
    )
      summary.state = 'search-content-type-stop';
    else {
      const match = matchingLink(firstHtml, seed, cheerio);
      summary.search.cardCount = match.cardCount || 0;
      summary.search.exactMatches = match.exactMatches || 0;
      if (match.state !== 'matched') summary.state = match.state;
      else {
        const cookie = cookiesForLink(first.headers['set-cookie']);
        summary.search.usableCookieCount = cookie
          ? cookie.split('; ').length
          : 0;
        if (!cookie) summary.state = 'cookie-unavailable-stop';
        else {
          summary.state = 'link-started';
          summary.requests = 2;
          await updateSentinel(marker, summary);
          const second = await request(
            match.link,
            {
              Accept: 'text/html,application/xhtml+xml',
              'Accept-Language': 'zh-CN,zh;q=0.9',
              Cookie: cookie,
              Referer: search.href,
              'User-Agent': USER_AGENT,
            },
            LINK_LIMIT,
          );
          const linkHtml = contentText(
            second.body,
            second.headers['content-type'],
          );
          const outcome = second.truncated
            ? { state: 'link-size-stop' }
            : linkDestination(second.status, second.headers, linkHtml, cheerio);
          summary.link = {
            status: second.status,
            bytes: second.body.length,
            sha256: hash(second.body),
            truncated: second.truncated,
            ...outcome,
          };
          summary.state = outcome.state;
        }
      }
    }
  } catch (error) {
    summary.state = 'request-or-parser-stop';
    summary.errorCode =
      typeof error.code === 'string' && /^[A-Z_]{2,30}$/.test(error.code)
        ? error.code
        : error.name === 'TimeoutError' || error.name === 'AbortError'
          ? 'TIMEOUT'
          : 'INTERNAL';
  }
  summary.completedAt = new Date().toISOString();
  await updateSentinel(marker, summary);
  return summary;
}

async function selfTest(cheerio) {
  const seed = {
    title: 'Sample article',
    accountName: 'Sample account',
    queryHash: hash('Sample article').slice(0, 20),
  };
  const card =
    '<ul class="news-list"><li id="sogou_vr_1"><h4><a href="/link?url=opaque&query=Sample+article&token=abc&type=2">Sample article</a></h4><span class="s2">Sample account</span></li></ul>';
  const response = (status, html, headers = {}) => ({
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: Buffer.from(html),
    truncated: false,
  });
  const cases = [
    {
      name: 'link-200',
      first: response(200, card, {
        'set-cookie': ['SNUID=fresh; Domain=.sogou.com; Path=/; HttpOnly'],
      }),
      second: response(
        200,
        "var url='';url += 'https://mp.weixin.qq.com/s?src=11&time';url += 'stamp=123&signature=abc';",
      ),
      state: 'official-url-found',
      requests: 2,
    },
    {
      name: 'no-cookie',
      first: response(200, card),
      state: 'cookie-unavailable-stop',
      requests: 1,
    },
    {
      name: 'challenge',
      first: response(200, '<title>安全验证</title><input id="seccodeInput">'),
      state: 'search-verification-stop',
      requests: 1,
    },
    {
      name: 'mismatch',
      first: response(200, card.replace('Sample account', 'Other account')),
      state: 'card-mismatch-stop',
      requests: 1,
    },
    {
      name: 'link-redirect-challenge',
      first: response(200, card, { 'set-cookie': ['SNUID=fresh; Path=/'] }),
      second: response(302, '', { location: '/antispider?foo=secret' }),
      state: 'verification-stop',
      requests: 2,
    },
  ];
  const directory = path.join(
    PRIVATE_DIR,
    `self-test-${process.pid}-${Date.now()}`,
  );
  await ensurePrivateDirectory(PRIVATE_DIR);
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    for (const item of cases) {
      const caseDir = path.join(directory, item.name);
      let called = 0;
      const request = async () => {
        called++;
        return called === 1 ? item.first : item.second;
      };
      const result = await runProbe(seed, cheerio, {
        directory: caseDir,
        request,
      });
      assert.equal(result.state, item.state, item.name);
      assert.equal(called, item.requests, item.name);
      assert.equal(result.requests, item.requests, item.name);
      await assert.rejects(
        runProbe(seed, cheerio, { directory: caseDir, request }),
        /duplicate-sentinel-no-request/,
      );
      assert.equal(called, item.requests, `${item.name} duplicate`);
    }
    assert.equal(cookiesForLink(['SNUID=x; Domain=evil.example; Path=/']), '');
    assert.equal(cookiesForLink(['SNUID=x; Path=/weixinwap']), '');
    assert.equal(cookiesForLink(['SNUID=x; Path=/']), 'SNUID=x');
    assert.equal(
      officialUrlShape('https://evil.example/s?src=11').complete,
      false,
    );
    return { selfTest: 'pass', cases: cases.length, networkRequests: 0 };
  } finally {
    for (const item of cases)
      await fs.rm(path.join(directory, item.name), {
        recursive: true,
        force: true,
      });
    await fs.rmdir(directory);
  }
}

async function main() {
  let parsed;
  try {
    parsed = cli(process.argv.slice(2));
    const cheerio = cheerioFromRoot(parsed.root);
    if (parsed.mode === '--self-test') {
      console.log(JSON.stringify(await selfTest(cheerio)));
      return;
    }
    const seed = loadSeed(parsed.root);
    const marker = path.join(PRIVATE_DIR, `${SEED_DIGEST}.json`);
    let attempted = false;
    try {
      await fs.access(marker);
      attempted = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (parsed.mode === '--preflight') {
      console.log(
        JSON.stringify({
          state: 'preflight',
          seedDigest: SEED_DIGEST,
          queryHash: seed.queryHash,
          publishedMonth: seed.publishedMonth,
          titleLength: seed.title.length,
          verifiedIdentityFields: seed.identity.length,
          endpoint: SEARCH,
          differentFromPriorAccountQuery: true,
          sentinelExists: attempted,
          ready: !attempted,
          requests: 0,
        }),
      );
      return;
    }
    if (attempted) throw new Error('duplicate-sentinel-no-request');
    const result = await runProbe(seed, cheerio, { directory: PRIVATE_DIR });
    console.log(
      JSON.stringify({
        state: result.state,
        seedDigest: SEED_DIGEST,
        requests: result.requests,
        searchStatus: result.search?.status || null,
        searchCards: result.search?.cardCount || 0,
        exactMatches: result.search?.exactMatches || 0,
        usableCookieCount: result.search?.usableCookieCount || 0,
        linkStatus: result.link?.status || null,
        linkState: result.link?.state || null,
        officialUrlShape: result.link?.official || null,
        evidence: marker,
      }),
    );
  } catch (error) {
    if (parsed?.mode === '--self-test') console.error(error.stack);
    console.error(
      JSON.stringify({
        state: 'preflight-or-sentinel-stop',
        reason: /^(?:seed-|db-|duplicate-|request-host-gate|Usage:)/.test(
          error.message,
        )
          ? error.message
          : 'internal',
        requests: 0,
      }),
    );
    process.exitCode = 1;
  }
}

main();
