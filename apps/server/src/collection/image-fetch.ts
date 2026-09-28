/** Only WeChat CDN images can be copied into exports or served by the image proxy. */
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
    if (length > 10_000_000) {
      await reader.cancel();
      throw new Error('IMAGE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks), type };
}
