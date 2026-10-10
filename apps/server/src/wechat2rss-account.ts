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
  failed: '登录未完成，请检查实例或按官方提示处理验证后手动重试。',
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

  private terminal(session: Session, state: State) {
    session.cookies.clear();
    session.view = view(state);
    return session.view;
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
    if (response.status !== 200 || !response.body) throw new Error('REJECTED');
    const reader = response.body.getReader();
    const parts: Buffer[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1_000_000) {
        await reader.cancel();
        throw new Error('REJECTED');
      }
      parts.push(Buffer.from(value));
    }
    const raw = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!raw || typeof raw !== 'object' || raw.err !== '' || !('data' in raw))
      throw new Error('REJECTED');
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
          throw new Error('REJECTED');
        const split = pair.indexOf('=');
        session.cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      if (
        session.cookies.size > 16 ||
        [...session.cookies.values()].join('').length > 8192
      )
        throw new Error('REJECTED');
    }
    return raw.data as unknown;
  }

  private loginReply(raw: unknown, session: Session): Wechat2RssLoginView {
    if (!raw || typeof raw !== 'object' || typeof raw['isLogin'] !== 'boolean')
      throw new Error('REJECTED');
    if (this.now() >= session.expires) return this.terminal(session, 'expired');
    if (raw['isLogin']) return this.terminal(session, 'succeeded');
    const qr = raw['qrcode'];
    if (qr !== undefined && typeof qr !== 'string') throw new Error('REJECTED');
    if (qr) {
      if (
        typeof qr !== 'string' ||
        qr.length > 700_000 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(qr)
      )
        throw new Error('REJECTED');
      const bytes = Buffer.from(
        qr.slice('data:image/png;base64,'.length),
        'base64',
      );
      if (
        bytes.length < 24 ||
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        bytes.readUInt32BE(16) < 1 ||
        bytes.readUInt32BE(16) > 2048 ||
        bytes.readUInt32BE(20) < 1 ||
        bytes.readUInt32BE(20) > 2048
      )
        throw new Error('REJECTED');
      session.view.qrcode = qr;
    }
    // Without an upstream cookie polling /login/new could create another login.
    if (!session.cookies.size) throw new Error('REJECTED');
    session.view.message = session.view.qrcode
      ? messages.waiting
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
    } catch {
      return this.terminal(session, 'failed');
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
    } catch {
      return this.terminal(session, 'failed');
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
