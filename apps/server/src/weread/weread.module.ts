import { Module } from '@nestjs/common';
import { WereadService } from './weread.service';
import { PrismaModule } from '@server/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [WereadService],
  exports: [WereadService],
})
export class WereadModule {}
