import { Module } from '@nestjs/common';
import { TrpcService } from '@server/trpc/trpc.service';
import { TrpcRouter } from '@server/trpc/trpc.router';
import { PrismaModule } from '@server/prisma/prisma.module';
import { WereadModule } from '@server/weread/weread.module';
import { CollectionService } from '../collection/collection.service';
import { PrismaService } from '../prisma/prisma.service';
import { SUBSCRIPTION_DISCOVERY } from '../collection/subscription-add';
import { createNativeSubscriptionDiscovery } from '../collection/subscription-native-adapter';
import { resolveWereadPublisherOriginal } from '../collection/weread-public-original';
import {
  XiaohongshuService,
  XHS_SOURCE,
} from '../collection/xiaohongshu.service';
import { RedbookSource } from '../collection/redbook-source';

@Module({
  imports: [PrismaModule, WereadModule],
  controllers: [],
  providers: [
    TrpcService,
    TrpcRouter,
    CollectionService,
    XiaohongshuService,
    // Registered but dormant. Credentials, real schema evidence and transports
    // require a separate reviewed handoff; environment variables cannot enable it.
    { provide: XHS_SOURCE, useFactory: () => new RedbookSource() },
    {
      provide: SUBSCRIPTION_DISCOVERY,
      inject: [PrismaService, CollectionService],
      useFactory: (prisma: PrismaService, collection: CollectionService) =>
        createNativeSubscriptionDiscovery({
          prisma,
          collection,
          resolveOriginal: (url, account) =>
            resolveWereadPublisherOriginal({
              url,
              account,
              trigger: 'local-manual',
            }),
        }),
    },
  ],
  exports: [TrpcService, TrpcRouter, XiaohongshuService],
})
export class TrpcModule {}
