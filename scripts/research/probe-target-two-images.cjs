// Exactly two bounded GETs of one verified old article's distinct images.
// Dry-run and self-test make no network requests. All raw material stays private.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const TARGET_MP = 'MP_WXS_3895431412';
const TARGET_BIZ = 'Mzg5NTQzMTQxMg==';
const ARTICLE_DIGEST = '792e0623ba3ee739';
const IMAGE_DIGESTS = ['d306250f513bedc2', '7070eee8dd479e6a'];
const PRIOR_SINGLE_IMAGE_DIGEST = '862f10b2324802c9';
const MAX_BYTES = 10_000_000;
const TIMEOUT_MS = 10_000;
const server = path.resolve(__dirname, '../../apps/server');
const serverRequire = createRequire(path.join(server, 'package.json'));
const built = path.join(server, 'dist/apps/server/src');

function sha16(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function officialArticleDigest(raw) {
  const url = new URL(raw);
  const keys = [...url.searchParams.keys()];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.pathname !== '/s' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    keys.length !== 4 ||
    keys.some((key) => !['__biz', 'mid', 'idx', 'sn'].includes(key)) ||
    ['__biz', 'mid', 'idx', 'sn'].some(
      (key) => url.searchParams.getAll(key).length !== 1,
    ) ||
    url.searchParams.get('__biz') !== TARGET_BIZ
  )
    throw new Error('article_identity_gate');
  return sha16(
    ['__biz', 'mid', 'idx', 'sn']
      .map((key) => url.searchParams.get(key))
      .join('\0'),
  );
}

function imageSources(html, load) {
  const $ = load(html);
  return $('.rich_media_content img, #js_content img')
    .toArray()
    .map((node) => $(node).attr('data-src') || $(node).attr('src') || '');
}

function readCandidate(dbPath, load, allowedImageUrl) {
  if (!path.isAbsolute(dbPath) || !fs.statSync(dbPath).isFile())
    throw new Error('database_gate');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
      throw new Error('source_integrity_gate');
    const counts = {
      feeds: db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n,
      articles: db.prepare('SELECT COUNT(*) AS n FROM articles').get().n,
    };
    const rows = db
      .prepare(
        'SELECT id, verified_source_url, content_html, publish_time FROM articles WHERE mp_id = ? AND verified_source_url IS NOT NULL AND content_html IS NOT NULL',
      )
      .all(TARGET_MP);
    const matches = rows.filter(
      (row) =>
        officialArticleDigest(row.verified_source_url) === ARTICLE_DIGEST,
    );
    if (matches.length !== 1) throw new Error('unique_article_gate');
    const row = matches[0];
    const sources = imageSources(row.content_html, load);
    if (
      sources.length !== 2 ||
      new Set(sources).size !== 2 ||
      sources.some(
        (source, index) =>
          sha16(source) !== IMAGE_DIGESTS[index] ||
          sha16(source) === PRIOR_SINGLE_IMAGE_DIGEST,
      )
    )
      throw new Error('unique_images_gate');
    for (const source of sources) {
      const url = allowedImageUrl(source);
      if (url.hostname !== 'mmbiz.qpic.cn') throw new Error('image_host_gate');
      if (
        rows.some(
          (other) =>
            other.id !== row.id &&
            imageSources(other.content_html, load).includes(source),
        )
      )
        throw new Error('shared_image_gate');
    }
    const saved = fs
      .readdirSync(os.tmpdir())
      .filter((name) =>
        /^(?:wewe-identity-|wewe-target-).*\-20260927\.html$/.test(name),
      );
    if (
      saved.some((name) => {
        const inSaved = imageSources(
          fs.readFileSync(path.join(os.tmpdir(), name), 'utf8'),
          load,
        );
        return sources.some((source) => inSaved.includes(source));
      })
    )
      throw new Error('saved_html_image_gate');
    const privateDir = os.tmpdir();
    const existingMarkers = fs
      .readdirSync(privateDir)
      .filter((name) => name.endsWith('.attempted'));
    const sentinels = sources.map((source) => {
      const fullDigest = crypto
        .createHash('sha256')
        .update(source)
        .digest('hex');
      if (
        existingMarkers.some((name) => name.includes(fullDigest.slice(0, 16)))
      )
        throw new Error('already_attempted_gate');
      return path.join(
        privateDir,
        `wewe-target-two-images-${fullDigest}.attempted`,
      );
    });
    return {
      id: row.id,
      body: row.content_html,
      imageUrls: sources,
      sentinels,
      counts,
      savedHtmlCount: saved.length,
    };
  } finally {
    db.close();
  }
}

