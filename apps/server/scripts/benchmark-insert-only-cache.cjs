/* Offline rehearsal only. Explicit source/cache paths are read-only inputs.
 * Every write, migration, deletion and restore is confined to a NEW work folder.
 * Run in apps/server with ts-node/register/transpile-only + tsconfig-paths/register.
 * The actual periodic owner's lease module/scripts must be present for the fast
 * branch. This script never enables any provider refresh or image transport. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { PrismaClient } = require('@prisma/client');
const { canonicalArticleUrl } = require('../src/collection/collection-format');
const { CollectionService } = require('../src/collection/collection.service');
const { TrpcService } = require('../src/trpc/trpc.service');
const guard = require('../src/collection/sqlite-snapshot-guard');
// Each sample needs a fresh owner process/generation for its NEW SQLite copy.
// Use the real lifecycle class, preserving its authentic in-memory lease checks.
let fixtureGuard;
guard.startSqliteSnapshotGuard = () => fixtureGuard.start();
guard.stopSqliteSnapshotGuard = () => fixtureGuard?.stop();
guard.recentVerifiedSqliteSnapshot = async () => {
  const health = await fixtureGuard.query();
  if (!health.verified || !health.fresh || !health.lease) return null;
  const lease = health.lease;
  return {
    source: lease.databasePath,
    sha256: lease.snapshotSha256,
    verifiedAtMs: lease.backupSucceededAtMs,
    lease,
  };
};
guard.assertInsertOnlySnapshotPermit = async (tx, snapshot) => {
  try {
    await fixtureGuard.assertLease(tx, snapshot.lease);
  } catch (error) {
    fs.writeFileSync(
      path.join(path.resolve(args['work-root']), 'lease-error.private.log'),
      error.stack || String(error),
    );
    throw error;
  }
};
guard.notifySqliteSnapshotDirty = (snapshot) =>
  fixtureGuard.markDirty(snapshot.lease);
const backup = require('../src/collection/sqlite-backup');
const { cacheRevision } = require('../src/feeds/cache-sync-state');
const python =
  process.env.SQLITE_BACKUP_PYTHON ||
  (process.platform === 'win32' ? 'python' : 'python3');
const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const at = raw.indexOf('=');
    if (at < 3) throw Error('EXPLICIT_NAMED_ARGUMENTS_REQUIRED');
    return [raw.slice(2, at), raw.slice(at + 1)];
  }),
);
const py = (code, parameters) => {
  const result = cp.spawnSync(python, ['-c', code, ...parameters], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fs.writeFileSync(
      path.join(path.resolve(args['work-root']), 'python-error.private.log'),
      result.stderr || String(result.error || 'unknown'),
    );
    throw Error('OFFLINE_PYTHON_REHEARSAL_FAILED');
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
};
const readAndCopy = `
import sys,sqlite3,json
from pathlib import Path
from contextlib import closing
source,cache,target,meta=map(Path,sys.argv[1:])
if source.resolve()==target.resolve() or cache.resolve()==target.resolve(): raise ValueError('isolation')
with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True)) as c:
  with closing(sqlite3.connect(target)) as d: c.backup(d)
  c.row_factory=sqlite3.Row
  feeds=[dict(r) for r in c.execute('select id,mp_name,collection_channel,status from feeds')]
  saved=[dict(r) for r in c.execute('select id,mp_id,title,publish_time,source_url,verified_source_url from articles')]
with closing(sqlite3.connect(cache.resolve().as_uri()+'?mode=ro',uri=True)) as c:
  c.row_factory=sqlite3.Row
  cached=[dict(r) for r in c.execute('select biz_id,url,title,created from articles order by created desc')]
meta.write_text(json.dumps(dict(feeds=feeds,saved=saved,cached=cached),ensure_ascii=False),encoding='utf-8')
print(json.dumps(dict(databaseBytes=source.stat().st_size,feeds=len(feeds),articles=len(saved),cached=len(cached))))
`;
const fingerprint = `
import sqlite3,json,sys,hashlib
from pathlib import Path
from contextlib import closing
db,selection=map(Path,sys.argv[1:]); selected=json.loads(selection.read_text(encoding='utf-8'))
def digest(rows):
  h=hashlib.sha256()
  for row in rows:
    h.update(json.dumps(list(row),ensure_ascii=False,default=lambda v:bytes(v).hex(),separators=(',',':')).encode());h.update(b'\\n')
  return h.hexdigest()
with closing(sqlite3.connect(db.resolve().as_uri()+'?mode=ro',uri=True)) as c:
  columns=[r[1] for r in c.execute('pragma table_info(feeds)')]
  allowed={'sync_time','update_time','has_history','last_collection_result','updated_at'}
  keep=[i for i,v in enumerate(columns) if v not in allowed]
  result={'protectedFeedFields':digest(tuple(row[i] for i in keep) for row in c.execute('select * from feeds order by id'))}
  ids=selected['ids']; q='select * from articles where id not in ('+','.join('?' for _ in ids)+') order by id'
  result['allOldArticleColumns']=digest(c.execute(q,ids))
  for (table,) in c.execute("select name from sqlite_master where type='table' and name not in ('articles','feeds','cache_insert_batches','sqlite_sequence') order by name"):
    quoted='"'+table.replace('"','""')+'"';result[table]=digest(c.execute('select * from '+quoted+' order by rowid'))
  result['articles']=c.execute('select count(*) from articles').fetchone()[0]
print(json.dumps(result))
`;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};
async function main() {
  const source = path.resolve(args['source-db'] || '');
  const cache = path.resolve(args['cache-db'] || '');
  const root = path.resolve(args['work-root'] || '');
  if (
    !args['source-db'] ||
    !args['cache-db'] ||
    !args['work-root'] ||
    !fs.statSync(root).isDirectory()
  )
    throw Error('EXPLICIT_EXISTING_INPUTS_REQUIRED');
  const samples = Number(args.samples || 6);
  const batchSize = Number(args['batch-size'] || 5);
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 20 ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 10
  )
    throw Error('BOUNDED_SAMPLES_REQUIRED');
  const work = fs.mkdtempSync(path.join(root, 'insert-only-cache-rehearsal-'));
  const seed = path.join(work, 'seed.db');
  const metaFile = path.join(work, 'cache-metadata.private.json');
  const input = py(readAndCopy, [source, cache, seed, metaFile]);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const known = (raw) => {
    try {
      return canonicalArticleUrl(raw);
    } catch {
      return null;
    }
  };
  let selected;
  for (const feed of meta.feeds.filter(
    (f) => f.status === 1 && f.collection_channel === 'wechat2rss',
  )) {
    const saved = meta.saved.filter((a) => a.mp_id === feed.id);
    if (
      saved.some(
        (a) =>
          !/^WX_\d{5,15}_\d+_[1-9]\d*$/.test(a.id) &&
          !a.source_url &&
          !a.verified_source_url,
      ) ||
      saved.some((a) =>
        [a.source_url, a.verified_source_url].some((url) => url && !known(url)),
      )
    )
      continue;
    const matches = new Map();
    for (const row of saved)
      for (const raw of [row.source_url, row.verified_source_url]) {
        const id = raw && known(raw)?.id;
        if (id) matches.set(id, row);
      }
    const articles = [];
    for (const row of meta.cached) {
      const identity = known(row.url);
      const previous = identity && matches.get(identity.id);
      if (
        !identity ||
        identity.mpId !== feed.id ||
        !previous ||
        previous.id !== identity.id ||
        articles.some((a) => a.id === identity.id)
      )
        continue;
      articles.push({
        ...identity,
        title: row.title,
        publishTime: previous.publish_time,
        contentHtml: null,
        picUrl: '',
      });
      if (articles.length === batchSize) break;
    }
    if (articles.length === batchSize) {
      selected = { feed, articles };
      break;
    }
  }
  if (!selected) throw Error('NO_VERIFIED_REAL_CACHE_BATCH_ELIGIBLE');
  const seedPrisma = new PrismaClient({
    datasources: { db: { url: 'file:' + seed.replace(/\\/g, '/') } },
  });
  try {
    await seedPrisma.$executeRawUnsafe(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'prisma/migrations/20261011090000_cache_insert_batches/migration.sql',
        ),
        'utf8',
      ),
    );
    // Rehearse the identical genuinely-absent identities in each isolated copy.
    // These sample rows are removed ONLY from the seed; the input is read only.
    await seedPrisma.article.deleteMany({
      where: { id: { in: selected.articles.map((a) => a.id) } },
    });
  } finally {
    await seedPrisma.$disconnect();
  }
  const selectionFile = path.join(work, 'selection.private.json');
  fs.writeFileSync(
    selectionFile,
    JSON.stringify({ ids: selected.articles.map((a) => a.id) }),
  );
  const before = py(fingerprint, [seed, selectionFile]);
  const page = {
    articles: selected.articles,
    coverage: 'stored-history-window',
    upstreamCount: batchSize,
    bodyMissing: batchSize,
    imageBlocked: 0,
  };
  process.env.WECHAT2RSS_ENABLED = '1';
  process.env.WECHAT2RSS_BASE_URL = 'http://127.0.0.1:1/';
  process.env.WECHAT2RSS_TOKEN = 'offline-unused';
  let networkRequests = 0;
  global.fetch = async () => {
    networkRequests++;
    throw Error('NETWORK_FORBIDDEN');
  };
  const axios = require('axios').default;
  axios.get = axios.post = async () => {
    networkRequests++;
    throw Error('NETWORK_FORBIDDEN');
  };
  let segments;
  let restoreSnapshot;
  const oldBackup = backup.createVerifiedSqliteBackup;
  backup.createVerifiedSqliteBackup = async (...parameters) => {
    const start = performance.now();
    try {
      const report = await oldBackup(...parameters);
      restoreSnapshot ||= report.backup;
      return report;
    } finally {
      segments.fullBackupMs += performance.now() - start;
      segments.fullBackupCalls++;
    }
  };
  for (const name of [
    'recentVerifiedSqliteSnapshot',
    'assertInsertOnlySnapshotPermit',
    'notifySqliteSnapshotDirty',
  ]) {
    const original = guard[name];
    guard[name] = async (...parameters) => {
      const start = performance.now();
      try {
        return await original(...parameters);
      } finally {
        segments[name + 'Ms'] += performance.now() - start;
      }
    };
  }
  const records = [];
  const prepareTime = [];
  for (let index = 0; index < samples; index++)
    for (const mode of ['old', 'fast']) {
      // Reuse only these two generated disposable files after both clients and
      // the previous owner have stopped. Immutable verified snapshots remain.
      const database = path.join(work, `${mode}.db`);
      fs.copyFileSync(seed, database);
      process.env.DATABASE_URL = 'file:' + database.replace(/\\/g, '/');
      process.env.SQLITE_INSERT_ONLY_FAST_PATH = mode === 'fast' ? '1' : '0';
      process.env.SQLITE_PERIODIC_SNAPSHOT_ENABLED =
        mode === 'fast' ? '1' : '0';
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      const originalTransaction = prisma.$transaction.bind(prisma);
      let transactionMs = 0;
      prisma.$transaction = async (...parameters) => {
        const start = performance.now();
        try {
          return await originalTransaction(...parameters);
        } finally {
          transactionMs += performance.now() - start;
        }
      };
      const service = new TrpcService(
        prisma,
        { get: () => ({ url: '', updateDelayTime: 0 }) },
        {},
        new CollectionService(prisma),
      );
      segments = {
        fullBackupMs: 0,
        fullBackupCalls: 0,
        recentVerifiedSqliteSnapshotMs: 0,
        assertInsertOnlySnapshotPermitMs: 0,
        notifySqliteSnapshotDirtyMs: 0,
      };
      try {
        if (mode === 'fast') {
          fixtureGuard = new guard.SqliteSnapshotGuard();
          const start = performance.now();
          await guard.startSqliteSnapshotGuard();
          let permit;
          for (let tries = 0; tries < 100 && !permit; tries++) {
            permit = await guard.recentVerifiedSqliteSnapshot();
            if (!permit) await new Promise((r) => setTimeout(r, 200));
          }
          if (!permit) throw Error('ACTUAL_SNAPSHOT_GUARD_NOT_READY');
          prepareTime.push(performance.now() - start);
          segments.recentVerifiedSqliteSnapshotMs = 0;
        }
        const revision = cacheRevision().revision;
        const start = performance.now();
        const result = await service.syncCachedWechat2RssPage(
          selected.feed.id,
          page,
          true,
        );
        const totalMs = performance.now() - start;
        assert.equal(result.created, batchSize);
        assert.equal(result.updated, 0);
        assert.equal(result.bodyReady, false);
        assert.notEqual(cacheRevision().revision, revision);
        if (segments.fullBackupCalls !== (mode === 'old' ? 1 : 0))
          console.log(
            JSON.stringify({
              mode,
              unexpectedFallback: true,
              ...segments,
              transactionMs,
            }),
          );
        assert.equal(segments.fullBackupCalls, mode === 'old' ? 1 : 0);
        const ledger = await prisma.$queryRawUnsafe(
          'SELECT COUNT(*) AS n FROM cache_insert_batches',
        );
        assert.equal(Number(ledger[0].n), mode === 'fast' ? 1 : 0);
        const after = py(fingerprint, [database, selectionFile]);
        assert.equal(after.articles, before.articles + batchSize);
        assert.deepEqual({ ...after, articles: 0 }, { ...before, articles: 0 });
        const repeatRevision = cacheRevision().revision;
        const repeats = await service.syncCachedWechat2RssPage(
          selected.feed.id,
          page,
          true,
        );
        assert.equal(repeats.created, 0);
        assert.equal(repeats.updated, 0);
        assert.equal(cacheRevision().revision, repeatRevision);
        records.push({ mode, index, totalMs, transactionMs, ...segments });
        console.log(
          JSON.stringify({
            sample: index,
            mode,
            totalMs,
            transactionMs,
            fullBackupMs: segments.fullBackupMs,
          }),
        );
      } finally {
        service.onModuleDestroy();
        guard.stopSqliteSnapshotGuard();
        await prisma.$disconnect();
      }
    }
  // Full snapshot restore is exercised on a separate target, never the input DB.
  // Later user edits are intentionally NOT removed by a per-batch DELETE tool.
  const restore = path.join(work, 'restored.db');
  assert.ok(restoreSnapshot);
  py(
    `import sqlite3,sys\nfrom pathlib import Path\nfrom contextlib import closing\ns,t=map(Path,sys.argv[1:])\nwith closing(sqlite3.connect(s.resolve().as_uri()+'?mode=ro',uri=True)) as a:\n assert a.execute('PRAGMA integrity_check').fetchall()==[('ok',)]\n with closing(sqlite3.connect(t)) as b:a.backup(b)`,
    [restoreSnapshot, restore],
  );
  assert.deepEqual(py(fingerprint, [restore, selectionFile]), before);
  assert.equal(networkRequests, 0);
  const summary = {
    schemaVersion: 1,
    samples,
    batchSize,
    input,
    scenario:
      'Existing verified cached metadata, chosen rows absent only in isolated seed. List INSERT only; no body/image readiness claim.',
    segments:
      'totalMs includes preflight, checks, transaction, local status and postcommit dirty; transactionMs includes lease assertions. Guard assertions overlap transactionMs and must not be added twice. Startup full snapshot, copy, schema prep and verification are excluded from save latency.',
    modes: Object.fromEntries(
      ['old', 'fast'].map((mode) => [
        mode,
        Object.fromEntries(
          [
            'totalMs',
            'transactionMs',
            'fullBackupMs',
            'recentVerifiedSqliteSnapshotMs',
            'assertInsertOnlySnapshotPermitMs',
            'notifySqliteSnapshotDirtyMs',
          ].map((field) => [
            field,
            stats(records.filter((r) => r.mode === mode).map((r) => r[field])),
          ]),
        ),
      ]),
    ),
    initialSnapshotMs: stats(prepareTime),
    oldRowsAndAllOtherTablesPreserved: true,
    duplicateDeliveryNoop: true,
    fullSnapshotRestorePassed: true,
    networkRequests,
    records,
  };
  fs.writeFileSync(
    path.join(work, 'benchmark-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
}
main().catch((error) => {
  guard.stopSqliteSnapshotGuard();
  fs.writeFileSync(
    path.join(path.resolve(args['work-root']), 'benchmark-error.private.log'),
    error.stack || String(error),
  );
  console.error('INSERT_ONLY_BENCHMARK_FAILED');
  process.exitCode = 1;
});
