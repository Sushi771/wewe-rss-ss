import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChannelTaskHistory } from './channel-task-history';
import {
  historyArchived,
  readChannelState,
  visibleHistory,
  withChannelExecution,
} from './channel-task-control';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';
import { Wechat2RssSubscriptionTasks } from './wechat2rss-subscription-tasks';
import { Wechat2RssProvider } from './providers/wechat2rss';
import { Wechat2RssSourceGate } from './wechat2rss-source-gate';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSubscriptionService } from './xhs-subscription.service';

describe('channel task history on real isolated Prisma SQLite (no source requests)', () => {
  jest.setTimeout(60000);
  let root: string,
    database: string,
    db: PrismaClient,
    manager: ChannelTaskHistory;
  let backup: jest.Mock, source: jest.SpyInstance;
  const managers: Array<{ close(): void }> = [];
  const oldEnv = { ...process.env };
  const batchId = '11111111-1111-4111-8111-111111111111';
  const taskId = '22222222-2222-4222-8222-222222222222';
  beforeEach(async () => {
    delete process.env.WECHAT2RSS_RECOVERY_HOLD;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-channel-history-'));
    database = path.join(root, 'fixture.db');
    process.env.DATABASE_URL = 'file:' + database.replace(/\\/g, '/');
    db = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await db.$executeRawUnsafe(
      'CREATE TABLE feeds(id TEXT PRIMARY KEY, document TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE articles(id TEXT PRIMARY KEY, document TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT,updated_at TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_refresh_batches(id TEXT PRIMARY KEY,state TEXT,created_at INTEGER)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_refresh_batch_items(batch_id TEXT,position INTEGER,state TEXT,operation_id TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_unbound_owner_requests(operation_id TEXT PRIMARY KEY,state TEXT,document TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE refresh_submission_claims(id TEXT PRIMARY KEY,state TEXT,document TEXT)',
    );
    await db.$executeRawUnsafe(
      "INSERT INTO feeds VALUES ('feed','unchanged subscription')",
    );
    await db.$executeRawUnsafe(
      "INSERT INTO articles VALUES ('article','unchanged content and image')",
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES (?, 'creator', 'queued', ?, '123')",
      taskId,
      JSON.stringify({ taskId, state: 'queued' }),
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_refresh_batches VALUES (?, 'paused', 123)",
      batchId,
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_refresh_batch_items VALUES (?, 0, 'reserved', ?)",
      batchId,
      taskId,
    );
    for (let i = 0; i < 3; i++)
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES (?, 'unknown', ?)",
        'old-' + i,
        'retain exact unknown evidence ' + i,
      );
    for (let i = 0; i < 7; i++)
      await db.$executeRawUnsafe(
        "INSERT INTO refresh_submission_claims VALUES (?, 'unknown', ?)",
        'old-' + i,
        'retain exact submission evidence ' + i,
      );
    source = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('REAL_SOURCE_FORBIDDEN'));
    backup = jest.fn(async () => {
      const file = path.join(root, 'recovery.db');
      await fs.copyFile(database, file);
      return {
        source: database,
        backup: file,
        sha256: createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex'),
        integrityCheck: 'ok',
        recoveryOrigin: {
          format: 'sqlite-recovery-origin-v1',
          kind: 'protected',
        },
      };
    });
    manager = new ChannelTaskHistory(
      db,
      () => database,
      backup,
      () => {},
    );
  });
  afterEach(async () => {
    expect(source).not.toHaveBeenCalled();
    managers.splice(0).forEach((m) => m.close());
    jest.restoreAllMocks();
    await db.$disconnect();
    process.env = { ...oldEnv };
    if (
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-channel-history-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  const confirm = async (
    channel: 'wechat' | 'xiaohongshu',
    action: 'archive' | 'pause' | 'resume',
  ) => {
    const p = await manager.preview(channel, action);
    return manager.confirm({
      channel,
      action,
      digest: p.digest,
      acknowledged: true,
    });
  };
  it('archives the complete visible XHS inventory, retaining content, unknowns and original rows byte for byte', async () => {
    // Match the reported production cardinalities using wholly synthetic data.
    await db.$executeRawUnsafe(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<13) INSERT INTO feeds SELECT 'feed-'||x,'subscription-'||x FROM n",
    );
    await db.$executeRawUnsafe(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2089) INSERT INTO articles SELECT 'article-'||x,'body and local image-'||x FROM n",
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,document TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_notes(id TEXT PRIMARY KEY,document TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_saved_comments(id TEXT PRIMARY KEY,document TEXT)',
    );
    await db.$executeRawUnsafe(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3) INSERT INTO xhs_creators SELECT 'creator-'||x,'creator data-'||x FROM n",
    );
    await db.$executeRawUnsafe(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<319) INSERT INTO xhs_notes SELECT 'note-'||x,'note body, media, metrics-'||x FROM n",
    );
    await db.$executeRawUnsafe(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<19) INSERT INTO xhs_saved_comments SELECT 'comment-'||x,'comment data-'||x FROM n",
    );
    await db.$executeRawUnsafe(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<76) INSERT INTO xhs_subscription_tasks SELECT 'task-'||x,'creator','blocked','{\"synthetic\":true}','123' FROM n",
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_refresh_batches VALUES ('batch-2','stopped',123),('batch-3','paused',123)",
    );
    await db.$executeRawUnsafe(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<6) INSERT INTO xhs_refresh_batch_items SELECT 'batch-2',x,CASE WHEN x=1 THEN 'queued' WHEN x=2 THEN 'reserved' ELSE 'cancelled' END,NULL FROM n",
    );
    const before = await fs.readFile(database);
    const plan = await manager.preview('xiaohongshu', 'archive');
    expect(plan.records.filter((r) => r.kind === 'xhs-task')).toHaveLength(77);
    expect(plan.records.filter((r) => r.kind === 'xhs-batch')).toHaveLength(3);
    expect(plan.sourceRequests).toBe(0);
    expect(backup).not.toHaveBeenCalled();
    const input = {
      channel: 'xiaohongshu' as const,
      action: 'archive' as const,
      digest: plan.digest,
      acknowledged: true as const,
    };
    expect((await manager.confirm(input)).paused).toBe(true);
    expect(await fs.readFile(database)).toEqual(before);
    expect((await manager.preview('xiaohongshu', 'archive')).visibleCount).toBe(
      0,
    );
    expect((await manager.confirm(input)).alreadyApplied).toBe(true);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(
      await db.$queryRawUnsafe<any[]>(
        "SELECT * FROM xhs_unbound_owner_requests WHERE state='unknown'",
      ),
    ).toHaveLength(3);
    expect(
      await db.$queryRawUnsafe<any[]>(
        "SELECT * FROM refresh_submission_claims WHERE state='unknown'",
      ),
    ).toHaveLength(7);
  });
  it('keeps one channel progressing while the other is paused, busy, corrupt, or has thrown', async () => {
    await confirm('wechat', 'pause');
    const allowed = jest.fn(async () => 'local simulator receipt');
    await expect(
      withChannelExecution('wechat', allowed, undefined, database),
    ).rejects.toThrow('CHANNEL_PAUSED');
    expect(
      await withChannelExecution('xiaohongshu', allowed, undefined, database),
    ).toBe('local simulator receipt');
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    const xhs = withChannelExecution(
      'xiaohongshu',
      async () => {
        entered();
        await pending;
        throw Error('simulated failure');
      },
      undefined,
      database,
    );
    await started;
    await confirm('wechat', 'resume');
    expect(
      await withChannelExecution('wechat', allowed, undefined, database),
    ).toBe('local simulator receipt');
    await expect(manager.preview('xiaohongshu', 'archive')).rejects.toThrow(
      'CHANNEL_BUSY',
    );
    finish();
    await expect(xhs).rejects.toThrow('simulated failure');
    const folder = path.join(
      root,
      '.collection-channel-control',
      'xiaohongshu',
    );
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'state.json'), 'broken');
    await expect(
      withChannelExecution('xiaohongshu', allowed, undefined, database),
    ).rejects.toThrow('CHANNEL_STATE_INVALID');
    expect(
      await withChannelExecution('wechat', allowed, undefined, database),
    ).toBe('local simulator receipt');
  });
  it('serializes concurrent confirmations, then accepts an idempotent retry without another backup', async () => {
    const p = await manager.preview('xiaohongshu', 'archive');
    const input = {
      channel: 'xiaohongshu' as const,
      action: 'archive' as const,
      digest: p.digest,
      acknowledged: true as const,
    };
    const outcomes = await Promise.allSettled([
      manager.confirm(input),
      manager.confirm(input),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await manager.confirm(input)).alreadyApplied).toBe(true);
    expect(backup).toHaveBeenCalledTimes(1);
  });
  it('tracks entered child ownership beyond acknowledgement and isolates a damaged startup channel', async () => {
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    let child!: Promise<void>;
    await withChannelExecution(
      'wechat',
      async () => {
        child = withChannelExecution(
          'wechat',
          async () => {
            entered();
            await pending;
          },
          undefined,
          database,
        );
        await started;
      },
      undefined,
      database,
    );
    await expect(manager.preview('wechat', 'archive')).rejects.toThrow(
      'CHANNEL_BUSY',
    );
    expect((await manager.preview('xiaohongshu', 'archive')).visibleCount).toBe(
      2,
    );
    finish();
    await child;
    expect((await manager.preview('wechat', 'archive')).visibleCount).toBe(0);
    const folder = path.join(
      root,
      '.collection-channel-control',
      'xiaohongshu',
    );
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'state.json'), 'broken');
    const xhs = new XhsSubscriptionService(db as any);
    await expect(xhs.onModuleInit()).resolves.toBeUndefined();
    expect(
      await withChannelExecution(
        'wechat',
        async () => 'available',
        undefined,
        database,
      ),
    ).toBe('available');
    await expect(
      withChannelExecution(
        'xiaohongshu',
        async () => 'forbidden',
        undefined,
        database,
      ),
    ).rejects.toThrow('CHANNEL_STATE_INVALID');
    expect(
      await db.$queryRawUnsafe<any[]>(
        'SELECT state FROM xhs_subscription_tasks',
      ),
    ).toEqual([{ state: 'queued' }]);
    await xhs.onModuleDestroy();
  });
  it('rejects stale previews, backup failures, global resume, and invalid inputs without state mutation', async () => {
    const p = await manager.preview('xiaohongshu', 'archive');
    await db.$executeRawUnsafe(
      "UPDATE xhs_subscription_tasks SET updated_at='124'",
    );
    await expect(
      manager.confirm({
        channel: 'xiaohongshu',
        action: 'archive',
        digest: p.digest,
        acknowledged: true,
      }),
    ).rejects.toThrow('CHANNEL_PREVIEW_CHANGED');
    backup.mockRejectedValueOnce(Error('backup failed'));
    await expect(confirm('xiaohongshu', 'archive')).rejects.toThrow(
      'backup failed',
    );
    expect((await readChannelState('xiaohongshu', database)).revision).toBe(0);
    process.env.WECHAT2RSS_RECOVERY_HOLD = '1';
    await expect(confirm('xiaohongshu', 'resume')).rejects.toThrow(
      'CHANNEL_GLOBAL_RECOVERY_HELD',
    );
    await expect(manager.preview('bad' as any, 'archive')).rejects.toThrow(
      'CHANNEL_INVALID',
    );
    await expect(
      manager.confirm({
        channel: 'wechat',
        action: 'archive',
        digest: 'bad',
        acknowledged: true,
      }),
    ).rejects.toThrow('CHANNEL_CONFIRM_INVALID');
    expect((await readChannelState('wechat', database)).revision).toBe(0);
  });
  it('rolls back the control state if atomic publication fails', async () => {
    const original = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('state.json'))
        throw Error('simulated disk failure');
      return original(from, to);
    });
    await expect(confirm('xiaohongshu', 'archive')).rejects.toThrow(
      'simulated disk failure',
    );
    expect((await readChannelState('xiaohongshu', database)).revision).toBe(0);
    expect((await manager.preview('xiaohongshu', 'archive')).visibleCount).toBe(
      2,
    );
  });
  it('binds previews to retained unknown evidence and rejects forged or changed backups', async () => {
    const p = await manager.preview('xiaohongshu', 'archive');
    expect(p.retainedUnknownCount).toBe(3);
    await db.$executeRawUnsafe(
      "UPDATE xhs_unbound_owner_requests SET document='new evidence' WHERE operation_id='old-0'",
    );
    await expect(
      manager.confirm({
        channel: 'xiaohongshu',
        action: 'archive',
        digest: p.digest,
        acknowledged: true,
      }),
    ).rejects.toThrow('CHANNEL_PREVIEW_CHANGED');
    const real = backup.getMockImplementation()!;
    backup.mockImplementationOnce(async () => ({
      ...(await real()),
      sha256: '0'.repeat(64),
    }));
    await expect(confirm('xiaohongshu', 'archive')).rejects.toThrow(
      'CHANNEL_BACKUP_REQUIRED',
    );
    backup.mockImplementationOnce(async () => {
      const report = await real();
      await db.$executeRawUnsafe(
        "UPDATE articles SET document='changed during backup'",
      );
      return report;
    });
    await expect(confirm('xiaohongshu', 'archive')).rejects.toThrow(
      'CHANNEL_DATABASE_CHANGED',
    );
    expect((await readChannelState('xiaohongshu', database)).revision).toBe(0);
  });
  it('cannot use pause or resume to release old queued work or bypass the global write gate', async () => {
    const guarded = new ChannelTaskHistory(
      db,
      () => database,
      backup,
      () => {
        throw Error('GLOBAL_WRITE_HELD');
      },
    );
    const p = await guarded.preview('wechat', 'pause');
    await expect(
      guarded.confirm({
        channel: 'wechat',
        action: 'pause',
        digest: p.digest,
        acknowledged: true,
      }),
    ).rejects.toThrow('GLOBAL_WRITE_HELD');
    await confirm('xiaohongshu', 'pause');
    await expect(confirm('xiaohongshu', 'resume')).rejects.toThrow(
      'CHANNEL_ACTIVE_HISTORY_REVIEW_REQUIRED',
    );
    expect((await readChannelState('xiaohongshu', database)).paused).toBe(true);
    expect(
      await historyArchived('xiaohongshu', 'xhs-task', taskId, database),
    ).toBe(false);
  });
  it('archives queued WeChat batches; restart and resume never send their eight old items', async () => {
    const submit = jest.fn(async () => ({
      state: 'succeeded' as const,
      message: 'simulated',
      accepted: true,
    }));
    const make = () => {
      const batches = new Wechat2RssSubscriptionBatches(
        () => database,
        () => 'fixture',
        submit,
        async () => null,
        async () => {},
      );
      batches.attachRefresh(submit);
      managers.push(batches);
      return batches;
    };
    const first = make();
    const b = await first.enqueueRefresh(
      Array.from({ length: 8 }, (_, i) => `MP_WXS_${1234500000 + i}`),
    );
    const rawPath = path.join(
      root,
      '.wechat2rss-subscription-batches',
      b.batchId + '.json',
    );
    const raw = await fs.readFile(rawPath);
    for (let i = 1; i < 117; i++) {
      const old = JSON.parse(raw.toString());
      old.batchId = randomUUID();
      old.state = 'completed';
      old.items = old.items.map((item: any) => ({
        ...item,
        state: 'skipped',
        message: 'synthetic historical skip',
      }));
      await fs.writeFile(
        path.join(
          root,
          '.wechat2rss-subscription-batches',
          old.batchId + '.json',
        ),
        JSON.stringify(old),
      );
    }
    expect((await manager.preview('wechat', 'archive')).visibleCount).toBe(117);
    await confirm('wechat', 'archive');
    expect(await first.list()).toEqual([]);
    first.close();
    const restarted = make();
    await restarted.init();
    await expect(restarted.runDue()).resolves.toBeUndefined();
    await confirm('wechat', 'resume');
    await restarted.runDue();
    await expect(restarted.resume(b.batchId)).rejects.toThrow(
      'CHANNEL_TASK_ARCHIVED',
    );
    expect(await fs.readFile(rawPath)).toEqual(raw);
    expect(submit).not.toHaveBeenCalled();
    expect(await restarted.list()).toEqual([]);
    expect(
      await historyArchived('wechat', 'wechat-batch', b.batchId, database),
    ).toBe(true);
    const fresh = await restarted.enqueueRefresh(
      Array.from({ length: 8 }, (_, i) => `MP_WXS_${1234500000 + i}`),
    );
    expect(fresh.batchId).not.toBe(b.batchId);
    await restarted.runDue();
    expect(submit).toHaveBeenCalled();
    expect(await fs.readFile(rawPath)).toEqual(raw);
  });
  it('retains archived per-article cache tasks without exposing or continuing them', async () => {
    const run = jest.fn();
    const tasks = new Wechat2RssSubscriptionTasks(
      () => database,
      () => 'fixture',
      run,
    );
    managers.push(tasks);
    const t = await tasks.enqueue({
      articleUrl:
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=1&idx=1',
      feedPath: '/feed/1234567890.xml',
      phase: 'cache',
    });
    await confirm('wechat', 'archive');
    await confirm('wechat', 'resume');
    await tasks.init();
    await tasks.runDue();
    expect(await tasks.list()).toEqual([]);
    await expect(tasks.resume(t.taskId)).rejects.toThrow(
      'CHANNEL_TASK_ARCHIVED',
    );
    expect(run).not.toHaveBeenCalled();
    expect(
      await visibleHistory(
        'wechat',
        'wechat-task',
        [{ id: t.taskId }],
        (r) => r.id,
        database,
      ),
    ).toEqual([]);
  });
  it('blocks actual provider transport for retained source restrictions after a channel resume', async () => {
    await db.$executeRawUnsafe(
      'CREATE TABLE Wechat2RssSourceGate(id INTEGER PRIMARY KEY,state TEXT,token TEXT,status INTEGER)',
    );
    await db.$executeRawUnsafe(
      "INSERT INTO Wechat2RssSourceGate VALUES(1,'stopped','retained-token',429)",
    );
    await confirm('wechat', 'archive');
    await confirm('wechat', 'resume');
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic-only',
      new Wechat2RssSourceGate(db),
    );
    await expect(
      provider.fetchAcceptedArticles(
        '/feed/1234567890.xml',
        'MP_WXS_1234567890',
      ),
    ).rejects.toThrow('WECHAT2RSS_SOURCE_STOPPED');
    expect(
      await db.$queryRawUnsafe<any[]>(
        'SELECT state,status FROM Wechat2RssSourceGate',
      ),
    ).toEqual([{ state: 'stopped', status: 429 }]);
  });
  it('blocks archived XHS IDs at the bound runtime before transport, even after resume', async () => {
    const api = jest
      .fn()
      .mockRejectedValue(Error('SYNTHETIC_TRANSPORT_MUST_NOT_RUN'));
    const runtime = new XhsSubscriptionRuntime({ enabled: () => true, api });
    runtime.bindChannelDatabase(() => database);
    try {
      await runtime.connectSession({
        a1: 'synthetic-only-a1',
        webSession: 'synthetic-only-session',
      });
      await confirm('xiaohongshu', 'archive');
      await confirm('xiaohongshu', 'resume');
      await expect(
        runtime.withTaskScope({ taskId, creatorId: 'creator' }, () =>
          runtime.resolve(
            'https://www.xiaohongshu.com/explore/synthetic-note?xsec_token=synthetic-access&xsec_source=app_share',
          ),
        ),
      ).rejects.toThrow('XHS_LIVE_ACCESS_DISABLED');
      expect(api).not.toHaveBeenCalled();
      expect(
        await db.$queryRawUnsafe<any[]>(
          "SELECT * FROM xhs_unbound_owner_requests WHERE state='unknown'",
        ),
      ).toHaveLength(3);
    } finally {
      runtime.onModuleDestroy();
    }
  });
});
