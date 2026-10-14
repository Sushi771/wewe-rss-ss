import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// A kill request is not an exit receipt. Keep a failed-to-stop child fenced
// until its close event, including after the bounded caller wait has expired.
const stoppingBackups = new Map<string, Set<ReturnType<typeof spawn>>>();

function logDiagnostic(attempt: string, outcome: string, output: string) {
  let diagnostics: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(output)?.diagnostics;
    if (
      raw &&
      ['lock', 'snapshot', 'copy', 'verify', 'hash', 'complete'].includes(
        raw.stage,
      )
    ) {
      diagnostics.stage = raw.stage;
      if (
        [
          'delete',
          'truncate',
          'persist',
          'memory',
          'wal',
          'off',
          'unknown',
        ].includes(raw.journalMode)
      )
        diagnostics.journalMode = raw.journalMode;
      for (const key of ['copySteps', 'busySteps'])
        if (Number.isSafeInteger(raw[key]) && raw[key] >= 0)
          diagnostics[key] = raw[key];
      const timings: Record<string, number> = {};
      for (const key of [
        'lock',
        'snapshot',
        'copy',
        'verify',
        'hash',
        'complete',
      ])
        if (
          Number.isSafeInteger(raw.milliseconds?.[key]) &&
          raw.milliseconds[key] >= 0
        )
          timings[key] = raw.milliseconds[key];
      diagnostics.milliseconds = timings;
    }
  } catch {
    // Never log raw child output, exceptions, paths, or SQL.
  }
  console.info(
    JSON.stringify({
      event: 'sqlite-backup',
      attempt,
      outcome,
      ...diagnostics,
    }),
  );
}

async function serverRoot() {
  for (const candidate of [
    process.cwd(),
    path.resolve(process.cwd(), 'apps', 'server'),
  ]) {
    try {
      await access(path.join(candidate, 'prisma', 'schema.prisma'));
      await access(path.join(candidate, 'scripts', 'backup-sqlite.py'));
      return candidate;
    } catch {
      // Try the next supported launch directory.
    }
  }
  throw new Error('找不到内置 SQLite 备份组件，本次未写入');
}

/** Only existing non-desktop MySQL channels may explicitly bypass this SQLite gate. */
export async function createVerifiedSqliteBackup(
  options: { allowMysqlSkip?: boolean } = {},
) {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (options.allowMysqlSkip === true && databaseUrl.startsWith('mysql://')) {
    try {
      if (!new URL(databaseUrl).hostname) throw new Error();
    } catch {
      throw new Error('MySQL 数据库连接地址无效，本次未写入');
    }
    return { skipped: true as const, databaseType: 'mysql' as const };
  }
  if (!databaseUrl.startsWith('file:'))
    throw new Error('当前数据库不是 SQLite，无法执行所需的一致性备份');
  let rawPath: string;
  try {
    rawPath = decodeURIComponent(databaseUrl.slice(5).split('?')[0]);
  } catch {
    throw new Error('SQLite 数据库路径无效，本次未写入');
  }
  if (!rawPath || rawPath.includes('\0'))
    throw new Error('SQLite 数据库路径无效，本次未写入');
  const root = await serverRoot();
  const database = await realpath(
    path.isAbsolute(rawPath) ? rawPath : path.resolve(root, 'prisma', rawPath),
  );
  const script = path.join(root, 'scripts', 'backup-sqlite.py');
  if (stoppingBackups.has(database))
    throw new Error('SQLite 备份子进程退出未确认，本次未写入');
  const backupRoot = path.join(path.dirname(database), 'backups');
  const python =
    process.env.SQLITE_BACKUP_PYTHON?.trim() ||
    (process.platform === 'win32' ? 'python' : 'python3');
  if (/[\0\r\n]/.test(python))
    throw new Error('SQLite 备份 Python 可执行路径无效，本次未写入');
  const output = await new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      // A configured interpreter is one executable, never a shell command.
      child = spawn(
        python,
        [script, '--database', database, '--backup-root', backupRoot],
        { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      reject(new Error('无法启动 SQLite 一致性备份，本次未写入'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping: string | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = randomUUID();
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      logDiagnostic(
        attempt,
        stoppingBackups.get(database)?.has(child)
          ? 'termination-unconfirmed'
          : stopping
            ? 'stopped'
            : 'failed',
        stderr,
      );
      reject(new Error(message));
    };
    const stop = (message: string) => {
      if (settled || stopping) return;
      clearTimeout(timer);
      stopping = message;
      const group =
        stoppingBackups.get(database) || new Set<ReturnType<typeof spawn>>();
      group.add(child);
      stoppingBackups.set(database, group);
      // Both waits are bounded. If termination cannot be confirmed, retain the
      // fence rather than allowing another child to contend with this one.
      forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* Wait for close or fence. */
        }
      }, 1000);
      exitTimer = setTimeout(() => {
        fail(`${message}；子进程退出未确认，已阻止重试`);
      }, 5000);
      try {
        child.kill();
      } catch {
        // Do not confuse a failed kill request with confirmed process exit.
      }
    };
    const timer = setTimeout(() => {
      stop('SQLite 一致性备份超时，本次未写入');
    }, 60000);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (settled || stopping) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 4096)
        stop('SQLite 一致性备份输出超限，本次未写入');
      else stdout += chunk;
    });
    child.stderr!.on('data', (chunk: string) => {
      if (settled || stopping) return;
      if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 4096)
        stop('SQLite 一致性备份输出超限，本次未写入');
      else stderr += chunk;
    });
    child.once('error', () => {
      if (stopping) return;
      clearTimeout(timer);
      if (child.pid) stop('SQLite 一致性备份进程异常，本次未写入');
      else fail('无法启动 SQLite 一致性备份，本次未写入');
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(exitTimer);
      const group = stoppingBackups.get(database);
      group?.delete(child);
      if (group?.size === 0) stoppingBackups.delete(database);
      if (settled) return;
      if (stopping) {
        fail(stopping);
        return;
      }
      if (code !== 0 || signal) {
        let timedOut = false;
        try {
          const failure = JSON.parse(stderr);
          timedOut =
            failure?.event === 'sqlite-backup-failed' &&
            failure?.reason === 'timeout';
        } catch {
          /* Ignore raw child exceptions. */
        }
        fail(
          timedOut
            ? 'SQLite 一致性备份超时，本次未写入'
            : 'SQLite 一致性备份未验证成功，本次未写入',
        );
      } else {
        settled = true;
        logDiagnostic(attempt, 'process-exited', stdout);
        resolve(stdout);
      }
    });
  });
  let report: {
    integrityCheck?: string;
    source?: string;
    backup?: string;
    sha256?: string;
  };
  try {
    report = JSON.parse(output);
  } catch {
    throw new Error('SQLite 备份验证报告无效，本次未写入');
  }
  if (
    !report ||
    report.integrityCheck !== 'ok' ||
    typeof report.backup !== 'string' ||
    !report.backup ||
    !/^[a-f0-9]{64}$/.test(report.sha256 || '')
  )
    throw new Error('SQLite 备份验证失败，本次未写入');
  return report;
}