function validSignature(bytes, type) {
  if (type === 'image/png')
    return (
      bytes.length >= 20 &&
      bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
      bytes.subarray(-8, -4).toString() === 'IEND'
    );
  if (type === 'image/jpeg')
    return (
      bytes.length >= 5 &&
      bytes.subarray(0, 3).toString('hex') === 'ffd8ff' &&
      bytes.subarray(-2).toString('hex') === 'ffd9'
    );
  if (type === 'image/gif')
    return (
      bytes.length >= 4 &&
      bytes.subarray(0, 3).toString() === 'GIF' &&
      bytes[bytes.length - 1] === 0x3b
    );
  if (type === 'image/webp')
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString() === 'RIFF' &&
      bytes.subarray(8, 12).toString() === 'WEBP' &&
      bytes.readUInt32LE(4) + 8 === bytes.length
    );
  return false;
}

function oneGet(raw) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.request(
      raw,
      {
        method: 'GET',
        agent: false,
        headers: { referer: 'https://mp.weixin.qq.com/' },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status !== 200) {
          response.destroy();
          finish(new Error(`http_${status}`));
          return;
        }
        const type = String(response.headers['content-type'] || '')
          .split(';')[0]
          .toLowerCase();
        const lengthHeader = response.headers['content-length'];
        const declared = lengthHeader ? Number(lengthHeader) : null;
        if (
          !/^image\/(?:png|jpeg|gif|webp)$/.test(type) ||
          ![undefined, 'identity'].includes(
            response.headers['content-encoding'],
          ) ||
          (declared !== null &&
            (!Number.isSafeInteger(declared) || declared > MAX_BYTES))
        ) {
          response.destroy();
          finish(new Error('response_gate'));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            finish(new Error('image_too_large'));
          } else chunks.push(chunk);
        });
        response.once('end', () => {
          if (declared !== null && declared !== size) {
            finish(new Error('incomplete_body'));
            return;
          }
          const bytes = Buffer.concat(chunks);
          if (!validSignature(bytes, type)) {
            finish(new Error('image_signature_gate'));
            return;
          }
          finish(null, { bytes, type, declaredLength: declared });
        });
        response.once('error', () => finish(new Error('response_error')));
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish(new Error('timeout'));
    }, TIMEOUT_MS);
    request.once('error', () => finish(new Error('network_error')));
    request.end();
  });
}

