import crypto from 'node:crypto';
import {
  RedbookClient,
  RedbookPauseError,
  RedbookRequest,
  RedbookTransport,
} from './redbook-client';
import { buildGetUri, signMainApi } from './redbook-vendor/signing';

const cookies = () => ({
  a1: 'synthetic-a1',
  web_session: 'synthetic-session',
});

describe('Redbook readonly client (synthetic fixtures; no network)', () => {
  it.each([
    ['GET', 'ef36a8deb6a7619d3f0d23d5fc995c21c8ecc5a5f2f16ee169d9bfc5c6bfeccd'],
    [
      'POST',
      '4839e7bc46e56b6fbd363d6ce3800422e14bcf772fda467fc485377f8ddb3396',
    ],
  ] as const)(
    'matches audited upstream %s signing vector after trimming',
    (method, expected) => {
      // Generated offline with v0.8.2 SHA 801a098 using these fixed synthetic inputs.
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.25);
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const bytes = jest
        .spyOn(crypto, 'randomBytes')
        .mockImplementation(((size: number) =>
          Buffer.alloc(size, 7)) as typeof crypto.randomBytes);
      try {
        const headers = signMainApi(
          method,
          '/api/sns/web/v1/feed',
          { a1: 'fixture-a1', web_session: 'fixture-session' },
          { cursor: 'a,b !' },
          { source_note_id: 'fixture-note' },
          1_700_000_000,
        );
        expect(
          crypto
            .createHash('sha256')
            .update(JSON.stringify(headers))
            .digest('hex'),
        ).toBe(expected);
      } finally {
        random.mockRestore();
        now.mockRestore();
        bytes.mockRestore();
      }
    },
  );

  function setup(
    status = 200,
    body: unknown = { success: true, data: { notes: [] } },
  ) {
    const transport = jest.fn(async (request: RedbookRequest) => ({
      status,
      url: request.url,
      body,
    }));
    return { transport, client: new RedbookClient({ transport, cookies }) };
  }

  it('blocks by default and never calls global fetch', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      await expect(
        new RedbookClient().getUserNotes('author'),
      ).rejects.toMatchObject({ reason: 'configuration', paused: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('requests one fixed v2 page with 30 entries and only jpg/webp', async () => {
    const { transport, client } = setup();
    await expect(
      client.getUserNotes('author', 'cursor with,+中文'),
    ).resolves.toEqual({ notes: [] });
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0][0];
    expect(request.url).toBe(
      'https://edith.xiaohongshu.com/api/sns/web/v2/user_posted?num=30&cursor=cursor%20with,%2B%E4%B8%AD%E6%96%87&user_id=author&image_formats=jpg,webp&xsec_token=&xsec_source=',
    );
    expect(request.redirect).toBe('error');
    expect(request.headers['x-s']).toMatch(/^XYS_/);
    expect(request.headers).not.toHaveProperty('X-API-Key');
  });

  it('requests detail once using the exact signed JSON body', async () => {
    const { transport, client } = setup();
    await client.getNoteById('note', 'fixture-token');
    const request = transport.mock.calls[0][0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe(
      'https://edith.xiaohongshu.com/api/sns/web/v1/feed',
    );
    expect(JSON.parse(request.body!)).toEqual({
      source_note_id: 'note',
      image_formats: ['jpg', 'webp'],
      extra: { need_body_topic: 1 },
      xsec_source: 'pc_feed',
      xsec_token: 'fixture-token',
    });
  });

  it.each([406, 404, 401, 403, 429, 461, 471, 500])(
    'pauses on HTTP %s without retry/fallback',
    async (status) => {
      const { transport, client } = setup(status, {
        success: true,
        data: { notes: [] },
        msg: 'private secret',
      });
      await expect(client.getUserNotes('author')).rejects.toBeInstanceOf(
        RedbookPauseError,
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([-100, -101, -104, 300012, 300015, -1])(
    'pauses on API code %s and strips raw evidence',
    async (code) => {
      const { transport, client } = setup(200, {
        success: false,
        code,
        msg: 'private secret',
        data: { secret: 'token' },
      });
      let caught: unknown;
      try {
        await client.getNoteById('note', 'private-token');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RedbookPauseError);
      expect(String(caught)).not.toMatch(/secret|token/);
      expect(caught).not.toHaveProperty('response');
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    [],
    'HTML private secret',
    { success: true },
    { success: 'true', data: {} },
    { success: true, code: -1, data: {} },
  ])('rejects malformed successful envelope %s', async (body) => {
    const { client } = setup(200, body);
    await expect(client.getUserNotes('author')).rejects.toMatchObject({
      reason: 'response',
    });
  });

  it('rejects cross-host results and sanitizes transport exceptions', async () => {
    const transport: RedbookTransport = async () => ({
      status: 200,
      url: 'https://attacker.example/',
      body: { success: true, data: {} },
    });
    await expect(
      new RedbookClient({ transport, cookies }).getUserNotes('author'),
    ).rejects.toMatchObject({ reason: 'transport' });
    await expect(
      new RedbookClient({
        transport: async () => {
          throw Error('cookie=secret');
        },
        cookies,
      }).getUserNotes('author'),
    ).rejects.toThrow('Redbook scan paused: transport');
  });

  it('blocks header injection and missing authentication before transport', async () => {
    const { transport } = setup();
    for (const provider of [
      () => ({ a1: 'fixture' }),
      () => ({ a1: 'fixture', web_session: 'secret\r\nInjected: 1' }),
    ]) {
      await expect(
        new RedbookClient({ transport, cookies: provider }).getUserNotes(
          'author',
        ),
      ).rejects.toMatchObject({ reason: 'authentication' });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('signs locally with explicit timestamp and rejects absent a1', () => {
    const headers = signMainApi(
      'GET',
      '/api/sns/web/v2/user_posted',
      cookies(),
      { cursor: 'a,b !' },
      undefined,
      1_700_000_000,
    );
    expect(headers['x-t']).toBe('1700000000000');
    expect(headers['x-s']).toMatch(/^XYS_/);
    expect(headers['x-s-common']).toBeTruthy();
    expect(headers['x-b3-traceid']).toMatch(/^[a-f0-9]{16}$/);
    expect(buildGetUri('/test', { token: "a!'()*+中文" })).toBe(
      '/test?token=a%21%27%28%29%2A%2B%E4%B8%AD%E6%96%87',
    );
    expect(() => signMainApi('GET', '/test', {})).toThrow("Missing 'a1'");
  });
});
