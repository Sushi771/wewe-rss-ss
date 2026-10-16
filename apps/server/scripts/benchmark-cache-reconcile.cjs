// Offline: run from repository root with Node and Python installed.
// Compares pinned baseline/current engines using the unchanged production SQL on
// one small synthetic SQLite database. No provider, production config, or HTTP.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const ts = require('../node_modules/typescript');
const repo = path.resolve(__dirname, '../../..');
const baseline = 'f82fadeba752cffbc8934010c0bd05dc35b88675';
const engineFile = 'apps/server/src/feeds/cache-sync-engine.ts';
const beforeSource = cp.execFileSync(
  'git',
  ['show', `${baseline}:${engineFile}`],
  {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  },
);
const trpc = fs.readFileSync(
  path.join(repo, 'apps/server/src/trpc/trpc.service.ts'),
  'utf8',
);
const sqlStart = trpc.indexOf(
  '`WITH RECURSIVE image_tags',
  trpc.indexOf('const readFlags = async'),
);
const sql = trpc
  .slice(sqlStart + 1, trpc.indexOf('`;', sqlStart))
  .replaceAll('${mpId}', '?');
const stateFile = path.join(repo, 'apps/server/src/feeds/cache-sync-state.ts');
function compile(source, dependency) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function('require', 'exports', 'module', code)(
    dependency,
    loaded.exports,
    loaded,
  );
  return loaded.exports;
}
const state = compile(fs.readFileSync(stateFile, 'utf8'), require);
const responseDiagnostics = compile(
  fs.readFileSync(
    path.join(
      repo,
      'apps/server/src/collection/providers/wechat2rss-response.ts',
    ),
    'utf8',
  ),
  require,
);
const cacheFailures = compile(
  fs.readFileSync(
    path.join(repo, 'apps/server/src/collection/cache-failure.ts'),
    'utf8',
  ),
  (name) =>
    name === './providers/wechat2rss-response'
      ? responseDiagnostics
      : require(name),
);
const loadEngine = (source) =>
  compile(source, (name) =>
    name === './cache-sync-state'
      ? state
      : name === '../collection/cache-failure'
        ? cacheFailures
        : require(name),
  ).CacheSyncEngine;
const engines = {
  before: loadEngine(beforeSource),
  after: loadEngine(fs.readFileSync(path.join(repo, engineFile), 'utf8')),
};
global.fetch = () => {
  throw Error('OFFLINE_NETWORK_FORBIDDEN');
};
const fixtureRoot = path.resolve(process.argv[2] || process.cwd());
const directory = fs.mkdtempSync(
  path.join(fixtureRoot, 'synthetic-cache-reconcile-'),
);
const python = String.raw`
import sqlite3,json,sys
database,sql=sys.argv[1:3]
c=sqlite3.connect(database)
c.executescript('CREATE TABLE articles(id TEXT PRIMARY KEY,mp_id TEXT,content_html TEXT);CREATE INDEX articles_mp_id_idx ON articles(mp_id);')
inline='<div id="js_content">fixture'+('<img src="data:image/png;base64,'+'A'*32768+'">')*4+'</div>'
c.executemany('INSERT INTO articles VALUES (?, ?, ?)',[(str(i),'fixture-feed',inline) for i in range(80)])
c.commit()
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    command=json.loads(line)
    mode=command['mode']
    if mode=='read':
        rows=c.execute(sql,['fixture-feed']*2).fetchall()
        body=sum(r[1] for r in rows);pending=sum(r[3] for r in rows)
        result={'mediaReady':body==0 and pending==0,'bodyMissing':body,'imageBlocked':0,'localMediaPendingArticleCount':pending}
    else:
        body=None if mode=='missing' else inline+('<img src="https://fixture.invalid/image">' if mode!='healthy' else '')
        c.execute('UPDATE articles SET content_html=? WHERE id=?',(body,'0'));c.commit()
        result={'changed':True}
    print(json.dumps(result),flush=True)
c.close()
`;
const worker = cp.spawn(
  process.platform === 'win32' ? 'python' : 'python3',
  ['-u', '-c', python, path.join(directory, 'fixture.db'), sql],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
let waiting;
const replies = [];
createInterface({ input: worker.stdout }).on('line', (line) => {
  const value = JSON.parse(line);
  if (waiting) {
    const resolve = waiting;
    waiting = undefined;
    resolve(value);
  } else replies.push(value);
});
worker.stderr.on('data', (value) => process.stderr.write(value));
const next = () =>
  replies.length
    ? Promise.resolve(replies.shift())
    : new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('SYNTHETIC_SQL_TIMEOUT')),
          20000,
        );
        waiting = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
