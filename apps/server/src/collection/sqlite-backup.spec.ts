import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { sqliteWrites } from './sqlite-write-coordinator';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  realpath: jest.fn(),
}));

const start = spawn as jest.MockedFunction<typeof spawn>;
const checkAccess = access as jest.MockedFunction<typeof access>;
const resolvePath = realpath as jest.MockedFunction<typeof realpath>;
const database = path.resolve('synthetic-backup-fixture', 'source.db');
const report = {
  integrityCheck: 'ok',
  backup: path.join(
    path.dirname(database),
    'backups',
    'synthetic',
    'backup.db',
  ),
  sha256: 'a'.repeat(64),
};

function fakeBackup() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(() => true),
  });
  start.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

async function waitForSpawn() {
  for (let i = 0; i < 20 && !start.mock.calls.length; i++)
    await Promise.resolve();
  expect(start).toHaveBeenCalledTimes(1);
}

describe('SQLite backup gate (synthetic children and mocked filesystem)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPython = process.env.SQLITE_BACKUP_PYTHON;
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;

  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.useFakeTimers();
    start.mockReset();
    checkAccess.mockReset().mockResolvedValue(undefined);
    resolvePath.mockReset().mockResolvedValue(database);
    process.env.DATABASE_URL = 'file:../data/fixture.db';
    delete process.env.SQLITE_BACKUP_PYTHON;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPython === undefined) delete process.env.SQLITE_BACKUP_PYTHON;
    else process.env.SQLITE_BACKUP_PYTHON = originalPython;
  });

  it('only skips an explicit MySQL channel before looking for SQLite dependencies', async () => {
    process.env.DATABASE_URL = 'mysql://fixture:secret@database:3306/wewe';
    expect(await createVerifiedSqliteBackup({ allowMysqlSkip: true })).toEqual({
      skipped: true,
      databaseType: 'mysql',
    });
    expect(checkAccess).not.toHaveBeenCalled();
    expect(resolvePath).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    'never skips MySQL without allowMysqlSkip=true (%s)',
    async (allowMysqlSkip) => {
      process.env.DATABASE_URL = 'mysql://fixture:secret@database:3306/wewe';
      await expect(
        createVerifiedSqliteBackup({ allowMysqlSkip }),
      ).rejects.toThrow('当前数据库不是 SQLite');
      expect(checkAccess).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    'postgresql://database/wewe',
    'sqlserver://database/wewe',
    'mysql:',
    'mysql://',
    'mysql:///wewe',
    'file:',
    'file:?mode=ro',
    'file:%00',
    'file:%E0%A4%A',
  ])(
    'rejects empty, unknown, or malformed DATABASE_URL %s even with skip allowed',
    async (url) => {
      process.env.DATABASE_URL = url;
      await expect(
        createVerifiedSqliteBackup({ allowMysqlSkip: true }),
      ).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['win32', 'python'],
    ['linux', 'python3'],
    ['darwin', 'python3'],
  ])(
    'uses %s default interpreter %s and waits for verified SQLite output',
    async (platform, command) => {
      Object.defineProperty(process, 'platform', {
        ...originalPlatform,
        value: platform,
      });
      const child = fakeBackup();
      const operation = createVerifiedSqliteBackup({ allowMysqlSkip: true });
      let completed = false;
      void operation.then(() => {
        completed = true;
      });
      await waitForSpawn();
      expect(completed).toBe(false);
      expect(start.mock.calls[0]).toEqual([
        command,
        [
          path.join(process.cwd(), 'scripts', 'backup-sqlite.py'),
          '--database',
          database,
          '--backup-root',
          path.join(path.dirname(database), 'backups'),
        ],
        { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      ]);
      child.stdout.write(JSON.stringify(report));
      await Promise.resolve();
      expect(completed).toBe(false);
      child.emit('close', 0, null);
      await expect(operation).resolves.toEqual(report);
    },
  );

  it('passes a configured interpreter path as one executable without invoking a shell', async () => {
    const executable = path.join(
      path.parse(database).root,
      'Python Runtime',
      'python.exe',
    );
    process.env.SQLITE_BACKUP_PYTHON = executable;
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    await waitForSpawn();
    expect(start.mock.calls[0][0]).toBe(executable);
    expect(start.mock.calls[0][2]).toMatchObject({ shell: false });
    expect(start.mock.calls[0][1]).not.toContain(executable);
    child.stdout.write(JSON.stringify(report));
    child.emit('close', 0, null);
    await expect(operation).resolves.toEqual(report);
  });

  it('rejects control characters in the configured executable', async () => {
    process.env.SQLITE_BACKUP_PYTHON = 'python\nother-command';
    await expect(createVerifiedSqliteBackup()).rejects.toThrow(
      '可执行路径无效',
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('resolves the actual SQLite file before spawning and strips URL options', async () => {
    process.env.DATABASE_URL = 'file:../data/Test%20Archive.db?mode=rw';
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    await waitForSpawn();
    expect(resolvePath).toHaveBeenCalledWith(
      path.resolve(process.cwd(), 'prisma', '../data/Test Archive.db'),
    );
    expect(start.mock.calls[0][1]).toContain(database);
    child.stdout.write(JSON.stringify(report));
    child.emit('close', 0, null);
    await expect(operation).resolves.toEqual(report);
  });

  it('finds the server scripts when launched from the repository root', async () => {
    const server = path.join(process.cwd(), 'apps', 'server');
    checkAccess.mockImplementation(async (candidate) => {
      if (!String(candidate).startsWith(server + path.sep))
        throw new Error('Synthetic missing server root');
    });
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    await waitForSpawn();
    expect(start.mock.calls[0][1]?.[0]).toBe(
      path.join(server, 'scripts', 'backup-sqlite.py'),
    );
    child.stdout.write(JSON.stringify(report));
    child.emit('close', 0, null);
    await expect(operation).resolves.toEqual(report);
  });

  it('does not spawn when the backup component is missing', async () => {
    checkAccess.mockRejectedValue(new Error('Synthetic missing file'));
    await expect(createVerifiedSqliteBackup()).rejects.toThrow(
      '找不到内置 SQLite 备份组件',
    );
    expect(resolvePath).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('does not spawn when the database path cannot be resolved', async () => {
    resolvePath.mockRejectedValue(new Error('Synthetic missing database'));
    await expect(createVerifiedSqliteBackup()).rejects.toThrow(
      'Synthetic missing database',
    );
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{', '报告无效'],
    ['null report', 'null', '备份验证失败'],
    ['missing report fields', '{}', '备份验证失败'],
    [
      'failed integrity check',
      JSON.stringify({ ...report, integrityCheck: 'corrupt' }),
      '备份验证失败',
    ],
    [
      'empty backup path',
      JSON.stringify({ ...report, backup: '' }),
      '备份验证失败',
    ],
    [
      'invalid checksum',
      JSON.stringify({ ...report, sha256: 'not-a-checksum' }),
      '备份验证失败',
    ],
  ])(
    'rejects %s despite a successful process exit',
    async (_name, output, reason) => {
      const child = fakeBackup();
      const operation = createVerifiedSqliteBackup();
      const check = expect(operation).rejects.toThrow(reason);
      await waitForSpawn();
      child.stdout.write(output);
      child.emit('close', 0, null);
      await check;
    },
  );

  it.each([
    [1, null],
    [null, 'SIGTERM'],
  ])(
    'rejects exit code %s and signal %s despite plausible output',
    async (code, signal) => {
      const child = fakeBackup();
      const operation = createVerifiedSqliteBackup();
      const check = expect(operation).rejects.toThrow('未验证成功');
      await waitForSpawn();
      child.stdout.write(JSON.stringify(report));
      child.stderr.write('private diagnostic that must not be forwarded');
      child.emit('close', code, signal);
      await check;
      await expect(operation).rejects.not.toThrow('private diagnostic');
    },
  );

  it('maps a missing interpreter to a controlled failure', async () => {
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    const check =
      expect(operation).rejects.toThrow('无法启动 SQLite 一致性备份');
    await waitForSpawn();
    child.emit('error', new Error('private executable path'));
    child.emit('close', -1, null);
    await check;
    await expect(operation).rejects.not.toThrow('private executable path');
  });

  it.each(['stdout', 'stderr'])(
    'waits for child close before rejecting oversized %s',
    async (stream) => {
      const child = fakeBackup();
      const operation = createVerifiedSqliteBackup();
      const check = expect(operation).rejects.toThrow('输出超限');
      await waitForSpawn();
      child[stream as 'stdout' | 'stderr'].write('中'.repeat(1500));
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit('close', 0, null);
      await check;
    },
  );

  it('rejects timed-out backups even if a later success report arrives', async () => {
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    const check = expect(operation).rejects.toThrow('备份超时');
    await waitForSpawn();
    let finished = false;
    void operation.catch(() => {
      finished = true;
    });
    await jest.advanceTimersByTimeAsync(60000);
    expect(finished).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.stdout.write(JSON.stringify(report));
    child.emit('close', 0, null);
    await check;
    await expect(operation).rejects.toThrow('备份超时');
  });

  it('fences retries after failed termination and releases the fence only on close', async () => {
    const child = fakeBackup();
    child.kill.mockImplementation(() => {
      throw new Error('private kill failure');
    });
    const operation = createVerifiedSqliteBackup();
    const check = expect(operation).rejects.toThrow('退出未确认');
    await waitForSpawn();
    await jest.advanceTimersByTimeAsync(65000);
    await check;
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await expect(createVerifiedSqliteBackup()).rejects.toThrow('退出未确认');
    expect(start).toHaveBeenCalledTimes(1);
    const write = jest.fn(async () => 1);
    const queuedWrite = sqliteWrites.write(write);
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');
    await expect(queuedWrite).resolves.toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    const next = fakeBackup();
    const retried = createVerifiedSqliteBackup();
    for (let i = 0; i < 20 && start.mock.calls.length < 2; i++)
      await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);
    next.stdout.write(JSON.stringify(report));
    next.emit('close', 0, null);
    await expect(retried).resolves.toEqual(report);
    expect(
      JSON.stringify((console.info as jest.Mock).mock.calls),
    ).not.toContain('private kill failure');
  });

  it('blocks a second child while a timed-out child is still stopping', async () => {
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    const check = expect(operation).rejects.toThrow('备份超时');
    await waitForSpawn();
    await jest.advanceTimersByTimeAsync(60000);
    await expect(createVerifiedSqliteBackup()).rejects.toThrow('退出未确认');
    expect(start).toHaveBeenCalledTimes(1);
    child.emit('close', null, 'SIGTERM');
    await check;
  });

  it('queues another backup caller until the timed-out child has closed', async () => {
    const first = fakeBackup();
    const second = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    const check = expect(operation).rejects.toThrow('备份超时');
    await waitForSpawn();
    const queued = createVerifiedSqliteBackup();
    await jest.advanceTimersByTimeAsync(60000);
    expect(start).toHaveBeenCalledTimes(1);
    first.emit('close', null, 'SIGTERM');
    await check;
    for (let i = 0; i < 30 && start.mock.calls.length < 2; i++)
      await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);
    second.stdout.write(JSON.stringify(report));
    second.emit('close', 0, null);
    await expect(queued).resolves.toEqual(report);
  });

  it('logs only allowlisted stage telemetry, never raw child diagnostics', async () => {
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    const check = expect(operation).rejects.toThrow('未验证成功');
    await waitForSpawn();
    child.stderr.write(
      JSON.stringify({
        diagnostics: {
          stage: 'copy',
          journalMode: 'delete',
          copySteps: 7,
          busySteps: 2,
          milliseconds: { lock: 12, copy: 5001, secret: 'private body' },
          secret: 'cookie=private-secret',
        },
      }),
    );
    child.emit('close', 1, null);
    await check;
    const logged = JSON.parse((console.info as jest.Mock).mock.calls[0][0]);
    expect(logged).toMatchObject({
      event: 'sqlite-backup',
      stage: 'copy',
      milliseconds: { lock: 12, copy: 5001 },
    });
    expect(JSON.stringify(logged)).not.toMatch(/private|cookie|secret/);
  });

  it('preserves retryable timeout classification from the bounded Python copy', async () => {
    const child = fakeBackup();
    const operation = createVerifiedSqliteBackup();
    const check = expect(operation).rejects.toThrow('备份超时');
    await waitForSpawn();
    child.stderr.write(
      JSON.stringify({
        event: 'sqlite-backup-failed',
        reason: 'timeout',
        diagnostics: { stage: 'copy' },
      }),
    );
    child.emit('close', 1, null);
    await check;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('confirms a real isolated child closes on timeout before allowing retry', async () => {
    const realSpawn =
      jest.requireActual<typeof import('node:child_process')>(
        'node:child_process',
      ).spawn;
    let closed = false;
    let realChild: ReturnType<typeof spawn>;
    start.mockImplementationOnce(() => {
      // No database access: exercise the actual OS child termination lifecycle.
      realChild = realSpawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      realChild.once('close', () => {
        closed = true;
      });
      return realChild;
    });
    const operation = createVerifiedSqliteBackup();
    const check = expect(operation).rejects.toThrow('备份超时');
    await waitForSpawn();
    await jest.advanceTimersByTimeAsync(60000);
    await check;
    expect(closed).toBe(true);
    expect(realChild!.exitCode !== null || realChild!.signalCode !== null).toBe(
      true,
    );
    const next = fakeBackup();
    const retried = createVerifiedSqliteBackup();
    for (let i = 0; i < 20 && start.mock.calls.length < 2; i++)
      await Promise.resolve();
    next.stdout.write(JSON.stringify(report));
    next.emit('close', 0, null);
    await expect(retried).resolves.toEqual(report);
  });
});

describe('production root and actionable capacity failure', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    jest.useRealTimers();
  });
  it('collection writes use the configured root and explain budget stops without exposing paths', async () => {
    start.mockReset();
    checkAccess.mockReset().mockResolvedValue(undefined);
    resolvePath.mockReset().mockResolvedValue(database);
    process.env.DATABASE_URL = 'file:' + database;
    process.env.SQLITE_PRODUCTION_BACKUP_ROOT = path.resolve(
      'configured-production-backups',
    );
    const child = fakeBackup(),
      operation = createVerifiedSqliteBackup();
    const rejected = expect(operation).rejects.toThrow('备份空间预算不足');
    await waitForSpawn();
    expect(start.mock.calls[0][1]).toContain(
      process.env.SQLITE_PRODUCTION_BACKUP_ROOT,
    );
    child.stderr.write(
      JSON.stringify({ event: 'sqlite-backup-failed', reason: 'space-budget' }),
    );
    child.emit('close', 1, null);
    await rejected;
  });
});
