import { Request, Response, NextFunction } from 'express';

/** Freeze every HTTP route during recovery inspection, including GET routes
 * which can trigger a refresh or fetch media. This does not freeze startup
 * audit or other process activity. */
export function recoveryHoldHttp(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (process.env.WECHAT2RSS_RECOVERY_HOLD === '1') {
    res.status(503).send('任务恢复检查中，操作暂不可用。');
    return;
  }
  next();
}
