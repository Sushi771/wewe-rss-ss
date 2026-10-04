import { canonicalArticleUrl } from './collection-format';
import { assertProviderPage, ProviderPage } from './subscription-provider';

const mpId = 'MP_WXS_3895431412';
const article = (mid: number) => ({
  ...canonicalArticleUrl(
    `https://mp.weixin.qq.com/s?__biz=${Buffer.from('3895431412').toString('base64')}&mid=${mid}&idx=1`,
  ),
  title: `文章 ${mid}`,
  publishTime: 1700000000,
  contentHtml: null,
  picUrl: '',
});
const page = (): ProviderPage => ({
  articles: [article(1), article(2)],
  coverage: 'recent-window',
  upstreamCount: 2,
  bodyMissing: 2,
  imageBlocked: 0,
});

describe('subscription provider write boundary', () => {
  it('accepts a well-formed page without claiming it proves upstream publication time', () => {
    const input = page();
    expect(assertProviderPage(input, mpId)).toBe(input);
  });

  it('preserves the legacy null representation of an absent short link', () => {
    const input = page();
    input.articles[0].shortUrl = null;
    expect(assertProviderPage(input, mpId)).toBe(input);
  });

  it('rejects a malformed supplied short link while accepting a validated one', () => {
    const input = page();
    input.articles[0].shortUrl = `https://mp.weixin.qq.com/s/${'a'.repeat(22)}`;
    expect(assertProviderPage(input, mpId)).toBe(input);
    for (const url of [
      `http://mp.weixin.qq.com/s/${'a'.repeat(22)}`,
      `https://example.com/s/${'a'.repeat(22)}`,
      'https://mp.weixin.qq.com/s/invalid',
    ]) {
      input.articles[0].shortUrl = url;
      expect(() => assertProviderPage(input, mpId)).toThrow(
        'PROVIDER_ARTICLE_IDENTITY_INVALID',
      );
    }
  });

  it('rejects a cross-feed or conflicting identity before article writes', () => {
    const wrongFeed = page();
    wrongFeed.articles[1].mpId = 'MP_WXS_1000000000';
    expect(() => assertProviderPage(wrongFeed, mpId)).toThrow(
      'PROVIDER_ARTICLE_IDENTITY_INVALID',
    );
    const wrongId = page();
    wrongId.articles[1].id = wrongId.articles[0].id;
    expect(() => assertProviderPage(wrongId, mpId)).toThrow(
      'PROVIDER_ARTICLE_IDENTITY_INVALID',
    );
    const duplicate = page();
    duplicate.articles[1] = { ...duplicate.articles[0] };
    expect(() => assertProviderPage(duplicate, mpId)).toThrow(
      'PROVIDER_ARTICLE_IDENTITY_INVALID',
    );
  });

  it('rejects an invalid publication time and inconsistent page counts', () => {
    const badTime = page();
    badTime.articles[0].publishTime = 0;
    expect(() => assertProviderPage(badTime, mpId)).toThrow(
      'PROVIDER_ARTICLE_METADATA_INVALID',
    );
    const badCount = page();
    badCount.upstreamCount = 1;
    expect(() => assertProviderPage(badCount, mpId)).toThrow(
      'PROVIDER_PAGE_INVALID',
    );
  });

  it('requires the provider boundary to receive a canonical HTTPS article URL', () => {
    for (const rawUrl of [
      page().articles[0].url.replace('https:', 'http:'),
      `${page().articles[0].url}&tracking=extra`,
    ]) {
      const input = page();
      input.articles[0].url = rawUrl;
      expect(() => assertProviderPage(input, mpId)).toThrow(
        'PROVIDER_ARTICLE_IDENTITY_INVALID',
      );
    }
  });
});
