import { verifySitesWechatCachedBody } from './sites-wechat-cache';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const image = `data:image/png;base64,${png}`;
describe('Sites cached Wechat body, without network or storage', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_NETWORK'));
  });
  afterEach(() => {
    expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  it('reuses the existing inert policy and preserves actual image bytes/order', () => {
    const result = verifySitesWechatCachedBody(
      `<div class="rich_media_content" onclick="bad()"><p>Hello</p><img src="${image}"><img src="${image}"><a href="https://private.invalid">link</a><script>secret()</script><iframe src="https://private.invalid"></iframe></div>`,
    );
    expect(result).toBe(
      `<div id="js_content"><p>Hello</p><img src="${image}"><img src="${image}"><a>link</a></div>`,
    );
  });
  it('accepts a text-only body and refuses content removed by the inert policy', () => {
    expect(
      verifySitesWechatCachedBody('<div id="js_content"><p>text</p></div>'),
    ).toBe('<div id="js_content"><p>text</p></div>');
    expect(() =>
      verifySitesWechatCachedBody(
        '<div id="js_content"><script>only()</script></div>',
      ),
    ).toThrow('CACHE_UNAVAILABLE');
  });
  it.each([
    null,
    '',
    '<p>no body</p>',
    '<div id="js_content"> </div>',
    '<div id="js_verify"></div><div id="js_content">challenge</div>',
    '<form action="/mp/verify"></form><div id="js_content">challenge</div>',
    '<input type="password"><div id="js_content">login</div>',
    '<div id="js_content"><img src="https://mmbiz.qpic.cn/a.png"></div>',
    '<div id="js_content"><img data-src="https://mmbiz.qpic.cn/a.png"></div>',
    '<div id="js_content"><img src="file:///private.png"></div>',
    '<div id="js_content"><img src="data:image/png;base64,YQ=="></div>',
    `<div id="js_content"><img src="data:image/jpeg;base64,${png}"></div>`,
    `<div id="js_content"><img src="data:image/png;base64,${png.slice(0, -8)}"></div>`,
    '<div id="js_content" data-wewe-image-pending="1">partial</div>',
    '<div id="js_content"><p data-wewe-image-pending="1">partial</p></div>',
    '<div id="js_content">partial<img data-wewe-image-unconfirmed="true"></div>',
    '<div id="js_content">text<video src="https://private.invalid/a"></video></div>',
    `<div id="js_content">${`<img src="${image}">`.repeat(61)}</div>`,
  ])('refuses incomplete or unsupported cached HTML (%#)', (html) => {
    expect(() => verifySitesWechatCachedBody(html)).toThrow(
      'CACHE_UNAVAILABLE',
    );
  });
  it('enforces raw and non-image body byte bounds before returning any content', () => {
    expect(() => verifySitesWechatCachedBody('x'.repeat(35_000_001))).toThrow(
      'CACHE_UNAVAILABLE',
    );
    expect(() =>
      verifySitesWechatCachedBody(
        `<div id="js_content">${'x'.repeat(5_000_001)}</div>`,
      ),
    ).toThrow('CACHE_UNAVAILABLE');
  });
});
