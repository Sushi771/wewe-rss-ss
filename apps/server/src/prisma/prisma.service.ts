import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertDatabaseWritesAllowed } from '../startup-audit';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super();
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
      )
        assertDatabaseWritesAllowed();
      return next(params);
    });
  }
  async onModuleInit() {
    await this.$connect();
  }
}
