import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { CollectionService } from './collection/collection.service';
import { WereadService } from './weread/weread.service';
import { TrpcRouter } from './trpc/trpc.router';
import { privateAccessGuard } from './private-access';
import { recoveryHoldHttp } from './recovery-hold-http';
import { startupAuditHttpGuard } from './startup-audit';

jest.mock('./offline-archive', () => ({ archiveDirectory: jest.fn() }));
jest.mock('./collection/provider-registry', () => ({
  ...jest.requireActual('./collection/provider-registry'),
  wechat2RssProvider: jest.fn(() => {
    throw new Error('OFFLINE_FIXTURE');
  }),
}));
jest.mock('./startup-audit', () => ({
  ...jest.requireActual('./startup-audit'),
  databaseWritesAllowed: () => true,
  waitForStartupAudit: async () => true,
}));

describe('AppModule startup with recovery hold (isolated fixture)', () => {
  const original = { ...process.env };
  let root: string;
  let app: NestExpressApplication | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-held-app-'));
    const database = join(root, 'synthetic.sqlite');
    await writeFile(database, 'fixture');
    await writeFile(join(root, 'untouched.json'), '{"unknown":true}');
    Object.assign(process.env, {
      NODE_ENV: 'production',
      PRIVATE_ONLINE_MODE: '0',
      DATABASE_URL: `file:${database}`,
      WECHAT2RSS_RECOVERY_HOLD: '1',
      WECHAT2RSS_ENABLED: '1',
      WECHAT2RSS_CACHE_SYNC: '1',
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    });
    delete process.env.REHEARSAL_GUARD_REPORT;
  });
  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
    process.env = { ...original };
    await rm(root, { recursive: true, force: true });
  });
  it('initializes actual AppModule without touching isolated queued-state fixture', async () => {
    const outbound = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WereadService)
      .useValue({})
      .overrideProvider(CollectionService)
      .useValue({})
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) =>
          key === 'platform'
            ? { url: '' }
            : key === 'feed'
              ? { updateDelayTime: 0 }
              : {},
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.use(privateAccessGuard);
    app.use(recoveryHoldHttp);
    app.use(startupAuditHttpGuard);
    app.get(TrpcRouter).applyMiddleware(app);
    await app.init();
    expect(outbound).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['synthetic.sqlite', 'untouched.json']);
    expect(await readFile(join(root, 'untouched.json'), 'utf8')).toBe(
      '{"unknown":true}',
    );
    outbound.mockRestore();
  });
  // The isolated local HTTP connection was rejected with EACCES. Do not retry
  // through another port, permission level, or transport without authorization.
  it.skip('runs actual module lifecycle and blocks controller and tRPC routes before their handlers', async () => {
    const outbound = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WereadService)
      .useValue({})
      .overrideProvider(CollectionService)
      .useValue({})
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) =>
          key === 'platform'
            ? { url: '' }
            : key === 'feed'
              ? { updateDelayTime: 0 }
              : {},
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    // Same order as main.ts; real AppModule supplies controllers and providers.
    app.use(privateAccessGuard);
    app.use(recoveryHoldHttp);
    app.use(startupAuditHttpGuard);
    app.get(TrpcRouter).applyMiddleware(app);
    await app.init();
    const server = app.getHttpServer();
    for (const url of [
      '/feeds/test?update=1',
      '/proxy/image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Ftest',
      '/download/article/single-task/test/candidates',
      '/api/trpc/feed.refreshArticles',
    ]) {
      await request(server).get(url).expect(503);
    }
    await request(server)
      .post('/api/trpc/feed.addFromArticle')
      .send({})
      .expect(503);
    expect(outbound).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['synthetic.sqlite', 'untouched.json']);
    expect(await readFile(join(root, 'untouched.json'), 'utf8')).toBe(
      '{"unknown":true}',
    );
    outbound.mockRestore();
  });
});
