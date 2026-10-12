import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MediaSafetyStop } from './media-safety-stop';

describe('persistent media restriction stop', () => {
  it('starts only without a latch and retains the stop after a restart', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wewe-media-stop-'),
    );
    const database = path.join(directory, 'test.db');
    try {
      await fs.writeFile(database, '');
      const first = new MediaSafetyStop();
      await first.initialize('file:' + database);
      expect(first.blocked).toBe(false);
      await first.stop();
      expect(first.blocked).toBe(true);
      const marker = path.join(directory, '.wechat2rss-media-blocked.json');
      const bytes = await fs.readFile(marker, 'utf8');
      const restarted = new MediaSafetyStop();
      await restarted.initialize('file:' + database);
      expect(restarted.blocked).toBe(true);
      await restarted.stop();
      expect(await fs.readFile(marker, 'utf8')).toBe(bytes);
      expect(await fs.readFile(database, 'utf8')).toBe('');
    } finally {
      if (
        path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)
      )
        await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it('observes another worker marker and fails closed when storage cannot initialize', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-live-latch-'));
    const database = path.join(dir, 'test.db');
    await fs.writeFile(database, '');
    const first = new MediaSafetyStop();
    await first.initialize('file:' + database);
    const other = new MediaSafetyStop();
    await other.initialize('file:' + database);
    await other.stop();
    expect(first.isBlocked()).toBe(true);
    const unavailable = new MediaSafetyStop();
    await expect(unavailable.initialize('invalid')).rejects.toThrow(
      'SQLITE_REQUIRED',
    );
    expect(unavailable.isBlocked()).toBe(true);
  });
});
