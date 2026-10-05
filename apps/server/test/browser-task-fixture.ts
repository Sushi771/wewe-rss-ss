import { browserBodyFingerprint } from '../src/browser-task';
export const short = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
export const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
export const config = {
  enabled: true,
  routeVerified: true,
  pairingKey: 'k'.repeat(43),
  extensionOrigin: 'chrome-extension://' + 'a'.repeat(32),
  localOrigin: 'http://127.0.0.1:11207',
};
export const binding = {
  tabId: 4,
  windowId: 2,
  pageUrl: 'https://weread.qq.com/web/mp/reader/fixture',
};
export function observation() {
  const html = `<meta property="og:url" content="${short}"><h1 id="activity-name">离线新文章</h1><span id="js_name">测试公众号</span><script>var biz="MTIzNDU2Nzg5MA==";var mid="2247000001";var idx="1";var sn="abcd";var ct="1700000000";</script><div id="js_content"><p>完整正文开头</p><p>末尾完整内容</p><img src="wewe-image:0"></div>`;
  return {
    pageUrl: binding.pageUrl,
    html,
    images: [{ index: 0, inline: 'data:image/png;base64,' + png }],
    projection: {
      bookId: 'MP_WXS_1234567890',
      current: {
        reviewId: 'MP_WXS_1234567890_abcdefghijklmnopqrstuv',
        review: {
          reviewId: 'MP_WXS_1234567890_abcdefghijklmnopqrstuv',
          belongBookId: 'MP_WXS_1234567890',
          bookId: '',
          type: 16,
          mpInfo: {
            originalId: 'abcdefghijklmnopqrstuv',
            title: '离线新文章',
            mp_name: '测试公众号',
            time: 1700000008,
            pic_url: '',
          },
        },
      },
      bodyFingerprint: browserBodyFingerprint(html),
    },
  };
}