const command = async (mode) => {
  worker.stdin.write(JSON.stringify({ mode }) + '\n');
  return next();
};
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function sample(version, mode) {
  await command('healthy');
  let now = Date.parse('2026-10-14T08:00:00Z'),
    enabled = true;
  let flagReads = 0,
    textCalls = 0;
  const readFlags = async () => {
    flagReads++;
    return command('read');
  };
  const page = {
    articles: [
      {
        id: 'fixture',
        title: 'synthetic',
        contentHtml: '<p>unchanged provider text</p>',
      },
    ],
    bodyMissing: 0,
    imageBlocked: 0,
  };
  const metadata = {
    feedId: 'fixture-feed',
    name: 'fixture',
    checkTime: null,
    nextUpdateTime: null,
    paused: false,
  };
  const engine = new engines[version]({
    now: () => now,
    mediaEnabled: () => enabled,
    list: async () => [metadata],
    localFeeds: async () => [{ id: metadata.feedId, mpName: metadata.name }],
    read: async () => page,
    sync: async (_id, _page, listOnly) => (listOnly ? {} : readFlags()),
    inspectLocalMedia: async () => {
      const result = await readFlags();
      return mode === 'unknown' ? undefined : result;
    },
    syncText: async () => {
      textCalls++;
      const result = await readFlags();
      if (mode === 'failed' && !enabled) throw Error('SYNTHETIC_TEXT_FAILURE');
      return mode === 'unknown' ? undefined : result;
    },
  });
  await engine.tick();
  await drain();
  const mediaDeadline = performance.now() + 20000;
  while (engine.mediaBusy) {
    if (performance.now() > mediaDeadline)
      throw Error('SYNTHETIC_MEDIA_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  // Remove the initial media job through the actual engine before measuring.
  assert.equal(state.cacheSyncState.feeds[0].state, 'synced-cache');
  await command(
    mode === 'missing' ? 'missing' : mode === 'healthy' ? 'healthy' : 'pending',
  );
  enabled = false;
  now += 60000;
  flagReads = 0;
  textCalls = 0;
  const started = performance.now();
  await engine.tick();
  await drain();
  const result = {
    elapsedMs: performance.now() - started,
    flagReads,
    textCalls,
    state: state.cacheSyncState.feeds[0].state,
  };
  engine.close();
  return result;
}
function distribution(rows) {
  const sorted = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], samples: rows };
}
async function main() {
  await next();
  const results = [];
  try {
    for (const mode of ['healthy', 'pending', 'missing', 'unknown', 'failed']) {
      const samples = { before: [], after: [] };
      for (let i = 0; i < 5; i++) {
        for (const version of i % 2 ? ['after', 'before'] : ['before', 'after'])
          samples[version].push(await sample(version, mode));
        assert.equal(
          samples.before[i].state,
          samples.after[i].state,
          'OUTCOME_CHANGED',
        );
        assert.equal(
          samples.after[i].flagReads,
          1,
          'EXPECTED_SINGLE_FRESH_SCAN',
        );
        assert.equal(samples.before[i].flagReads, mode === 'healthy' ? 1 : 2);
      }
      results.push({
        mode,
        equivalentState: true,
        before: distribution(samples.before),
        after: distribution(samples.after),
      });
    }
    console.log(
      JSON.stringify(
        {
          baseline,
          synthetic: true,
          articles: 80,
          inlineBodyKiB: 128,
          samplesPerCase: 5,
          networkRequests: 0,
          productionWrites: 0,
          results,
          limits: [
            'Actual engine control flow and unchanged production recursive SQL; dependency stand-ins exclude Prisma admission, metadata identity checking and write transactions.',
            'Healthy case remains one scan; pending/missing/unknown/failed cases remove one scan.',
            'Five alternating pairs, fixture SQL/IPC wall time, not production round savings.',
            'Synthetic fixtures retained.',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    worker.stdin.end();
  }
}
main().catch((error) => {
  console.error(error);
  worker.stdin.end();
  process.exitCode = 1;
});
