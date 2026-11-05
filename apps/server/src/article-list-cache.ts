import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { cacheRevision } from './feeds/cache-sync-state';
import {
  withArticleListReadTiming,
  articleListReadPhase,
  articleListCacheTiming,
} from './article-list-read-timing';

type Entry = { token: string; expires: number; bytes: number; rows: unknown };
const caches = new WeakMap<
  object,
  { entries: Map<string, Entry>; pending: Map<string, Promise<unknown>> }
>();
const TTL = 30000;
const MAX_BYTES = 4 * 1024 * 1024;

/** Read the committed rollback-journal change counter, never body pages.
 * WAL, relative URLs and unprovable files bypass reuse instead of serving stale data.
 */
async function revisionToken(databaseUrl?: string) {
  if (!databaseUrl?.startsWith('file:')) return;
  let database: string;
  try {
    database = decodeURIComponent(databaseUrl.slice(5).split('?')[0]);
  } catch {
    return;
  }
  if (!path.isAbsolute(database)) return;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    for (const suffix of ['-wal', '-journal']) {
      try {
        await fs.stat(database + suffix);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
    }
    handle = await fs.open(database, 'r');
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, 100, 0);
    const stat = await handle.stat({ bigint: true });
    if (
      bytesRead !== 100 ||
      header.subarray(0, 16).toString() !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1 ||
      !stat.ino
    )
      return;
    return [
      stat.dev,
      stat.ino,
      stat.size,
      header.readUInt32BE(24),
      header.readUInt32BE(40),
      cacheRevision().revision,
    ].join(':');
  } catch {
    return;
  } finally {
    await handle?.close();
  }
}

export function reusableArticleList<T>(
  client: object,
  query: unknown,
  databaseUrl: string | undefined,
  load: () => Promise<T>,
): Promise<T> {
  return withArticleListReadTiming(() =>
    reuseArticleList(client, query, databaseUrl, load),
  );
}

async function reuseArticleList<T>(
  client: object,
  query: unknown,
  databaseUrl: string | undefined,
  load: () => Promise<T>,
): Promise<T> {
  const token = await articleListReadPhase('revisionBefore', () =>
    revisionToken(databaseUrl),
  );
  if (!token) {
    articleListCacheTiming('bypass');
    return articleListReadPhase('snapshot', load);
  }
  let cache = caches.get(client);
  if (!cache) {
    cache = { entries: new Map(), pending: new Map() };
    caches.set(client, cache);
  }
  const key = JSON.stringify(query);
  const hit = cache.entries.get(key);
  if (hit && hit.token === token && hit.expires > Date.now()) {
    articleListCacheTiming('hit');
    cache.entries.delete(key);
    cache.entries.set(key, hit);
    return structuredClone(hit.rows) as T;
  }
  const pendingKey = token + '/' + key;
  const existing = cache.pending.get(pendingKey);
  if (existing) {
    articleListCacheTiming('coalesced');
    return structuredClone(await existing) as T;
  }
  articleListCacheTiming('miss');
  const operation = (async () => {
    const rows = await articleListReadPhase('snapshot', load);
    if (
      (await articleListReadPhase('revisionAfter', () =>
        revisionToken(databaseUrl),
      )) === token
    ) {
      const bytes = Buffer.byteLength(JSON.stringify(rows));
      if (bytes <= MAX_BYTES) {
        cache!.entries.delete(key);
        cache!.entries.set(key, {
          token,
          bytes,
          expires: Date.now() + TTL,
          rows: structuredClone(rows),
        });
        const size = () =>
          [...cache!.entries.values()].reduce(
            (sum, entry) => sum + entry.bytes,
            0,
          );
        while (cache!.entries.size > 50 || size() > MAX_BYTES)
          cache!.entries.delete(cache!.entries.keys().next().value!);
      }
    }
    return rows;
  })();
  cache.pending.set(pendingKey, operation);
  try {
    return structuredClone(await operation);
  } finally {
    cache.pending.delete(pendingKey);
  }
}
