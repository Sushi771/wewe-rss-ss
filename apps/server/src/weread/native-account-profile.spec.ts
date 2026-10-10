import axios from 'axios';
import {
  fetchNativeAccountProfile,
  parseNativeAccountProfile,
} from './native-account-profile';
import { OwnerWebSession } from '../collection/owner-web-search';
jest.mock('axios');

describe('normal Web own profile (no real HTTP)', () => {
  const session: OwnerWebSession = {
    source: 'owner-confirmed-native-web-login',
    ownerVid: '123',
    capturedAt: '2026-01-02T03:04:05.000Z',
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
        value: 'private-fixture',
        domain: '.weread.qq.com',
        path: '/',
        secure: true,
        expires: -1,
      },
    ],
  };
  beforeEach(() => jest.resetAllMocks());
  it('uses the known first-party Web endpoint and normal Web headers, retaining only verified metadata', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: {
        userVid: 123,
        name: '真实昵称',
        avatar: 'https://thirdwx.qlogo.cn/image',
        accessToken: 'never-store',
      },
    });
    const profile = await fetchNativeAccountProfile(session);
    expect(profile).toMatchObject({
      ownerVid: '123',
      name: '真实昵称',
      nativeLoginAt: session.capturedAt,
      avatar: 'https://thirdwx.qlogo.cn/image',
    });
    expect(JSON.stringify(profile)).not.toContain('never-store');
    expect(axios.get).toHaveBeenCalledWith(
      'https://weread.qq.com/api/userInfo',
      expect.objectContaining({
        params: { userVid: '123' },
        headers: expect.objectContaining({
          'x-vid': '123',
          'x-skey': 'private-fixture',
        }),
        maxRedirects: 0,
        proxy: false,
      }),
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
  it.each([
    { userVid: '999', name: '错误账号' },
    { userVid: 123, name: '  ' },
    { userVid: 123, name: '昵称', errCode: -2041 },
    '<html>verify</html>',
  ])('rejects missing, wrong or refused profile identities', (data) => {
    expect(() => parseNativeAccountProfile(data, session)).toThrow();
  });
  it('does not follow redirects, retry refusals or expose upstream credentials in errors', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      status: 302,
      data: { name: 'untrusted' },
    });
    await expect(fetchNativeAccountProfile(session)).rejects.toThrow('未重试');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});
