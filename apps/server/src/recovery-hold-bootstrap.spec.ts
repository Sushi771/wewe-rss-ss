import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from './trpc/trpc.router';
import { privateAccessGuard } from './private-access';
import { recoveryHoldHttp } from './recovery-hold-http';
import { startupAuditHttpGuard } from './startup-audit';

jest.mock('./collection/sqlite-snapshot-guard', () => ({
  startSqliteSnapshotGuard: jest.fn(),
  stopSqliteSnapshotGuard: jest.fn(),
}));
jest.mock('./startup-audit', () => ({
  ...jest.requireActual('./startup-audit'),
  startupAudit: () => undefined,
}));
jest.mock('./browser-task.opt-in', () => ({
  readBrowserTaskOptIn: () => undefined,
  browserTaskApplication: () => class FixtureModule {},
  mountBrowserTaskTransport: jest.fn(),
}));

it('actual main bootstrap installs recovery gate ahead of application routes', async () => {
  const uses: unknown[] = [];
  let routesMountedAt = -1;
  const app = {
    use: jest.fn((middleware: unknown) => uses.push(middleware)),
    useStaticAssets: jest.fn(),
    setBaseViewsDir: jest.fn(),
    setViewEngine: jest.fn(),
    enableCors: jest.fn(),
    listen: jest.fn().mockResolvedValue(undefined),
    getHttpServer: () => ({ once: jest.fn() }),
    get: (token: unknown) =>
      token === ConfigService
        ? { get: () => ({ host: '127.0.0.1', port: 0, isProd: false }) }
        : token === TrpcRouter
          ? {
              applyMiddleware: () => {
                routesMountedAt = uses.length;
              },
            }
          : undefined,
  };
  const create = jest
    .spyOn(NestFactory, 'create')
    .mockResolvedValue(app as any);
  const on = jest.spyOn(process, 'on').mockReturnValue(process);
  const once = jest.spyOn(process, 'once').mockReturnValue(process);
  try {
    require('./main');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(uses.indexOf(privateAccessGuard)).toBeLessThan(
      uses.indexOf(recoveryHoldHttp),
    );
    expect(uses.indexOf(recoveryHoldHttp)).toBeGreaterThanOrEqual(0);
    expect(uses.indexOf(recoveryHoldHttp)).toBeLessThan(
      uses.indexOf(startupAuditHttpGuard),
    );
    expect(routesMountedAt).toBeGreaterThan(uses.indexOf(recoveryHoldHttp));
    expect(app.listen).toHaveBeenCalledWith(0, '127.0.0.1');
  } finally {
    create.mockRestore();
    on.mockRestore();
    once.mockRestore();
  }
});
