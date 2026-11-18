import { runChannelSchedule } from './channel-task-control';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { databaseWritesAllowed } from '../startup-audit';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsScheduledClock } from './xhs-scheduled-clock';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
import { XhsEngagementService } from './xhs-engagement.service';

@Injectable()
export class XhsScheduledService {
  private readonly logger = new Logger(XhsScheduledService.name);
  private clock?: XhsScheduledClock;
  constructor(
    private readonly db: PrismaService,
    private readonly subscriptions: XhsSubscriptionService,
    private readonly engagement: XhsEngagementService,
  ) {}
  @Cron('* * * * *', { name: 'xhsScheduledRefresh', timeZone: 'Asia/Shanghai' })
  async tick(now = Date.now()) {
    if (
      process.env.WECHAT2RSS_RECOVERY_HOLD === '1' ||
      process.env.ENABLE_SCHEDULED_UPDATES !== '1' ||
      process.env.DISABLE_SCHEDULED_UPDATES === '1' ||
      process.env.XHS_SUBSCRIPTION_LIVE_ENABLED !== '1' ||
      !databaseWritesAllowed()
    )
      return;
    this.clock ??= new XhsScheduledClock(
      () => {
        const raw = process.env.DATABASE_URL || '';
        if (!raw.startsWith('file:')) throw Error('SQLITE_REQUIRED');
        return decodeURIComponent(raw.slice(5).split('?')[0]);
      },
      (round) =>
        new XhsScheduledRunner(
          this.db,
          this.subscriptions,
          this.engagement,
          process.env.WEWE_MANAGED_RUNTIME_MODE === 'scheduled-dual-v1'
            ? async () => {
                // A historical unknown author-context or list request closes
                // that author for this mode. Per-note fences still govern all others.
                const rows = await this.db.$queryRaw<
                  Array<{ creator_id: string }>
                >`
                  SELECT DISTINCT creator_id FROM xhs_unbound_owner_requests
                  WHERE outcome='unknown' AND phase IN ('profile','list')`;
                return new Set(rows.map((row) => row.creator_id));
              }
            : undefined,
        ).run(round),
    );
    try {
      await runChannelSchedule('xiaohongshu', (notBefore) =>
        this.clock!.tick(now, notBefore),
      );
    } catch (e) {
      if (
        !(
          e instanceof Error &&
          (e.message === 'XHS_SCHEDULE_TASK_PENDING' ||
            e.message.startsWith('CHANNEL_'))
        )
      )
        this.logger.warn(
          'XHS scheduled round deferred; persisted task state retained.',
        );
    }
  }
}
