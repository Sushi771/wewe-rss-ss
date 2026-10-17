import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import axios from 'axios';
import { OwnerWebCookieLifecycle } from '../collection/owner-web-cookie-lifecycle';
import { OwnerWebSession } from '../collection/owner-web-search';
import {
  applyNormalWebRenewal,
  NORMAL_WEB_RENEWAL_URL,
  normalWebSha256,
} from './normal-web-renewal';

jest.mock('axios');
const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/normal-web-renewal.json'),
    'utf8',
  ),
);
const now = Date.parse(fixture.now);
const session = (): OwnerWebSession => structuredClone(fixture.initialSession);
const response = () => ({
  url: NORMAL_WEB_RENEWAL_URL,
  status: 200,
  data: { succ: 1 },
  setCookies: [...fixture.setCookies],
});
const apply = (headers?: string[], input = session()) =>
  applyNormalWebRenewal(
    input,
    '123',
    { ...response(), ...(headers ? { setCookies: headers } : {}) },
    fixture.now,
  );

describe('successful ordinary Web renewal adaptor (synthetic saved attributes; no HTTP)', () => {
  beforeEach(() => jest.resetAllMocks());
  it('accepts no-Secure cookies and added wr_pf while retaining scan time, expiry and HTTPS scope', () => {
    expect(fixture.syntheticCredentialsOnly).toBe(true);
    const input = session();
    const before = JSON.stringify(input);
    const result = apply(undefined, input);
    expect(result.normalLoginAt).toBe(fixture.initialSession.capturedAt);
    expect(result.session.capturedAt).toBe(input.capturedAt);
    expect(result.renewedAt).toBe(fixture.now);
    expect(result.session.renewedAt).toBe(fixture.now);
    expect(result.parentAuthHash).not.toBe(result.resultingAuthHash);
    expect(result.parentSessionSha256).toBe(normalWebSha256(before));
    const key = result.session.cookies.find((c) => c.name === 'wr_skey')!;
    expect(key.expires).toBe(now / 1000 + 5400);
    expect(key.secure).toBe(true);
    expect(result.session.cookies.find((c) => c.name === 'wr_ql')!.value).toBe(
      '0',
    );
    expect(result.session.cookies.some((c) => c.name === 'wr_pf')).toBe(true);
    expect(result.receivedCookieMetadata.every((c) => c.secure === false)).toBe(
      true,
    );
    expect(
      result.receivedCookieMetadata.find((c) => c.name === 'wr_skey'),
    ).toMatchObject({
      maxAge: 5400,
      expires: 'Sun, 04 Oct 2026 20:19:06 GMT',
      expiresAt: now + 5400000,
    });
    const jar = new OwnerWebCookieLifecycle(result.session, '123', now);
    expect(jar.header('https://weread.qq.com/web/mp/articles', now)).toContain(
      'wr_skey=renewed-web-skey',
    );
    expect(() =>
      jar.header('http://weread.qq.com/web/mp/articles', now),
    ).toThrow();
    expect(() =>
      jar.header('https://sub.weread.qq.com/web/mp/articles', now),
    ).toThrow();
    expect(() =>
      jar.header('https://weread.qq.com/web/mp/articles', now + 5400000),
    ).toThrow();
    expect(JSON.stringify(input)).toBe(before);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('keeps ordinary directory/body guards unchanged', () => {
    const jar = new OwnerWebCookieLifecycle(session(), '123', now);
    expect(() =>
      jar.absorb(
        'https://weread.qq.com/web/mp/articles',
        fixture.setCookies,
        now,
      ),
    ).toThrow();
    expect(() =>
      jar.absorb(
        'https://weread.qq.com/web/mp/articles',
        ['wr_pf=synthetic; Domain=.weread.qq.com; Path=/; Secure'],
        now,
      ),
    ).toThrow();
    expect(jar.header('https://weread.qq.com/web/mp/articles', now)).toContain(
      'old-web-skey',
    );
  });
  it.each([
    { url: 'https://evil.invalid/web/login/renewal' },
    { url: 'http://weread.qq.com/web/login/renewal' },
    { url: 'https://weread.qq.com/web/mp/articles' },
    { url: NORMAL_WEB_RENEWAL_URL + '?anything=1' },
    { status: 302 },
    { status: 401 },
    { data: { succ: 0 } },
    { data: { succ: 1, errCode: -2041 } },
    { data: { succ: 1, code: -2013 } },
  ])('rejects non-success or non-renewal context %j', (patch) => {
    expect(() =>
      applyNormalWebRenewal(
        session(),
        '123',
        { ...response(), ...patch },
        fixture.now,
      ),
    ).toThrow();
  });
  it.each([
    'wr_vid=999; Path=/',
    'wr_vid=; Path=/',
    'wr_vid=123; Path=/; Max-Age=0',
    'wr_skey=; Path=/',
    'wr_skey=revoked; Path=/; Max-Age=0',
    'wr_skey=expired; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'wr_skey=bad; Domain=.qq.com; Path=/',
    'wr_skey=bad; Domain=evil.invalid; Path=/',
    'wr_skey=bad; Path=/web-other',
    'wr_skey=bad; Path=/web/login',
    'wr_skey=bad; Path=/; Path=/web',
    'wr_skey=bad; Path=/; Max-Age=invalid',
    'wr_skey=bad; Path=/; Expires=invalid',
    'wr_skey=bad; Path=/; Max-Age=9007199254740991',
    'wr_skey=bad, wr_vid=999; Path=/',
    'wr_skey=bad\r\nCookie: secret; Path=/',
    'wr_skey=bad; Domain=weread.qq.com; Domain=evil.invalid; Path=/',
  ])(
    'rejects invalid owner, scope, deletion or attribute without mutating input (%s)',
    (header) => {
      const input = session();
      const before = JSON.stringify(input);
      const name = header.split('=', 1)[0];
      const headers = fixture.setCookies.filter(
        (line: string) => !line.startsWith(name + '='),
      );
      expect(() => apply([...headers, header], input)).toThrow();
      expect(JSON.stringify(input)).toBe(before);
    },
  );
  it.each([
    ['wr_skey=only-key; Path=/'],
    ['wr_vid=123; Path=/'],
    [...fixture.setCookies, 'other_credential=secret; Path=/'],
    [...fixture.setCookies, 'wr_skey=conflicting-key; Path=/'],
    [...fixture.setCookies, 'wr_skey=renewed-web-skey; Path=/'],
    [...fixture.setCookies, 'x'.repeat(8193)],
  ])(
    'rejects missing owner/key, unknown names, duplicates and oversized headers',
    (...headers) => {
      expect(() => apply(headers as string[])).toThrow();
    },
  );
  it('preserves a host-only seed and rejects broadening an existing Web path', () => {
    const hostOnly = session();
    hostOnly.cookies.forEach((c) => (c.domain = 'weread.qq.com'));
    const result = apply(undefined, hostOnly);
    expect(
      result.session.cookies.every((c) => c.domain === 'weread.qq.com'),
    ).toBe(true);
    expect(
      result.receivedCookieMetadata.every((c) => c.hostOnly === false),
    ).toBe(true);
    const narrow = session();
    narrow.cookies.forEach((c) => (c.path = '/web'));
    expect(() => apply(undefined, narrow)).toThrow();
    const headers = fixture.setCookies.map((line: string) =>
      line.replace('Path=/', 'Path=/web'),
    );
    const narrowed = apply(headers);
    expect(
      narrowed.session.cookies
        .filter((c) => c.name !== 'wr_ql')
        .every((c) => c.path === '/web'),
    ).toBe(true);
    expect(
      new OwnerWebCookieLifecycle(narrowed.session, '123', now).header(
        'https://weread.qq.com/web/mp/content',
        now,
      ),
    ).toContain('renewed-web-skey');
  });
  it('honors Max-Age precedence and removes auxiliary revocations', () => {
    const headers = fixture.setCookies.map((line: string) =>
      line.startsWith('wr_skey=')
        ? 'wr_skey=new-key; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60'
        : line,
    );
    headers.push('wr_ql=; Path=/; Max-Age=0');
    const result = apply(headers);
    expect(
      result.session.cookies.find((c) => c.name === 'wr_skey')!.expires,
    ).toBe(now / 1000 + 60);
    expect(result.session.cookies.some((c) => c.name === 'wr_ql')).toBe(false);
  });
  it('retains Expires-only validity and rejects unchanged keys or falsified parent evidence', () => {
    const headers = fixture.setCookies.map((line: string) =>
      line.replace(/Max-Age=\d+; /, ''),
    );
    expect(
      apply(headers).session.cookies.find((c) => c.name === 'wr_skey')!.expires,
    ).toBe(Date.parse('Sun, 04 Oct 2026 20:19:06 GMT') / 1000);
    expect(() =>
      apply(
        fixture.setCookies.map((line: string) =>
          line.replace('renewed-web-skey', 'old-web-skey'),
        ),
      ),
    ).toThrow('WEB_RENEWAL_KEY_UNCHANGED');
    expect(() =>
      applyNormalWebRenewal(session(), '123', response(), fixture.now, '{}'),
    ).toThrow();
    expect(() =>
      applyNormalWebRenewal(
        session(),
        '123',
        response(),
        fixture.now,
        'private-malformed-token',
      ),
    ).toThrow('WEB_RENEWAL_CONTEXT_INVALID');
    expect(() =>
      applyNormalWebRenewal(
        session(),
        '123',
        response(),
        '2026-10-04T14:00:00Z',
      ),
    ).toThrow();
  });
});
