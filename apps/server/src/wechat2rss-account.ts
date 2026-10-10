import { randomUUID } from 'node:crypto';
import { Wechat2RssProvider } from './collection/providers/wechat2rss';

type Config = { enabled: boolean; baseUrl: string; token: string };
type State =
  | 'waiting'
  | 'succeeded'
  | 'expired'
  | 'failed'
  | 'busy'
  | 'unavailable'
  | 'closed';
export type Wechat2RssLoginView = {
  state: State;
  message: string;
  sessionId?: string;
  qrcode?: string;
  expiresAt?: number;
  code?: string;
  phase?: 'create' | 'poll';
};
type Session = {
  view: Wechat2RssLoginView;
  cookies: Map<string, string>;
  config: Config;
  expires: number;
  nextPoll: number;
  polls: number;
  pending: boolean;
};
const messages: Record<State, string> = {
  waiting: '请使用微信扫描二维码，并按官方提示确认登录。',
  succeeded: 'Wechat2RSS 登录成功。',
  expired: '本次登录已过期，请手动重新获取二维码。',
  failed: '本次登录未完成，已停止。',
  busy: '已有登录正在进行，请完成或关闭后再试。',
  unavailable: 'Wechat2RSS 实例尚未配置，无法登录。',
  closed: '已停止本次登录。',
};
const view = (state: State): Wechat2RssLoginView => ({
  state,
  message: messages[state],
});

/** Official /login/new uses a server-side cookie, not a UUID polling endpoint.
 * No network on construction; every request follows an explicit protected action.
 * This module never writes local accounts, configuration or authorization tokens.
 */
export class Wechat2RssAccounts {
  private sessions = new Map<string, Session>();
  private starting = false;

