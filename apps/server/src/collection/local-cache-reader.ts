import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseWechat2RssJsonFeed } from './provider-article';

/** Explicit recovery only. Reads a committed SQLite cache snapshot; zero HTTP. */
export async function readLocalWechat2RssCache(feedId: string, name: string) {
  const database = process.env.WECHAT2RSS_CACHE_DB?.trim();
  if (
    !database ||
    !path.isAbsolute(database) ||
    !/^MP_WXS_\d{5,15}$/.test(feedId)
  )
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
    [script, '--database', database, '--feed', feedId, '--name', name],
    {
      windowsHide: true,
      shell: false,
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return parseWechat2RssJsonFeed(JSON.parse(stdout), feedId);
}
