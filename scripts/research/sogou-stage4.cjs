#!/usr/bin/env node
'use strict';

// Bounded, read-only research probe. No URLs, cookies, titles or HTML are logged or written.
// Run --offline first. --live performs at most one GET each: index, /link, article.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const zlib = require('node:zlib');
const { load } = require('cheerio');

const TARGET_NAME = '妈妈部落畅聊阁';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const SOGOU = 'https://weixin.sogou.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0';
const ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isChallenge(html) {
  return /seccoderight|anti\.min\.css|antispider|系统检测到你的网络环境存在异常|请输入验证码/i.test(
    html,
  );
}

function searchUrl() {
  const url = new URL('/weixin', SOGOU);
  url.search = new URLSearchParams({
    type: '2',
    s_from: 'input',
    query: TARGET_NAME,
    ie: 'utf8',
    page: '1',
    _sug_: 'n',
    _sug_type_: '',
  }).toString();
  return url;
}

function parseIndex(html) {
  const $ = load(html);
  const cards = $('li[id^="sogou_vr_11002601_box_"]').toArray();
  const candidates = cards.map((card) => {
    const node = $(card);
    const author = node.find('.all-time-y2').first().text().trim();
    const timeHtml =
      node.find('div.txt-box > div.s-p > span.s2').first().html() || '';
    const timeMatch = /timeConvert\(['"](\d{10})['"]\)/.exec(timeHtml);
    const timestamp = timeMatch ? Number(timeMatch[1]) : null;
    const href = node
      .find('a[id*="sogou_vr_11002601_title_"]')
      .first()
      .attr('href');
    let link = null;
    if (href) {
      const resolved = new URL(href, SOGOU);
      if (
        resolved.protocol === 'https:' &&
        resolved.hostname === 'weixin.sogou.com' &&
        resolved.pathname === '/link' &&
        !resolved.username &&
        !resolved.password &&
        !resolved.port
      )
        link = resolved;
    }
    return { author, timestamp, link };
  });
  const exact = candidates.filter((item) => item.author === TARGET_NAME);
  const eligible = exact
    .filter(
      (item) =>
        item.link &&
        Number.isSafeInteger(item.timestamp) &&
        item.timestamp >= 946684800 &&
        item.timestamp <= Date.now() / 1000 + 300,
    )
    .sort((a, b) => b.timestamp - a.timestamp);
  return {
    cards: cards.length,
    authors: candidates.filter((item) => item.author).length,
    exactAuthors: exact.length,
    exactWithTimeAndLink: eligible.length,
    chosen: eligible[0] || null,
  };
}

function parseLink(html) {
  const parts = [...html.matchAll(/url\s*\+=\s*'([^']*)'/g)].map((m) => m[1]);
  assert(parts.length > 0, 'link fragments missing');
  // Match wx-search-cli's fragment parser. Do not HTML-decode the full URL:
  // decoding &timestamp as &times corrupts the signed query string.
  const joined = parts.join('').replaceAll('@', '');
  const url = new URL(
    joined.startsWith('http') ? joined : `https://mp.${joined}`,
  );
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'mp.weixin.qq.com');
  assert.equal(url.pathname, '/s');
  assert.equal(url.port, '');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  for (const key of ['src', 'timestamp', 'signature']) {
    assert(url.searchParams.get(key), `signed parameter ${key} missing`);
  }
  return url;
}

// Mirrors current main's article-page.ts CGI scalar extraction, without executing page JS.
function cgiDataNewField(html, name, valuePattern) {
  const marker = /\bwindow\.cgiDataNew\s*=\s*\{/.exec(html);
  if (!marker) return undefined;
  const start = marker.index + marker[0].lastIndexOf('{');
  const scriptEnd = html.indexOf('</script>', start);
  const limit = Math.min(
    scriptEnd < 0 ? html.length : scriptEnd,
    start + 1_000_000,
  );
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let end = -1;
  for (let i = start; i < limit; i++) {
    const char = html[i];
    const next = html[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
    } else if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
    } else if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '/' && next === '/') {
      lineComment = true;
      i++;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) return undefined;
  const expression = new RegExp(
    `(?:^|[,{])\\s*(?:["']${name}["']|${name})\\s*:\\s*(["'])(${valuePattern})\\1`,
    'g',
  );
  const matches = [...html.slice(start, end).matchAll(expression)];
  return matches.length === 1 ? matches[0][2] : undefined;
}

function parseArticle(html, searchTimestamp) {
  const $ = load(html);
  const body = $('#js_content').first();
  if (!body.length) {
    // Public-source variants all return HTML that can have HTTP 200. These
    // checks only classify explicit markers; an unrecognized page remains unknown.
    if (/环境异常|完成验证后即可继续访问/.test(html))
      throw new Error('article-verification-page');
    if (/该内容已被发布者删除/.test(html))
      throw new Error('article-deleted-page');
    if (/此内容因违规无法查看|该内容已被多人投诉/.test(html))
      throw new Error('article-policy-blocked-page');
    if (
      /仅关注[^<>]{0,20}粉丝|作者设置了[^<>]{0,12}可见|粉丝(?:才)?(?:可见|可以查看)/.test(
        html,
      )
    )
      throw new Error('article-follower-only-page');
    if (/系统出错|链接已过期|参数错误/.test(html))
      throw new Error('article-invalid-link-page');
    throw new Error('article-body-marker-absent');
  }
  const legacy = (name, pattern) =>
    html.match(
      new RegExp(`\\bvar\\s+${name}\\s*=\\s*["'](${pattern})["']`),
    )?.[1];
  const choose = (oldValue, newValue) => {
    if (oldValue && newValue && oldValue !== newValue)
      throw new Error('article-identity-conflict');
    return oldValue || newValue;
  };
  const biz = choose(
    legacy('biz', '[A-Za-z0-9+/=]+'),
    cgiDataNewField(html, 'bizuin', '[A-Za-z0-9+/=]+'),
  );
  const mid = choose(
    legacy('mid', '\\d+'),
    cgiDataNewField(html, 'mid', '\\d+'),
  );
  const idx = choose(
    legacy('idx', '\\d+'),
    cgiDataNewField(html, 'idx', '\\d+'),
  );
  const sn = choose(
    legacy('sn', '[a-fA-F0-9]+'),
    cgiDataNewField(html, 'sn', '[a-fA-F0-9]+'),
  );
  if (!biz) throw new Error('article-biz-absent');
  if (biz !== TARGET_BIZ) throw new Error('article-biz-mismatch');
  if (!mid) throw new Error('article-mid-absent');
  if (!/^\d+$/.test(mid)) throw new Error('article-mid-invalid');
  if (!idx) throw new Error('article-idx-absent');
  if (!/^[1-9]\d*$/.test(idx)) throw new Error('article-idx-invalid');
  if (Buffer.from(biz, 'base64').toString('ascii') !== '3895431412')
    throw new Error('article-biz-invalid');
  const legacyTime = html.match(
    /\b(?:create_time|ct|CreateTime)\b["']?\s*[:=]\s*['"]?(\d{10})(?!\d)['"]?/i,
  )?.[1];
  const cgiTime =
    cgiDataNewField(html, 'ori_create_time', '\\d{10}') ||
    cgiDataNewField(html, 'ori_send_time', '\\d{10}') ||
    cgiDataNewField(html, 'create_timestamp', '\\d{10}');
  if (legacyTime && cgiTime && legacyTime !== cgiTime)
    throw new Error('article-publish-time-conflict');
  if (!legacyTime && !cgiTime) throw new Error('article-publish-time-absent');
  const publishTime = Number(legacyTime || cgiTime);
  if (
    !Number.isSafeInteger(publishTime) ||
    publishTime < 946684800 ||
    publishTime > Date.now() / 1000 + 300
  )
    throw new Error('article-publish-time-invalid');
  const textCharacters = body
    .text()
    .replace(/[\s\u200b-\u200d\ufeff]/gu, '').length;
  const images = body.find('img').toArray();
  const imageReferences = images.filter((image) => {
    const src = $(image).attr('data-src') || $(image).attr('src');
    if (!src) return false;
    try {
      const url = new URL(src);
      return (
        url.protocol === 'https:' &&
        /(^|\.)(qpic\.cn|qlogo\.cn|qq\.com)$/.test(url.hostname) &&
        !url.port &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }).length;
  if (textCharacters === 0 && imageReferences === 0)
    throw new Error('article-body-empty');
  return {
    bizMatch: true,
    midPresent: true,
    idxPresent: true,
    snPresent: Boolean(sn),
    publishTimePresent: true,
    publishTimeSource:
      legacyTime && cgiTime
        ? 'page-ct-and-cgi'
        : legacyTime
          ? 'page-ct'
          : 'cgi-time',
    indexTimeDifferenceSeconds:
      searchTimestamp === null ? null : publishTime - searchTimestamp,
    textCharacters,
    imageNodes: images.length,
    allowedImageReferences: imageReferences,
  };
}

function requestOnce(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: { ...headers, 'Accept-Encoding': 'gzip, deflate, br' },
        timeout: 15000,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 10_000_000) {
            req.destroy(new Error('response size limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            let body = Buffer.concat(chunks);
            const encoding = response.headers['content-encoding'];
            if (encoding === 'gzip') body = zlib.gunzipSync(body);
            else if (encoding === 'deflate') body = zlib.inflateSync(body);
            else if (encoding === 'br') body = zlib.brotliDecompressSync(body);
            if (body.length > 20_000_000)
              throw new Error('decoded response size limit');
            resolve({
              status: response.statusCode,
              headers: response.headers,
              html: body.toString('utf8'),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function cookiesForSameSession(headers) {
  const raw = headers['set-cookie'] || [];
  return raw.map((item) => item.split(';')[0]).join('; ');
}

function offline(fixturePath) {
  const now = Math.floor(Date.now() / 1000) - 3600;
  const older = now - 100;
  const card = (i, author, time) =>
    `<li id="sogou_vr_11002601_box_${i}"><div class="txt-box"><a id="sogou_vr_11002601_title_${i}" href="/link?url=opaque${i}">fixture</a><div class="s-p"><span class="all-time-y2">${author}</span><span class="s2"><script>document.write(timeConvert('${time}'))</script></span></div></div></li>`;
  const index = parseIndex(
    card(1, TARGET_NAME, older) +
      card(2, TARGET_NAME, now) +
      card(3, '其他号', now + 1),
  );
  assert.equal(index.cards, 3);
  assert.equal(index.exactAuthors, 2);
  assert.equal(index.exactWithTimeAndLink, 2);
  assert.equal(index.chosen.timestamp, now);
  const signed = parseLink(
    "<script>var url = ''; url += 'weixin.qq.com/s?src=11&t'; url += 'imestamp=123&ver=1&signature=abcDEF*123&new=1';</script>",
  );
  assert.equal(signed.hostname, 'mp.weixin.qq.com');
  assert.equal(signed.searchParams.get('ver'), '1');
  assert.equal(signed.searchParams.get('new'), '1');
  assert.equal(signed.searchParams.get('signature'), 'abcDEF*123');
  assert.throws(() =>
    parseLink(
      "<script>url += 'weixin.qq.com/s?src=11&times;tamp=123&signature=abc';</script>",
    ),
  );
  const synthetic = `<div id="js_content"><p>正文</p><img data-src="https://mmbiz.qpic.cn/fixture"></div><script>window.cgiDataNew={bizuin:'${TARGET_BIZ}',mid:'2247493540',idx:'2',sn:'abcdef',ori_create_time:'${now}'};</script>`;
  const parsed = parseArticle(synthetic, now);
  assert.equal(parsed.bizMatch, true);
  assert.equal(parsed.textCharacters, 2);
  assert.equal(parsed.allowedImageReferences, 1);
  assert.throws(() =>
    parseArticle(synthetic.replace(TARGET_BIZ, 'MTAwMDAwMDAwMA=='), now),
  );
  assert.throws(() =>
    parseArticle(synthetic.replace("mid:'2247493540',", ''), now),
  );
  assert.throws(() =>
    parseArticle(
      synthetic.replace('id="js_content"', 'id="verification"'),
      now,
    ),
  );
  for (const phrase of [
    '当前环境异常，完成验证后即可继续访问',
    '该内容已被发布者删除',
    '此内容因违规无法查看',
    '仅关注的粉丝可见',
    '链接已过期',
  ])
    assert.throws(() =>
      parseArticle(`<html><body>${phrase}</body></html>`, now),
    );
  const result = {
    syntheticIndexCards: index.cards,
    syntheticExactAuthors: index.exactAuthors,
    syntheticSignedUrlShape: true,
    syntheticArticle: parsed,
  };
  if (fixturePath) {
    const actual = parseArticle(fs.readFileSync(fixturePath, 'utf8'), null);
    result.savedFixture = actual;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function live() {
  const counts = { index: 0, link: 0, article: 0 };
  const summary = { counts, stage: 'start' };
  const common = {
    Accept: ACCEPT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': UA,
  };
  try {
    const indexUrl = searchUrl();
    counts.index++;
    const index = await requestOnce(indexUrl, {
      ...common,
      Referer: `${SOGOU}/weixin?query=${encodeURIComponent(TARGET_NAME)}`,
    });
    summary.indexStatus = index.status;
    summary.indexChallenge = isChallenge(index.html);
    if (index.status !== 200 || summary.indexChallenge)
      throw new Error('index stopped');
    const parsedIndex = parseIndex(index.html);
    Object.assign(summary, {
      cards: parsedIndex.cards,
      exactAuthors: parsedIndex.exactAuthors,
      exactWithTimeAndLink: parsedIndex.exactWithTimeAndLink,
    });
    if (!parsedIndex.chosen) throw new Error('no eligible exact-author card');
    summary.stage = 'index-validated';
    await sleep(2500);
    counts.link++;
    const link = await requestOnce(parsedIndex.chosen.link, {
      ...common,
      Referer: indexUrl.toString(),
      Cookie: cookiesForSameSession(index.headers),
    });
    summary.linkStatus = link.status;
    summary.linkChallenge = isChallenge(link.html);
    if (link.status !== 200 || summary.linkChallenge)
      throw new Error('link stopped');
    const signed = parseLink(link.html);
    summary.stage = 'signed-url-validated';
    await sleep(2500);
    counts.article++;
    const article = await requestOnce(signed, {
      ...common,
      Referer: parsedIndex.chosen.link.toString(),
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-User': '?1',
    });
    summary.articleStatus = article.status;
    summary.articleChallenge = isChallenge(article.html);
    if (article.status !== 200 || summary.articleChallenge)
      throw new Error('article stopped');
    summary.article = parseArticle(article.html, parsedIndex.chosen.timestamp);
    summary.stage = 'article-validated';
  } catch (error) {
    // Never print exception messages: HTTP and parser exceptions can contain signed URLs.
    summary.stopped = true;
    const safeReasons = new Set([
      'article-body-marker-absent',
      'article-verification-page',
      'article-deleted-page',
      'article-policy-blocked-page',
      'article-follower-only-page',
      'article-invalid-link-page',
      'article-identity-conflict',
      'article-biz-absent',
      'article-biz-mismatch',
      'article-biz-invalid',
      'article-mid-absent',
      'article-mid-invalid',
      'article-idx-absent',
      'article-idx-invalid',
      'article-publish-time-conflict',
      'article-publish-time-absent',
      'article-publish-time-invalid',
      'article-body-empty',
    ]);
    summary.stopReason = safeReasons.has(error?.message)
      ? error.message
      : error instanceof assert.AssertionError
        ? 'shape-assertion'
        : 'request-or-parse';
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.stopped) process.exitCode = 1;
}

if (process.argv[2] === '--offline') offline(process.argv[3]);
else if (process.argv[2] === '--live') live();
else {
  process.stderr.write('Use --offline [existing HTML fixture] or --live\n');
  process.exitCode = 2;
}
