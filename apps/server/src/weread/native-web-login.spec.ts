import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeWebLogin } from './native-web-login';
import { ownerSessionCookie } from '../collection/owner-web-search';
jest.mock('axios');

describe('native Web QR login (no real HTTP)', () => {
  let dir: string;
  const prior = process.env.OWNER_SEARCH_CONFIG_FILE;
  beforeEach(async () => {
    jest.resetAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-qr-'));
    process.env.OWNER_SEARCH_CONFIG_FILE = path.join(dir, 'source.json');
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OWNER_SEARCH_CONFIG_FILE;
    else process.env.OWNER_SEARCH_CONFIG_FILE = prior;
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('does not request an unknown UID', async () => {
    expect((await new NativeWebLogin().poll('unknown')).terminal).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('returns authentic QR credentials without renewal or article requests', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ status: 200, data: { uid: 'uid-example' } })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          webLoginVid: 123,
          accessToken: 'normal-qr-token',
          refreshToken: 'renew/+?',
        },
      });
    const login = new NativeWebLogin();
    const qr = await login.create();
    const result = await login.poll(qr.uuid);
    expect(result.vid).toBe(123);
    expect(ownerSessionCookie(result.webSession!, '123')).toContain(
      'wr_skey=normal-qr-token',
    );
    expect(ownerSessionCookie(result.webSession!, '123')).toContain(
      'wr_rt=renew%2F%2B%3F',
    );
    expect(ownerSessionCookie(result.webSession!, '123')).toContain('wr_ql=0');
    expect(JSON.parse(result.token!).wr_rt).toBe('renew%2F%2B%3F');
    expect(await login.poll(qr.uuid)).toBe(result);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://weread.qq.com/api/auth/getLoginUid',
      expect.objectContaining({ maxRedirects: 0, proxy: false }),
    );
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('does not save malformed Web refresh credentials', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ status: 200, data: { uid: 'uid-example' } })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          webLoginVid: 123,
          accessToken: 'normal-qr-token',
          refreshToken: 'bad;cookie',
        },
      });
    const login = new NativeWebLogin();
    const qr = await login.create();
    const result = await login.poll(qr.uuid);
    expect(result.terminal).toBe(true);
    expect(result.token).toBeUndefined();
    expect(result.webSession).toBeUndefined();
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('persists a refusal and stops all further login requests', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ status: 403, data: {} });
    await expect(new NativeWebLogin().create()).rejects.toThrow('已停止');
    await expect(new NativeWebLogin().create()).rejects.toThrow('已停止');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        await fs.readFile(path.join(dir, 'native-login-stop.json'), 'utf8'),
      ).httpStatus,
    ).toBe(403);
  });
  it('does not swallow a polling failure as waiting for scan', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ status: 200, data: { uid: 'uid-example' } })
      .mockRejectedValueOnce(new Error('transport failed'));
    const login = new NativeWebLogin();
    const qr = await login.create();
    const result = await login.poll(qr.uuid);
    expect(result.terminal).toBe(true);
    expect(result.message).toContain('停止');
    expect(await login.poll(qr.uuid)).toBe(result);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});
