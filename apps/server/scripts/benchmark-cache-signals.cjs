/* Offline only: run with ts-node/register/transpile-only and tsconfig-paths/register.
 * Measures actual directory hints -> committed fingerprints on synthetic SQLite.
 * No provider, production config/database, HTTP or image operations. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const spawn = cp.spawn;
const python =
  process.env.SQLITE_BACKUP_PYTHON ||
  (process.platform === 'win32' ? 'python' : 'python3');
const pythonFixture = `
import sqlite3,json,sys,time,os
from pathlib import Path
database=Path(sys.argv[1])
def fixture(file,body='x'*4096):
    c=sqlite3.connect(file)
    c.executescript('CREATE TABLE rsses(biz_id INTEGER);CREATE TABLE articles(id INTEGER PRIMARY KEY,biz_id INTEGER,o_id TEXT,url TEXT,title TEXT,created TEXT,pic_url TEXT,content TEXT);')
    for biz in range(1234567800,1234567814):
        c.execute('INSERT INTO rsses VALUES (?)',(biz,))
        c.executemany("INSERT INTO articles(biz_id,o_id,url,title,created,pic_url,content) VALUES (?,?,'url','title','time','',?)",[(biz,str(i),body) for i in range(93)])
    c.commit()
    return c
c=fixture(database)
c.execute('PRAGMA journal_mode=WAL')
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    command=json.loads(line)
    mode=command['mode']
    if mode=='checkpoint':
        c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    elif mode=='metadata':
        c.execute('UPDATE rsses SET biz_id=biz_id');c.commit()
    elif mode=='replace':
        c.close()
        replacement=database.with_name('replacement.db')
        fixture(replacement, 'replacement'.ljust(4096,'x')).close()
        for attempt in range(40):
            try:os.replace(replacement,database);break
            except PermissionError:time.sleep(0.025)
        else:raise RuntimeError('fixture replacement remained locked')
        c=sqlite3.connect(database)
    else:
        if mode=='main':c.execute('PRAGMA journal_mode=DELETE')
        before=database.stat().st_size
        c.execute("UPDATE articles SET content=? WHERE biz_id=1234567800 AND o_id='0'",(str(command['sequence']).ljust(4096,'x'),))
        if mode=='precommit':time.sleep(0.25)
        c.commit()
    print(json.dumps({'commitAt':time.time_ns()/1e6,'mode':mode}),flush=True)
c.close()
`;
// Force daytime only for this synthetic child; product night restriction unchanged.
cp.spawn = (exe, args, options) => {
  if (args[1]?.endsWith('watch-wechat2rss-cache.py')) {
    const code =
      "import importlib.util,sys;s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.daytime=lambda:True;sys.argv=sys.argv[1:];m.main()";
    return spawn(exe, ['-u', '-c', code, ...args.slice(1)], options);
  }
  return spawn(exe, args, options);
};
const { CacheSqliteMonitor } = require('../src/feeds/cache-sqlite-monitor.ts');
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
async function main() {
  // Use the explicitly writable fixture root. Windows sandbox OS temp may
  // permit creation but deny replace/delete, which would test its ACL instead.
  const fixtureRoot = path.resolve(
    process.env.CACHE_MONITOR_TEST_ROOT || process.cwd(),
  );
  const directory = fs.mkdtempSync(
    path.join(fixtureRoot, 'wewe-event-signals-'),
  );
  const database = path.join(directory, 'cache.db');
  const writer = spawn(python, ['-u', '-c', pythonFixture, database], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let reply;
  const replies = [];
  createInterface({ input: writer.stdout }).on('line', (line) => {
    const value = JSON.parse(line);
    if (reply) {
      const cb = reply;
      reply = null;
      cb(value);
    } else replies.push(value);
  });
  const next = () =>
    replies.length
      ? Promise.resolve(replies.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error('SYNTHETIC_WRITER_TIMEOUT')),
            20000,
          );
          reply = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
        });
  writer.stderr.on('data', (data) => {
    fs.appendFileSync(
      path.join(process.cwd(), 'synthetic-writer-error.log'),
      data,
    );
    console.error('SYNTHETIC_WRITER_UNAVAILABLE');
  });
  await next();
  let pending;
  let previous;
  let notifications = 0;
  const wait = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('SIGNAL_TIMEOUT')), 20000);
      pending = (at) => {
        clearTimeout(timer);
        resolve(at);
      };
    });
  const monitor = new CacheSqliteMonitor(
    database,
    (hashes) => {
      notifications++;
      if (previous && JSON.stringify(previous) === JSON.stringify(hashes))
        throw Error('DUPLICATE_SNAPSHOT');
      previous = hashes;
      if (pending) {
        const cb = pending;
        pending = null;
        cb(performance.timeOrigin + performance.now());
      }
    },
    () => {},
  );
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  let signal = wait();
  signal.catch(() => {});
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage();
  let hints = 0;
  const originalHint = monitor.hint.bind(monitor);
  monitor.hint = () => {
    hints++;
    originalHint();
  };
  try {
    console.error('synthetic monitor startup');
    await monitor.start();
    await signal;
    const idleNotifications = notifications;
    await sleep(2200);
    if (notifications !== idleNotifications) throw Error('IDLE_CHANGED');
    const idleNodeCpu = process.cpuUsage(cpuBefore);
    for (const mode of [
      ...Array(10).fill('wal'),
      ...Array(10).fill('main'),
      'precommit',
      'replace',
      'lost-hint',
      'watch-rebuild',
    ]) {
      console.error('synthetic fixture step', mode);
      const sequence = results.length + 1;
      await sleep([53, 287, 611][sequence % 3]);
      if (mode === 'lost-hint') monitor.hint = () => {};
      if (mode === 'watch-rebuild') {
        monitor.hint = originalHint;
        monitor.watcher?.close();
        await sleep(1150);
      }
      signal = wait();
      signal.catch(() => {});
      writer.stdin.write(
        JSON.stringify({
          mode:
            mode === 'lost-hint'
              ? 'main'
              : mode === 'watch-rebuild'
                ? 'main'
                : mode,
          sequence,
        }) + '\n',
      );
      const commit = await next();
      const detectedAt = await signal;
      const latency = detectedAt - commit.commitAt;
      if (latency < -2) throw Error('NOTIFICATION_BEFORE_COMMIT');
      if (latency > 2000) throw Error('RECONCILIATION_TOO_SLOW');
      results.push({ mode, commitToDiscoveryMs: latency });
      console.log(
        JSON.stringify({
          sample: sequence,
          mode,
          commitToDiscoveryMs: latency,
        }),
      );
    }
    const count = notifications;
    for (const mode of ['metadata', 'checkpoint']) {
      writer.stdin.write(JSON.stringify({ mode }) + '\n');
      await next();
      await sleep(1200);
    }
    if (notifications !== count) throw Error('UNCHANGED_CONTENT_NOTIFIED');
    console.log(
      JSON.stringify({
        synthetic: true,
        realtimeUpstream: false,
        feeds: 14,
        articles: 1302,
        bodyBytes: 4096,
        results,
        wal: distribution(
          results
            .filter((row) => row.mode === 'wal')
            .map((row) => row.commitToDiscoveryMs),
        ),
        main: distribution(
          results
            .filter((row) => row.mode === 'main')
            .map((row) => row.commitToDiscoveryMs),
        ),
        idleNodeCpuMs: (idleNodeCpu.user + idleNodeCpu.system) / 1000,
        idleWindowMs: 2200,
        nodeRssBytes: memoryBefore.rss,
        hints,
        networkRequests: 0,
        productionWrites: 0,
      }),
    );
  } finally {
    monitor.close();
    writer.stdin.end();
    writer.kill();
    cp.spawn = spawn;
    // Verify the absolute cleanup target is our unique temp directory.
    await sleep(200);
    if (path.resolve(directory).startsWith(fixtureRoot + path.sep))
      fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
