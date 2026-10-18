import * as path from 'node:path';
import {
  readFileSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from 'node:fs';
import { createHash } from 'node:crypto';

/** Diagnostics only. Never used as admission, freshness or deletion authority. */
export function periodicLifecycleMessage(value: unknown) {
  const s = value as {
    status?: unknown;
    normal?: unknown;
    pending?: unknown;
  } | null;
  if (!s || typeof s !== 'object') return '';
  if (s.status === 'pending-confirmation')
    return '定期备份已有一份待确认副本；常规保留目标为3份，确认本次精确淘汰前不再新增变化副本。原有恢复点保留，数据未变时仍可验证复用。';
  if (
    ['copy-intent', 'retirement-started', 'releasing'].includes(
      String(s.status),
    )
  )
    return '定期备份上次操作尚未确认完成，新增副本已暂停；现有恢复点保留，需核对同一记录，不能据此获得新鲜快照许可。';
  return '';
}

export function backupForecastMessage(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const r = value as Record<string, unknown>;
  if (r.nextBackupAllowed === false)
    return '备份空间预算已达到上限，新恢复点生成暂停；现有恢复点保留，请复核并单独确认处理。';
  if (!r.warning) return '';
  const seconds = r.continuousChangedSnapshotIntervalSeconds;
  const days = r.estimatedDaysAtContinuousChanges;
  if (
    typeof seconds === 'number' &&
    Number.isSafeInteger(seconds) &&
    seconds >= 60 &&
    seconds <= 86400 &&
    typeof days === 'number' &&
    Number.isFinite(days) &&
    days >= 0 &&
    days <= 1000000
  ) {
    const cadence =
      seconds % 3600 === 0 ? `${seconds / 3600}小时` : `${seconds / 60}分钟`;
    return `备份空间需要复核。持续变化时按每${cadence}一份估算，剩余空间约${days}天；数据未变可验证复用，恢复点不会自动删除。`;
  }
  return '备份空间接近上限，请复核恢复点；现有恢复点不会自动删除。';
}

function lifecycleMessage(database: string) {
  const key = createHash('sha256').update(database).digest('hex').slice(0, 24);
  const file = path.join(
    resolveSqliteBackupRoot(database),
    `.periodic-lifecycle-${key}.json`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > 128 * 1024) return '定期备份记录需要核对，新增副本保持暂停。';
    const bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, 0) !== size) return '';
    return periodicLifecycleMessage(JSON.parse(bytes.toString('utf8')).payload);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? ''
      : '定期备份记录暂不可核验；此提示不代表快照已验证或已获得写入许可。';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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
    const periodic = lifecycleMessage(database);
    if (periodic) return periodic;
    const report = JSON.parse(
      readFileSync(
        path.join(
          resolveSqliteBackupRoot(database),
          '.space-budget-status.json',
        ),
        'utf8',
      ),
    );
    return backupForecastMessage(report);
  } catch {
    return '';
  }
}
