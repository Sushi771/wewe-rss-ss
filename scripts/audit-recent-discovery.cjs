// Offline diagnostic only. Sample originals are expectations, never discovery inputs.
// No network, imports, source changes or database writes are performed here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function audit({ database, originals, lists, mpId }) {
  const server = path.join(root, 'apps/server');
  const req = createRequire(path.join(server, 'package.json'));
  const { load } = req('cheerio');
  const { articleIdentity } = req(
    './dist/apps/server/src/collection/article-page.js',
  );
  const { canonicalArticleUrl } = req(
    './dist/apps/server/src/collection/collection-format.js',
  );
  const db = new DatabaseSync(fs.realpathSync(database), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw new Error('SQLITE_INTEGRITY_STOP');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('SQLITE_FOREIGN_KEY_STOP');
    const feeds = db
      .prepare(
        'SELECT id,mp_name,collection_channel,public_album_ids FROM feeds ORDER BY id',
      )
      .all();
    const feed = feeds.find((item) => item.id === mpId);
    if (!feed) throw new Error('SAVED_FEED_REQUIRED');
    const bound = JSON.parse(feed.public_album_ids || '[]');
    if (bound.length !== 1) throw new Error('SINGLE_BOUND_ALBUM_REQUIRED');
    const manifest = json(path.join(lists, 'manifest.json'));
    if (
      manifest.mpId !== mpId ||
      JSON.stringify(manifest.albumIds) !== JSON.stringify(bound)
    )
      throw new Error('LIST_MANIFEST_BINDING_STOP');
    const articles = new Map();
    const responses = [];
    const errors = [];
    const pages = [];
    // Read the preserved list responses, not either sample's HTML or local articles.
    for (const entry of manifest.responses.filter(
      (item) => item.kind === 'json',
    )) {
      if (path.basename(entry.file) !== entry.file)
        throw new Error('LIST_MANIFEST_PATH_STOP');
      const file = path.join(lists, entry.file);
      const bytes = fs.readFileSync(file);
      const url = new URL(entry.url);
      if (
        entry.status !== 200 ||
        sha256(bytes) !== entry.sha256 ||
        url.hostname !== 'mp.weixin.qq.com' ||
        url.pathname !== '/mp/appmsgalbum' ||
        !bound.includes(url.searchParams.get('album_id'))
      )
        throw new Error('LIST_MANIFEST_PROVENANCE_STOP');
      const saved = JSON.parse(bytes.toString('utf8'));
      const data = saved.data || saved;
      const response = data.getalbum_resp;
      if (!response) continue;
      if (
        Number(data.base_resp?.ret) !== 0 ||
        Number(response.verify_status) !== 0
      ) {
        errors.push({ file, reason: 'UPSTREAM_BUSINESS_FAILURE' });
        continue;
      }
      const list = Array.isArray(response.article_list)
        ? response.article_list
        : [response.article_list];
      for (const row of list) {
        if (!row?.url) throw new Error('LIST_SHAPE_STOP');
        const identity = canonicalArticleUrl(row.url);
        if (
          identity.mpId !== mpId ||
          identity.id !== `WX_${mpId.slice(7)}_${row.msgid}_${row.itemidx}`
        )
          throw new Error('LIST_IDENTITY_STOP');
        if (!Number.isInteger(Number(row.create_time)))
          throw new Error('LIST_TIME_STOP');
        articles.set(identity.id, {
          id: identity.id,
          title: row.title,
          publishTime: Number(row.create_time),
        });
      }
      pages.push({
        count: list.length,
        continueFlag: String(response.continue_flag),
        announcedCount:
          response.base_info?.article_count === undefined
            ? null
            : Number(response.base_info.article_count),
      });
      responses.push({ file, sha256: sha256(bytes) });
    }
    if (!responses.length) throw new Error('PRESERVED_LIST_RESPONSES_REQUIRED');
    if (
      pages.at(-1).continueFlag !== '0' ||
      !pages.some((page) => page.announcedCount === articles.size) ||
      pages.some(
        (page) =>
          page.announcedCount !== null && page.announcedCount !== articles.size,
      )
    )
      throw new Error('LIST_TERMINATION_COUNT_STOP');
    const checks = originals.map((directory) => {
      const file = path.join(directory, 'original.html');
      const bytes = fs.readFileSync(file);
      const saved = json(path.join(directory, 'result.json'));
      if (sha256(bytes) !== saved.originalSha256)
        throw new Error('ORIGINAL_HASH_STOP');
      const html = bytes.toString('utf8');
      const identity = articleIdentity(html);
      const $ = load(html);
      const title =
        $('#activity-name').text().trim() ||
        $('meta[property="og:title"]').attr('content');
      if (
        identity.mpId !== mpId ||
        identity.id !== saved.id ||
        !identity.publishTime ||
        title !== saved.title ||
        identity.canonical !== saved.canonical
      )
        throw new Error('ORIGINAL_IDENTITY_TIME_STOP');
      const rows = db
        .prepare(
          'SELECT id,source_url,verified_source_url FROM articles WHERE mp_id=?',
        )
        .all(mpId);
      const inDatabase = rows
        .filter(
          (row) =>
            row.id === identity.id ||
            [row.source_url, row.verified_source_url].some((url) => {
              try {
                return canonicalArticleUrl(url).id === identity.id;
              } catch {
                return false;
              }
            }),
        )
        .map((row) => row.id);
      return {
        id: identity.id,
        title,
        canonical: identity.canonical,
        publishTime: identity.publishTime,
        publishedUtc: new Date(identity.publishTime * 1000).toISOString(),
        original: {
          file,
          sha256: sha256(bytes),
          provenance: 'user-supplied-original-diagnostic-only',
        },
        returnedBySavedList: articles.has(identity.id),
        databaseIds: inDatabase,
        failureLayer: articles.has(identity.id)
          ? 'requires-local-chain-investigation'
          : 'not-returned-by-selected-album-list',
      };
    });
    return {
      observedAt: new Date().toISOString(),
      mode: 'offline-read-only-diagnostic',
      networkRequests: 0,
      databaseWrites: 0,
      database: fs.realpathSync(database),
      integrity: 'ok',
      counts: {
        feeds: feeds.length,
        articles: db.prepare('SELECT COUNT(*) AS n FROM articles').get().n,
        accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
      },
      protectedArticleSha256: sha256(
        JSON.stringify(db.prepare('SELECT * FROM articles ORDER BY id').all()),
      ),
      subscriptions: feeds.map((item) => ({
        id: item.id,
        name: item.mp_name,
        savedChannel: item.collection_channel,
        coverage:
          item.collection_channel === 'public-album'
            ? 'selected-albums'
            : 'no-enabled-source-verified-in-code',
      })),
      source: {
        id: feed.collection_channel,
        boundAlbumIds: bound,
        coverage: 'selected-albums',
        responses,
        pages,
        uniqueArticles: articles.size,
        errors,
      },
      samples: checks,
      checkpoint: {
        passed: false,
        reason: 'NO_ACCOUNT_LEVEL_RECENT_DISCOVERY_SOURCE',
        sampleCountIsNotCoverage: true,
      },
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        database: { type: 'string' },
        original: { type: 'string', multiple: true },
        lists: { type: 'string' },
        'mp-id': { type: 'string' },
        output: { type: 'string' },
      },
    });
    if (
      !values.database ||
      !values.original?.length ||
      !values.lists ||
      !/^MP_WXS_\d{5,15}$/.test(values['mp-id'] || '') ||
      !values.output
    )
      throw new Error('REQUIRE_DATABASE_ORIGINALS_LISTS_MP_ID_PRIVATE_OUTPUT');
    const privateRoot =
      fs.realpathSync(path.join(root, 'private-data')) + path.sep;
    const output = path.resolve(values.output);
    if (!output.startsWith(privateRoot))
      throw new Error('OUTPUT_MUST_BE_PRIVATE');
    const result = audit({
      database: values.database,
      originals: values.original,
      lists: values.lists,
      mpId: values['mp-id'],
    });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        output,
        counts: result.counts,
        coverage: result.source.coverage,
        listedArticles: result.source.uniqueArticles,
        samples: result.samples.map(
          ({ id, returnedBySavedList, databaseIds, failureLayer }) => ({
            id,
            returnedBySavedList,
            databaseIds,
            failureLayer,
          }),
        ),
        checkpoint: result.checkpoint,
      }),
    );
  } catch {
    console.error('AUDIT_STOP_NO_DATABASE_WRITE');
    process.exitCode = 1;
  }
}
module.exports = { audit };
