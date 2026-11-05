import { XhsScheduledService } from '../collection/xhs-scheduled.service';
import { bindXhsSourceTotalBudget } from '../collection/xhs-source-request-policy';
import { XhsSourceRiskStore } from '../collection/xhs-source-risk-store';
import { XhsLimitedRecoveryStore } from '../collection/xhs-limited-recovery-store';
import { XhsBatchSubscriptionService } from '../collection/xhs-batch-subscription.service';
import { XhsWholeCreatorService } from '../collection/xhs-whole-creator.service';
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
import { XiaohongshuService } from '../collection/xiaohongshu.service';
import { XhsEngagementService } from '../collection/xhs-engagement.service';
import {
  XHS_SUBSCRIPTION_SOURCE,
  XhsSubscriptionService,
} from '../collection/xhs-subscription.service';
import {
  createLocalXhsSubscriptionRuntime,
  XhsSubscriptionRuntime,
} from '../collection/xhs-subscription-runtime';

@Module({
  imports: [PrismaModule, WereadModule],
  controllers: [],
  providers: [
    TrpcService,
    TrpcRouter,
    CollectionService,
    XiaohongshuService,
    XhsSubscriptionService,
    XhsScheduledService,
    XhsBatchSubscriptionService,
    XhsEngagementService,
    XhsWholeCreatorService,
    {
      provide: XhsSubscriptionRuntime,
      inject: [PrismaService],
      useFactory: (db: PrismaService) => {
        const runtime = createLocalXhsSubscriptionRuntime();
        runtime.bindRiskStore(new XhsSourceRiskStore(db));
        runtime.bindLimitedRecoveryStore(new XhsLimitedRecoveryStore(db));
        bindXhsSourceTotalBudget(db, runtime);
        return runtime;
      },
    },
    { provide: XHS_SUBSCRIPTION_SOURCE, useExisting: XhsSubscriptionRuntime },
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
  exports: [
    TrpcService,
    TrpcRouter,
    XiaohongshuService,
    XhsSubscriptionService,
    XhsSubscriptionRuntime,
  ],
})
export class TrpcModule {}
