#!/usr/bin/env node
'use strict';

// One public Sogou account-search page. Never follows a link or sends cookies.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ORIGIN = 'https://weixin.sogou.com';
const SOURCE_FILE = path.join(
  os.homedir(),
  '.wewe-rss-private',
  'mobile-public-search',
  'e6599d7bcd694430da5c.html',
);
const SOURCE_SHA256 =
  '169880e6c825d70cc7c0258150414426265af5d0eaab745055ceee1152dbd13b';
const PRIVATE_DIR = path.join(
  os.homedir(),
  '.wewe-rss-private',
  'sogou-mobile-account-search',
);
const MARKER = 'attempt.json';
const HTML_FILE = 'response.html';
const RESULT_FILE = 'result.json';
const MAX_SOURCE = 128 * 1024;
const MAX_RESPONSE = 128 * 1024;
const TIMEOUT_MS = 8000;
const CHALLENGE_TEXT =
  /验证码|安全验证|人机验证|环境异常|操作频繁|访问过于频繁|seccoderight|seccodeInput|antispider|captcha/i;
const CHALLENGE_PATH = /antispider|captcha|verify|seccode|approve/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cli(argv) {
  const [mode, root, approval] = argv;
  if (
    !['--plan', '--self-test', '--preflight', '--execute'].includes(mode) ||
    !path.isAbsolute(root || '') ||
    (mode === '--execute' && approval !== '--approved-online') ||
    (mode !== '--execute' && argv.length !== 2)
  )
    throw Error('usage-gate');
  return { mode, root: path.resolve(root) };
}

function cheerioFromRoot(root) {
  return createRequire(path.join(root, 'apps/server/package.json'))('cheerio');
}

function loadSeed(root, cheerio) {
  const source = fs.readFileSync(SOURCE_FILE);
  if (source.length > MAX_SOURCE || sha256(source) !== SOURCE_SHA256)
    throw Error('source-integrity-gate');
  const $ = cheerio.load(source.toString('utf8'));
  const cards = $('span.s2[data-openid][data-sourcename]')
    .toArray()
    .map((node) => ({
      name: $(node).attr('data-sourcename'),
      openid: $(node).attr('data-openid'),
    }));
  if (cards.length !== 9) throw Error('source-card-gate');
  const groups = [...new Set(cards.map((card) => card.name))].map((name) => ({
    name,
    cards: cards.filter((card) => card.name === name),
  }));
  const selected = groups.filter((group) => group.cards.length === 8);
  if (
    selected.length !== 1 ||
    !selected[0].name ||
    selected[0].name !== selected[0].name.trim() ||
    /[\u0000-\u001f\u007f]/u.test(selected[0].name) ||
    selected[0].name.length > 100 ||
    new Set(selected[0].cards.map((card) => card.openid)).size !== 1 ||
    !/^oIWsFt[A-Za-z0-9_-]{22}$/.test(selected[0].cards[0].openid || '')
  )
    throw Error('source-identity-gate');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'apps/server/data/wewe-rss.db'), {
    readOnly: true,
  });
  let feeds;
  try {
    db.exec('PRAGMA query_only=ON');
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok')
      throw Error('db-integrity-gate');
    feeds = db.prepare('SELECT mp_name FROM feeds').all();
  } finally {
    db.close();
  }
  if (feeds.filter((feed) => feed.mp_name === selected[0].name).length !== 1)
    throw Error('db-account-gate');
  return {
    name: selected[0].name,
    openid: selected[0].cards[0].openid,
    sourceCards: selected[0].cards.length,
    openidDigest: sha256(selected[0].cards[0].openid),
  };
}

function searchUrl(name) {
  const url = new URL('/weixinwap', ORIGIN);
  url.search = new URLSearchParams({ type: '1', query: name }).toString();
  return url;
}

