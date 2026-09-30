// Convert A's PRIVATE real-response evidence into an exact-URL/hash replay cassette.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const [sourcePath, runtimeRoot] = process.argv.slice(2);
const runtime = fs.realpathSync(runtimeRoot);
const source = fs.realpathSync(sourcePath);
const root = path.dirname(source);
const manifest = JSON.parse(fs.readFileSync(source, 'utf8'));
const serverRequire = createRequire(
  path.join(runtime, 'apps/server/package.json'),
);
const { load } = serverRequire('cheerio');
const built = path.join(runtime, 'apps/server/dist/apps/server/src/collection');
const { canonicalArticleUrl } = require(path.join(built, 'collection-format'));
const { decodeInlineImage } = require(path.join(built, 'image-fetch'));
const { publicArticleRequestUrl } = require(path.join(built, 'public-album'));
const key = (url) => canonicalArticleUrl(url).id;
const output = path.join(
  runtime,
  'private-data/album-loop-qa',
  `cassette-${crypto.randomUUID()}`,
);
fs.mkdirSync(output, { recursive: true });
const responses = [];
const save = (url, kind, bytes, contentType) => {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = `${digest}.${kind === 'json' ? 'json' : kind === 'html' ? 'html' : 'bin'}`;
  fs.writeFileSync(path.join(output, file), bytes);
  if (!responses.some((r) => r.url === url && r.kind === kind))
    responses.push({
      url,
      kind,
      file,
      sha256: digest,
      ...(contentType ? { contentType } : {}),
    });
};
const pages = fs
  .readdirSync(manifest.run)
  .filter((n) => /^page-\d+\.json$/.test(n))
  .sort();
let previous;
for (const name of pages) {
  const bytes = fs.readFileSync(path.join(manifest.run, name));
  const page = JSON.parse(bytes.toString('utf8'));
  const url = new URL('https://mp.weixin.qq.com/mp/appmsgalbum');
  for (const [k, v] of Object.entries({
    action: 'getalbum',
    __biz: manifest.biz,
    album_id: manifest.albumId,
    count: '10',
    f: 'json',
    ...(previous
      ? { begin_msgid: previous.msgid, begin_itemidx: previous.itemidx }
      : {}),
  }))
    url.searchParams.set(k, String(v));
  save(url.toString(), 'json', bytes);
  previous = page.getalbum_resp.article_list.at(-1);
}
let originals = 0,
  images = 0;
for (const directory of fs.readdirSync(root)) {
  const folder = path.join(root, directory);
  if (!fs.existsSync(path.join(folder, 'evidence.json'))) continue;
  const evidence = JSON.parse(
    fs.readFileSync(path.join(folder, 'evidence.json')),
  );
  const item = manifest.items.find((a) => key(a.url) === evidence.identity.id);
  assert(item, 'BODY_OUTSIDE_OFFICIAL_ALBUM');
  const raw = fs.readFileSync(path.join(folder, 'original.html'));
  assert.equal(
    crypto.createHash('sha256').update(raw).digest('hex'),
    evidence.rawSha256,
  );
  save(evidence.requestUrl || publicArticleRequestUrl(item.url), 'html', raw);
  originals++;
  const sanitized = load(
    fs.readFileSync(path.join(folder, 'sanitized.html'), 'utf8'),
  );
  const localized = load(
    fs.readFileSync(path.join(folder, 'localized.html'), 'utf8'),
  );
  const remote = sanitized('img[src]')
    .toArray()
    .map((n) => sanitized(n).attr('src'));
  const local = localized('img[src]')
    .toArray()
    .map((n) => localized(n).attr('src'));
  assert.equal(remote.length, local.length);
  for (let i = 0; i < local.length; i++) {
    const { bytes, type } = decodeInlineImage(local[i]);
    save(remote[i], 'image', bytes, type);
    images++;
  }
}
const outManifest = path.join(output, 'manifest.json');
fs.writeFileSync(
  outManifest,
  JSON.stringify(
    {
      mpId: manifest.mpId,
      capturedAt: manifest.observedAt,
      albumIds: [manifest.albumId],
      responses,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    officialPages: pages.length,
    realOriginals: originals,
    realImages: images,
    manifest: outManifest,
    boundary: 'saved actual official inputs; converter made no requests',
  }),
);
