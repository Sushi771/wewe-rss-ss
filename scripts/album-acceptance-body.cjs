// Bounded real official-album acceptance. Raw inputs and outputs stay Git-ignored.
// node scripts/album-acceptance-body.cjs <list|verify|inspect|body|images|legacy-images|legacy-images-preflight> <main-root> <server-root> [index]
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const MP = 'MP_WXS_3895431412';
const BIZ = 'Mzg5NTQzMTQxMg==';
const ALBUM = '3588220544052641807';
const FAILED = new Set([
  'e28e53cb45b7c1eb',
  '792e0623ba3ee739',
  '8c460d508c0aae1b',
]);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const delay = () => new Promise((resolve) => setTimeout(resolve, 2000));

function official(raw) {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.pathname !== '/s' ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('article_url_gate');
  const q = url.searchParams;
  if (
    q.get('__biz') !== BIZ ||
    !/^\d+$/.test(q.get('mid') || '') ||
    !/^[1-9]\d*$/.test(q.get('idx') || '') ||
    !/^[a-f0-9]{16,64}$/i.test(q.get('sn') || '') ||
    ['__biz', 'mid', 'idx', 'sn'].some((key) => q.getAll(key).length !== 1)
  )
    throw new Error('article_identity_gate');
  url.protocol = 'https:';
  url.hash = '';
  return url;
}

// Native HTTPS has no proxy, retries, redirects or credential jar.
async function get(url, maxBytes, expectedType) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 15000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
          'Accept-Encoding': 'identity',
          Referer: 'https://mp.weixin.qq.com/',
        },
      },
      (res) => {
        const type = String(res.headers['content-type'] || '')
          .split(';')[0]
          .toLowerCase();
        if (res.statusCode !== 200 || !expectedType.test(type)) {
          res.destroy();
          reject(new Error('http_or_content_type_gate'));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new Error('response_size_gate'));
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            bytes: Buffer.concat(chunks),
            type,
            status: res.statusCode,
          }),
        );
        res.on('error', () => reject(new Error('response_network_error')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new Error('request_network_error')));
  });
}

