// Compare one current public article response with a saved, independently verified target page.
// This is a one-shot research probe: no response body, URL, title, or credential is persisted.
// Usage: node public-article-reference-control.cjs preflight <saved-temp-dir> <built-parser>
//        node public-article-reference-control.cjs probe <saved-temp-dir> <built-parser> <digest>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { createRequire } = require('node:module');

const [mode, savedDir, parserPath, chosenDigest] = process.argv.slice(2);
const MAX_BYTES = 6 * 1024 * 1024;
const ALBUM_FILES = [
  'wewe-target-album-page1-data-20260927.json',
  'wewe-target-album-page2-data-20260927.json',
  'wewe-target-album2-page1-20260927.json',
  'wewe-target-album2-page2-20260927.json',
];
const PREVIOUS_LIVE_DIGESTS = new Set(['e28e53cb45b7c1eb', '792e0623ba3ee739']);
const KEYS = ['__biz', 'mid', 'idx', 'sn'];

function digest(query) {
  return crypto
    .createHash('sha256')
    .update(KEYS.map((key) => query.get(key) || '').join('\0'))
    .digest('hex')
    .slice(0, 16);
}

function officialArticleUrl(raw) {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/s'
  )
    throw new Error('invalid_article_url');
  for (const key of KEYS)
    if (url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key))
      throw new Error('missing_or_ambiguous_identity');
  if (
    !/^\d+$/.test(url.searchParams.get('mid')) ||
    !/^[1-9]\d*$/.test(url.searchParams.get('idx')) ||
    !/^[a-fA-F0-9]{16,64}$/.test(url.searchParams.get('sn'))
  )
    throw new Error('invalid_identity_shape');
  url.protocol = 'https:';
  url.hash = '';
  return url;
}

function sameFields(left, right) {
  return Object.fromEntries(
    KEYS.map((key) => [key, left.get(key) === right.get(key)]),
  );
}

function summarizePage(html, ref, parser) {
  let liveIdentity;
  try {
    liveIdentity = parser.articleIdentity(html);
  } catch {
    return { result: 'article_identity_parser_stop', hasJsContent: true };
  }
  let liveUrl;
  try {
    liveUrl = new URL(liveIdentity.url);
  } catch {
    return { result: 'canonical_url_parser_stop', hasJsContent: true };
  }
  if (liveUrl.hostname !== 'mp.weixin.qq.com' || liveUrl.pathname !== '/s')
    return { result: 'canonical_url_host_or_path_stop', hasJsContent: true };
  const matchesOldAndList = sameFields(liveUrl.searchParams, ref.oldFields);
  let liveCt;
  try {
    liveCt = parser.articlePublishTime(html);
  } catch {
    return {
      result: 'publish_time_parser_stop',
      hasJsContent: true,
      identityMatchesOldAndList: matchesOldAndList,
    };
  }
  const literalCt = html.match(/\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/);
  const ctMatchesOld =
    liveCt === ref.oldCt && liveCt === Number(literalCt?.[1]);
  const allIdentityMatch = Object.values(matchesOldAndList).every(Boolean);
  return {
    result:
      allIdentityMatch && ctMatchesOld
        ? 'reference_identity_and_ct_match'
        : 'reference_mismatch_stop',
    hasJsContent: true,
    identityMatchesOldAndList: matchesOldAndList,
    ctMatchesOld,
  };
}

