import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import {
  articleVerificationLocation,
  verificationArticleUrl,
} from '../../../packages/shared/src/article-verification';
import {
  ArticleDownloadError,
  buildArticleDownload,
  requestDownloadResource,
} from './article-download';

const article = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
const location = `/mp/wappoc_appmsgcaptcha?action=verify&url=${encodeURIComponent(article)}`;
const expected = `https://mp.weixin.qq.com${location}`;

describe('this response official article-verification Location, offline only', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves the actual relative/absolute official Location and request association', () => {
    expect(articleVerificationLocation(location, article)).toEqual({
      status: 'available',
      articleUrl: article,
      url: expected,
    });
    expect(articleVerificationLocation(expected, article)).toEqual({
      status: 'available',
      articleUrl: article,
      url: expected,
    });
  });

  it('does not invent an address when Location was not retained', () => {
    expect(articleVerificationLocation(undefined, article)).toEqual({
      status: 'unavailable',
      articleUrl: article,
      reason: 'missing-location',
    });
  });

  it.each([
    'http://mp.weixin.qq.com/mp/verify',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://evil.invalid/mp/verify',
    'https://mp.weixin.qq.com.evil.invalid/mp/verify',
    'https://user:fixture@mp.weixin.qq.com/mp/verify',
    'https://@mp.weixin.qq.com/mp/verify',
    'https://mp.weixin.qq.com:8443/mp/verify',
    'https://127.0.0.1/mp/verify',
    'https://mp.weixin.qq.com/mp/verify#ticket',
    '/mp/openredirect?url=https://evil.invalid',
    '/mp/%76erify',
    '/mp/verify?action=verify&action=redirect',
    '/mp/verify?r=https%3A%2F%2Fevil.invalid',
    '/mp/verify?r=%0d%0aheader',
    '/mp/verify?unknown=opaque',
    '/mp/verify?url=https%3A%2F%2F127.0.0.1%2Fx',
    '/mp/verify?url=javascript%3Aalert(1)',
    `/mp/verify?url=${encodeURIComponent(article.replace('abcdef', 'zzzzzz'))}`,
    `/mp/verify?url=${encodeURIComponent(article + '?next=https://evil.invalid')}`,
    '/mp/verify?url=https%253A%252F%252Fmp.weixin.qq.com%252Fmp%252Fredirect%253Fnext%253Dhttps%25253A%25252F%25252Fevil.invalid',
  ])('rejects an unsafe Location without exposing it: %s', (raw) => {
    const result = articleVerificationLocation(raw, article);
    expect(result).toEqual({
      status: 'unavailable',
      articleUrl: article,
      reason: 'unsafe-location',
    });
    expect('url' in result).toBe(false);
  });

  it.each([
    '/mp/verify?key=fixture-private',
    '/mp/verify?pass_ticket=fixture-private',
    '/mp/verify?accessToken=fixture-private',
    '/mp/verify?captcha_ticket=fixture-private',
    '/mp/verify?r=eyJfixture.part.signature',
    `/mp/verify?url=${encodeURIComponent(article + '?wxskey=fixture-private')}`,
  ])(
    'withholds a sensitive address pending the authorized verification process: %s',
    (raw) => {
      expect(articleVerificationLocation(raw, article)).toEqual({
        status: 'unavailable',
        articleUrl: article,
        reason: 'sensitive-location',
      });
    },
  );

  it('uses only public identity fields for the UI article label', () => {
    expect(
      verificationArticleUrl(
        article + '?pass_ticket=fixture-private#wechat_redirect',
      ),
    ).toBe(article);
  });

  it('binds a full article URL using its public identity, including official aliases', () => {
    const full =
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2&mid=123&idx=1&sn=abcd';
    const aliases = full
      .replace('mid=', 'appmsgid=')
      .replace('idx=', 'itemidx=');
    const actual = `/mp/verify?url=${encodeURIComponent(aliases)}`;
    expect(articleVerificationLocation(actual, full)).toEqual({
      status: 'available',
      articleUrl: full,
      url: `https://mp.weixin.qq.com${actual}`,
    });
    expect(
      verificationArticleUrl(aliases + '&pass_ticket=fixture-private'),
    ).toBe(full);
    expect(
      articleVerificationLocation(actual.replace('abcd', 'ffff'), full).status,
    ).toBe('unavailable');
  });

  it.each(['@@@', 'c2VjcmV0', 'MTIzNA=='])(
    'rejects malformed or nonnumeric public publisher identity: %s',
    (biz) => {
      const full = `https://mp.weixin.qq.com/s?__biz=${biz}&mid=123&idx=1&sn=abcd`;
      expect(() => verificationArticleUrl(full)).toThrow();
      expect(articleVerificationLocation('/mp/verify', full).status).toBe(
        'unavailable',
      );
    },
  );

  it('captures an actual mocked transport header privately, without following it or putting it in diagnostics', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      status: 302,
      data: Buffer.alloc(0),
      headers: { location, 'content-type': 'text/html' },
    });
    const response = await requestDownloadResource(article, 5_000_000);
    expect(response.officialVerification).toEqual({
      status: 'available',
      articleUrl: article,
      url: expected,
    });
    expect(JSON.stringify(response)).not.toContain('wappoc_appmsgcaptcha');
    expect(get.mock.calls[0][1]).toMatchObject({
      maxRedirects: 0,
      proxy: false,
    });
    const folder = await mkdtemp(join(tmpdir(), 'wewe-verification-location-'));
    try {
      const request = jest.fn().mockResolvedValue(response);
      const failure = await buildArticleDownload(
        article,
        folder,
        request,
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(ArticleDownloadError);
      expect(failure.officialVerification.url).toBe(expected);
      expect(failure.diagnostic.code).toBe('VERIFICATION_REDIRECT');
      expect(JSON.stringify(failure)).not.toContain('wappoc_appmsgcaptcha');
      expect(request).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(1);
      expect(await readdir(folder)).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
