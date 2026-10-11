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
      }),
      platform: service.router({
        getLoginResult: service.protectedProcedure.query(work),
      }),
    });
    const caller = router.createCaller({});
    global.__weweStartupAudit = { status: 'verifying' };
    expect(await caller.feed.list()).toBe('done');
    await expect(caller.feed.update()).rejects.toThrow('正在检查');
    await expect(caller.platform.getLoginResult()).rejects.toThrow('正在检查');
    expect(work).toHaveBeenCalledTimes(1);
    global.__weweStartupAudit.status = 'ready';
    expect(await caller.feed.update()).toBe('done');
  });
});
