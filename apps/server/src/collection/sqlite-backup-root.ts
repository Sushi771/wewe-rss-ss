import * as path from 'node:path';
import { readFileSync } from 'node:fs';

/** All startup, collection and periodic recovery points share one policy root. */
export function resolveSqliteBackupRoot(database: string, env = process.env) {
  const test = env.SQLITE_BACKUP_KIND === 'test';
  const configured = test
    ? env.SQLITE_TEST_BACKUP_ROOT
    : env.SQLITE_PRODUCTION_BACKUP_ROOT;
  if (
    configured &&
    (!path.isAbsolute(configured) || /[\0\r\n]/.test(configured))
  )
    throw new Error('SQLite backup root must be an absolute local path');
  return path.resolve(
    configured || path.join(path.dirname(database), 'backups'),
  );
}

export function backupSpaceMessage() {
  if (process.env.SQLITE_BACKUP_KIND === 'test') return '';
  try {
    const url = process.env.DATABASE_URL || '';
    if (!url.startsWith('file:')) return '';
    const raw = decodeURIComponent(url.slice(5).split('?')[0]);
    const database = path.isAbsolute(raw)
      ? raw
      : path.resolve(process.cwd(), 'prisma', raw);
    const report = JSON.parse(
      readFileSync(
        path.join(
          resolveSqliteBackupRoot(database),
          '.space-budget-status.json',
        ),
        'utf8',
      ),
    );
    if (report.nextBackupAllowed === false)
      return '备份空间预算已达到上限，新恢复点生成暂停。已有恢复点保留；请经确认归档或调整有限预算后重试。';
    return report.warning
      ? '备份空间接近容量或按持续变化预测剩余不足24小时，请尽快复核恢复点并安排归档。已有恢复点不会自动删除。'
      : '';
  } catch {
    return '';
  }
}
