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
  it('reads CGI object scalar identity and original time without executing page script', () => {
    const cgi =
      "window.cgiDataNew={bizuin:'Mzg5NTQzMTQxMg==',mid:'2247493540',idx:'2',sn:'abcdef',ori_create_time:'1790400091',nested:{caption:'safe'}};";
    const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/short"><div id="js_content">正文</div><script>${cgi}</script>`;
    expect(articleIdentity(html)).toMatchObject({
      id: 'WX_3895431412_2247493540_2',
      mpId: 'MP_WXS_3895431412',
      publishTime: 1790400091,
    });
    expect(articlePublishTime(html)).toBe(1790400091);
    expect(() =>
      articleIdentity(
        html.replace("mid:'2247493540',", "mid:'2247493540',mid:'9',"),
      ),
    ).toThrow();
    expect(() =>
      articleIdentity(html.replace(cgi, `var mid="9";${cgi}`)),
    ).toThrow('身份字段冲突');
    expect(() =>
      articleIdentity(
        html.replace("mid:'2247493540',", '') +
          "<script>window.unrelated={mid:'2247493540'}</script>",
      ),
    ).toThrow('未取得原文 biz/mid/idx');
    expect(
      articlePublishTime(html.replace(cgi, `var ct=1790400092;${cgi}`)),
    ).toBeNull();
  });
  it('rejects conflicting repeated page identity variables', () => {
    const html =
      '<div id="js_content">正文</div><script>var biz="Mzg5NTQzMTQxMg==";var mid="2247493540";var idx="2";var sn="abcdef";</script>';
    expect(
      articleIdentity(`${html}<script>var sn="abcdef";</script>`),
    ).toMatchObject({
      id: 'WX_3895431412_2247493540_2',
    });
    expect(() =>
      articleIdentity(`${html}<script>var sn="fedcba";</script>`),
    ).toThrow('原文身份字段冲突');
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

  it.each([
    '<script>notAnArticle()</script>',
    '<iframe src="https://example.test/embed"></iframe>',
    '<img src="https://example.test/tracker"><img>',
    '<p>&nbsp;\u200b</p>',
  ])('does not count sanitized empty content as a body: %s', (body) => {
    expect(
      articleContentHtml(`<div id="js_content">${body}</div>`),
    ).toBeUndefined();
  });

  it('keeps an allowed image-only body', () => {
    expect(
      articleContentHtml(
        '<div id="js_content"><img data-src="https://mmbiz.qpic.cn/image.jpg"></div>',
      ),
    ).toContain('src="https://mmbiz.qpic.cn/image.jpg"');
  });
});
