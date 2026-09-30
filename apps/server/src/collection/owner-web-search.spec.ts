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
  });
  afterEach(async () => {
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
});
