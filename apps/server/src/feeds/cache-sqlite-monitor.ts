import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { FSWatcher, watch } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

/** Directory events wake a committed read-only snapshot; 1s polling reconciles.
 * Explicit local path only; never assumes a Docker/private path on other hosts. */
export class CacheSqliteMonitor {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private delay = 1000;
  private watcher?: FSWatcher;
  private hintTimer?: NodeJS.Timeout;
  private watchTimer?: NodeJS.Timeout;
  constructor(
    private readonly database: string,
    private readonly onSnapshot: (hashes: Record<string, string>) => void,
    private readonly onUnavailable: () => void,
  ) {}
  async start() {
    if (this.stopped) return;
    try {
      if (!path.isAbsolute(this.database) || /[\0\r\n]/.test(this.database))
        throw new Error();
      await access(this.database);
      const roots = [process.cwd(), path.resolve(process.cwd(), 'apps/server')];
      let script: string | undefined;
      for (const root of roots) {
        const candidate = path.join(root, 'scripts/watch-wechat2rss-cache.py');
        try {
          await access(candidate);
          script = candidate;
          break;
        } catch {}
      }
      const python =
        process.env.SQLITE_BACKUP_PYTHON?.trim() ||
        (process.platform === 'win32' ? 'python' : 'python3');
      if (!script || /[\0\r\n]/.test(python)) throw new Error();
      if (this.stopped) return;
      const child = spawn(
        python,
        ['-u', script, '--database', this.database, '--event-hints'],
        {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.child = child;
      child.stdin.on('error', () => {}); // Exit/restart is handled below.
      this.startWatch();
      let failed = false;
      const fail = () => {
        if (failed) return;
        failed = true;
        child.kill();
        if (this.child === child) this.child = undefined;
        this.retry();
      };
      child.on('error', fail);
      child.on('exit', fail);
      // Raw stderr can never enter product status/logs.
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          if (line.length > 200000) throw new Error();
          const data = JSON.parse(line);
          if (
            !data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            Object.keys(data).length > 1000 ||
            !Object.entries(data).every(
              ([id, hash]) =>
                /^MP_WXS_\d{5,15}$/.test(id) &&
                typeof hash === 'string' &&
                /^[a-f0-9]{64}$/.test(hash),
            )
          )
            throw new Error();
          this.delay = 1000;
          this.onSnapshot(data);
        } catch {
          fail();
        }
      });
    } catch {
      this.retry();
    }
  }
  private startWatch() {
    if (this.stopped || this.watcher) return;
    const basename = path.basename(this.database);
    const key = (name: string) =>
      process.platform === 'win32' ? name.toLowerCase() : name;
    // SQLite readers update SHM read marks themselves. Waking on SHM would
    // create a self-triggered fulltext scan loop; commits change DB/WAL instead.
    const watched = new Set([key(basename), key(basename + '-wal')]);
    try {
      // Watch the directory, not the file inode: rename/replacement must survive.
      const watcher = watch(path.dirname(this.database), (event, filename) => {
        if (filename && !watched.has(key(filename.toString()))) return;
        this.hint();
      });
      this.watcher = watcher;
      watcher.unref();
      const rebuild = () => {
        if (this.watcher !== watcher) return;
        this.watcher = undefined;
        watcher.close();
        if (!this.stopped && !this.watchTimer) {
          this.watchTimer = setTimeout(() => {
            this.watchTimer = undefined;
            this.startWatch();
            this.hint();
          }, 1000);
          this.watchTimer.unref();
        }
      };
      watcher.on('error', rebuild);
      watcher.on('close', rebuild);
    } catch {
      // A missing directory/unsupported watcher retains the polling lane.
      if (!this.stopped && !this.watchTimer) {
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined;
          this.startWatch();
        }, 1000);
        this.watchTimer.unref();
      }
    }
  }
  private hint() {
    if (this.stopped || this.hintTimer) return;
    // Coalesce duplicate WAL/SHM notifications; never poll fulltext at 100ms.
    this.hintTimer = setTimeout(() => {
      this.hintTimer = undefined;
      const input = this.child?.stdin;
      if (input && !input.destroyed && !input.writableNeedDrain)
        input.write('1\n');
    }, 20);
    this.hintTimer.unref();
  }
  private retry() {
    if (this.stopped) return;
    this.onUnavailable();
    this.timer = setTimeout(() => {
      void this.start();
    }, this.delay);
    this.timer.unref();
    this.delay = Math.min(60000, this.delay * 2);
  }
  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.child?.kill();
  }
}
