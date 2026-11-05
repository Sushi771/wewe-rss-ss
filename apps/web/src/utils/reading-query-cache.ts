import type { Query, QueryClient } from '@tanstack/react-query';

export const READING_CACHE_TIME = 60_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 12;
const MAX_QUERIES = 12;

function readingQuery(query: Query) {
  const path = query.queryKey[0];
  return (
    Array.isArray(path) &&
    path[0] === 'article' &&
    ['list', 'summary', 'byId'].includes(path[1])
  );
}

// Conservative UTF-8/retained-string estimate without serializing or copying
// large saved bodies. Stop counting as soon as a result cannot be retained.
function bytes(value: unknown, limit = MAX_BYTES): number {
  if (typeof value === 'string') return value.length * 3 + 32;
  if (!value || typeof value !== 'object') return 16;
  let total = 64;
  for (const [key, child] of Object.entries(value)) {
    total += key.length * 3 + 32 + bytes(child, limit - total);
    if (total > limit) break;
  }
  return total;
}

/** Only inactive reading results are retained: active pages/readers never lose
 * their data to the budget. No storage persistence or staleTime is introduced;
 * returning views still revalidate and existing invalidations remain effective. */
export function installReadingCacheBudget(client: QueryClient) {
  const cache = client.getQueryCache();
  const usage = new WeakMap<Query, number>();
  let clock = 0;
  let trimming = false;
  return cache.subscribe((event) => {
    if (trimming || !readingQuery(event.query)) return;
    usage.set(event.query, ++clock);
    trimming = true;
    try {
      const inactive = cache
        .getAll()
        .filter(
          (query) =>
            readingQuery(query) &&
            !query.getObserversCount() &&
            query.state.data !== undefined,
        )
        .sort((a, b) => (usage.get(b) || 0) - (usage.get(a) || 0));
      let retained = 0;
      let pages = 0;
      let queries = 0;
      for (const query of inactive) {
        const size = bytes(query.state.data);
        const count =
          (query.state.data as { pages?: unknown[] })?.pages?.length || 0;
        if (
          size + retained > MAX_BYTES ||
          count + pages > MAX_PAGES ||
          queries >= MAX_QUERIES
        ) {
          // A cancelled in-flight Query may retain its own GC timer after it
          // leaves the cache. Release its body now, not only the cache entry.
          const cancelled = query.cancel({ silent: true });
          query.setState({ data: undefined });
          cache.remove(query);
          // Cancellation can schedule GC after remove() has cleared the old
          // timer. Clear that late timer too so its revert snapshot can die.
          void cancelled.then(() => query.destroy());
        } else {
          retained += size;
          pages += count;
          queries++;
        }
      }
    } finally {
      trimming = false;
    }
  });
}
