import { randomUUID } from 'node:crypto';

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
  feeds: [] as CacheSyncFeedState[],
};
export function cacheSyncStatus() {
  return {
    ...cacheSyncState,
    ...cacheRevision(),
    lastChangedAt,
    // Copy objects so a caller cannot mutate the scheduler.
    feeds: cacheSyncState.feeds.map((feed) => ({ ...feed })),
    complete: false as const,
  };
}
