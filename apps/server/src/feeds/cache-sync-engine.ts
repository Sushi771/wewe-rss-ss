import { createHash } from 'node:crypto';
import { cacheFailureDiagnostic } from '../collection/cache-failure';
import { Wechat2RssListedFeed } from '../collection/providers/wechat2rss';
import { ProviderPage } from '../collection/subscription-provider';
import { cacheSyncState, CacheSyncFeedState } from './cache-sync-state';

export function cacheSyncDaytime(now: number) {
  return new Date(now + 8 * 3600000).getUTCHours() >= 6;
}
export function cachePageFingerprint(page: ProviderPage) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        articles: [...page.articles].sort((a, b) => a.id.localeCompare(b.id)),
        bodyMissing: page.bodyMissing,
        imageBlocked: page.imageBlocked,
      }),
    )
    .digest('hex');
}
type LocalFeed = { id: string; mpName: string };
type Slot = {
  metadata: Wechat2RssListedFeed;
  local: LocalFeed;
  status: CacheSyncFeedState;
  signature: string;
  fingerprint?: string;
  nextRead: number;
  settleUntil: number;
  failures: number;
  checks: number;
};
export type CacheSyncDependencies = {
  now(): number;
  /** Operational pause keeps list imports and pending media intact. */
  mediaEnabled?(): boolean;
  onMediaBlocked?(): Promise<void>;
  mediaStopped?(): boolean;
  /** Read-only fallback for dependencies without text reconciliation. */
  inspectLocalMedia?(
    id: string,
    page: ProviderPage,
  ): Promise<{ mediaReady: boolean }>;
  list(): Promise<Wechat2RssListedFeed[]>;
  localFeeds(): Promise<LocalFeed[]>;
  read(feed: Wechat2RssListedFeed, name: string): Promise<ProviderPage>;
  /** Reconcile text without CDN requests and return fresh stored-media readiness.
   * Missing readiness remains pending; never reuse a previous tick's summary. */
  syncText?(
    id: string,
    page: ProviderPage,
  ): Promise<{ mediaReady?: boolean } | void>;
  sync(
    id: string,
    page: ProviderPage,
    listOnly: boolean,
  ): Promise<{
    created?: number;
    updated?: number;
    bodyMissing?: number;
    imageBlocked?: number;
    mediaRequestBlocked?: boolean;
    localMediaPendingArticleCount?: number;
  }>;
};

/** One global metadata read per 5s. Only selected changed caches get body reads.
 * Metadata has no content version: continued reads plus periodic reconciliation
 * are required after check_time changes, including late/unchanged-time fills. */