  constructor(
    private readonly readConfig: () => Config = () => ({
      enabled: process.env.WECHAT2RSS_ENABLED === '1',
      baseUrl: process.env.WECHAT2RSS_BASE_URL || '',
      token: process.env.WECHAT2RSS_TOKEN || '',
    }),
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private config(): Config {
    const config = this.readConfig();
    if (!config.enabled) throw new Error('UNAVAILABLE');
    // Reuse the provider's existing private-host and credential validation.
    new Wechat2RssProvider(config.baseUrl, config.token);
    return config;
  }

  private terminal(session: Session, state: State, error?: unknown) {
    session.cookies.clear();
    session.view = view(state);
    if (state === 'failed') {
      const phase = session.polls ? 'poll' : 'create';
      const code = this.safeCode(error);
      const target = phase === 'create' ? '二维码' : '登录状态';
      const detail =
        code === 'UPSTREAM_REJECTED'
          ? '实例拒绝了请求，具体原因尚未确认'
          : code === 'HTTP_FAILED' || code === 'NETWORK_FAILED'
            ? '实例请求失败'
            : code === 'COOKIE_MISSING' || code === 'COOKIE_INVALID'
              ? '没有可继续使用的登录会话'
              : code === 'COOKIE_CLEARED'
                ? '登录会话已结束或过期'
                : code.startsWith('QR_')
                  ? '二维码图片响应未能识别'
                  : '实例响应结构未能识别';
      session.view = {
        ...session.view,
        phase,
        code,
        message: `${target}${phase === 'create' ? '获取' : '查询'}停止：${detail}。`,
      };
      console.info('[WECHAT2RSS_LOGIN_STOP]', JSON.stringify({ phase, code }));
    }
    return session.view;
  }

  private safeCode(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    return [
      'HTTP_FAILED',
      'NETWORK_FAILED',
      'BODY_TOO_LARGE',
      'INVALID_JSON',
      'ENVELOPE_INVALID',
      'UPSTREAM_REJECTED',
      'COOKIE_INVALID',
      'COOKIE_CLEARED',
      'COOKIE_MISSING',
      'LOGIN_REPLY_INVALID',
      'QR_FORMAT_INVALID',
      'QR_PNG_INVALID',
      'QR_JPEG_INVALID',
      'CONFIG_CHANGED',
    ].includes(code)
      ? code
      : 'NETWORK_FAILED';
  }

  private prune() {
    for (const [id, session] of this.sessions) {
      if (this.now() >= session.expires) {
        this.terminal(session, 'expired');
        this.sessions.delete(id);
      }
    }
  }

  private async get(
    config: Config,
    endpoint: '/login/new' | '/login/list',
    session?: Session,
  ) {
    const url = new URL(endpoint, config.baseUrl);
    url.searchParams.set('k', config.token);
    const response = await this.request(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: session?.cookies.size
        ? {
            Cookie: [...session.cookies]
              .map(([k, v]) => `${k}=${v}`)
              .join('; '),
          }
        : {},
    });
    const contentType = response.headers.get('content-type') || '';
    const category = /json/i.test(contentType)
      ? 'json'
      : /html/i.test(contentType)
        ? 'html'
        : /^image\//i.test(contentType)
          ? 'image'
          : contentType
            ? 'other'
            : 'missing';
    if (session)
      console.info(
        '[WECHAT2RSS_LOGIN_HEADERS]',
        JSON.stringify({
          phase: session.polls ? 'poll' : 'create',
          httpStatus: response.status,
          contentType: category,
          cookieHeaderPresent: response.headers.has('set-cookie'),
        }),
      );
    if (response.status !== 200 || !response.body)
      throw new Error('HTTP_FAILED');
    const reader = response.body.getReader();
    const parts: Buffer[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1_000_000) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }
      parts.push(Buffer.from(value));
    }
    let raw;
    try {
      raw = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      if (session)
        console.info(
          '[WECHAT2RSS_LOGIN_RESPONSE]',
          JSON.stringify({
            phase: session.polls ? 'poll' : 'create',
            httpStatus: response.status,
            contentType: category,
            json: false,
          }),
        );
      throw new Error('INVALID_JSON');
    }
    if (session) {
      const data = raw && typeof raw === 'object' ? raw.data : undefined;
      const qr = data && typeof data === 'object' ? data.qrcode : undefined;
      const flag = data && typeof data === 'object' ? data.isLogin : undefined;
      console.info(
        '[WECHAT2RSS_LOGIN_RESPONSE]',
        JSON.stringify({
          phase: session.polls ? 'poll' : 'create',
          httpStatus: response.status,
          contentType: category,
          json: true,
          envelopeType: typeof raw,
          errType: typeof raw?.err,
          errNonempty: typeof raw?.err === 'string' && raw.err.length > 0,
          dataType:
            data === null
              ? 'null'
              : Array.isArray(data)
                ? 'array'
                : typeof data,
          isLoginType: typeof flag,
          isLogin: typeof flag === 'boolean' ? flag : null,
          qrType: typeof qr,
          qrLength: typeof qr === 'string' ? qr.length : null,
          qrFormat:
            typeof qr !== 'string' || !qr
              ? 'empty'
              : /^data:image\/png;base64,/.test(qr)
                ? 'png-data-uri'
                : /^data:image\/(?:jpeg|jpg);base64,/.test(qr)
                  ? 'jpeg-data-uri'
                  : /^https?:/.test(qr)
                    ? 'remote-url'
                    : 'other',
          cookieHeaderPresent: response.headers.has('set-cookie'),
        }),
      );
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('ENVELOPE_INVALID');
    // The installed official client treats omitted/null err as success. Its
    // initial response may contain only qrcode; polls may omit false isLogin.
    if (raw.err != null && raw.err !== '') throw new Error('UPSTREAM_REJECTED');
    if (session) {
      const headers = response.headers as Headers & {
        getSetCookie?: () => string[];
      };
      const cookies =
        headers.getSetCookie?.() ||
        (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
      for (const cookie of cookies) {
        const pair = cookie.split(';')[0];
        if (
          !/^[!#$%&'*+\-.^_`|~\w]+=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(
            pair,
          ) ||
          pair.length > 4096
        )
          throw new Error('COOKIE_INVALID');
        const split = pair.indexOf('=');
        const cleared =
          split === pair.length - 1 ||
          cookie
            .split(';')
            .slice(1)
            .some((attribute) => {
              const [name, ...parts] = attribute.trim().split('=');
              const value = parts.join('=');
              return (
                (name.toLowerCase() === 'max-age' &&
                  /^-?\d+$/.test(value) &&
                  Number(value) <= 0) ||
                (name.toLowerCase() === 'expires' &&
                  Date.parse(value) <= this.now())
              );
            });
        if (cleared) {
          session.cookies.delete(pair.slice(0, split));
          // A waiting request without its cookie may create a fresh login.
          // Confirmed success may legitimately clear the completed session.
          if (raw.data?.isLogin !== true) throw new Error('COOKIE_CLEARED');
          continue;
        }
        session.cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      if (
        session.cookies.size > 16 ||
        [...session.cookies.values()].join('').length > 8192
      )
        throw new Error('COOKIE_INVALID');
    }
    return (raw.data ?? {}) as unknown;
  }

  private validJpeg(bytes: Buffer) {
    if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
      return false;
    let offset = 2;
    let components = 0;
    let scanning = false;
    let sawScan = false;
    // Walk every segment, including progressive scans. Never trust the MIME or
    // magic alone; a second frame cannot bypass the first frame's size limit.
    while (offset < bytes.length) {
      if (scanning) {
        while (offset < bytes.length) {
          if (bytes[offset++] !== 0xff) continue;
          const start = offset - 1;
          while (bytes[offset] === 0xff) offset++;
          const marker = bytes[offset++];
          if (marker === undefined) return false;
          if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) continue;
          offset = start;
          scanning = false;
          break;
        }
        if (scanning) return false;
      }
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9) return sawScan && offset === bytes.length;
      if (
        marker === undefined ||
        marker === 0 ||
        marker === 0xd8 ||
        marker === 1 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        offset + 2 > bytes.length
      )
        return false;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (components || length < 11 || bytes[offset + 2] !== 8) return false;
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        components = bytes[offset + 7];
        if (
          ![1, 3, 4].includes(components) ||
          length !== 8 + 3 * components ||
          height < 1 ||
          height > 2048 ||
          width < 1 ||
          width > 2048
        )
          return false;
      }
      if (marker === 0xda) {
        const scanComponents = bytes[offset + 2];
        if (
          !components ||
          scanComponents < 1 ||
          scanComponents > components ||
          length !== 6 + 2 * scanComponents
        )
          return false;
        sawScan = true;
        scanning = true;
      }
      offset += length;
    }
    return false;
  }

  private loginReply(raw: unknown, session: Session): Wechat2RssLoginView {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      (raw['isLogin'] != null && typeof raw['isLogin'] !== 'boolean')
    )
      throw new Error('LOGIN_REPLY_INVALID');
    if (this.now() >= session.expires) return this.terminal(session, 'expired');
    if (raw['isLogin']) return this.terminal(session, 'succeeded');
    const qr = raw['qrcode'];
    if (qr != null && typeof qr !== 'string')
      throw new Error('QR_FORMAT_INVALID');
    if (qr) {
      // The deployed supplier returns JPEG data URIs (including image/jpg),
      // while its official client passes qrcode directly to an img element.
      // Keep inline raster data only; never fetch a returned URL or accept SVG.
      const match =
        /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(qr);
      if (qr.length > 700_000 || !match) throw new Error('QR_FORMAT_INVALID');
      const bytes = Buffer.from(match[2], 'base64');
      if (
        bytes.toString('base64').replace(/=+$/, '') !==
        match[2].replace(/=+$/, '')
      )
        throw new Error('QR_FORMAT_INVALID');
      if (
        match[1] === 'png' &&
        (bytes.length < 24 ||
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.toString('ascii', 12, 16) !== 'IHDR' ||
          bytes.readUInt32BE(16) < 1 ||
          bytes.readUInt32BE(16) > 2048 ||
          bytes.readUInt32BE(20) < 1 ||
          bytes.readUInt32BE(20) > 2048)
      )
        throw new Error('QR_PNG_INVALID');
      if (match[1] !== 'png' && !this.validJpeg(bytes))
        throw new Error('QR_JPEG_INVALID');
      // Normalize jpg to its standard MIME and restore optional base64 padding.
      session.view.qrcode = `data:image/${match[1] === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
    }
    // Without an upstream cookie polling /login/new could create another login.
    if (!session.cookies.size) throw new Error('COOKIE_MISSING');
    session.view.message = session.view.qrcode
      ? '二维码已就绪，等待微信扫码或确认。'
      : '正在等待实例生成二维码。';
    return session.view;
  }

  async start(): Promise<Wechat2RssLoginView> {
    this.prune();
    if (
      this.starting ||
      [...this.sessions.values()].some((s) => s.view.state === 'waiting')
    )
      return view('busy');
    if (this.sessions.size >= 16)
      return { ...view('busy'), message: '登录尝试较多，请三分钟后手动重试。' };
    let config: Config;
    try {
      config = this.config();
    } catch {
      return view('unavailable');
    }
    this.starting = true;
    const id = randomUUID();
    const session: Session = {
      view: {
        ...view('waiting'),
        sessionId: id,
        expiresAt: this.now() + 180_000,
      },
      cookies: new Map(),
      config,
      expires: this.now() + 180_000,
      nextPoll: this.now() + 3000,
      polls: 0,
      pending: true,
    };
    this.sessions.set(id, session);
    try {
      const raw = await this.get(config, '/login/new', session);
      // A close may have arrived while the QR request was in flight.
      if (session.view.state !== 'waiting') {
        session.cookies.clear();
        return session.view;
      }
      return this.loginReply(raw, session);
    } catch (error) {
      return this.terminal(session, 'failed', error);
    } finally {
      session.pending = false;
      this.starting = false;
    }
  }

  async poll(id: string): Promise<Wechat2RssLoginView> {
    const session = this.sessions.get(id);
    if (!session) return view('expired');
    if (this.now() >= session.expires || session.polls >= 60)
      return this.terminal(session, 'expired');
    if (session.view.state !== 'waiting') return session.view;
    if (session.pending || this.now() < session.nextPoll) return session.view;
    session.pending = true;
    session.polls++;
    session.nextPoll = this.now() + 3000;
    try {
      const current = this.config();
      if (
        current.baseUrl !== session.config.baseUrl ||
        current.token !== session.config.token
      )
        throw new Error('CONFIG_CHANGED');
      const raw = await this.get(session.config, '/login/new', session);
      if (session.view.state !== 'waiting') {
        session.cookies.clear();
        return session.view;
      }
      return this.loginReply(raw, session);
    } catch (error) {
      return this.terminal(session, 'failed', error);
    } finally {
      session.pending = false;
    }
  }

  close(id: string): Wechat2RssLoginView {
    const session = this.sessions.get(id);
    if (session) this.terminal(session, 'closed');
    this.sessions.delete(id);
    return view('closed');
  }

  async list() {
    const base = {
      configured: false,
      checkedAt: null as string | null,
      accounts: [] as {
        name: string;
        available: boolean;
        needCheck: boolean;
        waitTime: string | null;
      }[],
    };
    let config: Config;
    try {
      config = this.config();
    } catch {
      return {
        ...base,
        code: 'SOURCE_UNAVAILABLE',
        message: messages.unavailable,
      };
    }
    try {
      const data = await this.get(config, '/login/list');
      if (!Array.isArray(data) || data.length > 100)
        throw new Error('REJECTED');
      const accounts = data.map((row) => {
        if (
          !row ||
          typeof row !== 'object' ||
          typeof row.available !== 'boolean' ||
          typeof row.needCheck !== 'boolean'
        )
          throw new Error('REJECTED');
        const name =
          typeof row.name === 'string' &&
          row.name.trim().length > 0 &&
          row.name.length <= 80 &&
          !/[\x00-\x1f\x7f]/.test(row.name) &&
          !row.name.includes(config.token)
            ? row.name
            : '微信账号';
        const waitTime =
          typeof row.waitTime === 'string' &&
          row.waitTime.length <= 80 &&
          !row.waitTime.includes(config.token) &&
          /^[\d\s:/.+\-年月日时分秒小时分钟]+$/.test(row.waitTime)
            ? row.waitTime
            : null;
        return {
          name,
          available: row.available && !row.needCheck,
          needCheck: row.needCheck,
          waitTime,
        };
      });
      return {
        configured: true,
        checkedAt: new Date(this.now()).toISOString(),
        accounts,
        code: 'OK',
        message: accounts.length
          ? '已读取 Wechat2RSS 账号状态。'
          : '实例尚无微信账号，请添加账号。',
      };
    } catch {
      return {
        ...base,
        configured: true,
        checkedAt: new Date(this.now()).toISOString(),
        code: 'STATUS_CHECK_FAILED',
        message: '实例账号状态读取失败，请手动重试。',
      };
    }
  }
}
