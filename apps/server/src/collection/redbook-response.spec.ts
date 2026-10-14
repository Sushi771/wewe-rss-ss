import {
  allowedRedbookMediaUrl,
  mapRedbookDetail,
  mapRedbookPage,
  RedbookMediaTransport,
} from './redbook-response';
import { xhsArchiveDraft } from './xiaohongshu-contract';

// Invented response shapes and real tiny PNG bytes; NOT captured platform data.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const url = 'https://sns-webpic-qc.xhscdn.com/synthetic-image';
function detail(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: 'synthetic-note',
        note_card: {
          note_id: 'synthetic-note',
          user: { user_id: 'synthetic-author' },
          type: 'normal',
          time: 1700000000123,
          title: 'Synthetic title',
          desc: 'Synthetic full text\nSecond paragraph',
          image_list: [{ url_default: url }, { url_default: `${url}-2` }],
          ...overrides,
        },
      },
    ],
  };
}
function imageTransport() {
  return jest.fn<
    ReturnType<RedbookMediaTransport>,
    Parameters<RedbookMediaTransport>
  >(
    async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
  );
}
const map = (raw: unknown, transport?: RedbookMediaTransport) =>
  mapRedbookDetail(raw, 'synthetic-author', 'synthetic-note', transport);

describe('redbook provisional response/media contract (offline only)', () => {
  let network: jest.SpyInstance;
  beforeEach(() => {
    network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });

  it('maps a bounded list and keeps request tokens ephemeral', () => {
    expect(
      mapRedbookPage(
        {
          notes: [
            {
              note_id: 'n1',
              user: { user_id: 'a1' },
              xsec_token: 'synthetic-token',
            },
          ],
          cursor: 'c1',
          has_more: true,
        },
        'a1',
      ),
    ).toEqual({
      notes: [{ noteId: 'n1', authorId: 'a1', xsecToken: 'synthetic-token' }],
      nextCursor: 'c1',
      hasMore: true,
    });
    expect(
      mapRedbookPage({ notes: [], cursor: '', has_more: false }, 'a1')
        .nextCursor,
    ).toBeNull();
  });

  it.each([
    { notes: [], cursor: '', has_more: true },
    { notes: [], cursor: 'c', has_more: 'true' },
    { notes: Array(31).fill({}), cursor: '', has_more: false },
    {
      notes: [{ note_id: 'n', user: { user_id: 'other' }, xsec_token: 't' }],
      cursor: '',
      has_more: false,
    },
    {
      notes: [{ note_id: 'n', user: { user_id: 'a1' }, xsec_token: '' }],
      cursor: '',
      has_more: false,
    },
  ])('rejects uncertain/malformed list without fallback', (raw) => {
    expect(() => mapRedbookPage(raw, 'a1')).toThrow();
  });

  it('archives actual image bytes in declared order without marking real verification', async () => {
    const transport = imageTransport();
    const candidate = await map(detail(), transport);
    expect(candidate.expectedImageCount).toBe(2);
    expect(candidate.publishedAt).toBe(1700000000);
    expect(candidate.images.map((image) => image.ordinal)).toEqual([1, 2]);
    const draft = xhsArchiveDraft('synthetic-author', candidate);
    expect(draft.verified).toBe(false);
    expect(draft.status).toBe('candidate');
    if (draft.status === 'candidate') {
      expect(draft.readyForEvidenceCheck).toBe(true);
      expect(draft.images[0].bytes).toEqual(png);
      expect(draft.images[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(transport.mock.calls.map(([request]) => request.href)).toEqual([
      url,
      `${url}-2`,
    ]);
    for (const [, options] of transport.mock.calls) {
      expect(options.redirect).toBe('manual');
      expect(options.credentials).toBe('omit');
      expect(Object.keys(options.headers)).toEqual(['accept']);
    }
  });

  it('has no ambient/default network access and redacts transport errors', async () => {
    await expect(map(detail())).rejects.toThrow('REDBOOK_MEDIA_REQUEST_FAILED');
    await expect(
      map(detail(), async () => {
        throw new Error('Cookie=secret https://signed-url');
      }),
    ).rejects.toThrow('REDBOOK_MEDIA_REQUEST_FAILED');
  });

  it.each([
    { note_id: 'wrong' },
    { user: { user_id: 'wrong' } },
    { type: 'video' },
    { time: '1700000000000' },
    { time: 1700000000 },
    { time: 1 },
    { time: Date.now() + 10 * 60_000 },
    { desc: null },
    { image_list: [{ info_list: [{ url }] }] },
    { image_list: Array(61).fill({ url_default: url }) },
    {
      image_list: [
        { url_default: url },
        { url_default: 'https://evil.example/image' },
      ],
    },
  ])('rejects uncertain detail before media calls', async (overrides) => {
    const transport = imageTransport();
    await expect(map(detail(overrides), transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    'http://sns-webpic-qc.xhscdn.com/a',
    'https://sns-webpic-qc.xhscdn.com:8080/a',
    'https://sns-webpic-qc.xhscdn.com:443/a',
    'https://user:password@sns-webpic-qc.xhscdn.com/a',
    'https://sns-webpic-qc.xhscdn.com.evil.test/a',
    'https://evil.sns-webpic-qc.xhscdn.com/a',
    'https://127.0.0.1/a',
    'https://sns-webpic-qc.xhscdn.com/a#secret',
    'not-a-url',
  ])('rejects unreviewed media destination %s', (raw) => {
    expect(() => allowedRedbookMediaUrl(raw)).toThrow(
      'REDBOOK_MEDIA_SOURCE_REJECTED',
    );
  });

  it.each([301, 401, 403, 406, 429, 500])(
    'stops at first media HTTP %s without retry',
    async (status) => {
      const transport = jest.fn(
        async () => new Response('synthetic', { status }),
      );
      await expect(map(detail(), transport)).rejects.toThrow(
        'REDBOOK_MEDIA_RESPONSE_REJECTED',
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects AVIF and fake PNG bytes without changing extensions/MIME', async () => {
    await expect(
      map(
        detail(),
        async () =>
          new Response(png, { headers: { 'content-type': 'image/avif' } }),
      ),
    ).rejects.toThrow('REDBOOK_MEDIA_RESPONSE_REJECTED');
    await expect(
      map(
        detail(),
        async () =>
          new Response('not PNG', { headers: { 'content-type': 'image/png' } }),
      ),
    ).rejects.toThrow('IMAGE_RESPONSE_INVALID');
  });

  it('rejects a transport that followed a redirect, even to another allowed host', async () => {
    const response = new Response(png, {
      headers: { 'content-type': 'image/png' },
    });
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', {
      value: 'https://sns-webpic.xhscdn.com/redirected',
    });
    const transport = jest.fn(async () => response);
    await expect(map(detail(), transport)).rejects.toThrow(
      'REDBOOK_MEDIA_RESPONSE_REJECTED',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('stops oversized streams before archive construction', async () => {
    const transport = jest.fn(
      async () =>
        new Response(Buffer.alloc(10_000_001), {
          headers: { 'content-type': 'image/png' },
        }),
    );
    await expect(map(detail(), transport)).rejects.toThrow(
      'REDBOOK_MEDIA_BUDGET_EXCEEDED',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('enforces aggregate 20 MB even when each image fits its 10 MB bound', async () => {
    const paddedPng = Buffer.concat([
      png.subarray(0, -12),
      Buffer.alloc(8_000_000 - png.length),
      png.subarray(-12),
    ]);
    const transport = jest.fn(
      async () =>
        new Response(paddedPng, { headers: { 'content-type': 'image/png' } }),
    );
    await expect(
      map(
        detail({ image_list: Array(3).fill({ url_default: url }) }),
        transport,
      ),
    ).rejects.toThrow('REDBOOK_MEDIA_BUDGET_EXCEEDED');
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
