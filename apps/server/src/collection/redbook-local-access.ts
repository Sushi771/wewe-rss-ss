import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

export function redbookHandoffPath(path: string) {
  return /^\/local\/redbook\/(status|session|revoke|resume-operator|diagnostic\/(status|session|list|detail|images|sample|review|discard))$/.test(
    path,
  );
}
/** Direct server-local administration only, never reverse-proxy forwarding. */
export function redbookLocalAccess(req: Request, authCode?: string) {
  if (
    !authCode ||
    typeof req.headers.authorization !== 'string' ||
    Object.keys(req.headers).some((key) => {
      const name = key.toLowerCase();
      return (
        name === 'forwarded' ||
        name.startsWith('x-forwarded-') ||
        name === 'via'
      );
    }) ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.socket.remoteAddress || '',
    )
  )
    return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(req.headers.authorization), digest(authCode)))
    return false;
  try {
    const authority = req.get('host') || '';
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/i.test(authority)
    )
      return false;
    const host = new URL(`${req.protocol}://${authority}`);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) &&
      req.headers.origin === host.origin
    );
  } catch {
    return false;
  }
}
