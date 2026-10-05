import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
import {
  saveNativeAccountSession,
  saveNativeAccountProfile,
  previewManualWereadBinding,
  confirmManualWereadBinding,
} from '../collection/owner-weread-binding';
import axios from 'axios';
jest.mock('../collection/sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest.fn(),
}));

describe('private owner accounts', () => {
  const previous = { ...process.env };
  let dir: string;
  const config = {
    get: (key: string) =>
      key === 'platform' ? { url: '' } : { updateDelayTime: 0 },
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.PRIVATE_ONLINE_MODE = '1';
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-account-'));
    process.env.OWNER_SEARCH_CONFIG_FILE = path.join(dir, 'config.json');
  });
  afterEach(async () => {
    process.env = { ...previous };
    await fs.rm(dir, { recursive: true, force: true });
  });
  function setup(prisma: any, weread: any = {}) {
    const service = new TrpcService(prisma, config as any, weread, {} as any);
    const router = new TrpcRouter(
      service,
      prisma,
      config as any,
      weread,
      {} as any,
    );
    return { service, router };
  }
  it('allows authenticated account metadata but rejects anonymous access', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: '123', name: 'owner' }]);
    const { router } = setup({ account: { findMany } });
    await expect(
      router.appRouter.createCaller({ errorMsg: '请先登录' }).account.list({}),
    ).rejects.toThrow('请先登录');
    expect(findMany).not.toHaveBeenCalled();
    expect(
      (await router.appRouter.createCaller({ errorMsg: null }).account.list({}))
        .items,
    ).toHaveLength(1);
    expect(findMany.mock.calls[0][0].select.token).toBe(false);
  });
  it('returns only immutable native scan time, without treating account edits as logins', async () => {
    const capturedAt = '2026-01-02T03:04:05.000Z';
    await saveNativeAccountSession(process.env.OWNER_SEARCH_CONFIG_FILE!, {
      source: 'owner-confirmed-native-web-login',
      ownerVid: '123',
      capturedAt,
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
    });
    const findMany = jest.fn().mockResolvedValue([
      { id: '123', name: 'WeRead_123', updatedAt: new Date() },
      { id: '456', name: 'old-label', updatedAt: new Date() },
    ]);
    const { router } = setup({ account: { findMany } });
    const result = await router.appRouter
      .createCaller({ errorMsg: null })
      .account.list({});
    expect(result.items.map((item) => item.nativeLoginAt)).toEqual([
      capturedAt,
      null,
    ]);
    expect(JSON.stringify(result)).not.toContain('private-fixture');
    expect(JSON.stringify(result)).not.toContain(dir);
    expect(findMany.mock.calls[0][0].select.token).toBe(false);
  });

  it('uses the verified nickname in connection preview without displaying an account number or replacing its identity', async () => {
    const session = {
      source: 'owner-confirmed-native-web-login' as const,
      ownerVid: '123',
      capturedAt: new Date().toISOString(),
      cookies: ['wr_vid', 'wr_skey'].map((name) => ({
        name,
        value: name === 'wr_vid' ? '123' : 'private-fixture',
        domain: '.weread.qq.com',
        path: '/',
        secure: true,
        expires: -1,
      })),
    };
    await fs.writeFile(
      process.env.OWNER_SEARCH_CONFIG_FILE!,
      JSON.stringify({ feeds: {} }),
    );
    await saveNativeAccountSession(
      process.env.OWNER_SEARCH_CONFIG_FILE!,
      session,
    );
    await saveNativeAccountProfile(
      process.env.OWNER_SEARCH_CONFIG_FILE!,
      {
        source: 'owner-confirmed-native-profile',
        ownerVid: '123',
        name: '真实昵称',
        capturedAt: new Date().toISOString(),
        nativeLoginAt: session.capturedAt,
      },
      session,
    );
    const findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ id: '123', name: 'WeRead_123', status: 1 });
    const { router } = setup({
      account: { findUniqueOrThrow },
      feed: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const result = await router.appRouter
      .createCaller({ errorMsg: null, isLocal: true })
      .account.manualRefreshOptions({ accountId: '123' });
    expect(result.accountLabel).toBe('真实昵称');
    expect(JSON.stringify(result)).not.toContain('123');
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: '123' } });
  });

  it('lists all twelve saved subscriptions, preserves unconfigured channels, and distinguishes connection from a later refresh receipt', async () => {
    const get = jest
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('no HTTP'));
    try {
      const mpId = 'MP_WXS_1234567890';
      const account = {
        id: '123',
        name: 'owner',
        status: 1,
        token: JSON.stringify({ wr_vid: '123', wr_skey: 'private-fixture' }),
      };
      const session = {
        source: 'owner-confirmed-native-web-login' as const,
        ownerVid: account.id,
        capturedAt: new Date().toISOString(),
        cookies: ['wr_vid', 'wr_skey'].map((name) => ({
          name,
          value: name === 'wr_vid' ? account.id : 'private-fixture',
          domain: '.weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        })),
      };
      const configFile = process.env.OWNER_SEARCH_CONFIG_FILE!;
      const sessionFile = await saveNativeAccountSession(configFile, session);
      const configText = JSON.stringify({
        feeds: {
          [mpId]: {
            mpId,
            name: 'fixture target',
            biz: 'MTIzNDU2Nzg5MA==',
            ownerVid: account.id,
            sessionFile,
            stateFile: path.join(dir, 'search.json'),
            runtimeStopFile: path.join(dir, 'original-runtime.json'),
            originalStopFiles: [path.join(dir, 'original-stop.json')],
            wereadLatestStateFile: path.join(dir, 'latest.json'),
          },
        },
      });
      await fs.writeFile(configFile, configText);
      const feeds = Array.from({ length: 12 }, (_, i) => ({
        id: `MP_WXS_${1234567890 + i}`,
        mpName: `fixture ${i}`,
        collectionChannel: i === 0 ? 'owner-weread-latest' : null,
        lastCollectionResult: null as string | null,
      }));
      const findMany = jest.fn().mockResolvedValue(feeds);
      const { router } = setup({
        account: { findUniqueOrThrow: jest.fn().mockResolvedValue(account) },
        feed: { findMany },
      });
      const caller = router.appRouter.createCaller({
        errorMsg: null,
        isLocal: true,
      });
      const before = await caller.account.manualRefreshOptions({
        accountId: account.id,
      });
      expect(before.options).toHaveLength(12);
      expect(before.options[0]).toMatchObject({
        ready: true,
        connected: false,
        refreshRequired: false,
      });
      expect(
        before.options
          .slice(1)
          .every((o) => !o.ready && o.reason === 'source-unconfigured'),
      ).toBe(true);
      expect(findMany).toHaveBeenCalledWith({
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      });
      expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
      const preview = await previewManualWereadBinding(account, mpId);
      await confirmManualWereadBinding(account, mpId, preview.revision);
      // Old failure receipts and zero article growth confer no new result.
      feeds[0].lastCollectionResult = JSON.stringify({
        source: 'owner-weread-latest',
        status: 'blocked',
        articles: 0,
        attemptedAt: 1,
      });
      const connected = await caller.account.manualRefreshOptions({
        accountId: account.id,
      });
      expect(connected.options[0]).toMatchObject({
        ready: true,
        connected: true,
        refreshRequired: true,
      });
      expect(connected.options[0].message).toContain('尚无连接后的取文结果');
      expect(JSON.stringify(connected)).not.toContain('private-fixture');
      expect(JSON.stringify(connected)).not.toContain(dir);
      const boundText = await fs.readFile(configFile, 'utf8');
      const connectionSecond = Math.floor(
        Date.parse(connected.options[0].connectedAt) / 1000,
      );
      feeds[0].lastCollectionResult = JSON.stringify({
        source: 'unavailable',
        status: 'blocked',
        attemptedAt: connectionSecond + 1,
      });
      expect(
        (await caller.account.manualRefreshOptions({ accountId: account.id }))
          .options[0].refreshRequired,
      ).toBe(true);
      for (const status of ['blocked', 'partial']) {
        feeds[0].lastCollectionResult = JSON.stringify({
          source: 'owner-weread-latest',
          status,
          articles: status === 'partial' ? 10 : 0,
          created: 0,
          attemptedAt: connectionSecond + 1,
        });
        const refreshed = await caller.account.manualRefreshOptions({
          accountId: account.id,
        });
        expect(refreshed.options[0]).toMatchObject({
          connected: true,
          refreshRequired: false,
        });
      }
      feeds[0].lastCollectionResult = '{bad';
      expect(
        (await caller.account.manualRefreshOptions({ accountId: account.id }))
          .options[0].refreshRequired,
      ).toBe(true);
      const stateFile = path.join(dir, 'latest.json');
      const stateText = await fs.readFile(stateFile, 'utf8');
      const changed = JSON.parse(stateText);
      changed.manualRefreshAuthorization.source = 'unconfirmed-fixture';
      await fs.writeFile(stateFile, JSON.stringify(changed));
      expect(
        (await caller.account.manualRefreshOptions({ accountId: account.id }))
          .options[0].connected,
      ).toBe(false);
      await fs.writeFile(stateFile, stateText);
      feeds[0].collectionChannel = 'public-album';
      expect(
        (await caller.account.manualRefreshOptions({ accountId: account.id }))
          .options[0],
      ).toMatchObject({ ready: false, reason: 'different-channel' });
      expect(await fs.readFile(configFile, 'utf8')).toBe(boundText);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it('requires both authentication and a local caller for manual binding preview and confirmation', async () => {
    const findUniqueOrThrow = jest.fn();
    const { router } = setup({ account: { findUniqueOrThrow } });
    const remote = router.appRouter.createCaller({
      errorMsg: null,
      isLocal: false,
    });
    await expect(
      remote.account.manualRefreshOptions({ accountId: '123' }),
    ).rejects.toThrow('只能在服务器本机');
    await expect(
      remote.account.connectManualRefresh({
        accountId: '123',
        mpId: 'MP_WXS_1234567890',
        revision: 'a'.repeat(64),
        confirm: true,
      }),
    ).rejects.toThrow('只能在服务器本机');
    await expect(
      router.appRouter
        .createCaller({ errorMsg: '请先登录', isLocal: true })
        .account.manualRefreshOptions({ accountId: '123' }),
    ).rejects.toThrow('请先登录');
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
  it('saves an unbound normal login server-side for explicit selection without changing the old owner', async () => {
    const configText = JSON.stringify({
      feeds: {
        test: {
          ownerVid: '999',
          sessionFile: path.join(dir, 'previous-owner'),
        },
      },
    });
    await fs.writeFile(process.env.OWNER_SEARCH_CONFIG_FILE!, configText);
    const prisma = {
      account: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const weread = {
      getLoginResult: jest.fn().mockResolvedValue({
        terminal: true,
        vid: 123,
        token: '{"wr_vid":"123","wr_skey":"new-qr"}',
        webSession: {
          source: 'owner-confirmed-native-web-login',
          ownerVid: '123',
          capturedAt: new Date().toISOString(),
          cookies: ['wr_vid', 'wr_skey'].map((name) => ({
            name,
            value: name === 'wr_vid' ? '123' : 'new-qr',
            domain: '.weread.qq.com',
            path: '/',
            secure: true,
            expires: -1,
          })),
        },
      }),
    };
    const { service } = setup(prisma, weread);
    const result = await service.getLoginResult('new-owner-uid');
    expect(result.saved).toBe(true);
    expect(result.searchSessionUpdated).toBe(false);
    expect(JSON.stringify(result)).not.toContain('new-qr');
    expect(
      await fs.readFile(process.env.OWNER_SEARCH_CONFIG_FILE!, 'utf8'),
    ).toBe(configText);
    expect(
      (await fs.readdir(dir)).filter((name) => /^native-account-/.test(name)),
    ).toHaveLength(1);
  });
  it('saves login once on server, preserving mobile credentials and access stops', async () => {
    const stopped = path.join(dir, 'original-stop.json');
    await fs.writeFile(stopped, '{"stopFurtherOriginalRequests":true}');
    await fs.writeFile(
      process.env.OWNER_SEARCH_CONFIG_FILE!,
      JSON.stringify({
        feeds: {
          test: {
            ownerVid: '123',
            sessionFile: path.join(dir, 'old-session'),
            originalStopFiles: [stopped],
            stateFile: path.join(dir, 'state'),
          },
        },
      }),
    );
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      account: {
        findUnique: jest.fn(async () => ({
          name: 'owner',
          token: JSON.stringify({
            mobile: { accessToken: 'old-mobile' },
            wr_rt: 'stale-web-refresh',
          }),
        })),
        upsert,
      },
    };
    const weread = {
      getLoginResult: jest.fn(async () => ({
        message: '',
        terminal: true,
        vid: 123,
        token: '{"wr_skey":"new-qr"}',
        webSession: {
          source: 'owner-confirmed-native-web-login',
          ownerVid: '123',
          capturedAt: new Date().toISOString(),
          cookies: ['wr_vid', 'wr_skey'].map((name) => ({
            name,
            value: name === 'wr_vid' ? '123' : 'new-qr',
            domain: '.weread.qq.com',
            path: '/',
            secure: true,
            expires: -1,
          })),
        },
      })),
    };
    const { service } = setup(prisma, weread);
    const [result, duplicate] = await Promise.all([
      service.getLoginResult('uid'),
      service.getLoginResult('uid'),
    ]);
    expect(result.saved).toBe(true);
    expect(result.searchSessionUpdated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('new-qr');
    expect(JSON.stringify(result)).not.toContain('old-mobile');
    expect(result).toEqual(duplicate);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(upsert.mock.calls[0][0].update.token).mobile.accessToken,
    ).toBe('old-mobile');
    expect(
      JSON.parse(upsert.mock.calls[0][0].update.token).wr_rt,
    ).toBeUndefined();
    const binding = JSON.parse(
      await fs.readFile(process.env.OWNER_SEARCH_CONFIG_FILE!, 'utf8'),
    ).feeds.test;
    expect(binding.originalStopFiles).toEqual([stopped]);
    expect(binding.stateFile).toBe(path.join(dir, 'state'));
    expect(await fs.readFile(stopped, 'utf8')).toBe(
      '{"stopFurtherOriginalRequests":true}',
    );
  });
});