function hrefShape(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 8192)
    return { host: 'missing_or_invalid', path: 'missing_or_invalid' };
  let url;
  try {
    url = new URL(raw, ORIGIN);
  } catch {
    return { host: 'invalid', path: 'invalid' };
  }
  const host =
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
      ? 'invalid'
      : url.hostname === 'weixin.sogou.com'
        ? 'sogou'
        : url.hostname === 'mp.weixin.qq.com'
          ? 'wechat'
          : 'other';
  const pathname = url.pathname;
  const pathType =
    pathname === '/gzh'
      ? 'gzh'
      : pathname === '/gzhjs'
        ? 'gzhjs'
        : pathname === '/link'
          ? 'link'
          : pathname === '/s'
            ? 'article'
            : 'other';
  return { host, path: host === 'invalid' ? 'invalid' : pathType };
}

function parseAccountPage(html, seed, cheerio) {
  if (CHALLENGE_TEXT.test(html))
    return {
      state: 'challenge-stop',
      challenge: 'html',
      accountCards: 0,
      exactNameCards: 0,
      matchingOpenidCards: 0,
      matches: [],
    };
  const $ = cheerio.load(html);
  const cards = $('li[d]')
    .toArray()
    .filter((node) => $(node).find('.gzh-box').length > 0);
  const entries = cards.map((node) => {
    const card = $(node);
    return {
      name: card.find('.gzh-tit').first().text().trim(),
      openid: card.attr('d') || '',
      href: card.find('.gzh-box > a[href]').first().attr('href') || '',
    };
  });
  const exact = entries.filter((entry) => entry.name === seed.name);
  const matches = exact.filter((entry) => entry.openid === seed.openid);
  return {
    state:
      matches.length === 1
        ? 'one-account-match'
        : matches.length > 1
          ? 'ambiguous-account-stop'
          : 'no-account-match',
    challenge: 'none',
    accountCards: entries.length,
    exactNameCards: exact.length,
    matchingOpenidCards: matches.length,
    matches,
  };
}

function requestOnce(url) {
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'weixin.sogou.com' ||
    url.pathname !== '/weixinwap' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll('type').length !== 1 ||
    url.searchParams.get('type') !== '1' ||
    url.searchParams.getAll('query').length !== 1 ||
    [...url.searchParams.keys()].length !== 2
  )
    throw Error('request-shape-gate');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const req = https.get(
      url,
      {
        agent: false,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (part) => {
          size += part.length;
          if (size > MAX_RESPONSE) {
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.alloc(0),
              truncated: true,
            });
            res.destroy();
            return;
          }
          chunks.push(part);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            truncated: false,
          }),
        );
        res.on('error', (error) => finish(error));
      },
    );
    req.setTimeout(TIMEOUT_MS, () =>
      req.destroy(Object.assign(Error('timeout'), { code: 'ETIMEDOUT' })),
    );
    req.on('error', (error) => finish(error));
  });
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const item of [path.dirname(directory), directory]) {
    const stats = fs.lstatSync(item);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw Error('private-directory-gate');
  }
}

