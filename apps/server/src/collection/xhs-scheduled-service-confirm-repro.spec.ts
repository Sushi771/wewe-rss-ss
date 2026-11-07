jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));
import { createVerifiedSqliteBackup } from './sqlite-backup';
it('reports only fixed idle-stage classification for an untrusted error', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const secret = 'PRIVATE_SQL_PATH_USER';
  const host: any = {
    readyForMutation: async () => {},
    running: new Set(),
    reviewing: new Set(),
    starting: new Set(),
    runtime: { hasActiveSourceSessions: () => false },
    db: {
      $queryRawUnsafe: async () => {
        throw Object.assign(Error(secret), { name: secret, code: secret });
      },
    },
    fullHistoryError: (error: unknown) => {
      throw error;
    },
  };
  try {
    await expect(
      XhsWholeCreatorService.prototype.confirmScheduledPolicy.call(host, {
        creatorIds: ['a', 'b', 'c'],
        maxRequests: 3,
        phaseLimits: { profile: 1, list: 1, detail: 1, media: 1 },
        digest: 'a'.repeat(64),
        acknowledgedRecurringCollection: true,
        acknowledgedUnknownScope: true,
        acknowledgedDuplicateDirectoryRead: true,
      }),
    ).rejects.toThrow(secret);
    expect(warn).toHaveBeenCalledTimes(1);
    const event = JSON.parse(warn.mock.calls[0][0]);
    expect(event).toEqual({
      event: 'xhs-scheduled-confirm-failed',
      stage: 'idle-outer-start',
      code: 'REVIEW_INTERNAL_UNCLASSIFIED',
      name: 'UNCLASSIFIED',
      checks: {},
    });
    expect(JSON.stringify(event)).not.toContain(secret);
  } finally {
    warn.mockRestore();
  }
});
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { sqliteWrites } from './sqlite-write-coordinator';
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
it.each(['idle', 'memory-busy', 'durable-busy'] as const)(
  'confirms safely with a single connection: %s',
  async (scenario) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-policy-clock-'));
    const db = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' +
            path.join(dir, 'synthetic.sqlite').replace(/\\/g, '/') +
            '?connection_limit=1',
        },
      },
    });
    try {
      const migrations = path.resolve(__dirname, '../../prisma/migrations');
      for (const name of (await fs.readdir(migrations)).sort()) {
        if (!(await fs.stat(path.join(migrations, name))).isDirectory())
          continue;
        for (const sql of splitSqliteStatements(
          await fs.readFile(
            path.join(migrations, name, 'migration.sql'),
            'utf8',
          ),
        ))
          await db.$executeRawUnsafe(sql);
      }
      const creatorIds = ['clock-a', 'clock-b', 'clock-c'];
      for (const id of creatorIds)
        await db.xhsCreator.create({
          data: {
            id,
            externalAuthorId: 'author-' + id,
            displayName: 'Synthetic',
            profileUrl: 'https://example.invalid/' + id,
          },
        });
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,1000)",
      );

      const database = path.join(dir, 'synthetic.sqlite');
      db.$use((params, next) =>
        sqliteWrites.write(
          () => next(params),
          params.runInTransaction === true,
        ),
      );
      (createVerifiedSqliteBackup as jest.Mock).mockImplementation(async () => {
        const backup = path.join(dir, 'protected.sqlite');
        await fs.copyFile(database, backup);
        if (scenario === 'memory-busy') host.running.add('synthetic-active');
        return {
          source: database,
          backup,
          sha256: 'a'.repeat(64),
          integrityCheck: 'ok',
          recoveryOrigin: {
            format: 'sqlite-recovery-origin-v1',
            kind: 'protected',
          },
        };
      });
      const host: any = {
        db,
        running: new Set(),
        reviewing: new Set(),
        starting: new Set(),
        runtime: { hasActiveSourceSessions: () => false },
        readyForMutation: async () => {},
        write: (fn: any) =>
          (XhsWholeCreatorService.prototype as any).write.call(
            host,
            async (tx: any) => {
              if (scenario === 'durable-busy') {
                const query = tx.$queryRawUnsafe.bind(tx);
                return fn(
                  new Proxy(tx, {
                    get(target, key) {
                      if (key === '$queryRawUnsafe')
                        return (sql: string, ...args: unknown[]) =>
                          sql.includes(
                            'UNION ALL SELECT id FROM xhs_whole_creator_jobs',
                          )
                            ? Promise.resolve([{ id: 'synthetic-active' }])
                            : query(sql, ...args);
                      return Reflect.get(target, key);
                    },
                  }),
                );
              }
              return fn(tx);
            },
          ),
        fullHistoryError: (e: any) => {
          console.log('SAFE_CONFIRM_CAUSE', e.code || e.message);
          throw e;
        },
      };
      const input = {
        creatorIds,
        maxRequests: 3000,
        phaseLimits: { profile: 100, list: 200, detail: 1000, media: 2500 },
      };
      const prepared =
        await XhsWholeCreatorService.prototype.prepareScheduledPolicy.call(
          host,
          input,
        );
      const confirmation =
        XhsWholeCreatorService.prototype.confirmScheduledPolicy.call(host, {
          ...input,
          digest: prepared.digest,
          acknowledgedRecurringCollection: true,
          acknowledgedUnknownScope: true,
          acknowledgedDuplicateDirectoryRead: true,
        });
      if (scenario === 'idle')
        await expect(confirmation).resolves.toBeDefined();
      else await expect(confirmation).rejects.toThrow('XHS_TASK_NOT_RESUMABLE');
      const policies = await db.$queryRawUnsafe<any[]>(
        "SELECT id FROM xhs_unbound_owner_reviews WHERE id LIKE 'scheduled-policy-%'",
      );
      expect(policies).toHaveLength(scenario === 'idle' ? 1 : 0);
    } finally {
      await db.$disconnect();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
