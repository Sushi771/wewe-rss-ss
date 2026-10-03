import { OwnerWebCookieLifecycle } from './owner-web-cookie-lifecycle';
import { OwnerWebSession } from './owner-web-search';

const cover = 'https://weread.qq.com/api/mp/cover';
const content = 'https://weread.qq.com/web/mp/content';
const now = Date.now();
const fixture = (): OwnerWebSession => ({
  source: 'owner-confirmed-native-web-login',
  capturedAt: new Date(now - 30 * 86400000).toISOString(),
  ownerVid: '123',
  cookies: [
    {
      name: 'wr_vid',
      value: '123',
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    },
    {
      name: 'wr_skey',
      value: 'old-fixture',
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    },
  ],
});
const jar = () => new OwnerWebCookieLifecycle(fixture(), '123', now);

describe('operation-local Web cookie attributes (offline fixtures only)', () => {
  it('rotates the same-owner root cookie without mutating the input', () => {
    const input = fixture();
    const cookies = new OwnerWebCookieLifecycle(input, '123', now);
    cookies.absorb(
      cover,
      [
        'wr_vid=123; Domain=.weread.qq.com; Path=/; Secure; HttpOnly',
        'wr_skey=new-fixture; Domain=weread.qq.com; Path=/; Secure; SameSite=Lax',
      ],
      now,
    );
    expect(cookies.header(content, now)).toBe(
      'wr_skey=new-fixture; wr_vid=123',
    );
    expect(input.cookies[1].value).toBe('old-fixture');
  });

  it.each([
    'http://weread.qq.com/web/mp/content',
    'https://evilweread.qq.com/web/mp/content',
    'https://sub.weread.qq.com/web/mp/content',
    'https://weread.qq.com.evil.invalid/web/mp/content',
    'https://mp.weixin.qq.com/web/mp/content',
    'https://weread.qq.com:444/web/mp/content',
  ])('does not forward cookies to %s', (url) => {
    expect(() => jar().header(url, now)).toThrow('OWNER_WEB_COOKIE_INVALID');
    expect(() => jar().absorb(url, [], now)).toThrow(
      'OWNER_WEB_COOKIE_INVALID',
    );
  });

  it('honors default Path and leaves the root key for content', () => {
    const cookies = jar();
    cookies.absorb(cover, 'wr_skey=api-fixture; Secure', now);
    expect(cookies.header(cover, now)).toContain('wr_skey=api-fixture');
    expect(cookies.header(content, now)).toBe(
      'wr_skey=old-fixture; wr_vid=123',
    );
    expect(
      cookies.header('https://weread.qq.com/api/mp-other', now),
    ).not.toContain('api-fixture');
  });

  it('keeps distinct paths and deletes only the matching cookie', () => {
    const cookies = jar();
    cookies.absorb(cover, 'wr_skey=api-fixture; Path=/api; Secure', now);
    cookies.absorb(cover, 'wr_skey=; Path=/api; Secure; Max-Age=0', now);
    expect(cookies.header(cover, now)).toBe('wr_skey=old-fixture; wr_vid=123');
    expect(cookies.header(content, now)).toBe(
      'wr_skey=old-fixture; wr_vid=123',
    );
  });

  it('uses path boundaries instead of string prefixes', () => {
    const cookies = jar();
    cookies.absorb(cover, 'wr_skey=web-fixture; Path=/web; Secure', now);
    expect(cookies.header(content, now)).toContain('wr_skey=web-fixture');
    expect(
      cookies.header('https://weread.qq.com/web-other', now),
    ).not.toContain('web-fixture');
  });

  it('lets valid Max-Age override Expires, in either attribute order', () => {
    for (const attributes of [
      'Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60',
    ]) {
      const cookies = jar();
      cookies.absorb(
        cover,
        `wr_skey=new-fixture; Path=/; Secure; ${attributes}`,
        now,
      );
      expect(cookies.header(content, now + 59000)).toContain('new-fixture');
      expect(() => cookies.header(content, now + 60000)).toThrow(
        'OWNER_WEB_COOKIE_INVALID',
      );
    }
  });

  it.each([
    'Max-Age=0; Expires=Wed, 01 Jan 2098 00:00:00 GMT',
    'Max-Age=-1',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ])('deletes an expired root credential (%s)', (attributes) => {
    const cookies = jar();
    cookies.absorb(
      cover,
      `wr_skey=old-fixture; Path=/; Secure; ${attributes}`,
      now,
    );
    expect(() => cookies.header(content, now)).toThrow(
      'OWNER_WEB_COOKIE_INVALID',
    );
  });

  it('expires saved cookies between requests without a capturedAt age heuristic', () => {
    const input = fixture();
    input.cookies[1].expires = Math.ceil((now + 2000) / 1000);
    const cookies = new OwnerWebCookieLifecycle(input, '123', now);
    expect(cookies.header(cover, now)).toContain('old-fixture');
    expect(() => cookies.header(content, now + 3000)).toThrow(
      'OWNER_WEB_COOKIE_INVALID',
    );
  });

  it.each([
    'wr_vid=other; Path=/; Secure',
    'wr_vid=123; Path=/; Secure; Max-Age=0',
    'wr_vid=; Path=/; Secure',
    'wr_skey=bad; Domain=.qq.com; Path=/; Secure',
    'wr_skey=bad; Domain=evil.invalid; Path=/; Secure',
    'wr_skey=bad; Domain=weread.qq.com.evil.invalid; Path=/; Secure',
    'wr_skey=bad; Path=/',
  ])(
    'rejects owner changes, parent domains and Secure weakening (%s)',
    (header) => {
      const cookies = jar();
      expect(() => cookies.absorb(cover, header, now)).toThrow(
        'OWNER_WEB_COOKIE_INVALID',
      );
      expect(cookies.header(content, now)).toBe(
        'wr_skey=old-fixture; wr_vid=123',
      );
    },
  );

  it('preserves host-only scope and rejects expanding an initial Web path', () => {
    const input = fixture();
    input.cookies = input.cookies.map((c) => ({
      ...c,
      domain: 'weread.qq.com',
      path: '/web',
    }));
    const cookies = new OwnerWebCookieLifecycle(input, '123', now);
    expect(() => cookies.header(cover, now)).toThrow();
    expect(() =>
      cookies.absorb(
        content,
        'wr_skey=new; Domain=weread.qq.com; Path=/web; Secure',
        now,
      ),
    ).toThrow();
    expect(() =>
      cookies.absorb(content, 'wr_skey=new; Path=/; Secure', now),
    ).toThrow();
    cookies.absorb(content, 'wr_skey=new; Path=/web; Secure', now);
    expect(cookies.header(content, now)).toBe('wr_skey=new; wr_vid=123');
  });

  it('keeps non-Secure normal-login evidence but still uses fixed HTTPS', () => {
    const input = fixture();
    input.cookies = input.cookies.map((c) => ({ ...c, secure: false }));
    const cookies = new OwnerWebCookieLifecycle(input, '123', now);
    cookies.absorb(cover, 'wr_skey=new-fixture; Path=/', now);
    expect(cookies.header(content, now)).toContain('new-fixture');
    expect(() =>
      cookies.header('http://weread.qq.com/web/mp/content', now),
    ).toThrow();
  });

  it('ignores unrelated RFC-token cookie names alongside a valid rotation', () => {
    const cookies = jar();
    cookies.absorb(
      cover,
      [
        'XSRF-TOKEN=unrelated-fixture; Domain=qq.com; Path=/',
        '__Host-unrelated=fixture; Path=/; Secure',
        'wr_skey=new-fixture; Path=/; Secure',
      ],
      now,
    );
    expect(cookies.header(content, now)).toBe(
      'wr_skey=new-fixture; wr_vid=123',
    );
  });
  it('does not comma-split Expires dates or accept a combined header', () => {
    const cookies = jar();
    cookies.absorb(
      cover,
      'wr_skey=new-fixture; Path=/; Secure; Expires=Wed, 01 Jan 2098 00:00:00 GMT',
      now,
    );
    expect(cookies.header(content, now)).toContain('new-fixture');
    expect(() =>
      cookies.absorb(cover, 'wr_skey=bad, wr_vid=999; Path=/; Secure', now),
    ).toThrow();
  });
});
