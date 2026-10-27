import type { Prisma } from '@prisma/client';
import { setTimeout as waitForRate } from 'node:timers/promises';
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
  xhsPublicInputUrl,
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
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsLimitedRecoveryStore } from './xhs-limited-recovery-store';
import { inspectLimitedRecovery } from './xhs-limited-recovery-inspect';
import { sourceOriginalLink } from './xhs-source-original-link';
import {
  commitWholeSourceCheckpoint,
  type WholeSourceGroup,
  type Phase,
  type Charge,
} from './xhs-whole-source-fence';

type RequestAdmission = {
  budget?: XhsRequestBudget;
  id: string;
  failure?: unknown;
  parent?: RequestAdmission;
  sourceTotalCovered?: boolean;
};
type RuntimeOptions = {
  commentsEnabled?: () => boolean;
  enabled: () => boolean;
  vault?: XhsSessionVault;
  api?: RedbookTransport;
  media?: RedbookMediaTransport;
  shortLinks?: XhsShortLinkTransport;
  profileParser?: XhsProfileParser;
  requirePersistentRisk?: boolean;
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
  private readonly budgetScope = new AsyncLocalStorage<RequestAdmission>();
  private readonly wholeSourceGroup = new AsyncLocalStorage<
    WholeSourceGroup & { checkpointed: boolean; noteId?: string }
  >();
  private readonly wholeAuthorization = new AsyncLocalStorage<{
    jobId: string;
    creatorId: string;
    authorId: string;
  }>();
  withWholeAuthorization<T>(
    scope: { jobId: string; creatorId: string; authorId: string },
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.wholeAuthorization.getStore())
      return Promise.reject(
        new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'),
      );
    return this.wholeAuthorization.run(scope, work);
  }
  withCheckpointGroup<T>(
    phase: Phase,
    authorId: string,
    noteId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const scope = this.wholeAuthorization.getStore();
    if (!scope) return work();
    if (scope.authorId !== authorId)
      return Promise.reject(
        new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED'),
      );
    return this.withWholeSourceGroup({ ...scope, phase, noteId }, work);
  }

  async withWholeSourceGroup<T>(
    scope: {
      jobId: string;
      creatorId: string;
      authorId: string;
      phase: Phase;
      noteId?: string;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.wholeSourceGroup.getStore())
      return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    const group = {
      ...scope,
      marker: 'xhs:dispatch-pending:whole:' + randomUUID(),
      acquired: false,
      started: false,
      checkpointed: false,
    };
    return this.wholeSourceGroup.run(group, async () => {
      const result = await work();
      if (group.acquired && !group.checkpointed)
        return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      return result;
    });
  }
  async checkpointWholeSource(
    tx: Prisma.TransactionClient,
    collectedAt?: number,
  ) {
    const group = this.wholeSourceGroup.getStore();
    if (group?.acquired) {
      if (!group.started) return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      await commitWholeSourceCheckpoint(
        tx,
        group.jobId,
        group.marker,
        collectedAt,
      );
      group.checkpointed = true;
    }
  }
  private checkWholeAuthor(authorId: string, noteId?: string) {
    const group = this.wholeSourceGroup.getStore();
    if (
      group &&
      (group.authorId !== authorId ||
        (noteId !== undefined && group.noteId !== noteId))
    )
      return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  }

  private readonly limitedRecoveryScope = new AsyncLocalStorage<{
    noteId: string;
    owner: string;
    started: boolean;
    isCancelled?: () => boolean;
  }>();
  private limitedRecoveryStore?: XhsLimitedRecoveryStore;
  bindLimitedRecoveryStore(store: XhsLimitedRecoveryStore) {
    this.limitedRecoveryStore ??= store;
  }
  withRequestBudget<T>(
    budget: XhsRequestBudget,
    id: string,
    work: () => Promise<T>,
    sourceTotalCovered = false,
  ) {
    const parent = this.budgetScope.getStore();
    // Preserve an enclosing test/operator cap; the same budget object/ID is one gate.
    for (let scope = parent; scope; scope = scope.parent)
      if (scope.id === id && scope.budget === budget) return work();
    return this.budgetScope.run(
      { budget, id, parent, sourceTotalCovered },
      work,
    );
  }
  private readonly batchDispatchScope = new AsyncLocalStorage<{
    assertReady: (tx?: Prisma.TransactionClient) => Promise<void>;
    isCancelled: () => boolean;
    onDispatch: () => void;
    onReceipt: () => void;
  }>();
  withBatchDispatch<T>(
    guard: {
      assertReady: (tx?: Prisma.TransactionClient) => Promise<void>;
      isCancelled: () => boolean;
      onDispatch: () => void;
      onReceipt: () => void;
    },
    work: () => Promise<T>,
  ) {
    return this.batchDispatchScope.run(guard, work);
  }
  private readonly originalLinks = new Map<
    string,
    Promise<import('@wewe-rss/shared').XhsOriginalLinkResult>
  >();
  private sourceAdmission?: (
    alreadyBudgeted: boolean,
    group?: WholeSourceGroup,
    ready?: (tx?: Prisma.TransactionClient) => Promise<void>,
  ) => Promise<(() => Promise<void>) | void>;
  private sourceDispatch?: <T>(
    operation: () => Promise<T>,
    ready: (tx?: Prisma.TransactionClient) => Promise<void>,
    group?: WholeSourceGroup,
    charge?: Charge,
  ) => Promise<T>;
  bindSourceAdmission(
    admit: (
      alreadyBudgeted: boolean,
      group?: WholeSourceGroup,
      ready?: (tx?: Prisma.TransactionClient) => Promise<void>,
    ) => Promise<(() => Promise<void>) | void>,
    dispatch?: XhsSubscriptionRuntime['sourceDispatch'],
  ) {
    this.sourceAdmission ??= admit;
    this.sourceDispatch ??= dispatch;
  }
  private cookies?: XhsSessionCookies;
  private generation = 0;
  private sessionAbort = new AbortController();
  private changing = false;
  private stored: boolean | null = null;
  private verified = false;
  private stopCode?: string;
  private persistedRisk?: string;
  private riskStore?: XhsSourceRiskStore;
  bindRiskStore(store: XhsSourceRiskStore) {
    this.riskStore ??= store;
  }
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
      transport: async (request) => {
        const group = this.wholeSourceGroup.getStore();
        if (group) {
          const url = new URL(request.url);
          const route = url.pathname;
          if (route === '/api/sns/web/v1/user/otherinfo') {
            if (
              request.method !== 'GET' ||
              url.searchParams.get('target_user_id') !== group.authorId
            )
              return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
          } else if (route === '/api/sns/web/v1/user_posted') {
            if (
              request.method !== 'GET' ||
              url.searchParams.get('user_id') !== group.authorId
            )
              return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
          } else if (route === '/api/sns/web/v1/feed') {
            let body: any;
            try {
              body = JSON.parse(request.body || '');
            } catch {
              return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
            }
            if (
              request.method !== 'POST' ||
              !group.noteId ||
              body?.source_note_id !== group.noteId ||
              !['detail', 'metrics'].includes(group.phase)
            )
              return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
          } else return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
        }
        const recovery = this.limitedRecoveryScope.getStore();
        if (recovery) {
          let body: any;
          try {
            body = JSON.parse(request.body || '');
          } catch {
            return failure('XHS_URL_INVALID');
          }
          if (
            recovery.started ||
            request.method !== 'POST' ||
            new URL(request.url).pathname !== '/api/sns/web/v1/feed' ||
            body?.source_note_id !== recovery.noteId
          )
            return failure('XHS_SOURCE_RISK_REVIEW_REQUIRED');
          await this.limitedRecoveryStore!.start(
            recovery.owner,
            recovery.noteId,
          );
          recovery.started = true;
        }
        const route = new URL(request.url).pathname;
        const charge: Charge = route.endsWith('/user/otherinfo') ? 'profile' : route.endsWith('/user_posted') ? 'list' : group?.phase === 'metrics' ? 'metrics' : 'detail';
        return this.guardTransport(() =>
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
        charge);
      },
    });
    this.adapter = new RedbookSubscriptionAdapter(
      client,
      {
        profileParser: options.profileParser,
        shortLinks: new XhsShortLinkResolver(async (url, request) => {
          if (this.wholeSourceGroup.getStore())
            return failure('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
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
        'media'),
    );
  }
  private async guardTransport<T>(operation: () => Promise<T>, charge?: Charge) {
    this.requireSession();
    const generation = this.generation,
      signal = this.sessionAbort.signal;
    const admission = this.budgetScope.getStore();
    const scopes: RequestAdmission[] = [];
    for (let scope = admission; scope; scope = scope.parent)
      if (scope.budget) scopes.push(scope);
    const totalCovered = scopes.some((scope) => scope.sourceTotalCovered);
    const undo: Array<() => Promise<void>> = [];
    let dispatched = false;
    const ready = async (tx?: Prisma.TransactionClient) => {
      const batch = this.batchDispatchScope.getStore();
      if (batch?.isCancelled()) return failure('XHS_TASK_CANCELLED');
      if (batch) await batch.assertReady(tx);
      const recovery = this.limitedRecoveryScope.getStore();
      if (recovery?.isCancelled?.()) return failure('XHS_TASK_CANCELLED');
      if (recovery)
        await this.limitedRecoveryStore!.assertActive(recovery.owner, tx);
      for (const scope of scopes) await scope.budget!.assertReady(tx);
      this.requireSession();
      if (generation !== this.generation || signal.aborted)
        return failure('XHS_SESSION_CHANGED');
    };
    const dispatch = () => {
      const batch = this.batchDispatchScope.getStore();
      if (batch?.isCancelled()) return failure('XHS_TASK_CANCELLED');
      if (this.limitedRecoveryScope.getStore()?.isCancelled?.())
        return failure('XHS_TASK_CANCELLED');
      this.requireSession();
      if (generation !== this.generation || signal.aborted)
        return failure('XHS_SESSION_CHANGED');
      dispatched = true;
      batch?.onDispatch();
      try {
        return operation();
      } catch (error) {
        return Promise.reject(error);
      }
    };
    let result: T;
    try {
      // Reject already-known failures before any reservation, including generic operator caps.
      for (const scope of scopes) await scope.budget!.check(scope.id);
      if (!totalCovered && this.sourceAdmission) {
        const release = await this.sourceAdmission(
          scopes.length > 0,
          this.wholeSourceGroup.getStore(),
          ready,
        );
        if (release) undo.push(release);
      }
      for (const scope of scopes)
        undo.push(await scope.budget!.reserve(scope.id));
      await ready();
      result = this.sourceDispatch
        ? await this.sourceDispatch(
            dispatch,
            ready,
            this.wholeSourceGroup.getStore(),
            charge,
          )
        : await dispatch();
      this.batchDispatchScope.getStore()?.onReceipt();
    } catch (error) {
      // Only a known non-dispatch permits reservation-specific CAS rollback.
      for (const release of dispatched ? [] : undo.reverse()) {
        try {
          await release();
        } catch {
          /* retain conservatively */
        }
      }
      if (!dispatched && admission) admission.failure = error;
      throw error;
    }
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
    if (
      this.stopCode &&
      !(
        (this.limitedRecoveryScope.getStore() ||
          this.wholeSourceGroup.getStore()) &&
        this.stopCode === 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED'
      )
    )
      return failure(this.stopCode);
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
    this.originalLinks.clear();
  }
  private snapshot(code?: string): XhsConnectionStatus {
    const liveEnabled = this.enabled(),
      connected = liveEnabled && !!this.cookies,
      risk = this.stopCode ?? this.persistedRisk;
    return {
      requestAttempts: { ...this.requestAttempts },
      liveEnabled,
      connected,
      sessionPresent: !!this.cookies,
      riskCode: risk,
      stored: liveEnabled ? this.stored : null,
      verified: connected && this.verified && !risk,
      canConnect: liveEnabled,
      canPersist: liveEnabled && !!this.options.vault,
      restartRequiresReparse: true,
      code:
        code ??
        (!liveEnabled
          ? 'XHS_LIVE_ACCESS_DISABLED'
          : (risk ?? (!connected ? 'XHS_SESSION_REQUIRED' : undefined))),
      message: !liveEnabled
        ? '真实访问尚未启用；未读取凭据。'
        : risk
          ? risk === 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED'
            ? '历史来源状态需要核查；未确认前不会发起来源请求。'
            : risk === 'XHS_SOURCE_RISK_REVIEW_REQUIRED'
              ? '来源操作仍在进行或结果未确认；请等待或核查后再操作。'
              : risk === 'XHS_SOURCE_RISK_UNAVAILABLE'
                ? '本机来源风险状态暂不可用；来源请求已停止。'
                : risk === 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'
                  ? '来源 API 拒绝了请求，原因尚不明确；采集已停止。网页可访问不代表此接口可用，请先核查来源状态。'
                  : risk === 'XHS_SOURCE_VERIFICATION_BLOCKED'
                    ? '来源明确提示需要验证；当前没有可确认的验证入口，采集已停止。'
                    : '当前来源已停止，请先核查来源状态；重新连接不会自动解除限制。'
          : !connected
            ? '尚未连接；请由本机页面明确提供会话或恢复受保护记录。'
            : '本机会话已就绪；不代表平台已确认登录。重启后需重新解析链接。',
    };
  }
  async connectionStatus() {
    if (this.riskStore) {
      try {
        this.persistedRisk = await this.riskStore.read();
      } catch {
        this.stopCode ??= 'XHS_SOURCE_RISK_UNAVAILABLE';
      }
    } else if (this.options.requirePersistentRisk) {
      this.stopCode ??= 'XHS_SOURCE_RISK_UNAVAILABLE';
    }
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
      ready =
        status.liveEnabled &&
        status.connected &&
        !this.stopCode &&
        !this.persistedRisk;
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
  private async withSession<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.budgetScope.getStore())
      return this.budgetScope.run({ id: '' }, () =>
        this.withSession(operation),
      );
    this.requireSession();
    const generation = this.generation;
    const admission = this.budgetScope.getStore();
    if (admission) delete admission.failure;
    if (!this.riskStore && this.options.requirePersistentRisk)
      return failure('XHS_SOURCE_RISK_UNAVAILABLE');
    let riskOwner: string | undefined;
    if (
      this.riskStore &&
      !this.limitedRecoveryScope.getStore() &&
      !this.wholeSourceGroup.getStore()
    ) {
      try {
        riskOwner = await this.riskStore.begin();
      } catch (error) {
        const code =
          error instanceof XhsSubscriptionError
            ? error.code
            : 'XHS_SOURCE_RISK_UNAVAILABLE';
        // A live concurrent operation also owns a pending fence. Reject this
        // caller without poisoning the owner; a crash leaves the fence durable.
        if (code !== 'XHS_SOURCE_RISK_REVIEW_REQUIRED') this.stopCode = code;
        return failure(code);
      }
    }
    try {
      const result = await operation();
      if (generation !== this.generation) return failure('XHS_SESSION_CHANGED');
      this.requireSession();
      if (riskOwner) {
        const owner = riskOwner;
        riskOwner = undefined;
        try {
          await this.riskStore!.finish(owner);
        } catch {
          this.stopCode = 'XHS_SOURCE_RISK_UNAVAILABLE';
          return failure(this.stopCode);
        }
        this.persistedRisk = undefined;
      }
      if (
        !this.limitedRecoveryScope.getStore() &&
        !this.wholeSourceGroup.getStore()
      )
        this.verified = true;
      return result;
    } catch (error) {
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
      if (riskOwner) {
        const known =
          admission?.failure instanceof XhsSubscriptionError
            ? admission.failure
            : error;
        const code =
          this.stopCode ??
          ((admission?.failure === known &&
            known instanceof XhsSubscriptionError &&
            known.code === 'XHS_TASK_CANCELLED') ||
          (known instanceof XhsSubscriptionError &&
            [
              'XHS_REQUEST_BUDGET_REQUIRED',
              'XHS_REQUEST_BUDGET_EXHAUSTED',
              'XHS_REQUEST_RATE_PAUSED',
              'XHS_ACCESS_CONTEXT_UNAVAILABLE',
              'XHS_ACCESS_CONTEXT_EXPIRED',
            ].includes(known.code))
            ? undefined
            : 'XHS_SOURCE_RISK_REVIEW_REQUIRED');
        try {
          await this.riskStore!.finish(
            riskOwner,
            code,
            error instanceof RedbookPauseError
              ? { status: error.httpStatus, endpoint: error.endpoint }
              : undefined,
          );
          this.persistedRisk = code;
        } catch {
          this.stopCode = 'XHS_SOURCE_RISK_UNAVAILABLE';
          return failure(this.stopCode);
        }
      }
      if (generation !== this.generation) return failure('XHS_SESSION_CHANGED');
      if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
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
    for (let scope = this.budgetScope.getStore(); scope; scope = scope.parent) {
      if (scope.budget) {
        await this.adapter.restoreContext(authorId, noteId, signal);
        return;
      }
    }
  }
  assertSourceReady() {
    this.requireSession();
  }
  async waitForSourceRate(ms: number) {
    this.requireSession();
    try {
      await waitForRate(ms, undefined, { signal: this.sessionAbort.signal });
    } catch {
      this.requireSession();
      return failure('XHS_SESSION_CHANGED');
    }
    this.requireSession();
  }
  cachedOriginalLink(authorId: string, noteId: string) {
    this.requireSession();
    return this.adapter.cachedOriginalLink(authorId, noteId);
  }
  prepareOriginalLink(
    authorId: string,
    noteId: string,
    refreshContext = false,
  ) {
    this.requireSession();
    const key = JSON.stringify([
      this.generation,
      authorId,
      noteId,
      refreshContext,
    ]);
    const active = this.originalLinks.get(key);
    if (active) return active;
    const pending = this.withSession(() =>
      this.adapter.prepareOriginalLink(authorId, noteId, refreshContext),
    ).finally(() => this.originalLinks.delete(key));
    this.originalLinks.set(key, pending);
    return pending;
  }
  resolve(url: string) {
    return this.withSession(() => this.adapter.resolve(url));
  }
  async resolveLimitedRecovery(
    raw: string,
    expectedAuthorId: string,
    isCancelled?: () => boolean,
    appendUnknownAttempt = false,
  ) {
    const url = xhsPublicInputUrl(raw);
    const match =
      /^\/(?:explore|discovery\/item)\/([a-zA-Z0-9_-]{1,128})\/?$/.exec(
        url.pathname,
      );
    if (
      url.hostname !== 'www.xiaohongshu.com' ||
      !match ||
      !url.searchParams.get('xsec_token')
    )
      return failure('XHS_URL_INVALID');
    if (!this.enabled()) return failure('XHS_LIVE_ACCESS_DISABLED');
    if (!this.cookies) return failure('XHS_SESSION_REQUIRED');
    if (!this.limitedRecoveryStore)
      return failure('XHS_SOURCE_RISK_UNAVAILABLE');
    if (!this.sourceAdmission || !this.sourceDispatch)
      return failure('XHS_REQUEST_BUDGET_REQUIRED');
    if (this.stopCode && this.stopCode !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED')
      return failure(this.stopCode);
    const noteId = match[1];
    if (!sourceOriginalLink(raw, url, noteId))
      return failure('XHS_ORIGINAL_LINK_SOURCE_UNAVAILABLE');
    if (isCancelled?.()) return failure('XHS_TASK_CANCELLED');
    const owner = await (appendUnknownAttempt
      ? this.limitedRecoveryStore.armAppend(noteId, expectedAuthorId)
      : this.limitedRecoveryStore.arm(noteId, expectedAuthorId));
    const scope = { noteId, owner, started: false, isCancelled };
    return this.limitedRecoveryScope.run(scope, async () => {
      let projection: ReturnType<typeof inspectLimitedRecovery> | undefined;
      try {
        const resolution = await this.withSession(() =>
          this.adapter.resolve(raw, (value) => {
            projection = value;
          }),
        );
        if (
          !scope.started ||
          !projection ||
          resolution.inputKind !== 'note' ||
          resolution.author.id !== projection.authorId ||
          projection.authorId !== expectedAuthorId
        )
          return failure('XHS_AUTHOR_MISMATCH');
        const transientToken = url.searchParams.get('xsec_token')!;
        if (
          JSON.stringify({
            author: resolution.author,
            note: projection,
          }).includes(transientToken)
        )
          return failure('XHS_DETAIL_INCOMPLETE');
        const original = this.adapter.cachedOriginalLink(
          expectedAuthorId,
          noteId,
        );
        if (original?.state !== 'ready')
          return failure('XHS_ORIGINAL_LINK_SOURCE_UNAVAILABLE');
        return {
          owner,
          author: resolution.author,
          note: projection,
          originalUrl: original.url,
        };
      } catch (error) {
        try {
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
          )
            await this.limitedRecoveryStore!.recordRefusal(
              owner,
              `XHS_SOURCE_${error.reason.toUpperCase()}_BLOCKED`,
            );
          else await this.limitedRecoveryStore!.finish(owner, 'unknown');
        } catch {
          /* retain a durable uncertainty fence */
        }
        throw error;
      }
    });
  }
  list(authorId: string, cursor: string | null, signal?: AbortSignal) {
    this.checkWholeAuthor(authorId);
    return this.withSession(async () => {
      await this.restoreContext(authorId, undefined, signal);
      return this.adapter.list(authorId, cursor, signal);
    });
  }
  detail(authorId: string, noteId: string, signal?: AbortSignal) {
    this.checkWholeAuthor(authorId, noteId);
    return this.withSession(() =>
      this.restoreContext(authorId, noteId, signal).then(() =>
        this.adapter.detail(authorId, noteId, signal),
      ),
    );
  }
  metrics(authorId: string, noteId?: string) {
    this.checkWholeAuthor(authorId, noteId);
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
    requirePersistentRisk: true,
  });
}
