import {
  startupAuditHttpGuard,
  assertDatabaseWritesAllowed,
  databaseWritesAllowed,
  waitForStartupAudit,
} from './startup-audit';
import { PrismaService } from './prisma/prisma.service';
import { TrpcService } from './trpc/trpc.service';

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
    const { startupMessage } = require('./startup-audit');
    expect(startupMessage()).toContain('备份空间预算不足');
    expect(startupMessage()).toContain('已有恢复点保留');
  });
});
