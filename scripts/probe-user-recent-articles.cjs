// Exact user-supplied recent original links; no credentials, redirects or retries.
// Raw responses and one-shot markers persist only in ignored private-data.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'apps/server');
const req = createRequire(path.join(server, 'package.json'));
const { load } = req('cheerio');
const { articleIdentity, articleContentHtml } = require(
  path.join(server, 'dist/apps/server/src/collection/article-page.js'),
);
const evidence = path.join(root, 'private-data/user-recent-articles');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const save = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
function get(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        timeout: 15000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
          'Accept-Encoding': 'identity',
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error('HTTP_STOP_' + response.statusCode));
          return;
        }
        if (!/^text\/html\b/i.test(response.headers['content-type'] || '')) {
          response.destroy();
          reject(new Error('CONTENT_TYPE_STOP'));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 6 * 1024 * 1024) response.destroy(new Error('SIZE_STOP'));
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', () => reject(new Error('RESPONSE_STOP')));
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => reject(new Error('NETWORK_STOP')));
  });
}
async function main() {
  const urls = process.argv.slice(2);
  assert(urls.length > 0 && urls.length <= 2);
  fs.mkdirSync(evidence, { recursive: true });
  for (const raw of urls) {
    const url = new URL(raw);
    assert(
      url.protocol === 'https:' &&
        url.hostname === 'mp.weixin.qq.com' &&
        !url.port &&
        !url.username &&
        !url.password &&
        /^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname) &&
        !url.search &&
        !url.hash,
      'EXACT_SHORT_URL_REQUIRED',
    );
    const dir = path.join(evidence, hash(url.href).slice(0, 20));
    fs.mkdirSync(dir, { recursive: true });
    const original = path.join(dir, 'original.html'),
      marker = path.join(dir, 'attempt.json');
    if (!fs.existsSync(original)) {
      assert(!fs.existsSync(marker), 'PRIOR_ATTEMPT_STOP');
      fs.writeFileSync(
        marker,
        JSON.stringify({
          url: url.href,
          attemptedAt: new Date().toISOString(),
        }),
        { flag: 'wx' },
      );
      try {
        fs.writeFileSync(original, await get(url));
      } catch (error) {
        save(path.join(dir, 'stop.json'), { reason: error.message });
        throw error;
      }
    }
    try {
      const bytes = fs.readFileSync(original),
        html = bytes.toString('utf8'),
        $ = load(html);
      assert(
        $('#js_content').length &&
          !/访问过于频繁|环境异常|为了你的帐号安全/.test(
            $('#js_content').text(),
          ),
        'VERIFICATION_STOP',
      );
      const identity = articleIdentity(html);
      const identityUrl = new URL(identity.url);
      assert(
        identity.mpId === 'MP_WXS_3895431412' &&
          identityUrl.searchParams.get('sn') &&
          identity.publishTime,
        'IDENTITY_CT_STOP',
      );
      assert(identity.canonical === url.href, 'SHORT_CANONICAL_STOP');
      const body = articleContentHtml(html);
      assert(body, 'BODY_STOP');
      fs.writeFileSync(path.join(dir, 'sanitized.html'), body);
      const candidates = new Map();
      const decoded = html
        .replace(/\\x([0-9a-f]{2})/gi, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        )
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        )
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
      const links = [
        ...$('a[href]')
          .toArray()
          .map((n) => $(n).attr('href')),
        ...decoded.matchAll(
          /https:\/\/mp\.weixin\.qq\.com\/mp\/appmsgalbum[^\s"'<>\\]*/g,
        ),
      ].map((v) => (typeof v === 'string' ? v : v[0]));
      for (const link of links) {
        try {
          const u = new URL(link);
          if (
            u.hostname === 'mp.weixin.qq.com' &&
            u.pathname === '/mp/appmsgalbum' &&
            u.searchParams.get('__biz') ===
              identityUrl.searchParams.get('__biz') &&
            /^\d{10,30}$/.test(u.searchParams.get('album_id') || '')
          )
            candidates.set(u.searchParams.get('album_id'), u.href);
        } catch {}
      }
      const result = {
        url: url.href,
        observedAt: new Date().toISOString(),
        status: 200,
        originalSha256: hash(bytes),
        ...identity,
        title:
          $('#activity-name').text().trim() ||
          $('meta[property="og:title"]').attr('content'),
        published: new Date(identity.publishTime * 1000).toISOString(),
        imageReferences: load(body)('img[src]').length,
        albumLinks: [...candidates.entries()].map(([id, link]) => ({
          id,
          link,
        })),
        albumInfoPresent: /\balbum_info_list\b/.test(html),
        evidenceDirectory: dir,
      };
      save(path.join(dir, 'result.json'), result);
      console.log(
        JSON.stringify({
          status: 200,
          id: result.id,
          title: result.title,
          published: result.published,
          imageReferences: result.imageReferences,
          albumIds: result.albumLinks.map((x) => x.id),
          evidenceDirectory: dir,
        }),
      );
    } catch (error) {
      save(path.join(dir, 'stop.json'), { reason: error.message });
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
main().catch((error) => {
  console.error(
    error.message.startsWith('HTTP_STOP_')
      ? error.message
      : 'PROBE_STOP_CHECK_PRIVATE_EVIDENCE',
  );
  process.exitCode = 1;
});
