import { withFixtureMigrationConnection } from '../test/fixture-migration-connection';
import { Test } from '@nestjs/testing';
beforeAll(
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Observe the real test process for the unchanged writer boundary.
  require('../../../scripts/local-release/writer-self.fixture.test.cjs')
    .prepareWriterSelf,
);
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { CollectionService } from './collection/collection.service';
import { WereadService } from './weread/weread.service';
import { TrpcRouter } from './trpc/trpc.router';
import { privateAccessGuard } from './private-access';
import { recoveryHoldHttp } from './recovery-hold-http';
import { startupAuditHttpGuard } from './startup-audit';
import { projectWriterGate } from './collection/project-writer-boundary';
import { splitSqliteStatements } from '../../../scripts/sqlite-statements.cjs';

jest.mock('./offline-archive', () => ({ archiveDirectory: jest.fn() }));
jest.mock('./collection/provider-registry', () => ({
  ...jest.requireActual('./collection/provider-registry'),
  wechat2RssProvider: jest.fn(() => {
    throw new Error('OFFLINE_FIXTURE');
  }),
}));
describe('AppModule startup with recovery hold (isolated fixture)', () => {
  const original = { ...process.env };
  let root: string;
  let app: NestExpressApplication | undefined;
  let prisma: PrismaService;
  let writerLease: { close(): void };
  let initialFiles: string[];
  let databaseBytes: Buffer;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-held-app-'));
    const database = join(root, 'synthetic.sqlite');
    await writeFile(database, '', { flag: 'wx' });
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
      XHS_SUBSCRIPTION_LIVE_ENABLED: '0',
    });
    delete process.env.REHEARSAL_GUARD_REPORT;
    writerLease = projectWriterGate().writerForUrl(process.env.DATABASE_URL);
    prisma = new PrismaService();
    // AppModule's local recovery hooks need their actual schema, even with
    // all source access held. An empty migrated database proves no queued
    // work is changed while keeping the real startup and writer guards.
    const migrations = resolve(__dirname, '../prisma/migrations');
    const entries = await readdir(migrations, { withFileTypes: true });
    await withFixtureMigrationConnection(
      'file:' + database,
      async (migrationClient) => {
        for (const entry of entries.sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (!entry.isDirectory()) continue;
          for (const statement of splitSqliteStatements(
            await readFile(
              join(migrations, entry.name, 'migration.sql'),
              'utf8',
            ),
          ))
            await migrationClient.$executeRawUnsafe(statement);
        }
      },
    );
    await mkdir(join(root, '.cache-incremental'));
    initialFiles = (await readdir(root)).sort();
    databaseBytes = await readFile(database);
  }, 30000);
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await prisma?.$disconnect();
    await writerLease?.close();
    jest.restoreAllMocks();
    process.env = { ...original };
    expect(dirname(root)).toBe(tmpdir());
    expect(basename(root)).toMatch(/^wewe-held-app-/);
    await rm(root, { recursive: true, force: true });
  });
  it('initializes actual AppModule without touching isolated queued-state fixture', async () => {
    const outbound = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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
    expect((await readdir(root)).sort()).toEqual(initialFiles);
    expect(await readFile(join(root, 'synthetic.sqlite'))).toEqual(
      databaseBytes,
    );
    expect(await readFile(join(root, 'untouched.json'), 'utf8')).toBe(
      '{"unknown":true}',
    );
    outbound.mockRestore();
    // Include actual module bootstrap and SQLite recovery in a finite I/O bound.
  }, 30000);
  // The isolated local HTTP connection was rejected with EACCES. Do not retry
  // through another port, permission level, or transport without authorization.
  it.skip('runs actual module lifecycle and blocks controller and tRPC routes before their handlers', async () => {
    const outbound = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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
    expect((await readdir(root)).sort()).toEqual(initialFiles);
    expect(await readFile(join(root, 'synthetic.sqlite'))).toEqual(
      databaseBytes,
    );
    expect(await readFile(join(root, 'untouched.json'), 'utf8')).toBe(
      '{"unknown":true}',
    );
    outbound.mockRestore();
  });
});