export class CacheSyncEngine {
  private slots = new Map<string, Slot>();
  private hashes: Record<string, string> = {};
  private pendingSignals = new Set<string>();
  private busy = false;
  private rerun = false;
  private mediaBusy = false;
  private mediaBlocked = false;
  private stopped = false;
  private media = new Map<string, { page: ProviderPage; due: number }>();
  private nextList = 0;
  private listFailures = 0;
  constructor(private readonly deps: CacheSyncDependencies) {}
  signal(hashes: Record<string, string>) {
    cacheSyncState.lastSignalAt = new Date(this.deps.now()).toISOString();
    for (const [id, hash] of Object.entries(hashes)) {
      if (this.hashes[id] !== hash) this.pendingSignals.add(id);
    }
    this.hashes = hashes;
    cacheSyncState.signal = 'sqlite';
  }
  signalUnavailable() {
    cacheSyncState.signal = 'metadata';
    cacheSyncState.state = 'signal-unavailable';
  }
  close() {
    this.stopped = true;
  }
  async tick() {
    if (this.stopped) return;
    if (this.busy) {
      this.rerun = true;
      return;
    }
    this.busy = true;
    try {
      const now = this.deps.now();
      if (now >= this.nextList) {
        try {
          const [listed, locals] = await Promise.all([
            this.deps.list(),
            this.deps.localFeeds(),
          ]);
          const keep = new Set<string>();
          for (const local of locals) {
            const metadata = listed.find((row) => row.feedId === local.id);
            if (!metadata || metadata.name !== local.mpName) continue;
            keep.add(local.id);
            const signature = JSON.stringify([
              metadata.checkTime,
              metadata.nextUpdateTime,
              metadata.paused,
            ]);
            let slot = this.slots.get(local.id);
            if (!slot) {
              slot = {
                metadata,
                local,
                signature,
                nextRead: 0,
                settleUntil: 0,
                failures: 0,
                checks: 0,
                status: {
                  feedId: local.id,
                  upstreamCheckTime: null,
                  nextUpdateTime: null,
                  paused: null,
                  lastCacheReadAt: null,
                  state: 'waiting',
                },
              };
              this.slots.set(local.id, slot);
            } else if (signature !== slot.signature) {
              slot.nextRead = 0;
              slot.settleUntil = now + 120000;
              slot.checks = 0;
            }
            slot.metadata = metadata;
            slot.local = local;
            slot.signature = signature;
            Object.assign(slot.status, {
              upstreamCheckTime: metadata.checkTime,
              nextUpdateTime: metadata.nextUpdateTime,
              paused: metadata.paused,
            });
            if (metadata.paused === true) slot.status.state = 'paused';
          }
          for (const id of this.slots.keys())
            if (!keep.has(id)) {
              this.slots.delete(id);
              this.media.delete(id);
            }
          this.listFailures = 0;
          cacheSyncState.metadataFailure = undefined;
          this.nextList = now + 5000;
          cacheSyncState.lastMetadataAt = new Date(now).toISOString();
          cacheSyncState.state = 'watching-cache';
        } catch (error) {
          cacheSyncState.metadataFailure = cacheFailureDiagnostic(
            error,
            'metadata-read',
            this.deps.now(),
          );
          this.nextList =
            now + Math.min(60000, 5000 * 2 ** Math.min(++this.listFailures, 4));
          cacheSyncState.state = 'upstream-unavailable';
          return;
        }
      }
      // No JSON fulltext or media downloads from 00:00 through 05:59 Shanghai.
      if (!cacheSyncDaytime(now)) {
        cacheSyncState.state = 'night-window';
        return;
      }
      for (const [id, slot] of this.slots) {
        if (this.pendingSignals.delete(id)) {
          slot.nextRead = 0;
          slot.settleUntil = now + 120000;
          slot.checks = 0;
        }
      }
      // Bound fulltext traffic even when many upstream checks advance at once.
      let readBudget = 2;
      const due = [...this.slots].sort((a, b) => a[1].nextRead - b[1].nextRead);
      for (const [id, slot] of due) {
        if (
          slot.metadata.paused === true ||
          now < slot.nextRead ||
          this.stopped
        )
          continue;
        if (readBudget-- <= 0) break;
        let point: 'cache-read' | 'cache-import' = 'cache-read';
        try {
          const page = await this.deps.read(slot.metadata, slot.local.mpName);
          point = 'cache-import';
          const fingerprint = cachePageFingerprint(page);
          // If cache HTTP lags its DB marker, keep rechecking the affected feed.
          // Never mark check_time consumed after a single unchanged/empty read.
          if (fingerprint !== slot.fingerprint) {
            await this.deps.sync(id, page, true);
            await this.deps.syncText?.(id, page);
            slot.fingerprint = fingerprint;
            this.media.set(id, { page, due: now });
          } else if (!this.media.has(id)) {
            // Reconcile local SQLite gaps without downloading healthy media or
            // rewriting a successful list. Unknown readiness stays pending.
            // Text reconciliation already reads current local flags and rereads
            // them after writes. Use that result instead of inspecting twice.
            const local = this.deps.syncText
              ? await this.deps.syncText(id, page)
              : await this.deps.inspectLocalMedia?.(id, page);
            if (local?.mediaReady !== true) {
              this.media.set(id, { page, due: now });
            }
          }
          slot.failures = 0;
          slot.status.failure = undefined;
          const delays =
            cacheSyncState.signal === 'sqlite'
              ? [1000, 2000, 5000, 15000, 30000, 60000]
              : [5000, 15000, 30000, 60000];
          slot.nextRead =
            now +
            (now < slot.settleUntil
              ? delays[Math.min(slot.checks++, delays.length - 1)]
              : 60000);
          slot.status.lastCacheReadAt = new Date(this.deps.now()).toISOString();
          slot.status.state = this.media.has(id)
            ? 'media-pending'
            : 'synced-cache';
          cacheSyncState.lastSyncAt = slot.status.lastCacheReadAt;
        } catch (error) {
          slot.status.state = 'unavailable';
          slot.status.failure = cacheFailureDiagnostic(
            error,
            point,
            this.deps.now(),
          );
          slot.nextRead =
            now +
            (error instanceof Error && error.message === 'CACHE_SYNC_BUSY'
              ? 1000
              : Math.min(60000, 5000 * 2 ** Math.min(++slot.failures, 4)));
        }
      }
      // Separate lane: slow image archives never hold the metadata/list worker.
      void this.runMedia();
    } finally {
      if (this.mediaBlocked || this.deps.mediaStopped?.())
        cacheSyncState.state = 'media-blocked';
      cacheSyncState.feeds = [...this.slots.values()].map((slot) => ({
        ...slot.status,
      }));
      this.busy = false;
      // A committed signal received during a slow import should not wait for
      // the next 1s timer. Reuse the existing worker and its bounded read budget.
      if (this.rerun) {
        this.rerun = false;
        queueMicrotask(
          () =>
            void this.tick().catch(() => {
              cacheSyncState.state = 'sync-unavailable';
            }),
        );
      }
    }
  }
  private async runMedia() {
    if (
      this.mediaBusy ||
      this.mediaBlocked ||
      this.deps.mediaStopped?.() ||
      this.stopped ||
      this.deps.mediaEnabled?.() === false ||
      !cacheSyncDaytime(this.deps.now())
    )
      return;
    const entry = [...this.media].find(
      ([id, job]) =>
        job.due <= this.deps.now() &&
        this.slots.get(id)?.metadata.paused !== true,
    );
    if (!entry) return;
    const [id, job] = entry;
    const slot = this.slots.get(id);
    if (!slot) {
      this.media.delete(id);
      return;
    }
    this.mediaBusy = true;
    try {
      const result = await this.deps.sync(id, job.page, false);
      // Security results are global, including a superseded snapshot.
      if (result.mediaRequestBlocked) {
        this.mediaBlocked = true;
        await this.deps.onMediaBlocked?.();
        slot.status.state = 'media-pending';
        cacheSyncState.state = 'media-blocked';
        return;
      }
      if (this.media.get(id) !== job) return; // New snapshot supersedes this one.
      if (
        result.bodyMissing === 0 &&
        result.imageBlocked === 0 &&
        result.localMediaPendingArticleCount === 0
      ) {
        this.media.delete(id);
        slot.status.state = 'synced-cache';
      } else {
        job.due = this.deps.now() + 60000;
        slot.status.state = 'media-pending';
      }
    } catch {
      job.due = this.deps.now() + 60000;
      slot.status.state = 'media-pending';
    } finally {
      cacheSyncState.feeds = [...this.slots.values()].map((row) => ({
        ...row.status,
      }));
      this.mediaBusy = false;
    }
  }
}