function loadReferences() {
  if (!['preflight', 'probe'].includes(mode) || !savedDir || !parserPath)
    throw new Error('arguments');
  const parser = require(path.resolve(parserPath));
  const cheerio = createRequire(path.resolve(parserPath))('cheerio');
  const records = JSON.parse(
    fs.readFileSync(
      path.join(savedDir, 'wewe-short-long-identities-20260927.json'),
      'utf8',
    ),
  ).articles;
  const albumItems = ALBUM_FILES.flatMap((name) => {
    const data = JSON.parse(fs.readFileSync(path.join(savedDir, name), 'utf8'));
    if (
      data.base_resp?.ret !== 0 ||
      !Array.isArray(data.getalbum_resp?.article_list)
    )
      throw new Error('album_data');
    return data.getalbum_resp.article_list;
  });
  const oldFiles = fs
    .readdirSync(savedDir)
    .filter((name) =>
      /^wewe-identity-[A-Za-z0-9_-]+-20260927\.html$/.test(name),
    )
    .sort();
  if (oldFiles.length !== 6) throw new Error('saved_reference_count');
  return oldFiles.map((name) => {
    const oldHtml = fs.readFileSync(path.join(savedDir, name), 'utf8');
    const oldIdentity = parser.articleIdentity(oldHtml);
    const oldUrl = officialArticleUrl(oldIdentity.url);
    const oldFields = oldUrl.searchParams;
    const candidates = albumItems.filter((item) => {
      const listFields = officialArticleUrl(item.url).searchParams;
      return KEYS.every((key) => listFields.get(key) === oldFields.get(key));
    });
    if (candidates.length !== 1) throw new Error('reference_album_identity');
    const item = candidates[0];
    const listUrl = officialArticleUrl(item.url);
    if (
      String(item.msgid) !== listUrl.searchParams.get('mid') ||
      String(item.itemidx) !== listUrl.searchParams.get('idx')
    )
      throw new Error('reference_album_item_identity');
    const record = records.find((row) => path.basename(row.htmlFile) === name);
    if (!record || !record.hasContent || !record.matchesCurrentRow)
      throw new Error('reference_verified_record');
    const oldCt = parser.articlePublishTime(oldHtml);
    const literalCt = oldHtml.match(
      /\bvar\s+ct\s*=\s*["']?(\d{10})(?!\d)["']?/,
    );
    const ctChecks = {
      present: Boolean(oldCt),
      parsedIdentity: oldCt === oldIdentity.publishTime,
      literal: oldCt === Number(literalCt?.[1]),
      recordedCt: oldCt === Number(record.ct),
    };
    const failedCtChecks = Object.entries(ctChecks)
      .filter(([, ok]) => !ok)
      .map(([key]) => key);
    if (failedCtChecks.length)
      throw new Error(`reference_original_ct_${failedCtChecks.join('_')}`);
    if (
      [record.biz, record.mid, record.idx, record.sn].some(
        (value, index) => String(value) !== oldFields.get(KEYS[index]),
      )
    )
      throw new Error('reference_verified_identity');
    const key = digest(oldFields);
    const reference = {
      key,
      oldFields,
      oldCt,
      recordedPublishTimeMatchesCt: oldCt === Number(record.currentPublishTime),
      oldHasJsContent: cheerio.load(oldHtml)('#js_content').length === 1,
      albumCreateTime: Number(item.create_time),
      requestUrl: listUrl,
      attempted:
        fs.existsSync(
          path.join(os.tmpdir(), `wewe-public-article-${key}.attempted`),
        ) ||
        fs.existsSync(
          path.join(os.tmpdir(), `wewe-public-reference-${key}.attempted`),
        ) ||
        PREVIOUS_LIVE_DIGESTS.has(key),
    };
    if (
      summarizePage(oldHtml, reference, parser).result !==
      'reference_identity_and_ct_match'
    )
      throw new Error('reference_staged_diagnostic');
    return reference;
  });
}

async function fetchOnce(url) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    const req = https.request(
      url,
      {
        method: 'GET',
        timeout: 12000,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://mp.weixin.qq.com/',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          res.destroy();
          done(null, { status });
          return;
        }
        if (!/^text\/html\b/i.test(String(res.headers['content-type'] || ''))) {
          res.destroy();
          done(null, { status, invalidContentType: true });
          return;
        }
        if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
          res.destroy();
          done(null, { status, responseLimit: true });
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            done(null, { status, responseLimit: true });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          done(null, { status, html: Buffer.concat(chunks).toString('utf8') }),
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

async function main() {
  let refs;
  try {
    refs = loadReferences();
  } catch (error) {
    const known = new Set([
      'arguments',
      'album_data',
      'saved_reference_count',
      'reference_album_identity',
      'reference_album_item_identity',
      'reference_verified_record',
      'reference_original_ct',
      'reference_verified_identity',
      'reference_staged_diagnostic',
      'invalid_article_url',
      'missing_or_ambiguous_identity',
      'invalid_identity_shape',
    ]);
    console.log(
      JSON.stringify({
        result: 'preflight_failed',
        reason:
          known.has(error.message) ||
          error.message.startsWith('reference_original_ct_')
            ? error.message
            : 'unexpected_local_error',
        requests: 0,
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (mode === 'preflight') {
    console.log(
      JSON.stringify({
        result: 'preflight_pass',
        requests: 0,
        savedReferences: refs.length,
        stagedDiagnosticPassCount: refs.length,
        candidates: refs.map((ref) => ({
          digest: ref.key,
          oldCtUtcDate: new Date(ref.oldCt * 1000).toISOString().slice(0, 10),
          ctMinusAlbumCreateSeconds: ref.oldCt - ref.albumCreateTime,
          oldHasJsContent: ref.oldHasJsContent,
          recordedPublishTimeMatchesCt: ref.recordedPublishTimeMatchesCt,
          attemptedThisRound: ref.attempted,
        })),
      }),
    );
    return;
  }
  const ref = refs.find((entry) => entry.key === chosenDigest);
  if (!ref || ref.attempted || !ref.oldHasJsContent) {
    console.log(JSON.stringify({ result: 'not_eligible', requests: 0 }));
    process.exitCode = 1;
    return;
  }
  try {
    const marker = path.join(
      os.tmpdir(),
      `wewe-public-reference-${ref.key}.attempted`,
    );
    const fd = fs.openSync(marker, 'wx');
    fs.writeSync(fd, `${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  } catch {
    console.log(JSON.stringify({ result: 'already_attempted', requests: 0 }));
    process.exitCode = 1;
    return;
  }
  let response;
  try {
    response = await fetchOnce(ref.requestUrl);
  } catch (error) {
    console.log(
      JSON.stringify({
        result: error.message === 'timeout' ? 'timeout' : 'network_error',
        requests: 1,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const base = { digest: ref.key, requests: 1, httpStatus: response.status };
  if (
    response.status !== 200 ||
    response.invalidContentType ||
    response.responseLimit
  ) {
    console.log(
      JSON.stringify({
        ...base,
        result:
          response.status >= 300 && response.status < 400
            ? 'redirect_or_verification_stop'
            : response.invalidContentType
              ? 'non_html_stop'
              : response.responseLimit
                ? 'response_limit_stop'
                : 'http_stop',
      }),
    );
    return;
  }
  const html = response.html;
  if (
    /wappoc_appmsgcaptcha|请输入验证码|为了你的帐号安全|访问过于频繁|环境异常/.test(
      html,
    )
  ) {
    console.log(
      JSON.stringify({
        ...base,
        result: 'verification_stop',
        hasJsContent: false,
      }),
    );
    return;
  }
  const cheerio = createRequire(path.resolve(parserPath))('cheerio');
  const hasJsContent = cheerio.load(html)('#js_content').length === 1;
  if (!hasJsContent) {
    console.log(
      JSON.stringify({ ...base, result: 'no_article_body_stop', hasJsContent }),
    );
    return;
  }
  const parser = require(path.resolve(parserPath));
  console.log(JSON.stringify({ ...base, ...summarizePage(html, ref, parser) }));
}

main();
