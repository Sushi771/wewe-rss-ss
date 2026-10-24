import { OnModuleDestroy } from '@nestjs/common';
import * as path from 'node:path';
import { privateOnlineMode } from '../private-access';
import {
  RedbookClient,
  RedbookPauseError,
  RedbookTransport,
} from './redbook-client';
import { RedbookMediaTransport } from './redbook-response';
import {
  RedbookSubscriptionAdapter,
  XhsProfileParser,
} from './xhs-redbook-subscription';
import {
  fetchXhsShortLink,
  XhsShortLinkResolver,
  XhsShortLinkTransport,
} from './xhs-short-link';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { XhsSubscriptionSource } from './xhs-subscription.service';
import {
  checkedXhsCookies,
  XhsDpapiSessionVault,
  XhsSessionCookies,
  XhsSessionVault,
} from './xhs-session-vault';
import {
  createRedbookHttpTransport,
  createXhsMediaTransport,
} from './xhs-http-transport';
import type { XhsConnectionStatus } from '@wewe-rss/shared';
import { parseXhsProfile } from './xhs-profile';

type RuntimeOptions = {
  enabled: () => boolean;
  vault?: XhsSessionVault;
  api?: RedbookTransport;
  media?: RedbookMediaTransport;
  shortLinks?: XhsShortLinkTransport;
  profileParser?: XhsProfileParser;
};
const failure = (code: string): never => {
  throw new XhsSubscriptionError(code);
};

/** Default-off native source. Construction/status while disabled never reads a
 * credential file. No browser extraction, ambient cookies, auto-restore or
 * persistent author/note access tokens are introduced. */
