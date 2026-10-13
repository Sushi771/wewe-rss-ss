import { Request, Response, NextFunction } from 'express';
import { ServiceUnavailableException } from '@nestjs/common';
import { backupSpaceMessage } from './collection/sqlite-backup-root';

type Audit = {
  status: 'verifying' | 'ready' | 'failed';
  reason?: string;
  startedAt: number;
  finishedAt: number | null;
  ready: Promise<boolean>;
  start(): void;
};
export function startupAudit(): Audit | undefined {
  return (globalThis as any).__weweStartupAudit;
}
/** Avoid startup-audit/periodic-snapshot races on the same bounded root. */
export async function startSnapshotsAfterStartupAudit(
  startSnapshots: () => Promise<void>,
) {
  const audit = startupAudit();
  audit?.start();
  if (audit && !(await audit.ready)) return false;
  await startSnapshots();
  return true;
}
export function startupMessage() {
  if (startupAudit()?.reason === 'space-budget-exceeded')
    return '备份空间预算不足，更新和修改已暂停，已有恢复点保留。请经确认归档或调整有限预算后重试。';
  return startupAudit()?.status === 'failed'
    ? '数据检查失败，更新和修改已暂停。请查看本地日志后重新启动。'
    : '正在检查已有数据，可先查看内容；检查完成后自动恢复更新和修改。';
}
export function databaseWritesAllowed() {
  const audit = startupAudit();
  return !audit || audit.status === 'ready';
}
export function assertDatabaseWritesAllowed() {
  if (!databaseWritesAllowed())
    throw new ServiceUnavailableException(startupMessage());
}
export async function waitForStartupAudit() {
  return startupAudit()?.ready ?? true;
}
export function startupAuditHttpGuard(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.path === '/startup-status' && req.method === 'GET') {
    const audit = startupAudit();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      status: audit?.status ?? 'ready',
      writesAllowed: databaseWritesAllowed(),
      message: databaseWritesAllowed()
        ? backupSpaceMessage()
        : startupMessage(),
    });
  }
  // tRPC checks procedure type itself (reads can be batched as POST).
  const independent =
    req.path.startsWith('/trpc/') ||
    /^\/download\/article\/(?:single-task|browser-task)\/[a-f0-9-]+\/cancel$/i.test(
      req.path,
    ) ||
    [
      '/auth/login',
      '/auth/logout',
      '/download/article/settings',
      '/download/article/directory',
    ].includes(req.path);
  if (
    !databaseWritesAllowed() &&
    !independent &&
    (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
      Boolean(req.query.update))
  ) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ message: startupMessage() });
  }
  next();
}
