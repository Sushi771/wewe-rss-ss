beforeAll(require('../../../../scripts/local-release/writer-self.fixture.test.cjs').prepareWriterSelf);
import { XhsRequestBudget } from './xhs-request-budget';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  XhsSubscriptionRuntime,
  createLocalXhsSubscriptionRuntime,
} from './xhs-subscription-runtime';
import {
  XHS_SUBSCRIPTION_SOURCE,
  XhsSubscriptionService,
} from './xhs-subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcRouter, isLocalXhsStatusRequest } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcModule } from '../trpc/trpc.module';
import { RedbookTransport } from './redbook-client';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { projectWriterGate } from './project-writer-boundary';

const cookies = {
  a1: 'synthetic-a1-only',
  web_session: 'synthetic-session-only',
};
const author = {
  id: 'synthetic-author',
  name: 'Synthetic author',
  profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic-author',
};
const noteUrl =
  'https://www.xiaohongshu.com/explore/synthetic-note?xsec_token=synthetic-note-access&xsec_source=app_share';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const vault = () => ({
  status: jest.fn(async () => ({ stored: true })),
  store: jest.fn(async () => {}),
  load: jest.fn(async () => ({ ...cookies })),
  disconnect: jest.fn(async () => {}),
});
function fixture() {
  const api: jest.MockedFunction<RedbookTransport> = jest.fn(
    async (request) => {
      const url = new URL(request.url);
      const data = url.pathname.endsWith('user_posted')
        ? {
            notes: [
              {
                note_id: 'synthetic-note',
                user: { user_id: author.id },
                xsec_token: 'synthetic-list-access',
                type: 'normal',
                display_title: 'Synthetic',
              },
            ],
            has_more: false,
            cursor: '',
          }
        : url.pathname.endsWith('otherinfo')
          ? { syntheticSchema: 1, author }
          : {
              items: [
                {
                  id: 'synthetic-note',
                  note_card: {
                    note_id: 'synthetic-note',
                    user: { user_id: author.id, nickname: author.name },
                    type: 'normal',
                    time: 1760000000000,
                    title: 'Synthetic',
                    desc: 'Synthetic body',
                    image_list: [
                      {
                        url_pre: 'https://sns-webpic.xhscdn.com/preview',
                        info_list: [
                          {
                            url: 'http://sns-webpic-qc.xhscdn.com/full?synthetic=1',
                            image_scene: 'WB_DFT',
                            width: 100,
                            height: 100,
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            };
      return {
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data },
      };
    },
  );
  const media = jest.fn(async (url: URL, _options: any) => {
    void _options;
    const response = new Response(png, {
      headers: { 'content-type': 'image/png' },
    });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  });
  return { api, media };
}
describe('default-off production source wiring with synthetic sessions only', () => {
  it('reports the process stop while disabled and restores a session without clearing it or dispatching', async () => {
    let enabled = true;
    const storage = vault();
    const api: jest.MockedFunction<RedbookTransport> = jest.fn(
      async (request) => ({
        status: 461,
        url: request.url,
        body: {},
      }),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => enabled,
      vault: storage,
      api,
    });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    await expect(runtime.resolve(noteUrl)).rejects.toMatchObject({
      reason: 'unknown_rejection',
    });
    expect(api).toHaveBeenCalledTimes(1);
    enabled = false;
    const disabled = await runtime.connectionStatus();
    expect(disabled).toMatchObject({
      liveEnabled: false,
      connected: false,
      sessionPresent: true,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
      code: 'XHS_LIVE_ACCESS_DISABLED',
    });
    expect(storage.status).not.toHaveBeenCalled();
    expect(storage.load).not.toHaveBeenCalled();
    expect(JSON.stringify(disabled)).not.toContain(cookies.a1);
    expect(JSON.stringify(disabled)).not.toContain(cookies.web_session);
    enabled = true;
    const restored = await runtime.restoreSession();
    expect(storage.load).toHaveBeenCalledTimes(1);
    expect(restored).toMatchObject({
      connected: true,
      sessionPresent: true,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
      code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    await expect(runtime.resolve(noteUrl)).rejects.toThrow(
      'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    );
    expect(api).toHaveBeenCalledTimes(1);
    await runtime.disconnectSession();
    expect((await runtime.connectionStatus()).riskCode).toBe(
      'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    );
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    await expect(runtime.resolve(noteUrl)).rejects.toThrow(
      'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    );
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  });
  it('charges context reconstruction, queued work and media before transport without an extra dispatch', async () => {
    const injected = fixture();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api: injected.api,
      media: injected.media,
      profileParser: () => author,
    });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    function allowance(limit: number) {
      let used = 0;
      return {
        budget: new XhsRequestBudget({
          reserve: async () => {
            if (used >= limit) return false;
            used++;
            return true;
          },
          read: async (id) => ({ id, used, limit, nextAt: 0, intervalMs: 0 }),
        }),
        used: () => used,
      };
    }
    const first = allowance(1);
    await expect(
      runtime.withRequestBudget(first.budget, 'first', () =>
        runtime.list(author.id, null),
      ),
    ).rejects.toThrow('XHS_REQUEST_BUDGET_EXHAUSTED');
    expect(injected.api).toHaveBeenCalledTimes(1);
    expect(first.used()).toBe(1);
    const next = allowance(3);
    await runtime.withRequestBudget(next.budget, 'next', async () => {
      // Register a queued continuation inside the same admission scope.
      await Promise.resolve().then(() => runtime.list(author.id, null));
      await runtime.detail(author.id, 'synthetic-note');
      await expect(
        runtime.metrics(author.id, 'synthetic-note'),
      ).rejects.toThrow('XHS_REQUEST_BUDGET_EXHAUSTED');
    });
    expect(next.used()).toBe(3);
    expect(injected.api).toHaveBeenCalledTimes(3);
    expect(injected.media).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  });
  it('keeps comment collection separately default-off without loading credentials or issuing a request', () => {
    const storage = vault(),
      api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      vault: storage,
      api,
    });
    expect(runtime.capability().canCollectComments).toBe(false);
    expect(() =>
      runtime.comments('synthetic-author', 'synthetic-note', ''),
    ).toThrow('XHS_COMMENT_COLLECTION_DISABLED');
    expect(api).not.toHaveBeenCalled();
    expect(storage.load).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
  });
  it('routes explicit top/reply pages through injected transport and stops without retries after signature rejection', async () => {
    const base = fixture();
    let rejectSignature = false;
    const api = jest.fn(async (request: Parameters<RedbookTransport>[0]) => {
      if (!new URL(request.url).pathname.includes('/comment/'))
        return base.api(request);
      if (rejectSignature)
        return {
          status: 406,
          url: request.url,
          body: { success: false, code: 300015 },
        };
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: {
            comments: [
              {
                id: request.url.includes('/sub/page') ? 'reply' : 'root',
                content: 'synthetic-only',
                like_count: '0',
                user_info: { nickname: 'Synthetic' },
              },
            ],
            has_more: false,
            cursor: '',
          },
        },
      };
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      commentsEnabled: () => true,
      api,
      media: base.media,
    });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    await runtime.resolve(noteUrl);
    expect(
      (await runtime.comments(author.id, 'synthetic-note', '')).comments[0],
    ).toMatchObject({ id: 'root', rootId: null, likes: 0 });
    expect(
      (await runtime.comments(author.id, 'synthetic-note', '', 'root'))
        .comments[0],
    ).toMatchObject({ id: 'reply', rootId: 'root', parentId: null });
    expect((await runtime.connectionStatus()).requestAttempts).toMatchObject({
      comments: 1,
      replies: 1,
    });
    rejectSignature = true;
    await expect(
      runtime.comments(author.id, 'synthetic-note', ''),
    ).rejects.toThrow('signature');
    const count = api.mock.calls.length;
    await expect(
      runtime.comments(author.id, 'synthetic-note', ''),
    ).rejects.toThrow('XHS_SOURCE_SIGNATURE_BLOCKED');
    expect(api).toHaveBeenCalledTimes(count);
    expect(runtime.capability().canCollectComments).toBe(false);
    runtime.onModuleDestroy();
  });
  it('registers the production source alias and never treats a disabled source as refresh-ready', async () => {
    const providers = Reflect.getMetadata('providers', TrpcModule);
    expect(
      providers.find((p: any) => p.provide === XHS_SUBSCRIPTION_SOURCE),
    ).toMatchObject({ useExisting: XhsSubscriptionRuntime });
    const storage = vault(),
      api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => false,
      vault: storage,
      api,
    });
    const module = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: XhsSubscriptionRuntime, useValue: runtime },
        {
          provide: XHS_SUBSCRIPTION_SOURCE,
          useExisting: XhsSubscriptionRuntime,
        },
        XhsSubscriptionService,
      ],
    }).compile();
    expect(module.get(XHS_SUBSCRIPTION_SOURCE)).toBe(runtime);
    expect(module.get(XhsSubscriptionService).capability()).toMatchObject({
      canSubscribe: false,
      canRefresh: false,
      canDownload: false,
    });
    expect(await runtime.connectionStatus()).toMatchObject({
      liveEnabled: false,
      connected: false,
      stored: null,
      code: 'XHS_LIVE_ACCESS_DISABLED',
    });
    await expect(
      runtime.connectSession({
        a1: cookies.a1,
        webSession: cookies.web_session,
        persist: true,
      }),
    ).rejects.toThrow('XHS_LIVE_ACCESS_DISABLED');
    await expect(runtime.restoreSession()).rejects.toThrow(
      'XHS_LIVE_ACCESS_DISABLED',
    );
    await expect(runtime.resolve(noteUrl)).rejects.toThrow(
      'XHS_LIVE_ACCESS_DISABLED',
    );
    expect(storage.status).not.toHaveBeenCalled();
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.store).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    await module.close();
  });
  it('keeps the normal host factory default off without inspecting credentials', async () => {
    const old = process.env.XHS_SUBSCRIPTION_LIVE_ENABLED;
    const oldUrl = process.env.DATABASE_URL;
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'xhs-disabled-boundary-'));
    const file = path.join(dir, 'synthetic.sqlite');
    await fs.writeFile(file, '', { flag: 'wx' });
    process.env.DATABASE_URL = 'file:' + file.replace(/\\/g, '/');
    delete process.env.XHS_SUBSCRIPTION_LIVE_ENABLED;
    try {
      const runtime = createLocalXhsSubscriptionRuntime();
      expect(await runtime.connectionStatus()).toMatchObject({
        liveEnabled: false,
        stored: null,
        connected: false,
      });
      runtime.onModuleDestroy();
    } finally {
      projectWriterGate().writerForUrl(process.env.DATABASE_URL)?.close();
      if (oldUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldUrl;
      await fs.rm(dir, { recursive: true, force: true });
      if (old === undefined) delete process.env.XHS_SUBSCRIPTION_LIVE_ENABLED;
      else process.env.XHS_SUBSCRIPTION_LIVE_ENABLED = old;
    }
  });
  it('connects only in memory by default, does not read/store old credentials and does not claim verified login', async () => {
    const storage = vault(),
      { api, media } = fixture();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      vault: storage,
      api,
      media,
    });
    const status = await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    expect(status).toMatchObject({
      connected: true,
      verified: false,
      stored: null,
      restartRequiresReparse: true,
    });
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.store).not.toHaveBeenCalled();
    expect(storage.status).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain(cookies.a1);
    expect(JSON.stringify(status)).not.toContain(cookies.web_session);
    runtime.onModuleDestroy();
    expect(runtime.capability().canRefresh).toBe(false);
  });
  it('uses only edith for signed reads and selects verified HTTPS native images without account headers', async () => {
    const { api, media } = fixture();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      media,
    });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    expect(await runtime.resolve(noteUrl)).toEqual({
      inputKind: 'note',
      author,
    });
    expect(media).not.toHaveBeenCalled();
    expect(await runtime.list(author.id, null)).toMatchObject({
      notes: [{ noteId: 'synthetic-note' }],
    });
    const note = await runtime.detail(author.id, 'synthetic-note');
    expect(note.images).toHaveLength(1);
    expect(note.images[0].inlineData).toContain(png.toString('base64'));
    for (const [request] of api.mock.calls) {
      expect(new URL(request.url).hostname).toBe('edith.xiaohongshu.com');
      expect(request.headers.cookie).toBe(
        `a1=${cookies.a1}; web_session=${cookies.web_session}`,
      );
      expect(request.redirect).toBe('error');
    }
    expect(media).toHaveBeenCalledTimes(1);
    expect(media.mock.calls[0][0].href).toBe(
      'https://sns-webpic-qc.xhscdn.com/full?synthetic=1',
    );
    expect(media.mock.calls[0][1]).toMatchObject({
      redirect: 'manual',
      credentials: 'omit',
    });
    expect(Object.keys(media.mock.calls[0][1].headers)).toEqual(['accept']);
    const attemptStatus = await runtime.connectionStatus();
    expect(attemptStatus.requestAttempts).toMatchObject({
      profiles: 0,
      lists: 1,
      details: 2,
      media: 1,
      shortLinks: 0,
    });
    expect((await runtime.connectionStatus()).requestAttempts).toEqual(
      attemptStatus.requestAttempts,
    );
    expect(JSON.stringify(attemptStatus.requestAttempts)).not.toContain(
      cookies.a1,
    );
    expect(JSON.stringify(attemptStatus.requestAttempts)).not.toContain(
      'xiaohongshu.com',
    );
    expect(await runtime.connectionStatus()).toMatchObject({
      connected: true,
      verified: true,
    });
  });
  it('requires explicit protected storage and restore actions; a new process never auto-restores access contexts', async () => {
    const storage = vault(),
      first = fixture();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      vault: storage,
      ...first,
    });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
      persist: true,
    });
    expect(storage.store).toHaveBeenCalledTimes(1);
    expect(storage.load).not.toHaveBeenCalled();
    await runtime.resolve(noteUrl);
    runtime.onModuleDestroy();
    const fresh = new XhsSubscriptionRuntime({
      enabled: () => true,
      vault: storage,
      ...fixture(),
    });
    expect((await fresh.connectionStatus()).connected).toBe(false);
    expect(storage.load).not.toHaveBeenCalled();
    await fresh.restoreSession();
    expect(storage.load).toHaveBeenCalledTimes(1);
    await expect(fresh.list(author.id, null)).rejects.toThrow(
      'XHS_ACCESS_CONTEXT_EXPIRED',
    );
    await fresh.resolve(noteUrl);
    expect(await fresh.list(author.id, null)).toMatchObject({
      notes: [{ noteId: 'synthetic-note' }],
    });
  });
  it('aborts in-flight requests and rejects their late response when disconnected', async () => {
    let release!: (value: any) => void, requestSignal: AbortSignal | undefined;
    const storage = vault(),
      f = fixture();
    const api: RedbookTransport = async (request) => {
      requestSignal = request.signal;
      return new Promise(
        (resolve) =>
          (release = (value) => resolve({ ...value, url: request.url })),
      );
    };
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      vault: storage,
      api,
    });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    const pending = runtime.resolve(noteUrl);
    while (!release) await Promise.resolve();
    const stopped = await runtime.disconnectSession();
    expect(stopped.connected).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    expect(storage.disconnect).toHaveBeenCalledTimes(1);
    release(
      await f.api({
        url: 'https://edith.xiaohongshu.com/api/sns/web/v1/feed',
        method: 'POST',
        headers: {},
        redirect: 'error',
        timeoutMs: 15000,
        maxResponseBytes: 8000000,
      }),
    );
    await expect(pending).rejects.toThrow('XHS_SESSION_CHANGED');
  });
  it.each([461, 471])(
    'stops the current session after an unknown HTTP %s rejection instead of dispatching again',
    async (status) => {
      const api: jest.MockedFunction<RedbookTransport> = jest.fn(
        async (request) => ({ status, url: request.url, body: {} }),
      );
      const runtime = new XhsSubscriptionRuntime({ enabled: () => true, api });
      await runtime.connectSession({
        a1: cookies.a1,
        webSession: cookies.web_session,
      });
      await expect(runtime.resolve(noteUrl)).rejects.toThrow(
        'unknown_rejection',
      );
      expect(runtime.capability().canRefresh).toBe(false);
      expect(await runtime.connectionStatus()).toMatchObject({
        code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
        verified: false,
      });
      await expect(runtime.resolve(noteUrl)).rejects.toThrow(
        'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
      );
      expect(api).toHaveBeenCalledTimes(1);
    },
  );
  it('does not claim protected-record deletion when cleanup failed, while memory access remains disconnected', async () => {
    const storage = vault();
    storage.disconnect.mockRejectedValue(Error('synthetic filesystem failure'));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      vault: storage,
    });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    expect(await runtime.disconnectSession()).toMatchObject({
      connected: false,
      stored: null,
      code: 'XHS_DISCONNECT_INCOMPLETE',
    });
    await expect(runtime.resolve(noteUrl)).rejects.toThrow(
      'XHS_SESSION_REQUIRED',
    );
  });
  it('protects all credential-management routes with auth and local same-origin checks', async () => {
    const storage = vault(),
      f = fixture(),
      runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        vault: storage,
        ...f,
      });
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const db = {} as any;
    const router = new TrpcRouter(
      new TrpcService(db, config, {} as any, {} as any),
      db,
      config,
      {} as any,
      {} as any,
      undefined,
      undefined,
      runtime,
    ).appRouter;
    await expect(
      router
        .createCaller({ errorMsg: 'synthetic unauthorized', isLocalSave: true })
        .xiaohongshu.connectionStatus(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const remote = router.createCaller({ errorMsg: null, isLocalSave: false });
    await expect(remote.xiaohongshu.connectionStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      remote.xiaohongshu.connectSession({
        a1: cookies.a1,
        webSession: cookies.web_session,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(remote.xiaohongshu.restoreSession()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(remote.xiaohongshu.disconnectSession()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.store).not.toHaveBeenCalled();
    const readOnly = router.createCaller({
      errorMsg: null,
      isLocalXhsRead: true,
    });
    expect(await readOnly.xiaohongshu.connectionStatus()).toMatchObject({
      connected: false,
    });
    await expect(readOnly.xiaohongshu.restoreSession()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      readOnly.xiaohongshu.resolveSubscription({ url: noteUrl }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(storage.load).not.toHaveBeenCalled();
    const local = router.createCaller({ errorMsg: null, isLocalSave: true });
    expect(
      await local.xiaohongshu.connectSession({
        a1: cookies.a1,
        webSession: cookies.web_session,
      }),
    ).toMatchObject({ connected: true, verified: false });
    expect(await local.xiaohongshu.disconnectSession()).toMatchObject({
      connected: false,
    });
  });
  it('permits Origin-less loopback GET status only and rejects remote, foreign Host and cross-site Origin', () => {
    const local = {
      method: 'GET',
      protocol: 'http',
      host: '127.0.0.1:4239',
      remoteAddress: '127.0.0.1',
    };
    expect(isLocalXhsStatusRequest(local)).toBe(true);
    expect(
      isLocalXhsStatusRequest({ ...local, origin: 'http://127.0.0.1:4239' }),
    ).toBe(true);
    for (const change of [
      { method: 'POST' },
      { host: 'attacker.test:4239' },
      { remoteAddress: '192.0.2.1' },
      { origin: 'https://attacker.test' },
      { origin: 'http://127.0.0.1:4240' },
      { origin: 'null' },
    ])
      expect(isLocalXhsStatusRequest({ ...local, ...change })).toBe(false);
  });
});

it.each([
  [461, {}, 'unknown_rejection'],
  [471, {}, 'unknown_rejection'],
  [461, { msg: 'captcha required' }, 'verification'],
  [471, { code: -100 }, 'authentication'],
])(
  'hard stops HTTP %s without retry, refund or expansion of the request budget',
  async (status, body, reason) => {
    const api: jest.MockedFunction<RedbookTransport> = jest.fn(
      async (request) => ({ status: status as number, url: request.url, body }),
    );
    const runtime = new XhsSubscriptionRuntime({ enabled: () => true, api });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    const state = {
      id: 'synthetic-budget',
      limit: 14,
      used: 13,
      nextAt: 0,
      intervalMs: 0,
    };
    const reserve = jest.fn(async () => {
      if (state.used >= state.limit) return false;
      state.used++;
      return true;
    });
    const budget = new XhsRequestBudget({
      reserve,
      read: async () => ({ ...state }),
    });
    await expect(
      runtime.withRequestBudget(budget, state.id, () =>
        runtime.resolve(noteUrl),
      ),
    ).rejects.toThrow(String(reason));
    const code = `XHS_SOURCE_${String(reason).toUpperCase()}_BLOCKED`;
    expect(await runtime.connectionStatus()).toMatchObject({
      code,
      verified: false,
    });
    expect(runtime.capability().canDownload).toBe(false);
    await expect(
      runtime.withRequestBudget(budget, state.id, () =>
        runtime.resolve(noteUrl),
      ),
    ).rejects.toThrow(code);
    expect(api).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      limit: 14,
      used: 14,
      intervalMs: 0,
      nextAt: 0,
    });
  },
);
