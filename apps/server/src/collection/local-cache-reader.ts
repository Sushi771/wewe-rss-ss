import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Wechat2RssListedFeed } from './providers/wechat2rss';
import { parseWechat2RssJsonFeed } from './provider-article';

/** Committed SQLite snapshots only. Explicit local mode; no HTTP fallback. */
async function readLocal(args: string[]) {
  const database = process.env.WECHAT2RSS_CACHE_DB?.trim();
  if (!database || !path.isAbsolute(database) || /[\0\r\n]/.test(database))
    throw new Error('CACHE_LOCAL_READ_UNAVAILABLE');
  let script: string | undefined;
  for (const root of [
    process.cwd(),
    path.resolve(process.cwd(), 'apps/server'),
  ]) {
    const candidate = path.join(root, 'scripts/read-wechat2rss-cache.py');
    try {
      await access(candidate);
      script = candidate;
      break;
    } catch {}
  }
  if (!script) throw new Error('CACHE_LOCAL_READ_UNAVAILABLE');
  const python =
    process.env.SQLITE_BACKUP_PYTHON?.trim() ||
    (process.platform === 'win32' ? 'python' : 'python3');
  const { stdout } = await promisify(execFile)(
    python,
    [script, '--database', database, ...args],
    {
      windowsHide: true,
      shell: false,
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as unknown;
}

export async function readLocalWechat2RssCache(feedId: string, name: string) {
  if (!/^MP_WXS_\d{5,15}$/.test(feedId))
    throw new Error('CACHE_LOCAL_READ_UNAVAILABLE');
  return parseWechat2RssJsonFeed(
    await readLocal(['--feed', feedId, '--name', name]),
    feedId,
  );
}

export async function listLocalWechat2RssCache(): Promise<
  Wechat2RssListedFeed[]
> {
  const value = await readLocal(['--list']);
  const seen = new Set<string>();
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('CACHE_LOCAL_IDENTITY_CONFLICT');
  for (const row of value) {
    if (
      !row ||
      !/^MP_WXS_\d{5,15}$/.test(row.feedId) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      seen.has(row.feedId) ||
      row.feedUrl !== `/feed/${row.feedId.slice(7)}.json` ||
      row.checkTime !== null ||
      row.nextUpdateTime !== null ||
      row.paused !== null
    )
      throw new Error('CACHE_LOCAL_IDENTITY_CONFLICT');
    seen.add(row.feedId);
  }
  return value;
}