async function main() {
  const [mode, mainRootRaw, serverRootRaw, indexRaw] = process.argv.slice(2);
  if (
    ![
      'list',
      'verify',
      'inspect',
      'body',
      'images',
      'legacy-images',
      'legacy-images-preflight',
    ].includes(mode) ||
    !mainRootRaw ||
    !serverRootRaw
  )
    throw new Error('arguments');
  const mainRoot = fs.realpathSync(mainRootRaw);
  if (
    !/^private-data\/$/m.test(
      fs.readFileSync(path.join(mainRoot, '.gitignore'), 'utf8'),
    )
  )
    throw new Error('private_ignore_gate');
  const dir = path.join(mainRoot, 'private-data', 'album-acceptance-20260930');
  fs.mkdirSync(dir, { recursive: true });
  const blocked = path.join(dir, 'network-blocked.json');
  const manifestPath = path.join(dir, 'manifest.json');
  const built = path.join(
    path.resolve(serverRootRaw),
    'dist/apps/server/src/collection',
  );
  const parser = require(path.join(built, 'article-page.js'));
  const requireServer = createRequire(
    path.join(path.resolve(serverRootRaw), 'package.json'),
  );
  const { load } = requireServer('cheerio');
  if (mode === 'legacy-images' || mode === 'legacy-images-preflight') {
    const { DatabaseSync } = require('node:sqlite');
    const { allowedImageUrl, fetchAllowedImage, decodeInlineImage } = require(
      path.join(built, 'image-fetch.js'),
    );
    const qaDir = path.join(mainRoot, 'private-data', 'album-loop-qa');
    const inputPath = path.join(qaDir, 'legacy-image-input.json');
    const inputRaw = fs.readFileSync(inputPath, 'utf8');
    const input = JSON.parse(inputRaw);
    const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      input.mpId !== MP ||
      String(input.albumId) !== ALBUM ||
      !Array.isArray(input.items) ||
      input.items.length > 1140
    )
      throw new Error('legacy_scope_gate');
    const scopeKeys = new Set(
      current.items.map((item) => {
        const q = official(item.url).searchParams;
        return ['__biz', 'mid', 'idx'].map((key) => q.get(key)).join('\0');
      }),
    );
    const copyPath = fs.realpathSync(path.resolve(qaDir, input.sourceCopy));
    if (!copyPath.startsWith(fs.realpathSync(qaDir) + path.sep))
      throw new Error('legacy_copy_path_gate');
    const db = new DatabaseSync(copyPath, { readOnly: true });
    const images = new Map();
    try {
      db.exec('PRAGMA query_only=ON');
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
        throw new Error('legacy_copy_integrity_gate');
      for (const item of input.items) {
        const row = db
          .prepare(
            'SELECT mp_id,verified_source_url,source_url,content_html FROM articles WHERE id=?',
          )
          .get(item.articleId);
        if (
          !row ||
          row.mp_id !== MP ||
          !row.content_html ||
          hash(row.content_html) !== item.bodyHash
        )
          throw new Error('legacy_body_hash_gate');
        const source = new URL(row.verified_source_url || row.source_url);
        const key = ['__biz', 'mid', 'idx']
          .map((field) => source.searchParams.get(field))
          .join('\0');
        if (source.hostname !== 'mp.weixin.qq.com' || !scopeKeys.has(key))
          throw new Error('legacy_article_scope_gate');
        const $ = load(row.content_html);
        const srcs = $('img')
          .toArray()
          .map((node) => {
            const src = $(node).attr('src');
            return src?.startsWith('data:image/')
              ? src
              : $(node).attr('data-src') || src;
          });
        if (!srcs.includes(item.url)) throw new Error('legacy_exact_src_gate');
        const url = allowedImageUrl(item.url);
        if (url.hostname !== 'mmbiz.qpic.cn')
          throw new Error('legacy_image_host_gate');
        const ids = images.get(item.url) || new Set();
        ids.add(item.articleId);
        images.set(item.url, ids);
      }
    } finally {
      db.close();
    }
    if (mode === 'legacy-images-preflight') {
      console.log(
        JSON.stringify({
          result: 'legacy_images_preflight_pass',
          requests: 0,
          scopeArticles: scopeKeys.size,
          articles: new Set(input.items.map((item) => item.articleId)).size,
          imageReferences: input.items.length,
          distinctImageURLs: images.size,
        }),
      );
      return;
    }
    const imageDir = path.join(dir, 'legacy-images');
    fs.mkdirSync(imageDir, { recursive: true });
    const stopPath = path.join(imageDir, 'network-blocked.json');
    if (fs.existsSync(stopPath) || fs.existsSync(blocked))
      throw new Error('legacy_prior_failure_stop');
    const outputPath = path.join(imageDir, 'manifest.json');
    const savedManifest = fs.existsSync(outputPath)
      ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      : null;
    const saved = savedManifest?.responses || [];
    const responses = [];
    let requests = 0;
    const persist = () =>
      fs.writeFileSync(
        outputPath,
        JSON.stringify(
          {
            mpId: MP,
            albumId: ALBUM,
            inputSha256: hash(inputRaw),
            capturedAt: savedManifest?.capturedAt || new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
            responses,
          },
          null,
          2,
        ),
      );
    for (const [url, articleIds] of images) {
      const existing = saved.find((entry) => entry.url === url);
      try {
        if (existing) {
          const bytes = fs.readFileSync(existing.file);
          if (hash(bytes) !== existing.sha256)
            throw new Error('legacy_cache_hash_gate');
          decodeInlineImage(
            `data:${existing.contentType};base64,${bytes.toString('base64')}`,
          );
          responses.push({ ...existing, articleIds: [...articleIds] });
          persist();
          continue;
        }
        if (requests) await delay();
        requests++;
        const result = await fetchAllowedImage(url);
        decodeInlineImage(
          `data:${result.type};base64,${result.bytes.toString('base64')}`,
        );
        const file = path.join(imageDir, hash(url) + '.image');
        fs.writeFileSync(file, result.bytes);
        responses.push({
          url,
          kind: 'image',
          file,
          sha256: hash(result.bytes),
          contentType: result.type,
          status: 200,
          bytes: result.bytes.length,
          articleIds: [...articleIds],
        });
        persist();
        console.log(
          JSON.stringify({
            result: 'legacy_image_pass',
            completed: responses.length,
            total: images.size,
            bytes: result.bytes.length,
          }),
        );
      } catch (error) {
        fs.writeFileSync(
          stopPath,
          JSON.stringify({
            time: new Date().toISOString(),
            urlSha256: hash(url),
            reason: /^[A-Z_]+$/.test(error.message)
              ? error.message
              : 'legacy_image_gate_failed',
          }),
        );
        persist();
        throw error;
      }
    }
    console.log(
      JSON.stringify({
        result: 'legacy_images_pass',
        requests,
        images: responses.length,
        totalBytes: responses.reduce((sum, entry) => sum + entry.bytes, 0),
        persistent: true,
      }),
    );
    return;
  }
  if (mode === 'list') {
    if (fs.existsSync(blocked)) throw new Error('prior_limit_stop');
    const run = path.join(dir, `list-${Date.now()}`);
    fs.mkdirSync(run);
    const items = [];
    let cursor = {};
    let complete = false;
    try {
      for (let page = 0; page < 5; page++) {
        if (page) await delay();
        const url = new URL('https://mp.weixin.qq.com/mp/appmsgalbum');
        for (const [key, val] of Object.entries({
          action: 'getalbum',
          __biz: BIZ,
          album_id: ALBUM,
          count: '10',
          f: 'json',
          ...cursor,
        }))
          url.searchParams.set(key, val);
        const result = await get(
          url,
          5_000_000,
          /^(application\/json|text\/plain)$/,
        );
        fs.writeFileSync(path.join(run, `page-${page + 1}.json`), result.bytes);
        const json = JSON.parse(result.bytes.toString('utf8'));
        const response = json.getalbum_resp;
        if (
          ![0, '0'].includes(json.base_resp?.ret) ||
          ![0, '0'].includes(response?.verify_status) ||
          !Array.isArray(response.article_list)
        )
          throw new Error('album_verification_or_status_gate');
        for (const item of response.article_list) {
          const articleUrl = official(item.url);
          if (
            articleUrl.searchParams.get('mid') !== String(item.msgid) ||
            articleUrl.searchParams.get('idx') !== String(item.itemidx)
          )
            throw new Error('album_identity_mismatch');
          items.push(item);
        }
        if (String(response.continue_flag) === '0') {
          complete = true;
          break;
        }
        if (
          String(response.continue_flag) !== '1' ||
          !response.article_list.length
        )
          throw new Error('album_cursor_gate');
        const last = response.article_list.at(-1);
        cursor = {
          begin_msgid: String(last.msgid),
          begin_itemidx: String(last.itemidx),
        };
      }
      const keys = items.map((item) => `${item.msgid}_${item.itemidx}`);
      if (!complete || new Set(keys).size !== items.length)
        throw new Error('album_completion_gate');
      const first = JSON.parse(
        fs.readFileSync(path.join(run, 'page-1.json'), 'utf8'),
      );
      if (
        Number(first.getalbum_resp.base_info.article_count) !== items.length ||
        first.getalbum_resp.base_info.nickname !== '妈妈部落畅聊阁' ||
        first.getalbum_resp.base_info.title !== '复旦数学营'
      )
        throw new Error('album_account_or_count_gate');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            mpId: MP,
            biz: BIZ,
            albumId: ALBUM,
            run,
            items,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          result: 'list_pass',
          articles: items.length,
          pages: fs.readdirSync(run).length,
          keySetSha256: hash(keys.sort().join('\n')),
          persistent: true,
        }),
      );
    } catch (error) {
      fs.writeFileSync(
        blocked,
        JSON.stringify({
          time: new Date().toISOString(),
          reason: error.message,
        }),
      );
      throw error;
    }
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (mode === 'verify') {
    const { decodeInlineImage } = require(path.join(built, 'image-fetch.js'));
    let articles = 0;
    let images = 0;
    const uniqueImages = new Set();
    const deltas = [];
    for (const item of manifest.items) {
      const expected = official(item.url).searchParams;
      const digest = hash(
        ['__biz', 'mid', 'idx', 'sn']
          .map((key) => expected.get(key))
          .join('\0'),
      ).slice(0, 16);
      const articleDir = path.join(dir, digest);
      const rawPath = path.join(articleDir, 'original.html');
      if (!fs.existsSync(rawPath)) continue;
      const html = fs.readFileSync(rawPath, 'utf8');
      const evidence = JSON.parse(
        fs.readFileSync(path.join(articleDir, 'evidence.json'), 'utf8'),
      );
      const identity = parser.articleIdentity(html);
      const actual = new URL(identity.url).searchParams;
      const cleaned = parser.articleContentHtml(html);
      if (
        !identity.publishTime ||
        identity.mpId !== MP ||
        ['__biz', 'mid', 'idx', 'sn'].some(
          (key) => actual.get(key) !== expected.get(key),
        ) ||
        hash(html) !== evidence.rawSha256 ||
        !cleaned ||
        hash(cleaned) !== evidence.bodySha256
      )
        throw new Error('offline_identity_or_hash_gate');
      const localized = fs.readFileSync(
        path.join(articleDir, 'localized.html'),
        'utf8',
      );
      const metadata = JSON.parse(
        fs.readFileSync(path.join(articleDir, 'images.json'), 'utf8'),
      );
      if (
        hash(localized) !== metadata.localizedSha256 ||
        hash(cleaned) !== metadata.sourceBodySha256
      )
        throw new Error('offline_image_cache_gate');
      const $ = load(localized);
      const imageHashes = $('img[src]')
        .toArray()
        .map((node) => hash(decodeInlineImage($(node).attr('src')).bytes));
      if (
        JSON.stringify(imageHashes) !== JSON.stringify(metadata.imageSha256) ||
        imageHashes.length !== evidence.imageCount
      )
        throw new Error('offline_image_integrity_gate');
      imageHashes.forEach((value) => uniqueImages.add(value));
      images += imageHashes.length;
      articles++;
      deltas.push(identity.publishTime - Number(item.create_time));
    }
    if (articles < 5) throw new Error('five_article_acceptance_gate');
    console.log(
      JSON.stringify({
        result: 'offline_verify_pass',
        requests: 0,
        articles,
        images,
        distinctImageByteHashes: uniqueImages.size,
        ctDeltaMin: Math.min(...deltas),
        ctDeltaMax: Math.max(...deltas),
      }),
    );
    return;
  }
  const index = Number(indexRaw);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= manifest.items.length
  )
    throw new Error('index_gate');
  const item = manifest.items[index];
  const url = official(item.url);
  const digest = hash(
    ['__biz', 'mid', 'idx', 'sn']
      .map((key) => url.searchParams.get(key))
      .join('\0'),
  ).slice(0, 16);
  const articleDir = path.join(dir, digest);
  fs.mkdirSync(articleDir, { recursive: true });
  const rawPath = path.join(articleDir, 'original.html');
  if (mode === 'body') {
    if (
      fs.existsSync(blocked) ||
      FAILED.has(digest) ||
      fs.existsSync(path.join(articleDir, 'failed.json'))
    )
      throw new Error('prior_limit_or_failure_stop');
    try {
      const result = await get(url, 10_000_000, /^text\/html$/);
      fs.writeFileSync(rawPath, result.bytes);
    } catch (error) {
      fs.writeFileSync(
        blocked,
        JSON.stringify({
          time: new Date().toISOString(),
          reason: error.message,
        }),
      );
      throw error;
    }
  }
  try {
    const html = fs.readFileSync(rawPath, 'utf8');
    const $ = load(html);
    // A verified js_content body can mention client captcha modules; only actual challenge pages block.
    if (
      !$('#js_content').length ||
      /访问过于频繁|环境异常|为了你的帐号安全/.test($('#js_content').text())
    )
      throw new Error('article_verification_or_body_gate');
    const identity = parser.articleIdentity(html);
    const actual = new URL(identity.url);
    if (
      identity.mpId !== MP ||
      ['__biz', 'mid', 'idx', 'sn'].some(
        (key) => url.searchParams.get(key) !== actual.searchParams.get(key),
      ) ||
      !identity.publishTime
    )
      throw new Error('article_identity_or_ct_gate');
    const contentHtml = parser.articleContentHtml(html);
    if (!contentHtml) throw new Error('sanitized_body_gate');
    // Retain and resolve a local parser-only stop after proving all identities agree.
    if (
      mode === 'inspect' &&
      fs.existsSync(blocked) &&
      JSON.parse(fs.readFileSync(blocked, 'utf8')).reason ===
        'article_identity_or_ct_gate'
    ) {
      fs.renameSync(blocked, path.join(dir, 'parser-stop-resolved.json'));
      if (fs.existsSync(path.join(articleDir, 'failed.json')))
        fs.renameSync(
          path.join(articleDir, 'failed.json'),
          path.join(articleDir, 'parser-stop-resolved.json'),
        );
    }
    fs.writeFileSync(path.join(articleDir, 'sanitized.html'), contentHtml);
    const clean = load(contentHtml);
    const sources = clean('img[src]')
      .toArray()
      .map((node) => clean(node).attr('src'));
    if (mode === 'images') {
      if (fs.existsSync(blocked)) throw new Error('prior_limit_stop');
      const { archiveProviderImages } = require(
        path.join(built, 'archive-provider-images.js'),
      );
      const cachePath = path.join(articleDir, 'images.json');
      const oldImages = fs.existsSync(cachePath)
        ? JSON.parse(fs.readFileSync(cachePath, 'utf8'))
        : null;
      const cachedBody =
        oldImages?.sourceBodySha256 === hash(contentHtml) &&
        fs.existsSync(path.join(articleDir, 'localized.html'))
          ? fs.readFileSync(path.join(articleDir, 'localized.html'), 'utf8')
          : null;
      const localized = cachedBody
        ? {
            articles: [{ ...identity, contentHtml: cachedBody }],
            bodyMissing: 0,
            imageBlocked: 0,
          }
        : await archiveProviderImages({
            articles: [{ ...identity, title: item.title, contentHtml }],
            bodyMissing: 0,
            imageBlocked: 0,
          });
      if (
        localized.bodyMissing ||
        localized.imageBlocked ||
        !localized.articles[0].contentHtml
      )
        throw new Error('image_localization_gate');
      fs.writeFileSync(
        path.join(articleDir, 'localized.html'),
        localized.articles[0].contentHtml,
      );
      const inline = load(localized.articles[0].contentHtml);
      const { decodeInlineImage } = require(path.join(built, 'image-fetch.js'));
      const hashes = inline('img[src]')
        .toArray()
        .map((node) => hash(decodeInlineImage(inline(node).attr('src')).bytes));
      if (hashes.length !== sources.length) throw new Error('image_count_gate');
      if (
        cachedBody &&
        (hash(localized.articles[0].contentHtml) !==
          oldImages.localizedSha256 ||
          JSON.stringify(hashes) !== JSON.stringify(oldImages.imageSha256))
      )
        throw new Error('image_cache_integrity_gate');
      fs.writeFileSync(
        path.join(articleDir, 'images.json'),
        JSON.stringify(
          {
            sourceBodySha256: hash(contentHtml),
            localizedSha256: hash(localized.articles[0].contentHtml),
            imageSha256: hashes,
          },
          null,
          2,
        ),
      );
    }
    const evidence = {
      identity,
      requestUrl: url.toString(),
      albumCreateTime: Number(item.create_time),
      ctMinusAlbumCreateSeconds:
        identity.publishTime - Number(item.create_time),
      rawSha256: hash(html),
      bodySha256: hash(contentHtml),
      imageCount: sources.length,
      rawSavedAt: fs.statSync(rawPath).mtime.toISOString(),
      observedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(articleDir, 'evidence.json'),
      JSON.stringify(evidence, null, 2),
    );
    console.log(
      JSON.stringify({
        result: mode + '_pass',
        index,
        keyDigest: digest,
        identityAndCtVerified: true,
        ctMinusAlbumCreateSeconds: evidence.ctMinusAlbumCreateSeconds,
        bodyCharacters: clean.text().trim().length,
        imageCount: sources.length,
        localized: mode === 'images',
        bodySha256: evidence.bodySha256,
      }),
    );
  } catch (error) {
    if (mode === 'body' || mode === 'images') {
      fs.writeFileSync(
        blocked,
        JSON.stringify({
          time: new Date().toISOString(),
          reason: error.message,
        }),
      );
      fs.writeFileSync(
        path.join(articleDir, 'failed.json'),
        JSON.stringify({ reason: error.message }),
      );
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      result: 'stopped',
      reason: /^[A-Za-z_]{3,80}$/.test(error.message)
        ? error.message
        : 'acceptance_gate_failed_check_private_evidence',
    }),
  );
  process.exitCode = 1;
});
