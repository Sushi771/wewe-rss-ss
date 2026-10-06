import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readOwnerVerificationStatus,
  readOwnerAccountAccess,
} from './owner-verification-status';
import { ownerLatestFailureReason } from './owner-weread-session-state';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';

describe('saved official verification status', () => {
  let directory: string;
  let configFile: string;
  let stateFile: string;
  const feed = {
    id: 'MP_WXS_12345',
    mpName: 'Fixture subscription',
    collectionChannel: 'owner-weread-latest',
  };
  const at = '2026-01-02T00:00:00.000Z';
  const profile = jest.fn(async () => ({ name: 'Fixture nickname' }));
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-verification-'));
    configFile = path.join(directory, 'config.json');
    stateFile = path.join(directory, 'state.json');
    await fs.writeFile(
      configFile,
      JSON.stringify({
        feeds: {
          [feed.id]: {
            mpId: feed.id,
            ownerVid: '123456789',
            wereadLatestStateFile: stateFile,
            sessionFile: path.join(directory, 'must-not-be-read.json'),
          },
        },
      }),
    );
    profile.mockClear();
  });
  afterEach(async () => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error('Test cleanup outside temp');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  async function state(reason = '业务码 -2041', extra = {}) {
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        stop: { at, stage: 'directory-0', reason, privateValue: 'secret' },
        callback: { ticket: 'secret', url: 'https://untrusted.invalid/' },
        ...extra,
      }),
    );
  }
  it('returns the actual bound nickname and tail, with no credentials or retry', async () => {
    await state();
    const before = await fs.readFile(stateFile);
    const result = await readOwnerVerificationStatus(
      configFile,
      [feed],
      profile,
    );
    expect(result.unavailable).toBe(false);
    expect(result.notices).toEqual([
      {
        feedId: feed.id,
        feedName: feed.mpName,
        accountName: 'Fixture nickname',
        accountTail: '6789',
        kind: 'weread-verification',
        state: 'verification_required',
        stage: '目录',
        stoppedAt: at,
        backendStatus: 'stopped',
        canResume: false,
        officialUrl: 'https://weread.qq.com/',
        verificationUrlAvailable: false,
      },
    ]);
    expect(profile).toHaveBeenCalledWith('123456789');
    expect(JSON.stringify(result)).not.toMatch(/secret|123456789|untrusted/);
    expect(await fs.readFile(stateFile)).toEqual(before);
  });
  it.each(['HTTP 429', 'HTTP 401', 'unknown'])(
    'does not misclassify %s as a manual captcha',
    async (reason) => {
      await state(reason);
      expect(
        (await readOwnerVerificationStatus(configFile, [feed], profile))
          .notices,
      ).toEqual([]);
      expect(profile).not.toHaveBeenCalled();
    },
  );
  it('projects a saved login timeout without making it a challenge or reading login secrets', async () => {
    await state('微信读书登录超时（业务码 -2012）');
    const before = await fs.readFile(stateFile);
    const result = await readOwnerVerificationStatus(
      configFile,
      [feed],
      profile,
    );
    expect(result.notices[0]).toMatchObject({
      state: 'expired',
      kind: 'weread-login-expired',
      canResume: false,
      verificationUrlAvailable: false,
    });
    const account = { id: '123456789', status: 1, nativeLoginAt: null };
    const access = await readOwnerAccountAccess(
      configFile,
      [feed],
      [
        account,
        { ...account, id: '999996789' }, // Same tail must not associate another account.
        { ...account, id: '456', status: 2 },
        { ...account, id: '789', status: 0 },
      ],
    );
    expect(access.get(account.id)).toMatchObject({
      loginState: 'expired',
      verificationRequired: false,
    });
    expect(access.get('999996789')?.loginState).toBe('unverified');
    expect(access.get('456')?.loginState).toBe('unverified');
    expect(access.get('789')?.loginState).toBe('expired');
    expect(await fs.readFile(stateFile)).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(
      /secret|123456789|must-not-be-read|untrusted/,
    );
  });
  it('new confirmed login supersedes only the expiry label and never removes an official challenge', async () => {
    const nativeLoginAt = new Date(Date.parse(at) + 1000).toISOString();
    const account = { id: '123456789', status: 1, nativeLoginAt };
    const loggedIn = async () => ({ name: 'Fixture nickname', nativeLoginAt });
    await state('业务码 -2012');
    expect(
      (await readOwnerVerificationStatus(configFile, [feed], loggedIn)).notices,
    ).toEqual([]);
    expect(
      (await readOwnerAccountAccess(configFile, [feed], [account])).get(
        account.id,
      ),
    ).toMatchObject({ loginState: 'unverified', verificationRequired: false });
    await state('业务码 -2041', { humanCompleted: true });
    const before = await fs.readFile(stateFile);
    expect(
      (await readOwnerVerificationStatus(configFile, [feed], loggedIn))
        .notices[0],
    ).toMatchObject({
      state: 'verification_required',
      canResume: false,
      verificationUrlAvailable: false,
    });
    expect(
      (await readOwnerAccountAccess(configFile, [feed], [account])).get(
        account.id,
      ),
    ).toMatchObject({ loginState: 'unverified', verificationRequired: true });
    expect(await fs.readFile(stateFile)).toEqual(before);
  });
  it('keeps the stop contract and recognizes the verified business code', async () => {
    const reason = ownerLatestFailureReason(new Error('业务码 -2041'));
    expect(reason).toBe('业务码 -2041');
    await state(reason);
    expect(
      (await readOwnerVerificationStatus(configFile, [feed], profile)).notices,
    ).toHaveLength(1);
  });
  it('requires a later real backend success, not a browser acknowledgement', async () => {
    await state('业务码 -2041', {
      humanCompleted: true,
      officialPageOpened: true,
    });
    expect(
      (await readOwnerVerificationStatus(configFile, [feed], profile)).notices,
    ).toHaveLength(1);
    await state('业务码 -2041', { lastSuccessAt: Date.parse(at) + 1 });
    expect(
      (await readOwnerVerificationStatus(configFile, [feed], profile)).notices,
    ).toEqual([]);
  });
  it('does not expose another channel and handles missing private state safely', async () => {
    await state();
    expect(
      (
        await readOwnerVerificationStatus(
          configFile,
          [{ ...feed, collectionChannel: null }],
          profile,
        )
      ).notices,
    ).toEqual([]);
    await fs.unlink(stateFile);
    expect(
      await readOwnerVerificationStatus(configFile, [feed], profile),
    ).toEqual({ notices: [], unavailable: true });
    expect(
      await readOwnerVerificationStatus(undefined, [feed], profile),
    ).toEqual({ notices: [], unavailable: false });
  });
  it('keeps the read endpoint authenticated and restricted to the local server', async () => {
    const prisma = { feed: { findMany: jest.fn() } };
    const config = { get: () => ({ url: '', updateDelayTime: 0 }) };
    const service = new TrpcService(
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
    const router = new TrpcRouter(
      service,
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
    await expect(
      router.appRouter
        .createCaller({ errorMsg: '请先登录', isLocal: true })
        .collection.verificationStatus(),
    ).rejects.toThrow('请先登录');
    await expect(
      router.appRouter
        .createCaller({ isLocal: false })
        .collection.verificationStatus(),
    ).rejects.toThrow('本机');
    expect(prisma.feed.findMany).not.toHaveBeenCalled();
  });
});
