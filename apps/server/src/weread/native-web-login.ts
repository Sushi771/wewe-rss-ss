import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { OwnerWebSession } from '../collection/owner-web-search';

export type NativeLoginResult = {
  message: string;
  terminal: boolean;
  vid?: number;
  token?: string;
  username?: string;
  webSession?: OwnerWebSession;
};
type Login = {
  deadline: number;
  polls: number;
  result?: NativeLoginResult;
  pending?: Promise<NativeLoginResult>;
};

/** Tencent's public homepage QR flow; never renew, retry, or call article APIs. */
export class NativeWebLogin {
  private logins = new Map<string, Login>();
  private creating = false;
  private lastCreate = 0;
  private stopFile() {
    const config = process.env.OWNER_SEARCH_CONFIG_FILE;
    if (!config || !path.isAbsolute(config))
      throw new Error('请先配置微信读书私有会话目录，未发登录请求。');
    return path.join(path.dirname(config), 'native-login-stop.json');
  }
  private async checkStop() {
    try {
      await fs.readFile(this.stopFile());
    } catch (e: any) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    throw new Error(
      '微信读书登录曾返回验证或拒绝，已停止请求；请先处理官方验证。',
    );
  }
  private async get(endpoint: string, params?: Record<string, string>) {
    await this.checkStop();
    const response = await axios.get(
      `https://weread.qq.com/api/auth/${endpoint}`,
      {
        params,
        timeout: endpoint === 'getLoginInfo' ? 45000 : 10000,
        maxRedirects: 0,
        proxy: false,
        maxContentLength: 65536,
        validateStatus: () => true,
        headers: {
          Referer: 'https://weread.qq.com/',
          'User-Agent': 'Mozilla/5.0',
        },
      },
    );
    const d = response.data;
    // Keep status/structure before interpretation; omit credentials, UID,
    // raw messages and any verification HTML.
    await fs.writeFile(
      path.join(
        path.dirname(this.stopFile()),
        `native-${endpoint}-${Date.now()}.json`,
      ),
      JSON.stringify({
        httpStatus: response.status,
        fields:
          d && typeof d === 'object'
            ? [
                'uid',
                'accessToken',
                'webLoginVid',
                'logicCode',
                'errCode',
                'errcode',
              ].filter((k) => k in d)
            : [],
        logicCode:
          typeof d?.logicCode === 'string' && /^[A-Z_]{1,60}$/.test(d.logicCode)
            ? d.logicCode
            : null,
        hasLoginIdentity: Boolean(d?.webLoginVid && d?.accessToken),
        businessCode:
          typeof (d?.errCode ?? d?.errcode) === 'number'
            ? (d.errCode ?? d.errcode)
            : null,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    if (
      response.status !== 200 ||
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      /captcha|验证码|频繁|安全验证|环境异常/i.test(
        String(d.message || d.msg || ''),
      ) ||
      ['errCode', 'errcode', 'code'].some(
        (k) => d[k] !== undefined && Number(d[k]) !== 0,
      )
    ) {
      await fs.writeFile(
        this.stopFile(),
        JSON.stringify({
          at: new Date().toISOString(),
          endpoint,
          httpStatus: response.status,
          stopped: true,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      throw new Error('腾讯登录返回验证、拒绝或异常响应，已停止请求。');
    }
    return d;
  }
  async create() {
    if (this.creating || Date.now() - this.lastCreate < 15000)
      throw new Error('登录二维码正在生成或刚生成，请稍后操作。');
    this.creating = true;
    this.lastCreate = Date.now();
    try {
      const d = await this.get('getLoginUid');
      if (typeof d.uid !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(d.uid))
        throw new Error('腾讯未返回有效登录二维码，未开始轮询。');
      for (const [uid, login] of this.logins)
        if (login.deadline < Date.now()) this.logins.delete(uid);
      if (this.logins.size >= 5)
        throw new Error('未完成的登录过多，请稍后操作。');
      this.logins.set(d.uid, { deadline: Date.now() + 120000, polls: 0 });
      return {
        uuid: d.uid,
        scanUrl: `https://weread.qq.com/web/confirm?uid=${encodeURIComponent(d.uid)}`,
      };
    } catch (e) {
      // Do not expose Axios request/response details or silently regenerate.
      if (e instanceof Error && !axios.isAxiosError(e)) throw e;
      throw new Error('微信读书登录请求失败，未自动重试。');
    } finally {
      this.creating = false;
    }
  }
  async poll(uid: string): Promise<NativeLoginResult> {
    const login = this.logins.get(uid);
    if (!login)
      return {
        message: '二维码不是本次服务生成或已失效，请刷新。',
        terminal: true,
      };
    if (login.result) return login.result;
    if (login.pending) return login.pending;
    if (login.deadline < Date.now() || login.polls >= 30)
      return (login.result = {
        message: '二维码已过期，请刷新。',
        terminal: true,
      });
    login.pending = this.pollOnce(uid, login);
    try {
      return await login.pending;
    } finally {
      login.pending = undefined;
    }
  }
  private async pollOnce(
    uid: string,
    login: Login,
  ): Promise<NativeLoginResult> {
    login.polls++;
    try {
      const d = await this.get('getLoginInfo', { uid, otp: '' });
      if (d.accessToken && d.webLoginVid) {
        const vid = Number(d.webLoginVid);
        if (
          !Number.isSafeInteger(vid) ||
          vid < 1 ||
          typeof d.accessToken !== 'string' ||
          /[;\s\x00-\x1f\x7f]/.test(d.accessToken)
        )
          throw new Error('腾讯登录身份字段无效，未保存账号。');
        // The direct Web QR response may also include a refresh token. Keep
        // that credential with this Web session; it is not a mobile token.
        const refreshToken = d.refreshToken;
        if (
          refreshToken !== undefined &&
          (typeof refreshToken !== 'string' ||
            !refreshToken ||
            /[;\s\x00-\x1f\x7f]/.test(refreshToken))
        )
          throw new Error('腾讯登录续期字段无效，未保存账号。');
        const webCookies = [
          { name: 'wr_vid', value: String(vid) },
          { name: 'wr_skey', value: d.accessToken },
          { name: 'wr_ql', value: '0' },
          ...(refreshToken
            ? [{ name: 'wr_rt', value: encodeURIComponent(refreshToken) }]
            : []),
        ];
        // First-party BVQc4ULa.js writes this QR response's accessToken to
        // wr_skey. This is not a conversion of mobile login credentials.
        const token = JSON.stringify({
          wr_vid: String(vid),
          wr_skey: d.accessToken,
          wr_ql: '0',
          ...(refreshToken ? { wr_rt: encodeURIComponent(refreshToken) } : {}),
          accessToken: d.accessToken,
          updateTime: Date.now(),
        });
        const webSession: OwnerWebSession = {
          source: 'owner-confirmed-native-web-login',
          ownerVid: String(vid),
          capturedAt: new Date().toISOString(),
          cookies: webCookies.map((c) => ({
            ...c,
            domain: '.weread.qq.com',
            path: '/',
            secure: true,
            expires: -1,
          })),
        };
        return (login.result = {
          message: '',
          terminal: true,
          vid,
          token,
          username: `WeRead_${vid}`,
          webSession,
        });
      }
      if (d.logicCode === 'LOGIN_TIMEOUT' || d.logicCode === 'LOGIN_CANCEL')
        return (login.result = {
          message: '二维码已过期或登录已取消，请刷新。',
          terminal: true,
        });
      if (
        d.logicCode &&
        !['WAITING_SCAN', 'WAITING_CONFIRM'].includes(d.logicCode)
      )
        throw new Error('腾讯登录返回未知状态，已停止本次轮询。');
      return {
        message:
          d.logicCode === 'WAITING_CONFIRM' ? '已扫码，请在微信中点击确认' : '',
        terminal: false,
      };
    } catch (error: any) {
      return (login.result = {
        message: ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)
          ? '二维码等待超时，已停止本次轮询，未保存账号。'
          : '微信读书登录请求失败或受限，已停止本次轮询，未保存账号。',
        terminal: true,
      });
    }
  }
}
