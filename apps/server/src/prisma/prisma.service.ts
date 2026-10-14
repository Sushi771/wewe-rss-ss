import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertDatabaseWritesAllowed } from '../startup-audit';
import { sqliteWrites } from '../collection/sqlite-write-coordinator';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super();
    const sqlite = () => (process.env.DATABASE_URL || '').startsWith('file:');
    const transaction = this.$transaction.bind(this);
    // Preserve both transaction forms; defer engine admission, not individual
    // statements inside a transaction, and never invoke the callback twice.
    this.$transaction = ((...args: Parameters<typeof transaction>) =>
      sqlite()
        ? sqliteWrites.write(() => transaction(...args))
        : transaction(...args)) as typeof this.$transaction;
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
