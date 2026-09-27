import { Module } from '@nestjs/common';
import { TrpcService } from '@server/trpc/trpc.service';
import { TrpcRouter } from '@server/trpc/trpc.router';
import { PrismaModule } from '@server/prisma/prisma.module';
import { WereadModule } from '@server/weread/weread.module';
import { CollectionService } from '../collection/collection.service';

@Module({
  imports: [PrismaModule, WereadModule],
  controllers: [],
  providers: [TrpcService, TrpcRouter, CollectionService],
  exports: [TrpcService, TrpcRouter],
})
export class TrpcModule {}