function consistentCopy(source, destination) {
  const script = [
    'import sqlite3,sys',
    'src=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)',
    'src.execute("PRAGMA query_only=ON")',
    'dst=sqlite3.connect(sys.argv[2])',
    'src.backup(dst,pages=1000,sleep=0.1)',
    'assert dst.execute("PRAGMA quick_check").fetchone()[0]=="ok"',
    'dst.close();src.close()',
  ].join('\n');
  const result = spawnSync('python', ['-c', script, source, destination], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error('consistent_copy_gate');
}

function articleSnapshot(db, selectedId) {
  const hash = crypto.createHash('sha256');
  const rows = db.prepare('SELECT * FROM articles ORDER BY id').all();
  for (const row of rows) {
    if (row.id === selectedId) row.content_html = null;
    hash.update(JSON.stringify(row));
    hash.update('\n');
  }
  return { count: rows.length, digest: hash.digest('hex') };
}

function appRouter(prisma, directory) {
  const { CollectionService } = require(
    path.join(built, 'collection/collection.service'),
  );
  const { TrpcService } = require(path.join(built, 'trpc/trpc.service'));
  const { TrpcRouter } = require(path.join(built, 'trpc/trpc.router'));
  const collection = new CollectionService(prisma);
  const config = {
    get: (key) =>
      ({
        platform: { url: '' },
        feed: { updateDelayTime: 0, obsidianPath: directory },
        database: { type: 'sqlite' },
      })[key],
  };
  const trpc = new TrpcService(prisma, config, {}, collection);
  const router = new TrpcRouter(trpc, prisma, config, {}, collection);
  return {
    router,
    caller: router.appRouter.createCaller({ errorMsg: null, isLocal: true }),
  };
}

async function packAndCheck(directory, zipPath, expectedHashes) {
  const { ZipArchive } = serverRequire('archiver');
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.directory(directory, false);
    archive.finalize().catch(reject);
  });
  const script = [
    'import hashlib,json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' names=z.namelist()',
    ' assert z.testzip() is None',
    ' images=[n for n in names if "/attachments/image_" in n]',
    ' assert len(images)==2 and len(set(images))==2',
    ' assert sorted(hashlib.sha256(z.read(n)).hexdigest() for n in images)==sorted(json.loads(sys.argv[2]))',
    ' md=[n for n in names if n.endswith("/index.md")]',
    ' assert len(md)==1',
    ' assert all(n.split("/attachments/")[1].encode() in z.read(md[0]) for n in images)',
    ' assert "README.md" in names',
  ].join('\n');
  const result = spawnSync(
    'python',
    ['-c', script, zipPath, JSON.stringify(expectedHashes)],
    {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 30_000,
    },
  );
  if (result.status !== 0) throw new Error('zip_attachment_gate');
}

