import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import * as backup from '../collection/sqlite-backup';

jest.setTimeout(30000);
describe('ordinary account edits and explicit credential protection (synthetic SQLite)', () => {
  const original = { ...process.env };
  const realBackup = backup.createVerifiedSqliteBackup;
  let root: string, prisma: PrismaService;
  let api: ReturnType<TrpcRouter['appRouter']['createCaller']>;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-ordinary-account-'));
    Object.assign(process.env, {
      DATABASE_URL: 'file:' + path.join(root, 'fixture.db'),
      SQLITE_BACKUP_KIND: 'test',
      SQLITE_TEST_BACKUP_ROOT: path.join(root, 'backups'),
      SQLITE_TEST_MAX_BYTES: String(10 * 1024 ** 2),
      SQLITE_TEST_MAX_COPIES: '5',
      SQLITE_TEST_MIN_FREE_BYTES: '1048576',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
    });
    prisma = new PrismaService();
    for (const name of (
      await fs.readdir(path.resolve(__dirname, '../../prisma/migrations'))
    ).sort()) {
      const sql = await fs
        .readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations',
            name,
            'migration.sql',
          ),
          'utf8',
        )
        .catch(() => '');
      for (const statement of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.account.create({
      data: {
        id: 'fixture',
        name: 'local name',
        token: 'synthetic-old-token',
        status: 1,
      },
    });
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const service = new TrpcService(prisma, config, {} as any, {} as any);
    api = new TrpcRouter(
      service,
      prisma,
      config,
      {} as any,
      {} as any,
    ).appRouter.createCaller({ errorMsg: null, isLocal: true });
    jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValue(Error('SNAPSHOTS_UNAVAILABLE'));
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NETWORK_FORBIDDEN'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma?.$disconnect();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^wewe-ordinary-account-/);
    await fs.rm(root, { recursive: true, force: true });
    process.env = { ...original };
  });
  it.each([
    { name: 'new local name' },
    { status: 0 },
    { name: 'combined', status: 0 },
    {},
  ])(
    'commits ordinary %j without any snapshot or credential exposure',
    async (data) => {
      const result = await api.account.edit({ id: 'fixture', data });
      expect(result).not.toHaveProperty('token');
      expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
      const fresh = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        expect(
          await fresh.account.findUniqueOrThrow({ where: { id: 'fixture' } }),
        ).toMatchObject({ ...data, token: 'synthetic-old-token' });
      } finally {
        await fresh.$disconnect();
      }
    },
  );
  it('rolls back a real SQL failure without a snapshot or partial edit', async () => {
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER refuse_account_update BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'synthetic-update-failure'); END",
    );
    const before = await prisma.account.findMany();
    await expect(
      api.account.edit({
        id: 'fixture',
        data: { name: 'uncommitted', status: 0 },
      }),
    ).rejects.toThrow();
    expect(await prisma.account.findMany()).toEqual(before);
    expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
  it('refuses low physical space and unsafe durability without a write', async () => {
    const before = await prisma.account.findMany();
    const actual = fs.statfs.bind(fs);
    const space = jest.spyOn(fs, 'statfs').mockImplementation((async (
      ...args: any[]
    ) => ({
      ...(await (actual as any)(...args)),
      bsize: 1n,
      bavail: 0n,
    })) as any);
    await expect(
      api.account.edit({ id: 'fixture', data: { name: 'no space' } }),
    ).rejects.toThrow('INCREMENTAL_DISK_SPACE_INSUFFICIENT');
    space.mockRestore();
    await prisma.$executeRawUnsafe('PRAGMA synchronous=OFF');
    await expect(
      api.account.edit({ id: 'fixture', data: { status: 0 } }),
    ).rejects.toThrow('INCREMENTAL_DURABILITY_MODE_UNPROVED');
    expect(await prisma.account.findMany()).toEqual(before);
    expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
  });
  it('credential replacement still fails closed when its single required backup fails', async () => {
    const before = await prisma.account.findMany();
    await expect(
      api.account.edit({
        id: 'fixture',
        data: { name: 'uncommitted', token: 'synthetic-new-token' },
      }),
    ).rejects.toThrow('SNAPSHOTS_UNAVAILABLE');
    expect(backup.createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(await prisma.account.findMany()).toEqual(before);
  });
  it('credential replacement retains exactly one verified recovery gate', async () => {
    jest
      .mocked(backup.createVerifiedSqliteBackup)
      .mockImplementation(realBackup);
    const result = await api.account.edit({
      id: 'fixture',
      data: { token: 'synthetic-new-token' },
    });
    expect(result).not.toHaveProperty('token');
    expect(backup.createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(
      (
        await jest.mocked(backup.createVerifiedSqliteBackup).mock.results[0]
          .value
      ).recoveryOrigin.kind,
    ).toBe('protected');
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: 'fixture' } }))
        .token,
    ).toBe('synthetic-new-token');
  });
});
