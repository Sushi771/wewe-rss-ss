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
import { CacheSyncEngine, cacheSyncDaytime } from './cache-sync-engine';
import { CacheSqliteMonitor } from './cache-sqlite-monitor';
import { cacheSyncState } from './cache-sync-state';
import { mediaSafetyStop } from './media-safety-stop';
import { AutomaticMediaQueue } from './automatic-media-queue';
import { AutomaticMediaScan } from './automatic-media-scan';
import { fetchAllowedImage } from '../collection/image-fetch';

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
      const safety = await mediaSafetyStop(process.env.DATABASE_URL || '');
      const provider = wechat2RssProvider();
      let allowedFeeds: ReadonlySet<string> = new Set();
      const scan = new AutomaticMediaScan(this.prisma);
      const media = new AutomaticMediaQueue(
        decodeURIComponent(
          (process.env.DATABASE_URL || '').slice(5).split('?')[0],
        ),
        {
          now: Date.now,
          scan: (cursor, since) =>
            scan.page(
              cursor,
              since,
              process.env.WECHAT2RSS_AUTOMATIC_MEDIA_HISTORY === '1',
            ),
          load: (id) => scan.load(id),
          commit: (row, images) =>
            this.trpc.commitAutomaticArticleMedia(row, images),
          fetch: fetchAllowedImage,
          canFetch: (id) =>
            !this.stopped &&
            databaseWritesAllowed() &&
            allowedFeeds.has(id) &&
            process.env.WECHAT2RSS_CACHE_MEDIA !== '0' &&
            !safety.isBlocked() &&
            cacheSyncDaytime(Date.now()),
          stop: () => safety.stop(),
          publish: (summary, code) => {
            cacheSyncState.media = summary;
            cacheSyncState.mediaFailure = code;
            cacheSyncState.mediaPause = safety.isBlocked()
              ? 'blocked'
              : process.env.WECHAT2RSS_CACHE_MEDIA === '0'
                ? 'disabled'
                : !cacheSyncDaytime(Date.now())
                  ? 'night'
                  : !allowedFeeds.size
                    ? 'metadata'
                    : undefined;
          },
        },
      );
      this.engine = new CacheSyncEngine({
        durableMedia: {
          tick: async (allowed) => {
            allowedFeeds = allowed;
            await media.tick();
          },
          close: () => media.close(),
        },
        now: Date.now,
        mediaEnabled: () =>
          process.env.WECHAT2RSS_CACHE_MEDIA !== '0' && !safety.isBlocked(),
        onMediaBlocked: () => safety.stop(),
        mediaStopped: () => safety.isBlocked(),
        list: () => provider.listSubscriptions(),
        localFeeds: async () =>
          (await this.prisma.feed.findMany({ where: { status: 1 } })).filter(
            (feed) => resolveCollectionRoute(feed).channel === 'wechat2rss',
          ),
        read: (feed, name) => provider.fetchListedArticles(feed, name),
        syncText: (id, page) =>
          this.trpc.syncCachedWechat2RssPage(id, page, false, {
            fetchMedia: false,
          }),
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
