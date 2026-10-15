import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { resolveSqliteBackupRoot } from './sqlite-backup-root';

/** Only schedules review scans. It never changes the write gate or deletes data. */
export function scheduleRetentionScans(
  run: () => Promise<void>,
  intervalMs: number,
) {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 3600000 ||
    intervalMs > 86400000
  )
    throw new Error('Invalid retention scan interval');
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await run();
    } catch {
      console.warn('[SQLITE_RETENTION_SCAN_FAILED]');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Explicit deployment opt-in; this function does not enable a running service. */
export function startSqliteRetentionMaintenance() {
  if (process.env.SQLITE_RETENTION_SCAN_ENABLED !== '1') return () => undefined;
  const seconds = Number(
    process.env.SQLITE_RETENTION_SCAN_INTERVAL_SECONDS || 3600,
  );
  if (!Number.isSafeInteger(seconds) || seconds < 3600 || seconds > 86400)
    throw new Error('Invalid retention scan interval');
  const url = process.env.DATABASE_URL || '';
  if (!url.startsWith('file:'))
    throw new Error('Retention scan requires SQLite');
  const raw = decodeURIComponent(url.slice(5).split('?')[0]);
  if (!raw || /[\0\r\n]/.test(raw))
    throw new Error('Invalid retention database');
  const server = [
    process.cwd(),
    path.resolve(process.cwd(), 'apps/server'),
  ].find((folder) =>
    existsSync(path.join(folder, 'scripts/sqlite-retention-plan.py')),
  );
  if (!server) throw new Error('Retention scanner unavailable');
  const database = path.isAbsolute(raw)
    ? raw
    : path.resolve(server, 'prisma', raw);
  const root = resolveSqliteBackupRoot(database);
  const python =
    process.env.SQLITE_BACKUP_PYTHON?.trim() ||
    (process.platform === 'win32' ? 'python' : 'python3');
  if (/[\0\r\n]/.test(python)) throw new Error('Invalid retention interpreter');
  let child: ChildProcess | undefined;
  const stop = scheduleRetentionScans(
    () =>
      new Promise<void>((resolve, reject) => {
        // A timeout alone is not proof of exit. Fence a still-live own child.
        if (child && child.exitCode === null && child.signalCode === null) {
          reject(new Error('Previous retention scanner exit unconfirmed'));
          return;
        }
        let settled = false;
        let output = '';
        const current = spawn(
          python,
          [
            path.join(server, 'scripts/sqlite-retention-plan.py'),
            '--database',
            database,
            '--backup-root',
            root,
          ],
          {
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child = current;
        const timer = setTimeout(() => {
          current.kill();
          finish(false);
        }, 30000);
        const finish = (success: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          success ? resolve() : reject(new Error('Retention scanner failed'));
        };
        current.stdout!.setEncoding('utf8');
        current.stdout!.on('data', (chunk: string) => {
          if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 16384) {
            current.kill();
            finish(false);
          } else output += chunk;
        });
        // Drain private diagnostics, never log raw paths or source content.
        current.stderr!.resume();
        current.once('error', () => finish(false));
        current.once('close', (code) => {
          if (child === current) child = undefined;
          finish(code === 0);
        });
      }),
    seconds * 1000,
  );
  return () => {
    stop();
    child?.kill();
  };
}
