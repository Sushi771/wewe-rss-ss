import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fetchOwnerSearchPage,
  ownerSessionCookie,
  OwnerWebSession,
} from './owner-web-search';
jest.mock('axios');
const session: OwnerWebSession = {
  source: 'owner-confirmed-dedicated-web-login',
  capturedAt: new Date().toISOString(),
  ownerVid: '123',
  cookies: [
    {
      name: 'wr_vid',
      value: '123',
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    },
    {
      name: 'wr_skey',
      value: 'fixture-only',
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    },
  ],
};
describe('backend normal Web session (all HTTP mocked)', () => {
  let dir: string;
  const config = () => ({
    sessionFile: path.join(dir, 'session.json'),
    stateFile: path.join(dir, 'state.json'),
    ownerVid: '123',
    name: '测试号',
    biz: 'MTIzNDU2Nzg5MA==',
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-owner-search-'));
    await fs.writeFile(config().sessionFile, JSON.stringify(session));
    jest.clearAllMocks();
    const realTimeout = global.setTimeout;
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback) =>
        realTimeout(callback, 0)) as typeof setTimeout);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('uses saved normal cookies, carries no browser dependency, bounds coverage and permits a later fresh update', async () => {
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: JSON.stringify({
        ret: -1,
        content: { ret: 0, data: [], continueFlag: 1 },
      }),
    });
    const page = await fetchOwnerSearchPage(config());
    expect(page).toMatchObject({
      requests: 1,
      pages: 1,
      truncated: true,
      complete: false,
      coverage: 'search-results',
      termination: 'page_budget',
    });
    expect((axios.post as jest.Mock).mock.calls[0][1]).toEqual({
      query: '测试号',
      offset: 0,
      searchcookies: '',
    });
    expect((axios.post as jest.Mock).mock.calls[0][2]).toMatchObject({
      proxy: false,
      maxRedirects: 0,
      headers: { Cookie: ownerSessionCookie(session, '123') },
    });
    await expect(fetchOwnerSearchPage(config())).rejects.toThrow('cooldown');
    expect(axios.post).toHaveBeenCalledTimes(1);
    const state = JSON.parse(await fs.readFile(config().stateFile, 'utf8'));
    state.lastAttemptAt = Date.now() - 16 * 60 * 1000;
    await fs.writeFile(config().stateFile, JSON.stringify(state));
    await fetchOwnerSearchPage(config());
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect((axios.post as jest.Mock).mock.calls[1][1].offset).toBe(0);
  });
  it.each([
    [401, '{}', 'auth_or_access_rejected'],
    [200, '{"errCode":-2012}', 'auth_expired'],
    [200, '<title>验证码</title>', 'challenge_or_rate_limit'],
    [429, '{}', 'rate_limit'],
  ])(
    'persists stop without retries or automatic renewal (%s)',
    async (status, data, reason) => {
      (axios.post as jest.Mock).mockResolvedValue({ status, data });
      await expect(fetchOwnerSearchPage(config())).rejects.toThrow(reason);
      const state = JSON.parse(await fs.readFile(config().stateFile, 'utf8'));
      state.lastAttemptAt = Date.now() - 16 * 60 * 1000;
      await fs.writeFile(config().stateFile, JSON.stringify(state));
      await expect(fetchOwnerSearchPage(config())).rejects.toThrow(reason);
      expect(axios.post).toHaveBeenCalledTimes(1);
    },
  );
  it('does not treat a same-account mobile mps1 credential as an OwnerWebSession', async () => {
    const mobile = {
      source: 'owner-confirmed-mobile-login',
      capturedAt: session.capturedAt,
      ownerVid: session.ownerVid,
      vid: session.ownerVid,
      skey: 'mps1-offline-fixture',
    };
    expect(() =>
      ownerSessionCookie(mobile as unknown as OwnerWebSession, '123'),
    ).toThrow('OWNER_WEB_SESSION_INVALID');
    await fs.writeFile(config().sessionFile, JSON.stringify(mobile));
    await expect(fetchOwnerSearchPage(config())).rejects.toThrow(
      'OWNER_WEB_SESSION_INVALID',
    );
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('accepts an old capturedAt structurally but still stops on mock upstream auth rejection', async () => {
    const web = {
      ...session,
      capturedAt: '2020-01-01T00:00:00.000Z',
    };
    expect(ownerSessionCookie(web, '123')).toContain('wr_skey=fixture-only');
    await fs.writeFile(config().sessionFile, JSON.stringify(web));
    (axios.post as jest.Mock).mockResolvedValueOnce({
      status: 401,
      data: '{}',
    });
    await expect(fetchOwnerSearchPage(config())).rejects.toThrow(
      'auth_or_access_rejected',
    );
    await expect(fetchOwnerSearchPage(config())).rejects.toThrow(
      'auth_or_access_rejected',
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong owner, expiry and non-authentication signatures before HTTP', () => {
    expect(() => ownerSessionCookie(session, 'other')).toThrow();
    expect(() =>
      ownerSessionCookie(
        {
          ...session,
          cookies: session.cookies.map((c) => ({ ...c, expires: 1 })),
        },
        '123',
      ),
    ).toThrow();
    expect(() =>
      ownerSessionCookie(
        {
          ...session,
          cookies: [
            ...session.cookies,
            { ...session.cookies[0], name: 'x-wr-ticket' },
          ],
        },
        '123',
      ),
    ).toThrow();
  });

  const item = (mid: number, title = `文章${mid}`) => ({
    docID: `doc-${mid}`,
    doc_url: `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${mid}&idx=1&sn=abcd`,
    title,
    source: { title: '测试号' },
    timestamp: 1700000000 + mid,
  });
  const response = (
    items: unknown[],
    offset: number,
    more: unknown = true,
  ) => ({
    status: 200,
    data: JSON.stringify({
      ret: -1,
      content: {
        ret: 0,
        data: [{ items }],
        offset,
        searchID: `cursor-${offset}`,
        cookies: `business-cursor-${offset}`,
        continueFlag: more,
      },
    }),
  });

  it('discovers consecutive items through a genuine third page, retaining only response cursors', async () => {
    (axios.post as jest.Mock)
      .mockResolvedValueOnce(response([item(100)], 15))
      .mockResolvedValueOnce(response([item(101)], 30))
      .mockResolvedValueOnce(response([item(102)], 45, false));
    const result = await fetchOwnerSearchPage({ ...config(), maxPages: 5 });
    expect(result).toMatchObject({
      pages: 3,
      requests: 3,
      truncated: false,
      termination: 'upstream_exhausted',
      complete: false,
      coverage: 'search-results',
    });
    expect(result.candidates.map((c) => c.id)).toEqual([
      'WX_1234567890_100_1',
      'WX_1234567890_101_1',
      'WX_1234567890_102_1',
    ]);
    expect((axios.post as jest.Mock).mock.calls[2][1]).toEqual({
      query: '测试号',
      offset: 30,
      searchid: 'cursor-30',
      searchcookies: 'business-cursor-30',
    });
    expect(setTimeout).toHaveBeenCalledTimes(2);
    expect(
      (setTimeout as unknown as jest.Mock).mock.calls.every(
        (v) => v[1] === 1000,
      ),
    ).toBe(true);
    const state = await fs.readFile(config().stateFile, 'utf8');
    expect(state).not.toMatch(/cursor|searchid|searchcookies/);
  });

  it('continues through a mixed-source page with no target matches', async () => {
    (axios.post as jest.Mock)
      .mockResolvedValueOnce(
        response([{ ...item(100), source: { title: '另一个号' } }], 15),
      )
      .mockResolvedValueOnce(response([item(101)], 30, 0));
    const result = await fetchOwnerSearchPage({ ...config(), maxPages: 5 });
    expect(result.candidates).toHaveLength(1);
    expect(result.pages).toBe(2);
    expect(result.termination).toBe('upstream_exhausted');
  });

  it('stops reordered repeated mixed-source pages while keeping coverage incomplete', async () => {
    const other = { ...item(101), source: { title: '另一个号' } };
    (axios.post as jest.Mock)
      .mockResolvedValueOnce(response([item(100), other], 15))
      .mockResolvedValueOnce(response([other, item(100)], 30));
    const result = await fetchOwnerSearchPage({ ...config(), maxPages: 5 });
    expect(result).toMatchObject({
      pages: 2,
      truncated: true,
      termination: 'repeated_page',
      complete: false,
    });
    expect(result.candidates).toHaveLength(1);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('records budget exhaustion without silently treating it as a complete list', async () => {
    (axios.post as jest.Mock)
      .mockResolvedValueOnce(response([item(100)], 15))
      .mockResolvedValueOnce(response([item(101)], 30));
    expect(
      await fetchOwnerSearchPage({ ...config(), maxPages: 2 }),
    ).toMatchObject({
      pages: 2,
      truncated: true,
      termination: 'page_budget',
      complete: false,
    });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('rejects conflicting titles for the same stable article across pages before returning a batch', async () => {
    (axios.post as jest.Mock)
      .mockResolvedValueOnce(response([item(100)], 15))
      .mockResolvedValueOnce(response([item(100, '冲突标题')], 30, false));
    await expect(
      fetchOwnerSearchPage({ ...config(), maxPages: 5 }),
    ).rejects.toThrow('identity_conflict');
    await expect(
      fetchOwnerSearchPage({ ...config(), maxPages: 5 }),
    ).rejects.toThrow('identity_conflict');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, '1', null, 2])(
    'rejects malformed continuation flag %s',
    async (more) => {
      const r = response([item(100)], 15, false);
      const data = JSON.parse(r.data);
      data.content.continueFlag = more;
      r.data = JSON.stringify(data);
      (axios.post as jest.Mock).mockResolvedValueOnce(r);
      await expect(
        fetchOwnerSearchPage({ ...config(), maxPages: 5 }),
      ).rejects.toThrow('invalid_response');
      expect(axios.post).toHaveBeenCalledTimes(1);
    },
  );

  it.each([0, -1, 6, 1.5, NaN])(
    'rejects invalid page budget %s before HTTP',
    async (maxPages) => {
      await expect(
        fetchOwnerSearchPage({ ...config(), maxPages }),
      ).rejects.toThrow('OWNER_SEARCH_CONFIG_INVALID');
      expect(axios.post).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], false, { stops: null }, { stops: [] }])(
    'rejects corrupt state before HTTP (%j)',
    async (state) => {
      await fs.writeFile(config().stateFile, JSON.stringify(state));
      await expect(
        fetchOwnerSearchPage({ ...config(), maxPages: 5 }),
      ).rejects.toThrow('request_or_structure_failed');
      expect(axios.post).not.toHaveBeenCalled();
      expect(await fs.readFile(config().stateFile, 'utf8')).toBe(
        JSON.stringify(state),
      );
    },
  );

  it('persists a refused continuation and does not return a partial successful batch or retry', async () => {
    (axios.post as jest.Mock)
      .mockResolvedValueOnce(response([item(100)], 15))
      .mockResolvedValueOnce({ status: 401, data: '{"errCode":-2012}' });
    await expect(
      fetchOwnerSearchPage({ ...config(), maxPages: 5 }),
    ).rejects.toThrow('auth_or_access_rejected');
    await expect(
      fetchOwnerSearchPage({ ...config(), maxPages: 5 }),
    ).rejects.toThrow('auth_or_access_rejected');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
