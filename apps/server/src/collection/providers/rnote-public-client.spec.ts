import { RnotePublicClient, RnoteReadError } from './rnote-public-client';
import { RnotePublicCandidate } from './rnote-public-candidate';

const user = 'a'.repeat(24),
  note = 'b'.repeat(24);
const key = 'synthetic-private-key';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const envelope = (data: unknown) => ({
  success: true,
  billed: true,
  data,
  debug_info: 'synthetic-private-diagnostic',
});
describe('documented Rnote candidate transport (synthetic fetch only)', () => {
  let realNetwork: jest.SpyInstance;
  beforeEach(() => {
    realNetwork = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    try {
      expect(realNetwork).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });
  const client = (read: typeof fetch, apiKey: string | undefined = key) =>
    new RnotePublicClient({ baseUrl: 'http://127.0.0.1:12345/', apiKey }, read);

  it('never requests without a Key and has no implicit hosted address', async () => {
    const read = jest.fn();
    await expect(client(read, '').posted(user)).rejects.toMatchObject({
      code: 'RNOTE_KEY_MISSING',
    });
    expect(read).not.toHaveBeenCalled();
    expect(
      () => new RnotePublicClient({ baseUrl: '', apiKey: key }, read),
    ).toThrow('RNOTE_BASE_URL_INVALID');
  });
  it.each([
    'https://evil.example/',
    'http://rnote.dev/',
    'http://127.1/',
    'http://@127.0.0.1/',
    'http://127.0.0.1/?key=secret',
    'http://127.0.0.1/private/',
    'ftp://127.0.0.1/',
    'http://127.0.0.1/#',
  ])('rejects unreviewed/repaired or credential-bearing base %s', (baseUrl) => {
    expect(
      () => new RnotePublicClient({ baseUrl, apiKey: key }, jest.fn()),
    ).toThrow('RNOTE_BASE_URL_INVALID');
  });
  it('requires explicit public host choice and sends the key only in a header', async () => {
    const read = jest
      .fn()
      .mockResolvedValue(
        json(envelope({ data: { notes: [], has_more: false, unknown: 1 } })),
      );
    const api = new RnotePublicClient(
      { baseUrl: 'https://rnote.dev/', apiKey: key },
      read,
    );
    const result = await api.posted(user, 'opaque/+ cursor', 3);
    const [url, opts] = read.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/api/v2/crawler/user/posted');
    expect(new URL(String(url)).searchParams.get('cursor')).toBe(
      'opaque/+ cursor',
    );
    expect(new URL(String(url)).searchParams.get('num')).toBe('3');
    expect(String(url)).not.toContain(key);
    expect(opts).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { 'X-API-Key': key },
    });
    expect(result).toMatchObject({
      evidenceVerified: false,
      productCompatibilityVerified: false,
      data: { data: { unknown: 1 } },
    });
    expect(JSON.stringify(result)).not.toContain(
      'synthetic-private-diagnostic',
    );
  });
  it.each(['image', 'video'] as const)(
    'uses only the requested detail endpoint %s',
    async (kind) => {
      const read = jest
        .fn()
        .mockResolvedValue(json(envelope({ data: [{ unknown: 'kept' }] })));
      await client(read)[kind](note);
      expect(read).toHaveBeenCalledTimes(1);
      expect(new URL(String(read.mock.calls[0][0])).pathname).toBe(
        '/api/v2/crawler/note/' + kind,
      );
    },
  );
  it('sends distinct PGY JSON requests with the OpenAPI page_size limit', async () => {
    const read = jest
      .fn()
      .mockImplementation(async () => json(envelope({ data: {} })));
    const api = client(read);
    await api.pgyNotes(user, 2, 8, 'notes_v2');
    await api.pgyDetail(note);
    expect(new URL(String(read.mock.calls[0][0])).pathname).toBe(
      '/api/v2/pgy/blogger/notes_v2',
    );
    expect(read.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ user_id: user, page_number: 2, page_size: 8 }),
    });
    expect(() => api.pgyNotes(user, 1, 20)).toThrow('RNOTE_PARAMETER_INVALID');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each([401, 402, 403, 429, 503])(
    'stops HTTP %s without fallback/retry or private messages',
    async (status) => {
      const read = jest
        .fn()
        .mockImplementation(async () =>
          json({ success: false, retry_after: 7, error: key }, status),
        );
      await expect(client(read).posted(user)).rejects.toMatchObject({ status });
      expect(read).toHaveBeenCalledTimes(1);
      try {
        await client(read).posted(user);
      } catch (e) {
        expect(String(e)).not.toContain(key);
        if (status === 429 || status === 503)
          expect((e as RnoteReadError).retryAfter).toBe(7);
      }
      expect(read).toHaveBeenCalledTimes(2); // Separate explicit call, never an automatic retry.
    },
  );
  it('rejects 302 without following Location or forwarding credentials', async () => {
    const read = jest.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'https://evil.example/' },
      }),
    );
    await expect(client(read).image(note)).rejects.toMatchObject({
      code: 'RNOTE_REDIRECT_REJECTED',
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][1].redirect).toBe('manual');
  });
  it.each([
    { success: false, retry_after: 3, error: key },
    { success: 'true', data: {} },
    { success: true, data: null },
    { success: true, data: {}, billed: 'yes' },
  ])(
    'rejects invalid/unsuccessful envelopes without using error text: %j',
    async (body) => {
      const read = jest.fn().mockResolvedValue(json(body));
      await expect(client(read).posted(user)).rejects.toBeInstanceOf(
        RnoteReadError,
      );
      expect(read).toHaveBeenCalledTimes(1);
    },
  );
  it('redacts transport exceptions and rejects bounded oversized bodies', async () => {
    const read = jest
      .fn()
      .mockRejectedValue(new Error(key + ' https://private.invalid/'));
    await expect(client(read).image(note)).rejects.toMatchObject({
      message: 'RNOTE_REQUEST_FAILED',
    });
    const large = jest
      .fn()
      .mockResolvedValue(json(envelope({ text: 'x'.repeat(4_000_001) })));
    await expect(client(large).image(note)).rejects.toMatchObject({
      code: 'RNOTE_RESPONSE_TOO_LARGE',
    });
  });
  it('checks nested posted structure but does not guess cursor/time/media mappings', async () => {
    const payload = {
      notes: [{ id: note, opaque: { kept: true } }],
      has_more: true,
      cursor_other: 'opaque',
    };
    const read = jest.fn().mockResolvedValue(json(envelope({ data: payload })));
    const result = await new RnotePublicCandidate(client(read)).creator(user);
    expect(result).toMatchObject({
      noteIds: [note],
      hasMore: true,
      cursorMappingVerified: false,
      evidenceVerified: false,
    });
    expect(result.data.data).toEqual(payload);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('rejects stringified paging booleans and malformed detail arrays', async () => {
    const read = jest
      .fn()
      .mockImplementation(async () =>
        json(envelope({ data: { notes: [], has_more: 'false' } })),
      );
    const api = new RnotePublicCandidate(client(read));
    await expect(api.creator(user)).rejects.toMatchObject({
      code: 'RNOTE_LIST_SHAPE_UNVERIFIED',
    });
    await expect(api.note(note, 'image')).rejects.toMatchObject({
      code: 'RNOTE_DETAIL_SHAPE_UNVERIFIED',
    });
  });
  it('binds PGY detail ID while retaining original timestamp without guessing seconds/milliseconds', async () => {
    const payload = {
      noteId: note,
      userId: user,
      title: 'synthetic',
      content: 'synthetic body',
      createTime: 1700000000000,
      imagesList: [],
      opaque: 1,
    };
    const read = jest
      .fn()
      .mockImplementation(async () => json(envelope({ data: payload })));
    const result = await new RnotePublicCandidate(client(read)).pgyNote(note);
    expect(result).toMatchObject({
      publicationUnitVerified: false,
      mediaBytesVerified: false,
    });
    expect(result.data.data).toEqual(payload);
    payload.noteId = 'c'.repeat(24);
    await expect(
      new RnotePublicCandidate(client(read)).pgyNote(note),
    ).rejects.toMatchObject({ code: 'RNOTE_DETAIL_SHAPE_UNVERIFIED' });
  });
  it('keeps PGY notes and notes_v2 contracts separate without automatic endpoint fallback', async () => {
    const read = jest
      .fn()
      .mockImplementation(async () =>
        json(envelope({ data: { list: [{ noteId: note }], total: 1 } })),
      );
    const api = new RnotePublicCandidate(client(read));
    expect((await api.pgyCreator(user)).noteIds).toEqual([note]);
    await expect(api.pgyCreator(user, 1, 3, 'notes_v2')).rejects.toMatchObject({
      code: 'RNOTE_LIST_SHAPE_UNVERIFIED',
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
