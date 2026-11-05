import { randomUUID } from 'node:crypto';
import type { CacheFailureDiagnostic } from '../collection/cache-failure';
import type { AutomaticMediaSummary } from './automatic-media-queue';

const mediaHints = new Set<string>();
export function hintMediaArticles(ids: string[]) {
  for (const id of ids) if (mediaHints.size < 100) mediaHints.add(id);
}
export function takeMediaHints() {
  const ids = [...mediaHints].slice(0, 20);
  for (const id of ids) mediaHints.delete(id);
  return ids;
}

// Process-local notification only: no network or writes from a revision query.
const epoch = randomUUID();
let counter = 0;
let lastChangedAt: string | null = null;
export function cacheRevision() {
  return { revision: `${epoch}:${counter}` };
}
export function cacheDataChanged(count: number) {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  counter++;
  lastChangedAt = new Date().toISOString();
}
export type CacheSyncFeedState = {
  feedId: string;
  upstreamCheckTime: string | null;
  nextUpdateTime: string | null;
  paused: boolean | null;
  lastCacheReadAt: string | null;
  failure?: CacheFailureDiagnostic;
  state:
    | 'waiting'
    | 'synced-cache'
    | 'media-pending'
    | 'paused'
    | 'unavailable';
};
export const cacheSyncState = {
  enabled: false,
  signal: 'metadata' as 'metadata' | 'sqlite',
  state: 'disabled' as string,
  lastMetadataAt: null as string | null,
  lastSignalAt: null as string | null,
  lastSyncAt: null as string | null,
  metadataFailure: undefined as CacheFailureDiagnostic | undefined,
  feeds: [] as CacheSyncFeedState[],
  media: [] as AutomaticMediaSummary[],
  mediaPause: undefined as string | undefined,
  mediaFailure: undefined as string | undefined,
};
export function cacheSyncStatus() {
  return {
    ...cacheSyncState,
    media: cacheSyncState.media.map((row) => ({ ...row })),
    ...cacheRevision(),
    lastChangedAt,
    // Copy objects so a caller cannot mutate the scheduler.
    metadataFailure: cacheSyncState.metadataFailure
      ? { ...cacheSyncState.metadataFailure }
      : undefined,
    feeds: cacheSyncState.feeds.map((feed) => ({
      ...feed,
      failure: feed.failure ? { ...feed.failure } : undefined,
    })),
    complete: false as const,
  };
}
