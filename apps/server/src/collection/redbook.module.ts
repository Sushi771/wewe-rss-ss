import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { XHS_SOURCE } from './xiaohongshu.service';
import { RedbookRuntime } from './redbook-runtime';
import { RedbookSessionController } from './redbook-session.controller';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [RedbookSessionController],
  providers: [
    RedbookRuntime,
    { provide: XHS_SOURCE, useExisting: RedbookRuntime },
  ],
  exports: [XHS_SOURCE, RedbookRuntime],
})
export class RedbookModule {}
