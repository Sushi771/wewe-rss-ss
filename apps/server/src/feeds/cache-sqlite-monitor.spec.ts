import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CacheSqliteMonitor } from './cache-sqlite-monitor';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
jest.mock('node:fs/promises', () => ({
  access: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('node:fs', () => ({ watch: jest.fn() }));
jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
describe('directory hints only', () => {
  it('filters, coalesces, rebuilds after watcher loss, and cleans up', async () => {
    jest.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    const watchers: any[] = [];
    (spawn as jest.Mock).mockReturnValue(child);
    (watch as jest.Mock).mockImplementation((directory, callback) => {
      const watcher = Object.assign(new EventEmitter(), {
        unref: jest.fn(),
        close: jest.fn(),
        callback,
      });
      watchers.push(watcher);
      return watcher;
    });
    const write = jest.spyOn(child.stdin, 'write');
    const snapshot = jest.fn();
    const monitor = new CacheSqliteMonitor(
      resolve('cache.db'),
      snapshot,
      jest.fn(),
    );
    try {
      await monitor.start();
      watchers[0].callback('change', 'unrelated.db');
      watchers[0].callback('change', 'cache.db-shm');
      jest.advanceTimersByTime(25);
      expect(write).not.toHaveBeenCalled();
      watchers[0].callback('change', 'cache.db-wal');
      watchers[0].callback('rename', 'cache.db');
      watchers[0].callback('change', null);
      jest.advanceTimersByTime(25);
      expect(write).toHaveBeenCalledTimes(1);
      expect(snapshot).not.toHaveBeenCalled(); // A hint is never a commit notification.
      watchers[0].emit('error', Error('synthetic watcher failure'));
      jest.advanceTimersByTime(1025);
      expect(watchers).toHaveLength(2);
      expect(write).toHaveBeenCalledTimes(2);
      monitor.close();
      jest.advanceTimersByTime(2000);
      expect(watchers[1].close).toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
    } finally {
      monitor.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      jest.useRealTimers();
    }
  });
});
