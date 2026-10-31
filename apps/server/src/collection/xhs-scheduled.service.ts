import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { databaseWritesAllowed } from '../startup-audit';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsScheduledClock } from './xhs-scheduled-clock';
import { XhsScheduledRunner } from './xhs-scheduled-runner';

@Injectable()
export class XhsScheduledService {
  private readonly logger=new Logger(XhsScheduledService.name);
  private clock?:XhsScheduledClock;
  constructor(private readonly db:PrismaService,private readonly subscriptions:XhsSubscriptionService) {}
  @Cron('* * * * *',{name:'xhsScheduledRefresh',timeZone:'Asia/Shanghai'})
  async tick(now=Date.now()) {
    if(process.env.ENABLE_SCHEDULED_UPDATES!=='1'||process.env.DISABLE_SCHEDULED_UPDATES==='1'||process.env.XHS_SUBSCRIPTION_LIVE_ENABLED!=='1'||!databaseWritesAllowed())return;
    this.clock??=new XhsScheduledClock(()=>{const raw=process.env.DATABASE_URL||'';if(!raw.startsWith('file:'))throw Error('SQLITE_REQUIRED');return decodeURIComponent(raw.slice(5).split('?')[0]);},(round)=>new XhsScheduledRunner(this.db,this.subscriptions).run(round));
    try{await this.clock.tick(now)}catch(e){if(!(e instanceof Error&&e.message==='XHS_SCHEDULE_TASK_PENDING'))this.logger.warn('XHS scheduled round deferred; persisted task state retained.');}
  }
}
