import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertDatabaseWritesAllowed } from '../startup-audit';
import { sqliteWrites } from '../collection/sqlite-write-coordinator';
import {
  articleListReadTimingEnabled,
  articleListNativeQueryTiming,
  prismaTransactionTiming,
} from '../article-list-read-timing';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
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
    // Preserve both transaction forms; defer engine admission, not individual
    // statements inside a transaction, and never invoke the callback twice.
    this.$transaction = ((...args: Parameters<typeof transaction>) => {
      const timing = prismaTransactionTiming(this);
      if (!timing)
        return sqlite()
          ? sqliteWrites.write(() => transaction(...args))
          : transaction(...args);
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
        return transaction(...observed);
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
