import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import * as path from 'node:path';

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
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    const stop = (message: string) => {
      clearTimeout(timer);
      fail(message);
      try {
        child.kill();
      } catch {
        // The request remains rejected even if process termination fails.
      }
    };
    const timer = setTimeout(() => {
      stop('SQLite 一致性备份超时，本次未写入');
    }, 60000);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (settled) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 4096)
        stop('SQLite 一致性备份输出超限，本次未写入');
      else stdout += chunk;
    });
    child.stderr!.on('data', (chunk: string) => {
      if (settled) return;
      if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 4096)
        stop('SQLite 一致性备份输出超限，本次未写入');
      else stderr += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      fail('无法启动 SQLite 一致性备份，本次未写入');
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0 || signal) fail('SQLite 一致性备份未验证成功，本次未写入');
      else {
        settled = true;
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
