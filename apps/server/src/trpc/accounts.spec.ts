import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
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