function privateWrite(directory, name, value) {
  const file = path.join(directory, name);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function runProbe(seed, cheerio, options = {}) {
  const directory = options.directory || PRIVATE_DIR;
  const request = options.request || requestOnce;
  ensurePrivateDirectory(directory);
  const url = searchUrl(seed.name);
  // This exclusive, durable marker is created before any online request.
  privateWrite(
    directory,
    MARKER,
    JSON.stringify({
      kind: 'sogou-mobile-account-one-shot',
      attemptedAt: new Date().toISOString(),
      requestDigest: sha256(url.href),
      sourceOpenidDigest: seed.openidDigest,
    }) + '\n',
  );
  let result;
  let response;
  let matchedAccounts = [];
  let requests = 0;
  try {
    requests = 1;
    response = await request(url);
    const contentType = String(response.headers?.['content-type'] || '');
    const location = String(response.headers?.location || '');
    const redirectChallenge =
      response.status >= 300 &&
      response.status < 400 &&
      CHALLENGE_PATH.test(location);
    const base = {
      httpStatus: response.status ?? null,
      accountCards: 0,
      exactNameCards: 0,
      matchingOpenidCards: 0,
      openidMatched: false,
      encGzhUrl: null,
    };
    if (response.truncated)
      result = { ...base, state: 'size-limit-stop', challenge: 'unknown' };
    else if (response.status >= 300 && response.status < 400)
      result = {
        ...base,
        state: 'redirect-stop',
        challenge: redirectChallenge ? 'redirect' : 'unknown',
      };
    else if ([403, 429].includes(response.status))
      result = { ...base, state: 'access-stop', challenge: 'possible' };
    else if (response.status !== 200)
      result = { ...base, state: 'http-stop', challenge: 'unknown' };
    else if (
      !/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType) ||
      String(response.headers?.['content-encoding'] || 'identity') !==
        'identity'
    )
      result = { ...base, state: 'content-type-stop', challenge: 'unknown' };
    else {
      const html = response.body.toString('utf8');
      const parsed = parseAccountPage(html, seed, cheerio);
      matchedAccounts = parsed.matches;
      const single = parsed.matches.length === 1 ? parsed.matches[0] : null;
      result = {
        ...base,
        state: parsed.state,
        challenge: parsed.challenge,
        accountCards: parsed.accountCards,
        exactNameCards: parsed.exactNameCards,
        matchingOpenidCards: parsed.matchingOpenidCards,
        openidMatched: !!single,
        encGzhUrl: single ? hrefShape(single.href) : null,
      };
    }
  } catch (error) {
    result = {
      state: 'transport-stop',
      challenge: 'unknown',
      httpStatus: null,
      accountCards: 0,
      exactNameCards: 0,
      matchingOpenidCards: 0,
      openidMatched: false,
      encGzhUrl: null,
      transport: error.code === 'ETIMEDOUT' ? 'timeout' : 'other',
    };
  }
  result.requests = requests;
  if (options.persistRaw !== false) {
    try {
      const contentType = String(response?.headers?.['content-type'] || '');
      if (
        !response?.truncated &&
        response?.body &&
        /^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)
      )
        privateWrite(directory, HTML_FILE, response.body);
      privateWrite(
        directory,
        RESULT_FILE,
        JSON.stringify({
          searchUrl: url.href,
          sourceOpenid: seed.openid,
          matchedAccounts,
          redirectLocation: response?.headers?.location || null,
          summary: result,
        }) + '\n',
      );
    } catch {
      return { ...result, state: 'evidence-persist-stop' };
    }
  }
  return result;
}

