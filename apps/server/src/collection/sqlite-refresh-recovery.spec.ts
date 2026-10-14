import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import {
  refreshRecovery,
  RefreshRecoveryBoundaries,
} from './sqlite-refresh-recovery';
import { sqliteWrites } from './sqlite-write-coordinator';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';
interface TestSqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: (string | number)[]): unknown;
    get(...values: (string | number)[]): Record<string, unknown> | undefined;
  };
  close(): void;
}
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (
    file: string,
    options?: { readOnly?: boolean },
  ) => TestSqlite;
};
async function backupPath() {
  const report = await createVerifiedSqliteBackup();
  if (!('backup' in report))
    throw new Error('Synthetic SQLite backup required');
  return report.backup;
}

describe('finite before-round recovery instead of a full copy per subscription', () => {
  let directory: string, source: string, root: string, db: TestSqlite;
  const previous = { ...process.env };
  const keys: string[] = [];
  const members = Array.from(
    { length: 14 },
    (_, i) => `MP_WXS_${1234567800 + i}`,
  );
  const makeKey = () => {
    const key = `synthetic-${Date.now()}-${keys.length}`;
    keys.push(key);
    return key;
  };
  const backups = async () => {
    let count = 0;
    const walk = async (p: string) => {
      for (const e of await fs.readdir(p, { withFileTypes: true })) {
        const file = path.join(p, e.name);
        if (e.isDirectory()) await walk(file);
        else if (e.name.endsWith('.db')) count++;
      }
    };
    await walk(root);
    return count;
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'refresh-recovery-synthetic-'),
    );
    source = path.join(directory, 'source.db');
    root = path.join(directory, 'backups');
    await fs.mkdir(root);
    db = new DatabaseSync(source);
    db.exec(
      'CREATE TABLE feeds(id TEXT PRIMARY KEY,name TEXT,attempt INTEGER);CREATE TABLE articles(id TEXT PRIMARY KEY,body TEXT,metric INTEGER);CREATE TABLE categories(id TEXT PRIMARY KEY,title TEXT);',
    );
    for (const id of members)
      db.prepare('INSERT INTO feeds VALUES(?,?,0)').run(id, `retained ${id}`);
    db.prepare('INSERT INTO articles VALUES(?,?,?)').run(
      'old',
      'retained old body',
      99,
    );
    db.prepare('INSERT INTO categories VALUES(?,?)').run(
      'favorite',
      'retained category',
    );
    for (let i = 0; i < 37; i++)
      await fs.copyFile(source, path.join(root, `retained-${i}.db`));
    Object.assign(process.env, {
      DATABASE_URL: `file:${source}`,
      SQLITE_BACKUP_KIND: 'test',
      SQLITE_TEST_BACKUP_ROOT: root,
      SQLITE_TEST_MAX_COPIES: '48',
      SQLITE_TEST_MAX_BYTES: String(16 * 1024 ** 2),
      SQLITE_TEST_MIN_FREE_BYTES: '1',
    });
  });
  afterEach(async () => {
    for (const key of keys.splice(0)) await refreshRecovery.close(key);
    db.close();
    process.env = { ...previous };
    jest.restoreAllMocks();
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('an unclaimed round scope does not replace independently protected cache-only admission', async () => {
    await refreshRecovery.run(makeKey(), members, members[0], async () => {
      expect(refreshRecovery.captureWriteGuard()).toBeUndefined();
      await expect(sqliteWrites.write(async () => 42)).resolves.toBe(42);
    });
    expect(await backups()).toBe(37);
  });
  it('demonstrates the previous per-submit policy stops the twelfth of fourteen writes', async () => {
    let completed = 0;
    for (const id of members) {
      try {
        await createVerifiedSqliteBackup();
      } catch (error) {
        expect(String(error)).toContain('备份空间');
        break;
      }
      await sqliteWrites.write(async () => {
        db.prepare('UPDATE feeds SET attempt=1 WHERE id=?').run(id);
      });
      completed++;
    }
    expect(completed).toBe(11);
    expect(await backups()).toBe(48);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE attempt=0').get()?.n,
    ).toBe(3);
  }, 20000);
  it('the actual durable worker completes all14 reservations and cache writes using one boundary', async () => {
    let clock = Date.parse('2026-10-14T09:30:00Z');
    let accepted = 0;
    let point: string | undefined;
    const manager = new Wechat2RssSubscriptionBatches(
      () => source,
      () => 'synthetic-instance',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    manager.attachRefreshPreparation(async (id) => {
      point = await backupPath();
      await sqliteWrites.write(async () => {
        db.prepare('UPDATE feeds SET attempt=1 WHERE id=?').run(id);
      });
      return {
        release: () => {},
        submit: async () => {
          accepted++;
          return {
            state: 'waiting',
            accepted: true,
            feedId: id,
            message: 'synthetic accepted',
          };
        },
      };
    });
    manager.attachRefresh(async (id, stage) => {
      expect(stage).toBe('cache');
      await createVerifiedSqliteBackup();
      await sqliteWrites.write(async () => {
        db.prepare('INSERT OR IGNORE INTO articles VALUES(?,?,?)').run(
          id,
          `new body ${id}`,
          0,
        );
      });
      return {
        state: 'succeeded',
        accepted: true,
        feedId: id,
        message: 'synthetic saved',
      };
    });
    try {
      const batch = await manager.enqueueRefresh(members);
      keys.push(batch.batchId);
      for (
        let i = 0;
        i < 40 &&
        (await manager.list()).find((item) => item.batchId === batch.batchId)
          ?.state !== 'completed';
        i++
      ) {
        await manager.runDue();
        clock += 31000;
      }
      expect(
        (await manager.list()).find((item) => item.batchId === batch.batchId)
          ?.state,
      ).toBe('completed');
      expect(accepted).toBe(14);
      expect(await backups()).toBe(38);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE attempt=1').get()?.n,
      ).toBe(14);
      expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()?.n).toBe(
        15,
      );
      expect(
        db.prepare("SELECT body,metric FROM articles WHERE id='old'").get(),
      ).toEqual({ body: 'retained old body', metric: 99 });
      const restored = new DatabaseSync(point!, { readOnly: true });
      try {
        expect(restored.prepare('PRAGMA quick_check').get()).toEqual({
          quick_check: 'ok',
        });
        expect(
          restored
            .prepare('SELECT COUNT(*) AS n FROM feeds WHERE attempt=0')
            .get()?.n,
        ).toBe(14);
        expect(
          restored
            .prepare("SELECT body,metric FROM articles WHERE id='old'")
            .get(),
        ).toEqual({ body: 'retained old body', metric: 99 });
        expect(
          restored.prepare('SELECT COUNT(*) AS n FROM articles').get()?.n,
        ).toBe(1);
      } finally {
        restored.close();
      }
      expect(
        (await fs.readdir(root)).filter((n) =>
          n.startsWith('refresh-recovery-owner-'),
        ),
      ).toHaveLength(0);
      const live = JSON.parse(
        await fs.readFile(
          path.join(
            directory,
            '.wechat2rss-subscription-batches',
            batch.batchId + '.json',
          ),
          'utf8',
        ),
      );
      expect(live.state).toBe('completed');
      expect(
        live.items.every((i: { state: string }) => i.state === 'succeeded'),
      ).toBe(true);
    } finally {
      manager.close();
    }
  });
  it('a failed checkpoint prevents every write and submission; recovery retries retain one intent', async () => {
    process.env.SQLITE_TEST_MAX_COPIES = '37';
    process.env.SQLITE_TEST_MAX_BYTES = '1';
    let submitted = 0;
    const key = makeKey();
    await expect(
      refreshRecovery.run(key, members, members[0], async () => {
        await createVerifiedSqliteBackup();
        submitted++;
        db.exec('UPDATE feeds SET attempt=1');
      }),
    ).rejects.toThrow('备份空间');
    expect(submitted).toBe(0);
    expect(await backups()).toBe(37);
    process.env.SQLITE_TEST_MAX_BYTES = String(16 * 1024 ** 2);
    process.env.SQLITE_TEST_MAX_COPIES = '48';
    await refreshRecovery.run(key, members, members[0], async () => {
      await createVerifiedSqliteBackup();
      submitted++;
      await sqliteWrites.write(async () => {
        db.prepare('UPDATE feeds SET attempt=1 WHERE id=?').run(members[0]);
      });
    });
    expect(submitted).toBe(1);
    expect(await backups()).toBe(38);
  });
  it('a new round creates a fresh point covering the previous round without deleting either', async () => {
    const points: string[] = [];
    for (const key of [makeKey(), makeKey()])
      await refreshRecovery.run(key, members, members[0], async () => {
        points.push(await backupPath());
        await sqliteWrites.write(async () => {
          db.exec('UPDATE feeds SET attempt=attempt+1');
        });
      });
    expect(new Set(points).size).toBe(2);
    expect(await backups()).toBe(39);
    const previousRound = new DatabaseSync(points[1], { readOnly: true });
    try {
      expect(
        previousRound
          .prepare('SELECT COUNT(*) AS n FROM feeds WHERE attempt=1')
          .get()?.n,
      ).toBe(14);
    } finally {
      previousRound.close();
    }
  });
  it('a corrupted recovery file cannot authorize another write in the same round', async () => {
    const key = makeKey();
    let point: string | undefined;
    await refreshRecovery.run(key, members, members[0], async () => {
      point = await backupPath();
      await sqliteWrites.write(async () => {
        db.prepare('INSERT INTO articles VALUES(?,?,?)').run(
          'successful',
          'new successful body',
          7,
        );
        db.prepare('UPDATE categories SET title=? WHERE id=?').run(
          'new successful classification',
          'favorite',
        );
      });
    });
    await fs.writeFile(point!, Buffer.alloc(8192));
    let written = false;
    await expect(
      refreshRecovery.run(key, members, members[1], async () => {
        await createVerifiedSqliteBackup();
        written = true;
      }),
    ).rejects.toThrow('checksum');
    expect(written).toBe(false);
    expect(await backups()).toBe(38);
    expect(
      db
        .prepare("SELECT body,metric FROM articles WHERE id='successful'")
        .get(),
    ).toEqual({ body: 'new successful body', metric: 7 });
    expect(
      db.prepare("SELECT title FROM categories WHERE id='favorite'").get()
        ?.title,
    ).toBe('new successful classification');
  });
  it('sharing does not authorize a backup inside an already admitted write', async () => {
    const key = makeKey();
    await refreshRecovery.run(key, members, members[0], () =>
      createVerifiedSqliteBackup(),
    );
    await expect(
      refreshRecovery.run(key, members, members[1], () =>
        sqliteWrites.write(() => createVerifiedSqliteBackup()),
      ),
    ).rejects.toThrow('inside an admitted write');
  });
  it('expiry and restart require a new verified generation; detached contexts never keep authority', async () => {
    let time = 10000;
    const registry = new RefreshRecoveryBoundaries(() => time, 1000);
    const checksum = createHash('sha256')
      .update(await fs.readFile(source))
      .digest('hex');
    let calls = 0;
    const create = async () => {
      calls++;
      const copy = path.join(root, `generation-${calls}.db`);
      await fs.copyFile(source, copy);
      return { source, backup: copy, sha256: checksum, integrityCheck: 'ok' };
    };
    await registry.run('epoch', members, members[0], () =>
      registry.snapshot(source, root, create),
    );
    time += 1001;
    await registry.run('epoch', members, members[1], () =>
      registry.snapshot(source, root, create),
    );
    const restarted = new RefreshRecoveryBoundaries(() => time, 1000);
    await restarted.run('epoch', members, members[2], () =>
      restarted.snapshot(source, root, create),
    );
    expect(calls).toBe(3);
    let release!: () => void;
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<unknown>;
    await restarted.run('epoch', members, members[3], async () => {
      detached = later.then(() => restarted.snapshot(source, root, create));
    });
    release();
    await detached;
    expect(calls).toBe(4);
    await registry.close('epoch');
    await restarted.close('epoch');
  });
  it('manual and scheduled concurrent scopes cannot borrow each other’s cached point', async () => {
    const registry = new RefreshRecoveryBoundaries();
    const checksum = createHash('sha256')
      .update(await fs.readFile(source))
      .digest('hex');
    let creates = 0;
    const create = async () => {
      const copy = path.join(root, `concurrent-${++creates}.db`);
      await fs.copyFile(source, copy);
      return { source, backup: copy, sha256: checksum, integrityCheck: 'ok' };
    };
    const result = await Promise.all(
      ['manual', 'scheduled'].map((key) =>
        registry.run(key, members, members[0], () =>
          registry.snapshot(source, root, create),
        ),
      ),
    );
    expect(creates).toBe(2);
    expect(new Set(result.map((r) => r.backup)).size).toBe(2);
    expect(
      (await fs.readdir(root)).filter((n) =>
        n.startsWith('refresh-recovery-owner-'),
      ),
    ).toHaveLength(2);
    await registry.close('manual');
    await registry.close('scheduled');
    expect(await backups()).toBe(39);
  });
  it('same-round concurrent first users establish exactly one verified boundary', async () => {
    const registry = new RefreshRecoveryBoundaries();
    const checksum = createHash('sha256')
      .update(await fs.readFile(source))
      .digest('hex');
    let creates = 0;
    const create = async () => {
      creates++;
      const copy = path.join(root, 'concurrent-shared.db');
      await fs.copyFile(source, copy);
      return { source, backup: copy, sha256: checksum, integrityCheck: 'ok' };
    };
    const result = await Promise.all(
      members
        .slice(0, 3)
        .map((id) =>
          registry.run('one-round', members, id, () =>
            registry.snapshot(source, root, create),
          ),
        ),
    );
    expect(creates).toBe(1);
    expect(new Set(result.map((r) => r.backup)).size).toBe(1);
    await registry.close('one-round');
  });
  it('an expired in-flight boundary cannot be replaced or authorize writes when its checkpoint returns late', async () => {
    let time = 10000;
    const registry = new RefreshRecoveryBoundaries(() => time, 1000);
    const checksum = createHash('sha256')
      .update(await fs.readFile(source))
      .digest('hex');
    let release!: () => void;
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const begun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let written = false;
    const pending = registry.run('late', members, members[0], async () => {
      await registry.snapshot(source, root, async () => {
        entered();
        await later;
        const copy = path.join(root, 'late.db');
        await fs.copyFile(source, copy);
        return { source, backup: copy, sha256: checksum, integrityCheck: 'ok' };
      });
      written = true;
    });
    const rejected = expect(pending).rejects.toThrow('expired');
    await begun;
    time += 1001;
    const operation = jest.fn(async () => undefined);
    await expect(
      registry.run('late', members, members[1], operation),
    ).rejects.toThrow('in-flight');
    expect(operation).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(written).toBe(false);
    expect(await backups()).toBe(38);
    await registry.close('late');
  });
  it('changed membership cannot expand an established round', async () => {
    const key = makeKey();
    await refreshRecovery.run(key, members, members[0], () =>
      createVerifiedSqliteBackup(),
    );
    const operation = jest.fn(async () => undefined);
    await expect(
      refreshRecovery.run(key, [...members, 'extra'], 'extra', operation),
    ).rejects.toThrow('membership');
    expect(operation).not.toHaveBeenCalled();
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const owner = async () =>
    path.join(
      root,
      (await fs.readdir(root)).find((n) =>
        n.startsWith('refresh-recovery-owner-'),
      )!,
    );
  it.each(['expiry', 'close'])(
    'checks %s after queued write admission, preserving successful data and receipt bytes',
    async (reason) => {
      let clock = Date.now();
      jest
        .spyOn(refreshRecovery as unknown as { now: () => number }, 'now')
        .mockImplementation(() => clock);
      const key = makeKey();
      const receipt = path.join(directory, 'successful-receipt.json');
      await refreshRecovery.run(key, members, members[0], async () => {
        await createVerifiedSqliteBackup();
        await sqliteWrites.write(async () => {
          db.prepare('INSERT INTO articles VALUES(?,?,?)').run(
            'successful',
            'successful body',
            7,
          );
          db.prepare('UPDATE categories SET title=? WHERE id=?').run(
            'successful classification',
            'favorite',
          );
          await fs.writeFile(receipt, JSON.stringify({ state: 'succeeded' }));
        });
      });
      const beforeReceipt = await fs.readFile(receipt);
      const hold = deferred(),
        entered = deferred(),
        proved = deferred();
      const blocker = sqliteWrites.snapshot(async () => {
        entered.resolve();
        await hold.promise;
      });
      await entered.promise;
      const operation = jest.fn(async () => {
        db.prepare('INSERT INTO articles VALUES(?,?,?)').run(
          'late',
          'must not execute',
          0,
        );
      });
      const queued = refreshRecovery.run(key, members, members[1], async () => {
        await createVerifiedSqliteBackup();
        proved.resolve();
        await sqliteWrites.write(operation);
      });
      const rejected = expect(queued).rejects.toThrow('expired or closed');
      await proved.promise;
      if (reason === 'expiry') clock += 900001;
      else await refreshRecovery.close(key);
      hold.resolve();
      await blocker;
      await rejected;
      expect(operation).not.toHaveBeenCalled();
      expect(
        db.prepare("SELECT body FROM articles WHERE id='successful'").get()
          ?.body,
      ).toBe('successful body');
      expect(
        db.prepare("SELECT title FROM categories WHERE id='favorite'").get()
          ?.title,
      ).toBe('successful classification');
      expect(await fs.readFile(receipt)).toEqual(beforeReceipt);
      await expect(sqliteWrites.write(async () => 42)).resolves.toBe(42); // Rejected admission released, no replay.
    },
  );
  it.each(['missing', 'replaced', 'content'])(
    'rejects a %s owner before sharing and preserves the DB snapshot',
    async (change) => {
      const key = makeKey();
      let point!: string;
      await refreshRecovery.run(key, members, members[0], async () => {
        point = await backupPath();
      });
      const reference = await owner();
      const bytes = await fs.readFile(reference);
      if (change === 'content')
        await fs.writeFile(
          reference,
          Buffer.from(
            bytes
              .toString()
              .replace('database-before-round', 'altered-before-round'),
          ),
        );
      else {
        await fs.rename(reference, reference + '.fixture');
        if (change === 'replaced') await fs.writeFile(reference, bytes);
      }
      await expect(
        refreshRecovery.run(key, members, members[1], () =>
          createVerifiedSqliteBackup(),
        ),
      ).rejects.toThrow('owner reference');
      expect((await fs.stat(point)).size).toBeGreaterThan(0);
      expect(await backups()).toBe(38);
      if (change !== 'missing')
        expect(await fs.readFile(reference)).toBeDefined(); // Unproved replacement is not cleaned as ours.
    },
  );
  it.each(['owner', 'backup', 'source'])(
    'rechecks %s changes after queueing and before engine entry',
    async (change) => {
      const key = makeKey();
      let point!: string;
      await refreshRecovery.run(key, members, members[0], async () => {
        point = await backupPath();
      });
      const hold = deferred(),
        entered = deferred(),
        proved = deferred();
      const blocker = sqliteWrites.snapshot(async () => {
        entered.resolve();
        await hold.promise;
      });
      await entered.promise;
      const operation = jest.fn(async () => {
        db.exec('UPDATE feeds SET attempt=9');
      });
      const queued = refreshRecovery.run(key, members, members[1], async () => {
        await createVerifiedSqliteBackup();
        proved.resolve();
        await sqliteWrites.write(operation);
      });
      const rejected = expect(queued).rejects.toThrow();
      await proved.promise;
      if (change === 'owner') {
        const reference = await owner();
        await fs.rename(reference, reference + '.fixture');
      } else if (change === 'backup') {
        await fs.writeFile(point, Buffer.alloc((await fs.stat(point)).size));
      } else {
        db.close();
        await fs.rename(source, source + '.fixture');
        await fs.copyFile(source + '.fixture', source);
        db = new DatabaseSync(source);
      }
      hold.resolve();
      await blocker;
      await rejected;
      expect(operation).not.toHaveBeenCalled();
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE attempt=0').get()?.n,
      ).toBe(14);
      await expect(sqliteWrites.write(async () => 42)).resolves.toBe(42);
    },
  );
});