async function rehearse(dbPath, candidate, fetched) {
  if (fetched.length !== 2) throw new Error('rehearsal_image_count_gate');
  const { PrismaClient } = serverRequire('@prisma/client');
  const { archiveProviderImages } = require(
    path.join(built, 'collection/archive-provider-images'),
  );
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'wewe-image-rehearsal-'),
  );
  const copy = path.join(root, 'preserved.db');
  const scoped = path.join(root, 'scoped.db');
  const priorFetch = global.fetch;
  let prisma;
  let scopedPrisma;
  let phase = 'copy';
  try {
    consistentCopy(dbPath, copy);
    const migrated = new DatabaseSync(copy);
    try {
      const columns = migrated
        .prepare('PRAGMA table_info(feeds)')
        .all()
        .map((column) => column.name);
      if (!columns.includes('provider_refresh_attempt_time')) {
        const sql = fs.readFileSync(
          path.join(
            server,
            'prisma/migrations/20260929010000_provider_refresh_cooldown/migration.sql',
          ),
          'utf8',
        );
        if (
          sql.trim() !==
          'ALTER TABLE "feeds" ADD COLUMN "provider_refresh_attempt_time" INTEGER NOT NULL DEFAULT 0;'
        )
          throw new Error('migration_source_gate');
        migrated.exec(sql);
      }
    } finally {
      migrated.close();
    }
    phase = 'read_copy';
    const check = new DatabaseSync(copy);
    let before;
    let articleBaseline;
    try {
      articleBaseline = articleSnapshot(check, candidate.id);
      before = check
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(candidate.id);
      if (!before || before.content_html !== candidate.body)
        throw new Error('copy_article_gate');
    } finally {
      check.close();
    }
    const mockedCalls = new Map();
    const fetchedByUrl = new Map(
      candidate.imageUrls.map((url, index) => [url, fetched[index]]),
    );
    phase = 'archive';
    global.fetch = async (raw) => {
      const url = String(raw);
      const next = (mockedCalls.get(url) || 0) + 1;
      mockedCalls.set(url, next);
      const image = fetchedByUrl.get(url);
      if (!image || next !== 1) throw new Error('offline_fetch_gate');
      return new Response(image.bytes, {
        status: 200,
        headers: { 'content-type': image.type },
      });
    };
    const archived = await archiveProviderImages({
      articles: [{ id: candidate.id, contentHtml: candidate.body }],
      imageBlocked: 0,
      bodyMissing: 0,
    });
    global.fetch = async () => {
      throw new Error('offline_only');
    };
    if (
      mockedCalls.size !== 2 ||
      candidate.imageUrls.some((url) => mockedCalls.get(url) !== 1) ||
      archived.imageBlocked !== 0 ||
      archived.bodyMissing !== 0 ||
      (archived.articles[0].contentHtml?.match(/data:image\//g) || [])
        .length !== 2 ||
      candidate.imageUrls.some((url) =>
        archived.articles[0].contentHtml.includes(url),
      )
    )
      throw new Error('archive_gate');
    phase = 'write_copy';
    const changed = new DatabaseSync(copy);
    try {
      changed
        .prepare('UPDATE articles SET content_html = ? WHERE id = ?')
        .run(archived.articles[0].contentHtml, candidate.id);
      const after = changed
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(candidate.id);
      for (const key of Object.keys(before)) {
        if (key !== 'content_html' && after[key] !== before[key])
          throw new Error('old_field_changed_gate');
      }
      const articleAfter = articleSnapshot(changed, candidate.id);
      if (
        articleAfter.count !== articleBaseline.count ||
        articleAfter.digest !== articleBaseline.digest
      )
        throw new Error('all_articles_preservation_gate');
      if (changed.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
        throw new Error('copy_integrity_gate');
    } finally {
      changed.close();
    }
    prisma = new PrismaClient({
      datasources: { db: { url: `file:${copy.replace(/\\/g, '/')}` } },
    });
    phase = 'obsidian';
    const vault = path.join(root, 'vault');
    const { caller } = appRouter(prisma, vault);
    const saved = await caller.article.saveToObsidian(candidate.id);
    const markdown = await fsp.readFile(saved.path, 'utf8');
    const attachments = markdown.match(
      /attachments\/image_[a-f0-9]+\.(?:png|jpe?g|gif|webp)/g,
    );
    if (
      !attachments ||
      attachments.length !== 2 ||
      new Set(attachments).size !== 2
    )
      throw new Error('obsidian_attachment_gate');
    const actualHashes = [];
    for (const attachment of attachments) {
      const local = await fsp.readFile(
        path.join(path.dirname(saved.path), attachment),
      );
      actualHashes.push(
        crypto.createHash('sha256').update(local).digest('hex'),
      );
    }
    const expectedHashes = fetched.map((image) =>
      crypto.createHash('sha256').update(image.bytes).digest('hex'),
    );
    if (actualHashes.sort().join('\0') !== expectedHashes.sort().join('\0'))
      throw new Error('obsidian_bytes_gate');
    phase = 'scope_copy';
    consistentCopy(copy, scoped);
    const narrowed = new DatabaseSync(scoped);
    try {
      narrowed
        .prepare('DELETE FROM articles WHERE mp_id = ? AND id <> ?')
        .run(TARGET_MP, candidate.id);
    } finally {
      narrowed.close();
    }
    scopedPrisma = new PrismaClient({
      datasources: { db: { url: `file:${scoped.replace(/\\/g, '/')}` } },
    });
    phase = 'zip_directory';
    const { router } = appRouter(scopedPrisma, path.join(root, 'unused'));
    const folder = path.join(root, 'zip-contents');
    let result;
    try {
      result = await router.buildOfflineFeedDirectory(TARGET_MP, folder);
    } catch (error) {
      console.log(
        JSON.stringify({
          phase: 'zip_directory_exception',
          type: error.constructor.name,
          code: /^P\d{4}$/.test(error.code || '') ? error.code : null,
          missingPath: /ENOENT|no such file/i.test(error.message),
          databaseError: /database|sqlite|table/i.test(error.message),
        }),
      );
      throw error;
    }
    if (
      result?.articles !== 1 ||
      result.complete !== 1 ||
      result.incomplete.length
    ) {
      console.log(
        JSON.stringify({
          phase: 'zip_directory_counts',
          articles: result?.articles,
          complete: result?.complete,
          incomplete: result?.incomplete?.length,
        }),
      );
      throw new Error('zip_directory_gate');
    }
    phase = 'zip_archive';
    await packAndCheck(folder, path.join(root, 'feed.zip'), expectedHashes);
    return {
      obsidianAttachments: attachments.length,
      zipAttachments: 2,
      oldFieldsPreserved: true,
    };
  } catch {
    throw new Error(`rehearsal_${phase}`);
  } finally {
    global.fetch = priorFetch;
    await scopedPrisma?.$disconnect();
    await prisma?.$disconnect();
    const resolvedRoot = await fsp.realpath(root);
    const resolvedTemp = await fsp.realpath(os.tmpdir());
    if (
      path.dirname(resolvedRoot) !== resolvedTemp ||
      !path.basename(resolvedRoot).startsWith('wewe-image-rehearsal-')
    )
      throw new Error('temporary_cleanup_gate');
    await fsp.rm(resolvedRoot, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, dbPath, approval] = process.argv.slice(2);
  if (
    !['--dry-run', '--self-test', '--online'].includes(mode) ||
    !dbPath ||
    (mode === '--online' && approval !== '--approved-online') ||
    (mode !== '--online' && approval)
  )
    throw new Error('usage_gate');
  const { load } = serverRequire('cheerio');
  const { allowedImageUrl } = require(
    path.join(built, 'collection/image-fetch'),
  );
  const candidate = readCandidate(dbPath, load, allowedImageUrl);
  const base = {
    articleDigest: ARTICLE_DIGEST,
    imageDigests: IMAGE_DIGESTS,
    sourceCounts: candidate.counts,
    savedHtmlChecked: candidate.savedHtmlCount,
    selectedImageCount: 2,
    maxOnlineGets: 2,
    maxBytesPerImage: MAX_BYTES,
    timeoutMsPerImage: TIMEOUT_MS,
    redirects: false,
    retries: false,
    credentials: false,
  };
  if (mode === '--dry-run') {
    console.log(JSON.stringify({ ...base, gate: 'ready', networkGets: 0 }));
    return;
  }
  if (mode === '--self-test') {
    const synthetic = [
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
    ].map((base64) => ({
      bytes: Buffer.from(base64, 'base64'),
      type: 'image/png',
    }));
    const rehearsal = await rehearse(dbPath, candidate, synthetic);
    console.log(
      JSON.stringify({
        ...base,
        networkGets: 0,
        syntheticRehearsal: rehearsal,
      }),
    );
    return;
  }
  const fetched = [];
  for (const [index, raw] of candidate.imageUrls.entries()) {
    // The private marker is created atomically immediately before this one URL.
    try {
      fs.writeFileSync(
        candidate.sentinels[index],
        JSON.stringify({
          attemptedAtUtc: new Date().toISOString(),
          articleDigest: ARTICLE_DIGEST,
          imageDigest: IMAGE_DIGESTS[index],
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    } catch {
      console.log(
        JSON.stringify({
          ...base,
          networkGets: index,
          stoppedAtImage: index + 1,
          outcome: 'sentinel_gate',
        }),
      );
      return;
    }
    try {
      fetched.push(await oneGet(raw));
    } catch (error) {
      console.log(
        JSON.stringify({
          ...base,
          networkGets: index + 1,
          stoppedAtImage: index + 1,
          outcome: /^[a-z_0-9]+$/.test(error.message)
            ? error.message
            : 'network_gate',
        }),
      );
      return;
    }
  }
  let rehearsal;
  try {
    rehearsal = await rehearse(dbPath, candidate, fetched);
  } catch (error) {
    const phase = /^[a-z_]+$/.test(error.message)
      ? error.message
      : 'unknown_rehearsal_error';
    console.log(
      JSON.stringify({
        ...base,
        networkGets: 2,
        outcome: 'image_received_export_rehearsal_failed',
        phase,
        bytes: fetched.map((image) => image.bytes.length),
        types: fetched.map((image) => image.type),
      }),
    );
    return;
  }
  console.log(
    JSON.stringify({
      ...base,
      networkGets: 2,
      outcome: 'complete_images_and_scoped_exports',
      bytes: fetched.map((image) => image.bytes.length),
      types: fetched.map((image) => image.type),
      contentLengthMatched: fetched.map((image) =>
        image.declaredLength === null ? null : true,
      ),
      ...rehearsal,
    }),
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      outcome: /^[a-z_]+$/.test(error.message) ? error.message : 'probe_failed',
    }),
  );
  process.exitCode = 1;
});
