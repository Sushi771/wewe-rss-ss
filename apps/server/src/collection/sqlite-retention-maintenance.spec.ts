import {
  scheduleRetentionScans,
  startSqliteRetentionMaintenance,
} from './sqlite-retention-maintenance';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as path from 'node:path';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

describe('bounded retention review scheduling', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('is opt-in and leaves a normal server untouched by default', () => {
    const previous = process.env.SQLITE_RETENTION_SCAN_ENABLED;
    delete process.env.SQLITE_RETENTION_SCAN_ENABLED;
    expect(() => startSqliteRetentionMaintenance()()).not.toThrow();
    if (previous !== undefined)
      process.env.SQLITE_RETENTION_SCAN_ENABLED = previous;
  });
  it.each([0, -1, 3599999, 86400001, Infinity, NaN])(
    'rejects unbounded intervals %s',
    (interval) => {
      expect(() =>
        scheduleRetentionScans(async () => undefined, interval),
      ).toThrow();
    },
  );
  it('runs immediately, never overlaps, and stops future scans', async () => {
    jest.useFakeTimers();
    let release: () => void = () => undefined;
    const run = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = scheduleRetentionScans(run, 3600000);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(7200000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(3600000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    release();
    await jest.advanceTimersByTimeAsync(7200000);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('isolates scan failure and reports only a safe event', async () => {
    jest.useFakeTimers();
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error('private/path'))
      .mockResolvedValue(undefined);
    const stop = scheduleRetentionScans(run, 3600000);
    await jest.advanceTimersByTimeAsync(3600000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith('[SQLITE_RETENTION_SCAN_FAILED]');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private/path');
    stop();
  });
});

describe('own retention child lifecycle', () => {
  let previous: NodeJS.ProcessEnv;
  let child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: string | null;
    kill: jest.Mock;
  };
  beforeEach(() => {
    previous = { ...process.env };
    process.env.SQLITE_RETENTION_SCAN_ENABLED = '1';
    process.env.SQLITE_RETENTION_SCAN_INTERVAL_SECONDS = '3600';
    process.env.DATABASE_URL = `file:${path.resolve('synthetic-retention.db')}`;
    process.env.SQLITE_BACKUP_KIND = 'test';
    process.env.SQLITE_TEST_BACKUP_ROOT = path.resolve(
      'synthetic-retention-backups',
    );
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: jest.fn(() => false),
    });
    (spawn as jest.Mock).mockReset().mockReturnValue(child);
  });
  afterEach(() => {
    process.env = previous;
    jest.useRealTimers();
    jest.restoreAllMocks();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  it('uses argument arrays, hidden windows and no shell; drains private diagnostics', async () => {
    const stop = startSqliteRetentionMaintenance();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((spawn as jest.Mock).mock.calls[0][2]).toEqual({
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.write('private source/path');
    child.emit('close', 0);
    await Promise.resolve();
    expect(console.warn).not.toHaveBeenCalled();
    stop();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('fences an unconfirmed timeout exit and allows a later confirmed close', async () => {
    const stop = startSqliteRetentionMaintenance();
    await jest.advanceTimersByTimeAsync(3600000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    child.emit('close', 1);
    await jest.advanceTimersByTimeAsync(3600000);
    expect(spawn).toHaveBeenCalledTimes(2);
    stop();
  });
  it('bounds stdout and stops only its own child', async () => {
    const stop = startSqliteRetentionMaintenance();
    child.stdout.write('x'.repeat(16385));
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledTimes(1);
    stop();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith('[SQLITE_RETENTION_SCAN_FAILED]');
  });
  it('invalid configuration fails before spawning', () => {
    process.env.SQLITE_RETENTION_SCAN_INTERVAL_SECONDS = '1';
    expect(() => startSqliteRetentionMaintenance()).toThrow('interval');
    expect(spawn).not.toHaveBeenCalled();
  });
});
