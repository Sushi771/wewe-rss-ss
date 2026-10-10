import { browserBodyFingerprint } from '../src/browser-task';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** Actual valid PNG with incompressible synthetic RGB bytes, under 10MB;
 * its JSON data URI crosses the original application's 10MiB parser limit. */
export function largeSyntheticPng() {
  const width = 2100,
    height = 1300,
    row = width * 3 + 1;
  const pixels = randomBytes(row * height);
  for (let y = 0; y < height; y++) pixels[y * row] = 0;
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const content = Buffer.concat([Buffer.from(name), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(content));
    return Buffer.concat([header, content, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
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
