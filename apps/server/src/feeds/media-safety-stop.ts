import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** A CDN restriction must survive restarts. This private latch never changes
 * article/queue state and has no automatic expiry or reset. */
export class MediaSafetyStop {
  private marker = '';
  blocked = true;
  async initialize(databaseUrl: string) {
    if (!databaseUrl.startsWith('file:')) throw new Error('SQLITE_REQUIRED');
    const database = await fs.realpath(
      decodeURIComponent(databaseUrl.slice(5).split('?')[0]),
    );
    this.marker = path.join(
      path.dirname(database),
      '.wechat2rss-media-blocked.json',
    );
    try {
      await fs.access(this.marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.blocked = false;
    }
  }
  async stop() {
    this.blocked = true;
    if (!this.marker) throw new Error('MEDIA_SAFETY_STORAGE_UNAVAILABLE');
    try {
      await fs.writeFile(
        this.marker,
        JSON.stringify({
          version: 1,
          code: 'IMAGE_REQUEST_BLOCKED',
          blockedAt: new Date().toISOString(),
        }) + '\n',
        { flag: 'wx' },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
