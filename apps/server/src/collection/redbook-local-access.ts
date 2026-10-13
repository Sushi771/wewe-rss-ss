import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

export function redbookHandoffPath(path: string) {
  return /^\/local\/redbook\/(status|session|revoke|resume-operator)$/.test(
    path,
  );
}
/** Direct server-local administration only, never reverse-proxy forwarding. */
export function redbookLocalAccess(req: Request, authCode?: string) {
  if (
    !authCode ||
    typeof req.headers.authorization !== 'string' ||
    [
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'via',
    ].some((key) => req.headers[key] !== undefined) ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.socket.remoteAddress || '',
    )
  )
    return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(req.headers.authorization), digest(authCode)))
    return false;
  try {
    const host = new URL(`${req.protocol}://${req.get('host')}`);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) &&
      req.headers.origin === host.origin
    );
  } catch {
    return false;
  }
}
