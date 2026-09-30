// Reuse two already fetched user article pages; never request either original again.
// node scripts/album-acceptance-body-recent.cjs <prepare|verify> <main-root> <built-server-root>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const MP = 'MP_WXS_3895431412';
const DIRECTORIES = ['e327de2ad1eb292750d7', '66b7f4dbb553effbc7e4'];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const [mode, rootRaw, serverRaw] = process.argv.slice(2);
  if (!['prepare', 'verify'].includes(mode) || !rootRaw || !serverRaw)
    throw new Error('arguments');
  const root = fs.realpathSync(rootRaw);
  if (
    !/^private-data\/$/m.test(
      fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    )
  )
    throw new Error('private_ignore_gate');
  const base = path.join(root, 'private-data', 'user-recent-articles');
  const output = path.join(base, 'body-image-acceptance');
  fs.mkdirSync(output, { recursive: true });
  const built = path.join(
    path.resolve(serverRaw),
    'dist/apps/server/src/collection',
  );
  const parser = require(path.join(built, 'article-page.js'));
  const { allowedImageUrl, fetchAllowedImage, decodeInlineImage } = require(
    path.join(built, 'image-fetch.js'),
  );
  const { load } = createRequire(
    path.join(path.resolve(serverRaw), 'package.json'),
  )('cheerio');
  const listPath = path.join(base, 'album-lists', 'result.json');
  const listRaw = fs.readFileSync(listPath, 'utf8');
  const list = JSON.parse(listRaw);
  if (
    !Array.isArray(list.articles) ||
    list.articles.length !== 120 ||
    list.pages !== 13 ||
    list.albums.length !== 2
  )
    throw new Error('verified_list_gate');
  const cassette = {
    mpId: MP,
    capturedAt: new Date().toISOString(),
    sourceListResult: listPath,
    sourceListSha256: hash(listRaw),
    albumIds: list.ids,
    responses: [],
  };
  const articles = [];
  let requests = 0;
  for (let index = 0; index < DIRECTORIES.length; index++) {
    const name = DIRECTORIES[index];
    const source = path.join(base, name);
    const result = JSON.parse(
      fs.readFileSync(path.join(source, 'result.json'), 'utf8'),
    );
    const rawFile = path.join(source, 'original.html');
    const html = fs.readFileSync(rawFile, 'utf8');
    const identity = parser.articleIdentity(html);
    const listed = list.articles.find((article) => article.id === identity.id);
    if (
      result.status !== 200 ||
      hash(html) !== result.originalSha256 ||
      identity.mpId !== MP ||
      identity.id !== result.id ||
      identity.publishTime !== result.publishTime ||
      !listed ||
      identity.publishTime == null
    )
      throw new Error('original_identity_or_ct_gate');
    const canonical = new URL(identity.url);
    const listedCanonical = new URL(listed.url);
    if (
      ['__biz', 'mid', 'idx', 'sn'].some(
        (key) =>
          canonical.searchParams.get(key) !==
          listedCanonical.searchParams.get(key),
      )
    )
      throw new Error('list_canonical_identity_gate');
    const content = parser.articleContentHtml(html);
    if (!content) throw new Error('body_sanitization_gate');
    const $ = load(content);
    const nodes = $('img[src]').toArray();
    if (nodes.length !== (index === 0 ? 1 : 0))
      throw new Error('expected_image_count_gate');
    const expectedDate = index === 0 ? '2026-09-30' : '2026-09-29';
    if (
      new Date(identity.publishTime * 1000 + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 10) !== expectedDate
    )
      throw new Error('publication_date_gate');
    const articleDir = path.join(output, name);
    fs.mkdirSync(articleDir, { recursive: true });
    for (const node of nodes) {
      const url = $(node).attr('src');
      if (allowedImageUrl(url).hostname !== 'mmbiz.qpic.cn')
        throw new Error('image_host_gate');
      const imageFile = path.join(articleDir, 'image.bytes');
      const metadataFile = path.join(articleDir, 'image.json');
      const attemptFile = path.join(articleDir, 'image-attempt.json');
      let image;
      if (fs.existsSync(metadataFile) && fs.existsSync(imageFile)) {
        const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        const bytes = fs.readFileSync(imageFile);
        if (metadata.url !== url || metadata.sha256 !== hash(bytes))
          throw new Error('image_cache_integrity_gate');
        image = decodeInlineImage(
          `data:${metadata.contentType};base64,${bytes.toString('base64')}`,
        );
      } else {
        if (mode === 'verify' || fs.existsSync(attemptFile))
          throw new Error('image_missing_or_previous_attempt_stop');
        fs.writeFileSync(
          attemptFile,
          JSON.stringify({
            requestedAt: new Date().toISOString(),
            urlSha256: hash(url),
          }),
        );
        try {
          requests++;
          image = await fetchAllowedImage(url);
          decodeInlineImage(
            `data:${image.type};base64,${image.bytes.toString('base64')}`,
          );
          fs.writeFileSync(imageFile, image.bytes);
          fs.writeFileSync(
            metadataFile,
            JSON.stringify(
              {
                url,
                contentType: image.type,
                sha256: hash(image.bytes),
                status: 200,
                capturedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
        } catch {
          fs.writeFileSync(
            path.join(articleDir, 'image-stop.json'),
            JSON.stringify({
              reason: 'image_network_or_container_gate',
              time: new Date().toISOString(),
            }),
          );
          throw new Error('image_network_or_container_gate');
        }
      }
      $(node)
        .attr(
          'src',
          `data:${image.type};base64,${image.bytes.toString('base64')}`,
        )
        .removeAttr('data-src');
      cassette.responses.push({
        url,
        kind: 'image',
        file: imageFile,
        sha256: hash(image.bytes),
        contentType: image.type,
        status: 200,
      });
    }
    const localized = $.html($('.rich_media_content').first());
    const localizedPath = path.join(articleDir, 'localized.html');
    if (
      mode === 'verify' &&
      (!fs.existsSync(localizedPath) ||
        hash(fs.readFileSync(localizedPath)) !== hash(localized))
    )
      throw new Error('localized_body_integrity_gate');
    if (mode === 'prepare') fs.writeFileSync(localizedPath, localized);
    cassette.responses.push({
      url: result.url,
      aliases: [...new Set([identity.url, listed.requestUrl])].filter(Boolean),
      aliasProof: 'same_exact_biz_mid_idx_sn_in_verified_list_and_original',
      kind: 'html',
      file: rawFile,
      sha256: hash(html),
      contentType: 'text/html',
      status: 200,
      originallyCapturedAt: result.observedAt,
    });
    articles.push({
      ...identity,
      requestUrl: listed.requestUrl,
      actualOriginalRequestUrl: result.url,
      title: result.title,
      contentHtml: localized,
      albumCreateTime: listed.publishTime,
      originalPublishTime: identity.publishTime,
      ctMinusAlbumCreateSeconds: identity.publishTime - listed.publishTime,
      rawSha256: hash(html),
      bodySha256: hash(content),
      localizedSha256: hash(localized),
      imageCount: nodes.length,
    });
  }
  const prepared = { mpId: MP, sourceListSha256: hash(listRaw), articles };
  if (mode === 'prepare') {
    fs.writeFileSync(
      path.join(output, 'articles.json'),
      JSON.stringify(prepared, null, 2),
    );
    fs.writeFileSync(
      path.join(output, 'cassette.json'),
      JSON.stringify(cassette, null, 2),
    );
  } else {
    const old = JSON.parse(
      fs.readFileSync(path.join(output, 'articles.json'), 'utf8'),
    );
    if (hash(JSON.stringify(old)) !== hash(JSON.stringify(prepared)))
      throw new Error('prepared_article_integrity_gate');
  }
  console.log(
    JSON.stringify({
      result: mode + '_pass',
      originalRequests: 0,
      imageRequests: requests,
      articles: articles.length,
      images: articles.reduce((sum, article) => sum + article.imageCount, 0),
      identityAndCtVerified: true,
      sourceListArticles: list.articles.length,
      originalPublicationDatesShanghai: ['2026-09-30', '2026-09-29'],
    }),
  );
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      result: 'stopped',
      reason: /^[A-Za-z_]{3,80}$/.test(error.message)
        ? error.message
        : 'acceptance_gate_failed',
    }),
  );
  process.exitCode = 1;
});