export class XhsSubscriptionRuntime
  implements XhsSubscriptionSource, OnModuleDestroy
{
  private cookies?: XhsSessionCookies;
  private generation = 0;
  private sessionAbort = new AbortController();
  private changing = false;
  private stored: boolean | null = null;
  private verified = false;
  private stopCode?: string;
  private readonly adapter: RedbookSubscriptionAdapter;
  constructor(private readonly options: RuntimeOptions) {
    const api = options.api ?? createRedbookHttpTransport();
    const media = options.media ?? createXhsMediaTransport();
    const shortLinks = options.shortLinks ?? fetchXhsShortLink;
    const signal = (other?: AbortSignal) =>
      other
        ? AbortSignal.any([this.sessionAbort.signal, other])
        : this.sessionAbort.signal;
    const client = new RedbookClient({
      cookies: () => {
        this.requireSession();
        return { ...this.cookies! };
      },
      transport: (request) =>
        this.guardTransport(() =>
          api({ ...request, signal: signal(request.signal) }),
        ),
    });
    this.adapter = new RedbookSubscriptionAdapter(
      client,
      {
        profileParser: options.profileParser,
        shortLinks: new XhsShortLinkResolver(async (url, request) => {
          return this.guardTransport(() =>
            shortLinks(url, { ...request, signal: signal(request.signal) }),
          );
        }),
      },
      (url, request) =>
        this.guardTransport(() =>
          media(url, { ...request, signal: signal(request.signal) }),
        ),
    );
  }
  private async guardTransport<T>(operation: () => Promise<T>) {
    this.requireSession();
    const generation = this.generation,
      signal = this.sessionAbort.signal;
    const result = await operation();
    if (generation !== this.generation || signal.aborted)
      return failure('XHS_SESSION_CHANGED');
    this.requireSession();
    return result;
  }
  private enabled() {
    return this.options.enabled() === true;
  }
  private requireSession() {
    if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
    if (this.stopCode) return failure(this.stopCode);
    if (!this.cookies) return failure('XHS_SESSION_REQUIRED');
  }
  private clearMemory() {
    this.generation++;
    this.sessionAbort.abort();
    this.sessionAbort = new AbortController();
    if (this.cookies) {
      this.cookies.a1 = '';
      this.cookies.web_session = '';
    }
    this.cookies = undefined;
    this.verified = false;
    this.adapter.clearAccessContext();
  }
  private snapshot(code?: string): XhsConnectionStatus {
    const liveEnabled = this.enabled(),
      connected = liveEnabled && !!this.cookies;
    return {
      liveEnabled,
      connected,
      stored: liveEnabled ? this.stored : null,
      verified: connected && this.verified,
      canConnect: liveEnabled,
      canPersist: liveEnabled && !!this.options.vault,
      restartRequiresReparse: true,
      code:
        code ??
        (!liveEnabled
          ? 'XHS_LIVE_ACCESS_DISABLED'
          : (this.stopCode ??
            (!connected ? 'XHS_SESSION_REQUIRED' : undefined))),
      message: !liveEnabled
        ? '真实访问尚未启用；未读取凭据。'
        : this.stopCode
          ? '当前来源已停止，请先处理登录、验证或访问限制，再明确重新连接。'
          : !connected
            ? '尚未连接；请由本机页面明确提供会话或恢复受保护记录。'
            : '本机会话已就绪；不代表平台已确认登录。重启后需重新解析链接。',
    };
  }
  async connectionStatus() {
    if (!this.enabled()) return this.snapshot();
    if (this.options.vault) {
      try {
        this.stored = (await this.options.vault.status()).stored;
      } catch {
        this.stored = null;
        return this.snapshot('XHS_VAULT_OPERATION_FAILED');
      }
    }
    return this.snapshot();
  }
  capability() {
    const status = this.snapshot(),
      ready = status.liveEnabled && status.connected && !this.stopCode;
    return {
      sourceConfigured: ready,
      canSubscribe: ready,
      canRefresh: ready,
      canDownload: ready,
      liveEnabled: status.liveEnabled,
      connected: status.connected,
      restartRequiresReparse: true,
      message: status.message,
    };
  }
  private async change<T>(operation: () => Promise<T>) {
    if (this.changing) return failure('XHS_SESSION_BUSY');
    this.changing = true;
    try {
      return await operation();
    } finally {
      this.changing = false;
    }
  }
  async connectSession(input: {
    a1: string;
    webSession: string;
    persist?: boolean;
  }) {
    if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
    return this.change(async () => {
      const next = checkedXhsCookies({
        a1: input.a1,
        web_session: input.webSession,
      });
      try {
        if (input.persist) {
          if (!this.options.vault) return failure('XHS_VAULT_UNAVAILABLE');
          try {
            await this.options.vault.store(next);
            this.stored = true;
          } catch {
            return failure('XHS_VAULT_OPERATION_FAILED');
          }
        }
        if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
        this.clearMemory();
        this.stopCode = undefined;
        this.cookies = { ...next };
        return this.snapshot();
      } finally {
        next.a1 = '';
        next.web_session = '';
      }
    });
  }
  async restoreSession() {
    if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
    return this.change(async () => {
      if (!this.options.vault) return failure('XHS_VAULT_UNAVAILABLE');
      let next: XhsSessionCookies | undefined;
      try {
        try {
          next = checkedXhsCookies(await this.options.vault.load());
        } catch {
          return failure('XHS_VAULT_OPERATION_FAILED');
        }
        if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
        this.clearMemory();
        this.stopCode = undefined;
        this.cookies = { ...next };
        this.stored = true;
        return this.snapshot();
      } finally {
        if (next) {
          next.a1 = '';
          next.web_session = '';
        }
      }
    });
  }
  async disconnectSession() {
    return this.change(async () => {
      this.clearMemory();
      this.stopCode = undefined;
      try {
        await this.options.vault?.disconnect();
        this.stored = false;
        return this.snapshot();
      } catch {
        this.stored = null;
        return this.snapshot('XHS_DISCONNECT_INCOMPLETE');
      }
    });
  }
  private async withSession<T>(operation: () => Promise<T>) {
    this.requireSession();
    const generation = this.generation;
    try {
      const result = await operation();
      if (generation !== this.generation) return failure('XHS_SESSION_CHANGED');
      this.requireSession();
      this.verified = true;
      return result;
    } catch (error) {
      if (generation !== this.generation) return failure('XHS_SESSION_CHANGED');
      if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
      if (
        error instanceof RedbookPauseError &&
        [
          'authentication',
          'verification',
          'permission',
          'signature',
          'rate_limit',
        ].includes(error.reason)
      ) {
        this.stopCode = `XHS_SOURCE_${error.reason.toUpperCase()}_BLOCKED`;
        this.verified = false;
        this.sessionAbort.abort();
        this.adapter.clearAccessContext();
      }
      throw error;
    }
  }
  resolve(url: string) {
    return this.withSession(() => this.adapter.resolve(url));
  }
  list(authorId: string, cursor: string | null, signal?: AbortSignal) {
    return this.withSession(() => this.adapter.list(authorId, cursor, signal));
  }
  detail(authorId: string, noteId: string, signal?: AbortSignal) {
    return this.withSession(() =>
      this.adapter.detail(authorId, noteId, signal),
    );
  }
  onModuleDestroy() {
    this.clearMemory();
  }
}

export function createLocalXhsSubscriptionRuntime() {
  let vault: XhsSessionVault | undefined;
  const raw = process.env.DATABASE_URL ?? '';
  const database = raw.startsWith('file:')
    ? decodeURIComponent(raw.slice(5).split('?')[0])
    : '';
  if (process.platform === 'win32' && path.isAbsolute(database))
    vault = new XhsDpapiSessionVault(path.dirname(database));
  return new XhsSubscriptionRuntime({
    enabled: () =>
      process.env.XHS_SUBSCRIPTION_LIVE_ENABLED === '1' &&
      !privateOnlineMode() &&
      process.env.WEWE_ACCEPTANCE_MODE !== '1',
    vault,
    profileParser: parseXhsProfile,
  });
}
