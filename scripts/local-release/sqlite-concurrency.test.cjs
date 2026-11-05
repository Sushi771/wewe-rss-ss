const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { sqliteRuntimeUrl } = require('./engine-audit.cjs');

test(
  'one SQLite connection preserves concurrent deferred transactions alongside readonly backups',
  { timeout: 30000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-runtime-pool-'));
    const database = path.join(root, 'synthetic.db');
    const python =
      process.env.SQLITE_BACKUP_PYTHON ||
      (process.platform === 'win32' ? 'python' : 'python3');
    const clientPath = require.resolve('@prisma/client', {
      paths: [path.resolve(__dirname, '../../apps/server')],
    });
    const { PrismaClient } = require(clientPath);
    const schema = `CREATE TABLE feeds(id TEXT PRIMARY KEY,mp_name TEXT NOT NULL,mp_cover TEXT NOT NULL,mp_intro TEXT NOT NULL,status INTEGER NOT NULL DEFAULT 1,sync_time INTEGER NOT NULL DEFAULT 0,update_time INTEGER NOT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME,has_history INTEGER DEFAULT 1,"order" INTEGER NOT NULL DEFAULT 0,local_directory TEXT,public_album_ids TEXT,last_collection_result TEXT,collection_channel TEXT,provider_refresh_attempt_time INTEGER NOT NULL DEFAULT 0,group_id TEXT);INSERT INTO feeds(id,mp_name,mp_cover,mp_intro,update_time) VALUES('synthetic','synthetic','','',0);`;
    execFileSync(
      python,
      [
        '-c',
        'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit(); c.close()',
        database,
        schema,
      ],
      { windowsHide: true },
    );
    const client = new PrismaClient({
      datasources: { db: { url: sqliteRuntimeUrl(database) } },
    });
    const reader = spawn(
      python,
      [
        '-c',
        `import sqlite3,pathlib,sys,time
p=pathlib.Path(sys.argv[1]); success=0
for n in range(20):
 with sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=.1) as source:
  source.execute('PRAGMA query_only=ON')
  with sqlite3.connect(p.parent/'backup.db') as destination:
   source.backup(destination,pages=1,sleep=.01)
 success+=1; time.sleep(.02)
print(success)
`,
        database,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    reader.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    reader.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const ended = new Promise((resolve, reject) => {
      reader.once('error', reject);
      reader.once('close', resolve);
    });
    try {
      for (let round = 0; round < 4; round++)
        await Promise.all(
          [1, 2].map(() =>
            client.$transaction(async (tx) => {
              await tx.feed.count();
              await new Promise((resolve) => setTimeout(resolve, 40));
              await tx.feed.update({
                where: { id: 'synthetic' },
                data: { syncTime: { increment: 1 } },
              });
            }),
          ),
        );
      assert.equal(
        (await client.feed.findUnique({ where: { id: 'synthetic' } })).syncTime,
        8,
      );
      assert.equal(await ended, 0, stderr);
      assert(Number(stdout.trim()) >= 1);
    } finally {
      await client.$disconnect();
      if (reader.exitCode === null) reader.kill();
      await ended.catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
