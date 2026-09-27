import {
  articlePublishTime,
  articleContentHtml,
  articleIdentity,
} from './article-page';

describe('article publication evidence', () => {
  it('extracts canonical article identity from a real body and explicit page variables', () => {
    const html =
      '<meta property="og:url" content="https://mp.weixin.qq.com/s/short"><div id="js_content">正文</div><script>var biz="Mzg5NTQzMTQxMg==";var mid="2247493540";var idx="2";var sn="abcdef";var ct=1790400091;</script>';
    expect(articleIdentity(html)).toMatchObject({
      id: 'WX_3895431412_2247493540_2',
      mpId: 'MP_WXS_3895431412',
      canonical: 'https://mp.weixin.qq.com/s/short',
      publishTime: 1790400091,
    });
    expect(() =>
      articleIdentity(html.replace('id="js_content"', 'id="verification"')),
    ).toThrow();
    expect(() =>
      articleIdentity(html.replace('var mid="2247493540";', '')),
    ).toThrow();
  });
  it('requires an article body rather than a timestamp in a verification page', () => {
    expect(
      articlePublishTime('<script>var ct = 1787013185;</script><p>请验证</p>'),
    ).toBeNull();
    expect(
      articlePublishTime(
        '<div id="js_content">正文</div><script>var ct = 1787013185;</script>',
      ),
    ).toBe(1787013185);
  });

  it('does not accept milliseconds, future dates, or cover updateTime', () => {
    for (const field of [
      'ct=1787013185000',
      'ct=9999999999',
      'updateTime=1787013185',
    ]) {
      expect(
        articlePublishTime(
          `<div class="rich_media_content">正文</div><script>${field}</script>`,
        ),
      ).toBeNull();
    }
  });

  it('caches only safe body HTML and authorized image hosts, preserving body text', () => {
    const html = articleContentHtml(
      '<div id="js_content"><p onclick="bad()">正文</p><script>bad()</script><iframe src="https://evil.test"></iframe><a href="javascript:bad()">链接</a><img data-src="https://mmbiz.qpic.cn/photo.jpg"><img src="https://evil.test/pixel"><img src="https://secret@qpic.cn/pixel"></div>',
    );
    expect(html).toContain('正文');
    expect(html).toContain('src="https://mmbiz.qpic.cn/photo.jpg"');
    expect(html).not.toMatch(/onclick|script|iframe|evil|secret|data-src/);
    expect(articleContentHtml('<p>请验证</p>')).toBeUndefined();
  });
});
