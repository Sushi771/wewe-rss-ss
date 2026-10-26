import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  assertDatabaseWritesAllowed,
  setDatabaseRecovery,
  databaseRecoveryStatus,
} from '../startup-audit';
import { sqliteWrites } from '../collection/sqlite-write-coordinator';
import {
  articleListReadTimingEnabled,
  articleListNativeQueryTiming,
  prismaTransactionTiming,
} from '../article-list-read-timing';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly recoveryOwner = new AsyncLocalStorage<boolean>();
  private recovery: Promise<void> | undefined;

  recoverFailedMediaTransaction(): Promise<void> {
    if (this.recovery) return this.recovery;
    setDatabaseRecovery('recovering');
    this.recovery = this.recoveryOwner.run(true, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active = true;
      try {
        await Promise.race([
          (async () => {
            await this.$disconnect();
            if (!active) return;
            await this.$connect();
            if (!active) {
              await this.$disconnect();
              return;
            }
            const rows =
              await this.$queryRawUnsafe<Array<{ ok: number | bigint }>>(
                'SELECT 1 AS ok',
              );
            if (Number(rows[0]?.ok) !== 1)
              throw Error('SQLITE_RECOVERY_PROBE_FAILED');
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('SQLITE_RECOVERY_TIMEOUT')),
              15000,
            );
          }),
        ]);
        setDatabaseRecovery('ready');
        this.recovery = undefined;
      } catch {
        setDatabaseRecovery('failed');
        throw Error('MEDIA_TRANSACTION_RECOVERY_FAILED');
      } finally {
        active = false;
        clearTimeout(timer);
      }
    });
    return this.recovery;
  }

  constructor() {
    super(
      articleListReadTimingEnabled()
        ? { log: [{ emit: 'event', level: 'query' }] }
        : undefined,
    );
    if (articleListReadTimingEnabled())
      (
        this as unknown as {
          $on(
            event: 'query',
            listener: (event: Prisma.QueryEvent) => void,
          ): void;
        }
      ).$on('query', (event) => articleListNativeQueryTiming(this, event));
    const sqlite = () => (process.env.DATABASE_URL || '').startsWith('file:');
    const transaction = this.$transaction.bind(this);
    const guardedTransaction = async (
      ...args: Parameters<typeof transaction>
    ) => {
      if (
        !this.recoveryOwner.getStore() &&
        databaseRecoveryStatus() !== 'ready'
      )
        throw Error('SQLITE_RECOVERY_UNAVAILABLE');
      return transaction(...args);
    };
    // Preserve both transaction forms; defer engine admission, not individual
    // statements inside a transaction, and never invoke the callback twice.
    this.$transaction = ((...args: Parameters<typeof transaction>) => {
      const timing = prismaTransactionTiming(this);
      if (!timing)
        return sqlite()
          ? sqliteWrites.write(() => guardedTransaction(...args))
          : guardedTransaction(...args);
      const callback = args[0];
      const observed = [...args] as Parameters<typeof transaction>;
      if (typeof callback === 'function')
        observed[0] = async (tx) => {
          timing.mark('callbackEntry');
          try {
            return await callback(tx);
          } finally {
            timing.mark('callbackDone');
          }
        };
      const invoke = () => {
        timing.mark('admitted');
        return guardedTransaction(...observed);
      };
      return (sqlite() ? sqliteWrites.write(invoke) : invoke()).then(
        (value) => {
          timing.mark('wrapperReturn', true);
          return value;
        },
        (error) => {
          timing.mark('wrapperReturn', false);
          throw error;
        },
      );
    }) as typeof this.$transaction;
    this.$use(async (params, next) => {
      // Only the fixed reconnect probe may use the client during recovery.
      if (this.recoveryOwner.getStore()) return next(params);
      if (databaseRecoveryStatus() !== 'ready')
        throw new Error('SQLITE_RECOVERY_UNAVAILABLE');
      // Cover nested writes and raw execution even outside HTTP (cron/tasks).
      if (
        ![
          'findUnique',
          'findUniqueOrThrow',
          'findFirst',
          'findFirstOrThrow',
          'findMany',
          'count',
          'aggregate',
          'groupBy',
        ].includes(params.action)
      ) {
        assertDatabaseWritesAllowed();
        if (sqlite())
          return sqliteWrites.write(async () => {
            // The startup audit may have changed during admission wait.
            assertDatabaseWritesAllowed();
            return next(params);
          });
      }
      return next(params);
    });
  }
  async onModuleInit() {
    await this.$connect();
  }
}
