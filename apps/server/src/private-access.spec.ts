import { Request, Response } from 'express';
import {
  hasPrivateSession,
  newSession,
  privateAccessGuard,
  verifyAccessCode,
} from './private-access';

describe('private online access', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.PRIVATE_ONLINE_MODE = '1';
    process.env.AUTH_CODE = 'correct-private-code-over-24-characters';
    process.env.SERVER_ORIGIN_URL = 'https://private.example.ts.net';
  });
  afterAll(() => {
    process.env = previous;
  });

  const request = (path: string, cookie?: string, method = 'GET') =>
    ({ path, method, headers: cookie ? { cookie } : {} }) as Request;
  const response = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
    };
    return res as unknown as Response;
  };

  it('accepts a signed cookie and rejects a forged one', () => {
    expect(verifyAccessCode('incorrect')).toBe(false);
    expect(verifyAccessCode(process.env.AUTH_CODE!)).toBe(true);
    const valid = newSession();
    expect(
      hasPrivateSession(
        request('/feeds/all.atom', `wewe_private_session=${valid}`),
      ),
    ).toBe(true);
    const last = valid.endsWith('0') ? '1' : '0';
    expect(
      hasPrivateSession(
        request(
          '/feeds/all.atom',
          `wewe_private_session=${valid.slice(0, -1)}${last}`,
        ),
      ),
    ).toBe(false);
  });

  it.each([
    '/feeds/all.atom',
    '/proxy/image',
    '/download/feed/MP_WXS_1234567890.zip',
    '/trpc',
  ])('blocks anonymous content at %s', (path) => {
    const res = response();
    const next = jest.fn();
    privateAccessGuard(request(path), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('redirects private pages but permits only the login shell and assets', () => {
    const next = jest.fn();
    const res = response();
    privateAccessGuard(request('/dash/feeds/MP_WXS_1234567890'), res, next);
    expect(res.redirect).toHaveBeenCalledWith(302, '/dash/login');
    privateAccessGuard(request('/'), res, next);
    expect(res.redirect).toHaveBeenCalledWith(302, '/dash/login');
    privateAccessGuard(request('/dash/login'), response(), next);
    privateAccessGuard(request('/dash/assets/app.js'), response(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('rejects a cross-origin mutation even with a valid session', () => {
    const req = request(
      '/trpc/feed.delete',
      `wewe_private_session=${newSession()}`,
      'POST',
    );
    req.headers.origin = 'https://attacker.example';
    const res = response();
    const next = jest.fn();
    privateAccessGuard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
