import { Module } from '@nestjs/common';
import { TrpcService } from '@server/trpc/trpc.service';
import { TrpcRouter } from '@server/trpc/trpc.router';
import { PrismaModule } from '@server/prisma/prisma.module';
import { WereadModule } from '@server/weread/weread.module';

@Module({
  imports: [PrismaModule, WereadModule],
  controllers: [],
  providers: [TrpcService, TrpcRouter],
  exports: [TrpcService, TrpcRouter],
})
export class TrpcModule {}
