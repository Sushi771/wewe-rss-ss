import { json, RequestHandler } from 'express';
import {
  BrowserTaskBroker,
  BrowserTaskError,
  BROWSER_TASK_MAX_BYTES,
} from './browser-task';

/** Future opt-in integration: mount only at /browser-task BEFORE main.ts's
 * global 10mb parser, with Nest bodyParser disabled or this middleware first.
 * Pairing/origin/host checks happen before buffering an authenticated payload.
 * No global parser increase, and this middleware is currently not registered.
 */
export function browserTaskBodyParser(
  broker: BrowserTaskBroker,
): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      broker.authorize(req);
    } catch (error) {
      res.status(error instanceof BrowserTaskError ? error.status : 403).json({
        code:
          error instanceof BrowserTaskError ? error.code : 'PAIRING_REQUIRED',
      });
      return;
    }
    const parser = json({
      limit: req.path === '/complete' ? BROWSER_TASK_MAX_BYTES : 4096,
      strict: true,
    });
    parser(req, res, (error) => {
      if (error) {
        res.status(error.type === 'entity.too.large' ? 413 : 400).json({
          code:
            error.type === 'entity.too.large' ? 'PAYLOAD_SIZE' : 'JSON_INVALID',
        });
        return;
      }
      next();
    });
  };
}
