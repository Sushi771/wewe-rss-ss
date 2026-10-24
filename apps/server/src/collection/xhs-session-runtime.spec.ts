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
  it('stops the current session after verification/permission failures instead of dispatching again', async () => {
    const api: jest.MockedFunction<RedbookTransport> = jest.fn(
      async (request) => ({ status: 471, url: request.url, body: {} }),
    );
    const runtime = new XhsSubscriptionRuntime({ enabled: () => true, api });
    await runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
    });
    await expect(runtime.resolve(noteUrl)).rejects.toThrow('verification');
    expect(runtime.capability().canRefresh).toBe(false);
    expect(await runtime.connectionStatus()).toMatchObject({
      code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
      verified: false,
    });
    await expect(runtime.resolve(noteUrl)).rejects.toThrow(
      'XHS_SOURCE_VERIFICATION_BLOCKED',
    );
    expect(api).toHaveBeenCalledTimes(1);
  });
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