async function selfTest(cheerio) {
  const seed = {
    name: 'Fixture account',
    openid: 'oIWsFt' + 'A'.repeat(22),
    openidDigest: sha256('oIWsFt' + 'A'.repeat(22)),
  };
  const account = (name, openid, href = '/gzh?opaque=1') =>
    `<li d="${openid}"><div class="gzh-box"><a href="${href}"><p class="gzh-tit">${name}</p></a></div></li>`;
  const response = (status, body, headers = {}) => ({
    status,
    body: Buffer.from(body),
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...headers,
    },
    truncated: false,
  });
  const cases = [
    {
      name: 'matched',
      response: response(200, account(seed.name, seed.openid)),
      state: 'one-account-match',
      matches: 1,
    },
    {
      name: 'wrong-openid',
      response: response(200, account(seed.name, 'oIWsFt' + 'B'.repeat(22))),
      state: 'no-account-match',
      matches: 0,
    },
    {
      name: 'challenge',
      response: response(200, '<input id="seccodeInput">'),
      state: 'challenge-stop',
      matches: 0,
    },
    {
      name: 'redirect',
      response: response(302, '', { location: '/antispider?token=private' }),
      state: 'redirect-stop',
      matches: 0,
    },
    {
      name: 'non-html',
      response: response(200, '{}', { 'content-type': 'application/json' }),
      state: 'content-type-stop',
      matches: 0,
    },
    {
      name: 'oversize',
      response: { ...response(200, ''), truncated: true },
      state: 'size-limit-stop',
      matches: 0,
    },
  ];
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'sogou-account-selftest-'),
  );
  try {
    for (const item of cases) {
      const caseDir = path.join(directory, item.name);
      let calls = 0;
      const request = async () => {
        calls++;
        return item.response;
      };
      const persistRaw = item.name === 'matched';
      const result = await runProbe(seed, cheerio, {
        directory: caseDir,
        request,
        persistRaw,
      });
      assert.equal(result.state, item.state);
      assert.equal(result.matchingOpenidCards, item.matches);
      assert.equal(result.requests, 1);
      assert.equal(calls, 1);
      if (persistRaw) {
        const privateResult = JSON.parse(
          fs.readFileSync(path.join(caseDir, RESULT_FILE), 'utf8'),
        );
        assert.equal(privateResult.sourceOpenid, seed.openid);
        assert.equal(privateResult.matchedAccounts.length, 1);
        assert(
          fs
            .readFileSync(path.join(caseDir, HTML_FILE), 'utf8')
            .includes(seed.openid),
        );
      }
      await assert.rejects(
        runProbe(seed, cheerio, {
          directory: caseDir,
          request,
          persistRaw: false,
        }),
        /EEXIST/,
      );
      assert.equal(calls, 1);
    }
    assert.deepEqual(hrefShape('javascript:alert(1)'), {
      host: 'invalid',
      path: 'invalid',
    });
    assert.deepEqual(hrefShape('/gzh?opaque=1'), {
      host: 'sogou',
      path: 'gzh',
    });
    assert.throws(() => cli(['--execute', directory]), /usage-gate/);
    return {
      state: 'self-test-pass',
      fakeCases: cases.length,
      realNetworkRequests: 0,
    };
  } finally {
    const resolved = fs.realpathSync(directory);
    if (
      path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith('sogou-account-selftest-')
    )
      throw Error('self-test-cleanup-gate');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function main() {
  let mode;
  try {
    const args = cli(process.argv.slice(2));
    mode = args.mode;
    const cheerio = cheerioFromRoot(args.root);
    if (mode === '--self-test') {
      console.log(JSON.stringify(await selfTest(cheerio)));
      return;
    }
    if (mode === '--plan') {
      console.log(
        JSON.stringify({
          state: 'plan-only',
          endpoint: `${ORIGIN}/weixinwap`,
          queryType: 1,
          maxRequests: 1,
          timeoutMs: TIMEOUT_MS,
          maxBytes: MAX_RESPONSE,
          onlineApprovalFlagRequired: true,
          realNetworkRequests: 0,
        }),
      );
      return;
    }
    const seed = loadSeed(args.root, cheerio);
    const markerExists = fs.existsSync(path.join(PRIVATE_DIR, MARKER));
    if (mode === '--preflight') {
      console.log(
        JSON.stringify({
          state: 'preflight',
          sourceCards: seed.sourceCards,
          sourceOpenidConsistent: true,
          exactFeedName: true,
          markerExists,
          ready: !markerExists,
          realNetworkRequests: 0,
        }),
      );
      return;
    }
    if (markerExists) throw Error('already-attempted-gate');
    console.log(JSON.stringify(await runProbe(seed, cheerio)));
  } catch (error) {
    if (mode === '--self-test') console.error(error.stack);
    else
      console.error(
        JSON.stringify({
          state: 'offline-or-sentinel-stop',
          reason: /^(?:usage|source|db|already|private|request)-/.test(
            error.message,
          )
            ? error.message
            : 'internal',
          realNetworkRequests: 0,
        }),
      );
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = {
  loadSeed,
  searchUrl,
  hrefShape,
  parseAccountPage,
  runProbe,
  selfTest,
};
