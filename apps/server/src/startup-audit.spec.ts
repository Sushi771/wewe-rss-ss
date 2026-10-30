beforeAll(require('../../../scripts/local-release/writer-self.fixture.test.cjs').prepareWriterSelf);
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteSnapshotGuard } from './collection/sqlite-snapshot-guard';
import {
  startupAuditHttpGuard,
  assertDatabaseWritesAllowed,
  databaseWritesAllowed,
  waitForStartupAudit,
  startupMessage,
  startSnapshotsAfterStartupAudit,
} from './startup-audit';
import { PrismaService } from './prisma/prisma.service';
import { TrpcService } from './trpc/trpc.service';
import * as snapshotStatus from './collection/sqlite-snapshot-guard';

describe('startup audit lifecycle', () => {
  const global = globalThis as any;
  afterEach(() => {
    delete global.__weweStartupAudit;
    jest.restoreAllMocks();
  });

  function request(path: string, method = 'GET', query = {}) {
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    const next = jest.fn();
    startupAuditHttpGuard({ path, method, query } as any, res, next);
    return { res, next };
  }
  it('the existing status read carries only the sanitized owner display snapshot and does not acquire a lease', () => {
    const display = snapshotStatus.safePeriodicLifecycleStatus({
      status: 'pending-confirmation',
      normalCopies: 3,
      pendingCopies: 1,
      lastGeneratedAtMs: 10,
      lastVerifiedAtMs: 20,
      coverageAtMs: 10,
      backup: 'private-path',
      token: 'private-token',
    })!;
    const current = jest
      .spyOn(snapshotStatus, 'periodicSnapshotPublicStatus')
      .mockReturnValue({ ...display, observedAtMs: 30 });
    const lease = jest.spyOn(snapshotStatus, 'queryFastInsertSnapshotGuard');
    const payload = request('/startup-status').res.json.mock.calls[0][0];
    expect(payload.periodicBackup).toMatchObject({
      generationPaused: true,
      normalCopies: 3,
      pendingCopies: 1,
      lastGeneratedAtMs: 10,
      lastVerifiedAtMs: 20,
      coverageAtMs: 10,
    });
    expect(JSON.stringify(payload)).not.toContain('private-');
    expect(lease).not.toHaveBeenCalled();
    current.mockReturnValue(null);
    expect(
      request('/startup-status').res.json.mock.calls[0][0].periodicBackup,
    ).toBeNull();
  });
  it('keeps cached reads, independent settings and private login usable; blocks write-triggering HTTP before side effects', async () => {
    global.__weweStartupAudit = {
      status: 'verifying',
      ready: Promise.resolve(false),
    };
    for (const path of [
      '/dash/tools/article-download',
      '/feeds/f.rss',
      '/download/article/single-tasks',
      '/offline/feed/f.zip',
    ])
      expect(request(path).next).toHaveBeenCalled();
    for (const path of [
      '/auth/login',
      '/auth/logout',
      '/download/article/settings',
      '/download/article/directory',
      '/trpc/feed.list',
      '/download/article/single-task/abcdef-1234/cancel',
      '/download/article/browser-task/abcdef-1234/cancel',
    ])
      expect(request(path, 'POST').next).toHaveBeenCalled();
    for (const req of [
      request('/download/article', 'POST'),
      request('/feeds/f.rss', 'GET', { update: '1' }),
    ]) {
      expect(req.next).not.toHaveBeenCalled();
      expect(req.res.status).toHaveBeenCalledWith(503);
    }
    expect(databaseWritesAllowed()).toBe(false);
    expect(await waitForStartupAudit()).toBe(false);
    expect(() => assertDatabaseWritesAllowed()).toThrow('正在检查');
    global.__weweStartupAudit.status = 'failed';
    expect(() => assertDatabaseWritesAllowed()).toThrow('检查失败');
    global.__weweStartupAudit.status = 'ready';
    expect(request('/download/article', 'POST').next).toHaveBeenCalled();
    expect(() => assertDatabaseWritesAllowed()).not.toThrow();
  });
  it('status never claims completion or exposes raw paths and diagnostics while verifying or failed', () => {
    for (const status of ['verifying', 'failed']) {
      global.__weweStartupAudit = {
        status,
        secret: 'private-token',
        path: 'private-path',
      };
      const { res } = request('/startup-status');
      const payload = res.json.mock.calls[0][0];
      expect(payload.status).toBe(status);
      expect(payload.writesAllowed).toBe(false);
      expect(JSON.stringify(payload)).not.toContain('private-');
    }
  });
  it('Prisma middleware protects nested/raw/background writes and restores them only after success', async () => {
    let middleware: any;
    jest.spyOn(PrismaService.prototype, '$use').mockImplementation((fn) => {
      middleware = fn;
    });
    const client = new PrismaService();
    const next = jest.fn(async () => 'executed');
    global.__weweStartupAudit = { status: 'verifying' };
    expect(await middleware({ action: 'findMany' }, next)).toBe('executed');
    for (const action of [
      'create',
      'update',
      'upsert',
      'deleteMany',
      'executeRaw',
      'queryRaw',
    ])
      await expect(middleware({ action }, next)).rejects.toThrow('正在检查');
    global.__weweStartupAudit.status = 'failed';
    await expect(middleware({ action: 'update' }, next)).rejects.toThrow(
      '检查失败',
    );
    global.__weweStartupAudit.status = 'ready';
    expect(await middleware({ action: 'update' }, next)).toBe('executed');
    await client.$disconnect();
  });
  it('tRPC batched queries remain usable and mutations/GET login-result cannot start protected work', async () => {
    const service = new TrpcService(
      {} as any,
      {
        get: (key: string) =>
          key === 'platform'
            ? { url: 'http://127.0.0.1:1' }
            : { updateDelayTime: 60 },
      } as any,
      {} as any,
      {} as any,
    );
    const work = jest.fn(() => 'done');
    const router = service.router({
      feed: service.router({
        list: service.protectedProcedure.query(work),
        update: service.protectedProcedure.mutation(work),
        stopSubscriptionBatch: service.protectedProcedure.mutation(work),
      }),
      platform: service.router({
        getLoginResult: service.protectedProcedure.query(work),
      }),
    });
    const caller = router.createCaller({});
    global.__weweStartupAudit = { status: 'verifying' };
    expect(await caller.feed.list()).toBe('done');
    expect(await caller.feed.stopSubscriptionBatch()).toBe('done');
    await expect(caller.feed.update()).rejects.toThrow('正在检查');
    await expect(caller.platform.getLoginResult()).rejects.toThrow('正在检查');
    expect(work).toHaveBeenCalledTimes(2);
    global.__weweStartupAudit.status = 'ready';
    expect(await caller.feed.update()).toBe('done');
  });

  it.each([true, false])(
    'task recovery waits for audit and only resumes on success=%s',
    async (passed) => {
      const previousMode = process.env.NODE_ENV;
      const previousGuard = process.env.REHEARSAL_GUARD_REPORT;
      process.env.NODE_ENV = 'production';
      delete process.env.REHEARSAL_GUARD_REPORT;
      let finish!: (ok: boolean) => void;
      global.__weweStartupAudit = {
        status: 'verifying',
        ready: new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      };
      const service = new TrpcService(
        {} as any,
        {
          get: (key: string) =>
            key === 'platform'
              ? { url: 'http://127.0.0.1:1' }
              : { updateDelayTime: 60 },
        } as any,
        {} as any,
        {} as any,
      );
      const tasks = jest
        .spyOn((service as any).subscriptionTasks, 'init')
        .mockResolvedValue(undefined);
      const batches = jest
        .spyOn((service as any).subscriptionBatches, 'init')
        .mockResolvedValue(undefined);
      try {
        await service.onModuleInit();
        expect(tasks).not.toHaveBeenCalled();
        expect(batches).not.toHaveBeenCalled();
        global.__weweStartupAudit.status = passed ? 'ready' : 'failed';
        finish(passed);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(tasks).toHaveBeenCalledTimes(passed ? 1 : 0);
        expect(batches).toHaveBeenCalledTimes(passed ? 1 : 0);
      } finally {
        if (previousMode === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousMode;
        if (previousGuard === undefined)
          delete process.env.REHEARSAL_GUARD_REPORT;
        else process.env.REHEARSAL_GUARD_REPORT = previousGuard;
        service.onModuleDestroy();
      }
    },
  );
});

describe('capacity failure message', () => {
  afterEach(() => delete global.__weweStartupAudit);
  it('keeps reads available while explaining protected writes paused for capacity', () => {
    global.__weweStartupAudit = {
      status: 'failed',
      reason: 'space-budget-exceeded',
    };
    expect(startupMessage()).toContain('备份空间预算不足');
    expect(startupMessage()).toContain('已有恢复点保留');
  });
});

describe('startup audit and periodic snapshots share a finite root', () => {
  it('finishes the real startup worker before starting the enabled Python owner', async () => {
    const originalEnv = { ...process.env };
    const directory = fs.mkdtempSync(
      path.join(tmpdir(), 'wewe-startup-periodic-'),
    );
    const database = path.join(directory, 'synthetic.db'),
      backups = path.join(directory, 'backups');
    const migrations = path.resolve(__dirname, '../prisma/migrations');
    const owner = new SqliteSnapshotGuard();
    try {
      execFileSync(
        process.env.SQLITE_BACKUP_PYTHON ||
          (process.platform === 'win32' ? 'python' : 'python3'),
        [
          path.resolve(
            __dirname,
            '../../../scripts/local-release/synthetic-sqlite.py',
          ),
          '--database',
          database,
          '--migrations',
          migrations,
        ],
        {
          windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      );
      Object.assign(process.env, {
        DATABASE_URL: 'file:' + database,
        SQLITE_PERIODIC_SNAPSHOT_ENABLED: '1',
        SQLITE_BACKUP_KIND: 'test',
        SQLITE_TEST_BACKUP_ROOT: backups,
        SQLITE_TEST_BUDGET_ROOT: directory,
      });
      const localRequire = createRequire(__filename);
      const { createStartupAudit } = localRequire(
        path.resolve(
          __dirname,
          '../../../scripts/local-release/startup-audit.cjs',
        ),
      );
      const audit = createStartupAudit({
        database,
        migrations,
        auditRoot: path.join(directory, 'audit'),
        backupRoot: backups,
        kind: 'test',
      });
      (globalThis as any).__weweStartupAudit = audit;
      let periodicStarted = false;
      const started = startSnapshotsAfterStartupAudit(async () => {
        expect(audit.status).toBe('ready');
        expect(fs.existsSync(path.join(backups, '.space-budget.lock'))).toBe(
          false,
        );
        expect(fs.existsSync(backups)).toBe(false);
        periodicStarted = true;
        await owner.start();
      });
      expect(periodicStarted).toBe(false);
      await expect(started).resolves.toBe(true);
      let healthy = false;
      for (let i = 0; i < 30; i++) {
        const status = await owner.query();
        if (status.verified && status.fresh) {
          healthy = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(healthy).toBe(true);
      expect(audit.status).toBe('ready');
      expect(
        fs
          .readdirSync(backups)
          .filter((name) => name.startsWith('periodic-snapshot-')),
      ).toHaveLength(1);
    } finally {
      owner.stop();
      delete (globalThis as any).__weweStartupAudit;
      process.env = originalEnv;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(path.dirname(directory)).toBe(tmpdir());
      expect(path.basename(directory)).toMatch(/^wewe-startup-periodic-/);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
});
