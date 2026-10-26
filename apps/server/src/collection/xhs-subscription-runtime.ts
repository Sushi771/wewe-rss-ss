import { AsyncLocalStorage } from 'node:async_hooks';
import { XhsRequestBudget } from './xhs-request-budget';
import { OnModuleDestroy } from '@nestjs/common';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  commentsEnabled?: () => boolean;
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
  private readonly budgetScope = new AsyncLocalStorage<{
    budget: XhsRequestBudget;
    id: string;
    failure?: unknown;
  }>();
  withRequestBudget<T>(
    budget: XhsRequestBudget,
    id: string,
    work: () => Promise<T>,
  ) {
    return this.budgetScope.run({ budget, id }, work);
  }
  private cookies?: XhsSessionCookies;
  private generation = 0;
  private sessionAbort = new AbortController();
  private changing = false;
  private stored: boolean | null = null;
  private verified = false;
  private stopCode?: string;
  private readonly adapter: RedbookSubscriptionAdapter;
  private readonly requestAttempts = {
    instanceId: randomUUID(),
    profiles: 0,
    lists: 0,
    details: 0,
    media: 0,
    shortLinks: 0,
    comments: 0,
    replies: 0,
  };
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
          (() => {
            const route = new URL(request.url).pathname;
            if (route.endsWith('/user/otherinfo'))
              this.requestAttempts.profiles++;
            else if (route.endsWith('/user_posted'))
              this.requestAttempts.lists++;
            else if (route.endsWith('/feed')) this.requestAttempts.details++;
            else if (route.endsWith('/comment/page'))
              this.requestAttempts.comments++;
            else if (route.endsWith('/comment/sub/page'))
              this.requestAttempts.replies++;
            return api({ ...request, signal: signal(request.signal) });
          })(),
        ),
    });
    this.adapter = new RedbookSubscriptionAdapter(
      client,
      {
        profileParser: options.profileParser,
        shortLinks: new XhsShortLinkResolver(async (url, request) => {
          return this.guardTransport(() =>
            (() => {
              this.requestAttempts.shortLinks++;
              return shortLinks(url, {
                ...request,
                signal: signal(request.signal),
              });
            })(),
          );
        }),
      },
      (url, request) =>
        this.guardTransport(() =>
          (() => {
            this.requestAttempts.media++;
            return media(url, { ...request, signal: signal(request.signal) });
          })(),
        ),
    );
  }
  private async guardTransport<T>(operation: () => Promise<T>) {
    this.requireSession();
    const generation = this.generation,
      signal = this.sessionAbort.signal;
    const admission = this.budgetScope.getStore();
    if (admission) {
      try {
        await admission.budget.admit(admission.id);
      } catch (error) {
        admission.failure = error;
        throw error;
      }
    }
    this.requireSession();
    if (signal.aborted) return failure('XHS_SESSION_CHANGED');
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
      requestAttempts: { ...this.requestAttempts },
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
          ? this.stopCode === 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'
            ? '来源 API 拒绝了请求，原因尚不明确；采集已停止。网页可访问不代表此接口可用，请先核查来源状态，再明确重新连接。'
            : this.stopCode === 'XHS_SOURCE_VERIFICATION_BLOCKED'
              ? '来源明确提示需要验证；当前没有可确认的验证入口，采集已停止。'
              : '当前来源已停止，请先处理登录、验证或访问限制，再明确重新连接。'
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
      canCollectComments: ready && this.options.commentsEnabled?.() === true,
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
    const admission = this.budgetScope.getStore();
    if (admission) delete admission.failure;
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
          'unknown_rejection',
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
      // RedbookClient intentionally wraps transport failures. Preserve only the
      // local pre-dispatch admission result, never provider text or responses.
      if (!this.stopCode && admission?.failure) throw admission.failure;
      throw error;
    }
  }
  private async restoreContext(
    authorId: string,
    noteId?: string,
    signal?: AbortSignal,
  ) {
    // Existing manual workflows retain their explicit reparse boundary.
    if (this.budgetScope.getStore())
      await this.adapter.restoreContext(authorId, noteId, signal);
  }
  resolve(url: string) {
    return this.withSession(() => this.adapter.resolve(url));
  }
  list(authorId: string, cursor: string | null, signal?: AbortSignal) {
    return this.withSession(async () => {
      await this.restoreContext(authorId, undefined, signal);
      return this.adapter.list(authorId, cursor, signal);
    });
  }
  detail(authorId: string, noteId: string, signal?: AbortSignal) {
    return this.withSession(() =>
      this.restoreContext(authorId, noteId, signal).then(() =>
        this.adapter.detail(authorId, noteId, signal),
      ),
    );
  }
  metrics(authorId: string, noteId?: string) {
    return this.withSession(async () => {
      await this.restoreContext(authorId, noteId);
      return this.adapter.metrics(authorId, noteId);
    });
  }
  comments(authorId: string, noteId: string, cursor: string, rootId?: string) {
    if (this.options.commentsEnabled?.() !== true)
      return failure('XHS_COMMENT_COLLECTION_DISABLED');
    return this.withSession(() =>
      this.restoreContext(authorId, noteId).then(() =>
        this.adapter.comments(authorId, noteId, cursor, rootId),
      ),
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
    commentsEnabled: () => process.env.XHS_COMMENT_COLLECTION_ENABLED === '1',
    enabled: () =>
      process.env.XHS_SUBSCRIPTION_LIVE_ENABLED === '1' &&
      !privateOnlineMode() &&
      process.env.WEWE_ACCEPTANCE_MODE !== '1',
    vault,
    profileParser: parseXhsProfile,
  });
}
