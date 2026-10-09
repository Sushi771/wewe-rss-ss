/** Only WeChat CDN images can be copied into exports or served by the image proxy. */
const MAX_IMAGE_BYTES = 10_000_000;
const PNG_END = Buffer.from('0000000049454e44ae426082', 'hex');

type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Reject obvious truncation or MIME mismatches; this is not a full image decoder. */
function assertImageContainer(bytes: Buffer, type: string): ImageType {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('IMAGE_RESPONSE_INVALID');
  const valid =
    (type === 'image/png' &&
      bytes.length >= 45 &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
      bytes.subarray(-12).equals(PNG_END)) ||
    (type === 'image/jpeg' &&
      bytes.length >= 64 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.includes(Buffer.from([0xff, 0xda])) &&
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].some((marker) => bytes.includes(Buffer.from([0xff, marker]))) &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9) ||
    (type === 'image/gif' &&
      bytes.length >= 20 &&
      ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) &&
      bytes.includes(0x2c, 13) &&
      bytes[bytes.length - 1] === 0x3b) ||
    (type === 'image/webp' &&
      bytes.length >= 16 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.readUInt32LE(4) === bytes.length - 8 &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(
        bytes.subarray(12, 16).toString('ascii'),
      ));
  if (!valid) throw new Error('IMAGE_RESPONSE_INVALID');
  return type as ImageType;
}

/** Existing SQLite data URIs must pass the same check before an offline export. */
export function decodeInlineImage(raw: string): {
  bytes: Buffer;
  type: ImageType;
} {
  // Match only the fixed-size header: scanning a multi-MB Base64 capture with
  // a greedy regexp can exhaust the V8 regexp stack. The canonical round trip
  // below still rejects whitespace, invalid alphabet and malformed padding.
  const match = raw.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,/);
  if (
    !match ||
    raw.length - match[0].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
  )
    throw new Error('IMAGE_RESPONSE_INVALID');
  const encoded = raw.slice(match[0].length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded)
    throw new Error('IMAGE_RESPONSE_INVALID');
  return { bytes, type: assertImageContainer(bytes, match[1]) };
}

export function allowedImageUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !/(^|\.)(qpic\.cn|qlogo\.cn|qq\.com)$/.test(url.hostname)
  )
    throw new Error('IMAGE_SOURCE_NOT_ALLOWED');
  return url;
}

export async function fetchAllowedImage(
  raw: string,
): Promise<{ bytes: Buffer; type: string }> {
  const url = allowedImageUrl(raw);
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: { referer: 'https://mp.weixin.qq.com/' },
  });
  const type = (response.headers.get('content-type') || '')
    .split(';')[0]
    .toLowerCase();
  if (
    response.status !== 200 ||
    !/^image\/(?:png|jpeg|gif|webp)$/.test(type) ||
    !response.body
  )
    throw new Error('IMAGE_RESPONSE_INVALID');
  let length = 0;
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error('IMAGE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, type: assertImageContainer(bytes, type) };
}
