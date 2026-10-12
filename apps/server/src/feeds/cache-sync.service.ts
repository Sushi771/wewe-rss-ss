import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcService } from '../trpc/trpc.service';
import { wechat2RssProvider } from '../collection/provider-registry';
import { resolveCollectionRoute } from '../collection/collection-channel';
import { databaseWritesAllowed, waitForStartupAudit } from '../startup-audit';
import { CacheSyncEngine } from './cache-sync-engine';
import { CacheSqliteMonitor } from './cache-sqlite-monitor';
import { cacheSyncState } from './cache-sync-state';
import { MediaSafetyStop } from './media-safety-stop';

@Injectable()
export class CacheSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private engine?: CacheSyncEngine;
  private monitor?: CacheSqliteMonitor;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly trpc: TrpcService,
  ) {}
  onApplicationBootstrap() {
    if (
      process.env.WECHAT2RSS_CACHE_SYNC !== '1' ||
      process.env.WECHAT2RSS_ENABLED !== '1' ||
      process.env.WEWE_ACCEPTANCE_MODE === '1' ||
      process.env.REHEARSAL_GUARD_REPORT
    )
      return;
    void waitForStartupAudit().then((ok) => {
      if (ok && !this.stopped) this.start();
    });
  }
  private async start() {
    try {
      const safety = new MediaSafetyStop();
      await safety.initialize(process.env.DATABASE_URL || '');
      const provider = wechat2RssProvider();
      this.engine = new CacheSyncEngine({
        now: Date.now,
        mediaEnabled: () =>
          process.env.WECHAT2RSS_CACHE_MEDIA !== '0' && !safety.blocked,
        onMediaBlocked: () => safety.stop(),
        mediaStopped: () => safety.blocked,
        list: () => provider.listSubscriptions(),
        localFeeds: async () =>
          (await this.prisma.feed.findMany({ where: { status: 1 } })).filter(
            (feed) => resolveCollectionRoute(feed).channel === 'wechat2rss',
          ),
        read: (feed, name) => provider.fetchListedArticles(feed, name),
        sync: (id, page, listOnly) =>
          this.trpc.syncCachedWechat2RssPage(id, page, listOnly),
      });
      cacheSyncState.enabled = true;
      const database = process.env.WECHAT2RSS_CACHE_DB?.trim();
      if (database) {
        this.monitor = new CacheSqliteMonitor(
          database,
          (hashes) => {
            this.engine?.signal(hashes);
            this.tick();
          },
          () => this.engine?.signalUnavailable(),
        );
        void this.monitor.start();
      }
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref();
      this.tick();
    } catch {
      cacheSyncState.state = 'configuration-unavailable';
    }
  }
  private tick() {
    if (databaseWritesAllowed())
      void this.engine?.tick().catch(() => {
        cacheSyncState.state = 'sync-unavailable';
      });
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.monitor?.close();
    this.engine?.close();
  }
}
