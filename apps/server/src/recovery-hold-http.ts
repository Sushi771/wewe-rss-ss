import { Request, Response, NextFunction } from 'express';

const localProcedures = new Map([
  ['xiaohongshu.prepareRefreshBatchLocalCancellation', 'query'],
  ['xiaohongshu.confirmRefreshBatchLocalCancellation', 'mutation'],
  ['xiaohongshu.refreshBatchStatus', 'query'],
  ['xiaohongshu.connectionStatus', 'query'],
]);

/** Only local metadata administration. This is not authentication, source
 * admission, backup approval or a write grant; all original guards still run. */
export function recoveryHoldLocalProcedure(
  path: string,
  type: string,
  ctx: unknown,
) {
  const local = ctx as { isLocalSave?: boolean; isLocalXhsRead?: boolean };
  return (
    localProcedures.has(path) && localProcedures.get(path) === type &&
    (local?.isLocalSave === true ||
      (type === 'query' && local?.isLocalXhsRead === true))
  );
}

/** Keep recovery/source work frozen. Exact local settlement requests may reach
 * their existing authenticated, validated and backup-protected procedures. */
export function recoveryHoldHttp(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (process.env.WECHAT2RSS_RECOVERY_HOLD === '1') {
    const origin = `${req.protocol}://${req.get?.('host') || ''}`;
    const local =
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        req.socket?.remoteAddress || '',
      ) && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
    const sameOrigin = local && req.headers?.origin === origin;
    const localRead =
      local && req.method === 'GET' &&
      (req.headers?.origin === undefined || sameOrigin);
    const type = req.method === 'GET' ? 'query' :
      req.method === 'POST' ? 'mutation' : '';
    if (
      (localRead && req.path === '/startup-status') ||
      (req.path?.startsWith('/trpc/') && recoveryHoldLocalProcedure(
        req.path.slice('/trpc/'.length), type,
        { isLocalSave: sameOrigin, isLocalXhsRead: localRead },
      ))
    ) {
      res.setHeader('Cache-Control', 'no-store');
      return next();
    }
    res.status(503).send('任务恢复检查中，操作暂不可用。');
    return;
  }
  next();
}
