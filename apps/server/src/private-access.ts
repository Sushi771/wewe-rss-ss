import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

const cookieName = 'wewe_private_session';
const sessionSeconds = 30 * 24 * 60 * 60;

export function privateOnlineMode() {
  return process.env.PRIVATE_ONLINE_MODE === '1';
}

export function assertPrivateConfig() {
  if (
    privateOnlineMode() &&
    (!process.env.AUTH_CODE || process.env.AUTH_CODE.length < 24)
  )
    throw new Error(
      'PRIVATE_ONLINE_MODE requires a private AUTH_CODE of at least 24 characters',
    );
}

function secret() {
  return createHash('sha256')
    .update(`wewe-private-session:${process.env.AUTH_CODE || ''}`)
    .digest();
}

export function verifyAccessCode(input: string) {
  if (!process.env.AUTH_CODE || typeof input !== 'string') return false;
  const submitted = createHash('sha256').update(input).digest();
  const expected = createHash('sha256').update(process.env.AUTH_CODE).digest();
  return timingSafeEqual(submitted, expected);
}

export function newSession() {
  const payload = `${Math.floor(Date.now() / 1000) + sessionSeconds}.${randomBytes(16).toString('hex')}`;
  const signature = createHmac('sha256', secret())
    .update(payload)
    .digest('hex');
  return `${payload}.${signature}`;
}

export function hasPrivateSession(req: Request) {
  if (!privateOnlineMode()) return false;
  const value = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!value || !/^\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value))
    return false;
  const [expiry, nonce, signature] = value.split('.');
  if (Number(expiry) <= Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', secret())
    .update(`${expiry}.${nonce}`)
    .digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

export function setSessionCookie(res: Response, value: string) {
  res.cookie(cookieName, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: sessionSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

/** Keep the login shell public; all application data routes require the session. */
export function privateAccessGuard(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!privateOnlineMode()) return next();
  const pathname = req.path;
  if (
    pathname === '/auth/login' ||
    pathname === '/robots.txt' ||
    pathname === '/favicon.ico' ||
    pathname === '/dash/login' ||
    pathname.startsWith('/dash/assets/')
  )
    return next();
  if (pathname === '/')
    return res.redirect(302, hasPrivateSession(req) ? '/dash/' : '/dash/login');
  if (!hasPrivateSession(req)) {
    if (pathname.startsWith('/dash')) return res.redirect(302, '/dash/login');
    return res.status(401).send('Login required');
  }
  // Session cookies must not authorize cross-origin state changes.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    const configured = process.env.SERVER_ORIGIN_URL?.replace(/\/$/, '');
    if (origin && configured && origin !== configured)
      return res.status(403).send('Origin not allowed');
  }
  next();
}
