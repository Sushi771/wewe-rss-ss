import {
  allowedImageUrl,
  decodeInlineImage,
  fetchAllowedImage,
} from './image-fetch';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);

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
      new Response(png, {
        headers: { 'content-type': 'image/png' },
      }),
    );
    const image = await fetchAllowedImage('https://mmbiz.qpic.cn/photo');
    expect(image.type).toBe('image/png');
    expect(image.bytes).toEqual(png);
  });

  it('rejects a partial response, a false MIME type, and a cut-off image', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    fetchMock.mockResolvedValueOnce(
      new Response(png, {
        status: 206,
        headers: { 'content-type': 'image/png' },
      }),
    );
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/photo'),
    ).rejects.toThrow('IMAGE_RESPONSE_INVALID');
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from('not an image'), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/photo'),
    ).rejects.toThrow('IMAGE_RESPONSE_INVALID');
    fetchMock.mockResolvedValueOnce(
      new Response(png.subarray(0, -12), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/photo'),
    ).rejects.toThrow('IMAGE_RESPONSE_INVALID');
  });

  it('validates cached data URIs before an offline export', () => {
    expect(
      decodeInlineImage(`data:image/png;base64,${png.toString('base64')}`),
    ).toEqual({
      bytes: png,
      type: 'image/png',
    });
    expect(() =>
      decodeInlineImage(
        `data:image/png;base64,${png.subarray(0, -12).toString('base64')}`,
      ),
    ).toThrow('IMAGE_RESPONSE_INVALID');
    expect(() =>
      decodeInlineImage(`data:image/jpeg;base64,${png.toString('base64')}`),
    ).toThrow('IMAGE_RESPONSE_INVALID');
  });

  it('accepts valid JPEG, GIF, and WebP containers', () => {
    const examples = [
      [
        'image/jpeg',
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z',
      ],
      [
        'image/gif',
        'R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==',
      ],
      [
        'image/webp',
        'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
      ],
    ] as const;
    for (const [type, base64] of examples) {
      expect(decodeInlineImage(`data:${type};base64,${base64}`).bytes).toEqual(
        Buffer.from(base64, 'base64'),
      );
    }
  });
});
