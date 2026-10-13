import { Request, Response, NextFunction } from 'express';
import { ServiceUnavailableException } from '@nestjs/common';

type Audit = {
  status: 'verifying' | 'ready' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  ready: Promise<boolean>;
  start(): void;
};
export function startupAudit(): Audit | undefined {
  return (globalThis as any).__weweStartupAudit;
}
export function startupMessage() {
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
      message: databaseWritesAllowed() ? '' : startupMessage(),
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
