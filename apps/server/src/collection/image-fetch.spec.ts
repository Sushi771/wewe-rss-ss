import { allowedImageUrl, fetchAllowedImage } from './image-fetch';

describe('archived image fetch boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects local destinations and redirect responses', async () => {
    expect(() => allowedImageUrl('http://127.0.0.1/private')).toThrow(
      'IMAGE_SOURCE_NOT_ALLOWED',
    );
    expect(() => allowedImageUrl('https://example.com/image.png')).toThrow(
      'IMAGE_SOURCE_NOT_ALLOWED',
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 302 }));
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/photo'),
    ).rejects.toThrow('IMAGE_RESPONSE_INVALID');
  });

  it('accepts a bounded image from the WeChat CDN', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    const image = await fetchAllowedImage('https://mmbiz.qpic.cn/photo');
    expect(image.type).toBe('image/png');
    expect(image.bytes).toEqual(Buffer.from([137, 80, 78, 71]));
  });
});
