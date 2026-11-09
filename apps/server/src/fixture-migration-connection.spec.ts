import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFixtureMigrationConnection } from '../test/fixture-migration-connection';

jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client');
  return {
    ...actual,
    PrismaClient: jest.fn((options) => new actual.PrismaClient(options)),
  };
});

const constructor = PrismaClient as jest.MockedClass<typeof PrismaClient>;

describe('explicit test fixture migration connection', () => {
  beforeEach(() => constructor.mockClear());

  it.each([
    ['file:/synthetic/a.sqlite', 'file:/synthetic/a.sqlite?connection_limit=1'],
    [
      'file:/synthetic/a%20b.sqlite?socket_timeout=10&tag=a%2Fb',
      'file:/synthetic/a%20b.sqlite?socket_timeout=10&tag=a%2Fb&connection_limit=1',
    ],
    [
      'file:/synthetic/a.sqlite?',
      'file:/synthetic/a.sqlite?connection_limit=1',
    ],
    [
      'file:/synthetic/a.sqlite?connection_limit=1&socket_timeout=10',
      'file:/synthetic/a.sqlite?connection_limit=1&socket_timeout=10',
    ],
  ])('preserves the explicit fixture URL %s', async (original, expected) => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const migrationClient = { $disconnect: disconnect } as any;
    constructor.mockImplementationOnce(() => migrationClient);
    const result = { retained: true };
    const migrate = jest.fn(async (client) => {
      expect(client).toBe(migrationClient);
      return result;
    });
    await expect(
      withFixtureMigrationConnection(original, migrate),
    ).resolves.toBe(result);
    expect(original).not.toContain('connection_limit=1&connection_limit');
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledWith({
      datasources: { db: { url: expected } },
    });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    '',
    'file:',
    'file:?',
    'file:?connection_limit=1',
    'postgresql://synthetic.invalid/db',
    'file:/synthetic/a.sqlite#fragment',
    'file:/synthetic/a.sqlite?connection_limit=2',
    'file:/synthetic/a.sqlite?connection_limit=1&connection_limit=1',
    'file:/synthetic/a.sqlite?connection_limit=1&%63onnection_limit=2',
  ])(
    'rejects an ambiguous or non-fixture URL before constructing: %s',
    async (url) => {
      const migrate = jest.fn();
      await expect(
        withFixtureMigrationConnection(url, migrate),
      ).rejects.toThrow();
      expect(constructor).not.toHaveBeenCalled();
      expect(migrate).not.toHaveBeenCalled();
    },
  );

  it('disconnects once and propagates the original migration failure without retry', async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    constructor.mockImplementationOnce(
      () => ({ $disconnect: disconnect }) as any,
    );
    const failure = new Error('synthetic migration failure');
    const migrate = jest.fn(async () => {
      throw failure;
    });
    await expect(
      withFixtureMigrationConnection('file:/synthetic/a.sqlite', migrate),
    ).rejects.toBe(failure);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('synthetic migration failure'), undefined])(
    'retains both migration and disconnect failures without retry (%s)',
    async (migrationError) => {
      const disconnectError = new Error('synthetic disconnect failure');
      const disconnect = jest.fn().mockRejectedValue(disconnectError);
      constructor.mockImplementationOnce(
        () => ({ $disconnect: disconnect }) as any,
      );
      const migrate = jest.fn(async () => {
        throw migrationError;
      });
      const error = await withFixtureMigrationConnection(
        'file:/synthetic/a.sqlite',
        migrate,
      ).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual([migrationError, disconnectError]);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('does not swallow a failed disconnect', async () => {
    const failure = new Error('synthetic disconnect failure');
    constructor.mockImplementationOnce(
      () => ({ $disconnect: jest.fn().mockRejectedValue(failure) }) as any,
    );
    await expect(
      withFixtureMigrationConnection('file:/synthetic/a.sqlite', async () => 1),
    ).rejects.toBe(failure);
  });

  it('keeps native BEGIN/rebuild/COMMIT on one connection and exposes committed rows to the unchanged business client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-affinity-'));
    const originalUrl =
      'file:' + join(directory, 'fixture.sqlite').replace(/\\/g, '/');
    const business = new PrismaClient({
      datasources: { db: { url: originalUrl } },
    });
    try {
      await withFixtureMigrationConnection(
        originalUrl,
        async (migrationClient) => {
          expect(migrationClient).not.toBe(business);
          const statements = [
            'CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT)',
            "INSERT INTO retained VALUES (1, 'unchanged')",
            'BEGIN IMMEDIATE',
            'CREATE TABLE rebuilt (id INTEGER PRIMARY KEY, value TEXT)',
            'INSERT INTO rebuilt SELECT * FROM retained',
            'DROP TABLE retained',
            'ALTER TABLE rebuilt RENAME TO retained',
            'COMMIT',
          ];
          for (const sql of statements) {
            await migrationClient.$executeRawUnsafe(sql);
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        },
      );
      expect(await business.$queryRawUnsafe('SELECT * FROM retained')).toEqual([
        { id: 1, value: 'unchanged' },
      ]);
      expect(constructor.mock.calls).toEqual([
        [{ datasources: { db: { url: originalUrl } } }],
        [{ datasources: { db: { url: originalUrl + '?connection_limit=1' } } }],
      ]);
      await business.$executeRawUnsafe(
        "INSERT INTO retained VALUES (2, 'business')",
      );
      expect(
        await business.$queryRawUnsafe(
          'SELECT value FROM retained ORDER BY id',
        ),
      ).toEqual([{ value: 'unchanged' }, { value: 'business' }]);
    } finally {
      await business.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
