import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import axios from 'axios';
import {
  applyNormalWebRenewal,
  NORMAL_WEB_RENEWAL_URL,
  normalWebSha256 as sha,
} from './normal-web-renewal';
import {
  activateNormalWebMaintenance,
  persistNormalWebMaintenance,
  prepareNormalWebMaintenance,
} from './normal-web-maintenance';
import {
  ownerLatestAuthHash,
  ownerLatestStopMessage,
} from '../collection/owner-weread-session-state';
import { fetchOwnerWereadLatest } from '../collection/owner-weread-latest';
import {
  previewManualWereadBinding,
  confirmManualWereadBinding,
  nativeAccountLoginAt,
} from '../collection/owner-weread-binding';

jest.mock('axios');
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));
const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/normal-web-renewal.json'),
    'utf8',
  ),
);
const now = Date.parse(fixture.now);
const mpId = 'MP_WXS_1234567890';
const response = () => ({
  url: NORMAL_WEB_RENEWAL_URL,
  status: 200,
  data: { succ: 1 },
  setCookies: [...fixture.setCookies],
});
const makeState = () => {
  const auth = ownerLatestAuthHash(fixture.initialSession, '123', now);
  return {
    sessionAuthHash: auth,
    lastAttemptAt: Date.parse('2026-10-04T17:53:07.125Z'),
    stop: {
      at: '2026-10-04T17:53:07.314Z',
      stage: 'directory-0',
      requests: 1,
      reason: '业务码 -2012',
      sessionAuthHash: auth,
    },
    response: { stage: 'directory-0', httpStatus: 200, requests: 1, bytes: 70 },
    manualRefreshAuthorization: {
      source: fixture.initialSession.source,
      target: mpId,
      authHash: auth,
      sessionCapturedAt: fixture.initialSession.capturedAt,
      approvedAt: '2026-10-04T17:12:06.301Z',
      stopHash: sha('earlier-401-stop'),
    },
  };
};

describe('immutable normal Web maintenance and reviewed continuation (temp files, no HTTP)', () => {
  let dir: string,
    configFile: string,
    stateFile: string,
    originalFile: string,
    indexFile: string,
    configText: string,
    stateText: string,
    sessionText: string;
  const oldEnv = process.env.OWNER_SEARCH_CONFIG_FILE;
  const account = {
    id: '123',
    name: 'synthetic-owner',
    status: 1,
    token: JSON.stringify({ wr_vid: '123', wr_skey: 'old-web-skey' }),
  };
  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-maintenance-'));
    configFile = path.join(dir, 'source.json');
    stateFile = path.join(dir, 'latest.json');
    sessionText = JSON.stringify(fixture.initialSession, null, 2);
    originalFile = path.join(
      dir,
      `native-session-${sha(sessionText).slice(0, 24)}.json`,
    );
    indexFile = path.join(
      dir,
      `native-account-${sha('123').slice(0, 24)}.json`,
    );
    stateText = JSON.stringify(makeState());
    configText = JSON.stringify({
      feeds: {
        [mpId]: {
          mpId,
          name: 'synthetic-feed',
          biz: 'MTIzNDU2Nzg5MA==',
          ownerVid: '123',
          sessionFile: originalFile,
          stateFile: path.join(dir, 'search.json'),
          runtimeStopFile: path.join(dir, 'runtime.json'),
          originalStopFiles: [path.join(dir, 'original-stop.json')],
          wereadLatestStateFile: stateFile,
          wereadDirectoryEnabled: true,
        },
        MP_WXS_9876543210: { untouched: 'another-feed' },
      },
    });
    await Promise.all([
      fs.writeFile(originalFile, sessionText),
      fs.writeFile(stateFile, stateText),
      fs.writeFile(configFile, configText),
      fs.writeFile(indexFile, JSON.stringify({ sessionFile: originalFile })),
    ]);
    process.env.OWNER_SEARCH_CONFIG_FILE = configFile;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (oldEnv === undefined) delete process.env.OWNER_SEARCH_CONFIG_FILE;
    else process.env.OWNER_SEARCH_CONFIG_FILE = oldEnv;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const options = () => ({
    configFile,
    mpId,
    expectedConfigSha256: sha(configText),
    expectedStateSha256: sha(stateText),
    expectedSessionSha256: sha(sessionText),
    response: response(),
    renewedAt: fixture.now,
    now,
  });
  const assertOriginal = async () => {
    expect(await fs.readFile(originalFile, 'utf8')).toBe(sessionText);
    expect(await fs.readFile(indexFile, 'utf8')).toBe(
      JSON.stringify({ sessionFile: originalFile }),
    );
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  };
  const activate = async () => {
    const candidate = await persistNormalWebMaintenance(options());
    const candidateText = await fs.readFile(candidate.file, 'utf8');
    const result = await activateNormalWebMaintenance({
      configFile,
      mpId,
      maintenanceFile: candidate.file,
      expectedMaintenanceSha256: sha(candidateText),
      expectedConfigSha256: sha(configText),
      approval: 'same-owner-timeout-continuation',
      approvedAt: fixture.now,
      now,
    });
    return { candidate, result };
  };
  it('materializes an idempotent private candidate without changing any active binding or stop', async () => {
    const first = await persistNormalWebMaintenance(options());
    const text = await fs.readFile(first.file, 'utf8');
    expect(path.basename(first.file)).toBe(
      `normal-maintenance-${sha(text)}.json`,
    );
    expect(first.evidence).toMatchObject({
      requestPolicy: 'maintenance-only-no-collection',
      parentSessionSha256: sha(sessionText),
      parentStateSha256: sha(stateText),
      normalLoginAt: fixture.initialSession.capturedAt,
      renewedAt: fixture.now,
      failedStopSha256: sha(JSON.stringify(makeState().stop)),
      validUntil: '2026-10-04T20:19:06.000Z',
    });
    expect((await persistNormalWebMaintenance(options())).file).toBe(
      first.file,
    );
    expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateText);
    expect(
      ownerLatestStopMessage(makeState(), first.evidence.session, '123', mpId),
    ).not.toBeNull();
    await assertOriginal();
  });
  it('serializes concurrent persistence and preserves locks owned by another operation', async () => {
    const results = await Promise.allSettled([
      persistNormalWebMaintenance(options()),
      persistNormalWebMaintenance(options()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await fs.writeFile(stateFile + '.lock', 'inflight-body');
    await expect(persistNormalWebMaintenance(options())).rejects.toThrow();
    expect(await fs.readFile(stateFile + '.lock', 'utf8')).toBe(
      'inflight-body',
    );
    expect(
      await fs.stat(configFile + '.native-login.lock').catch(() => null),
    ).toBeNull();
    await assertOriginal();
  });
  it('cleans only its own pending file if immutable publication fails', async () => {
    jest
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(new Error('synthetic-disk-failure'));
    await expect(persistNormalWebMaintenance(options())).rejects.toThrow(
      'synthetic-disk-failure',
    );
    expect(
      (await fs.readdir(dir)).some((name) =>
        /pending|\.lock|normal-maintenance/.test(name),
      ),
    ).toBe(false);
    expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateText);
    await assertOriginal();
  });
  it.each([
    'expectedConfigSha256',
    'expectedStateSha256',
    'expectedSessionSha256',
  ])('rejects stale %s evidence', async (key) => {
    await expect(
      persistNormalWebMaintenance({ ...options(), [key]: sha('stale') }),
    ).rejects.toThrow();
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateText);
    expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
    await assertOriginal();
  });
  it.each([
    '业务码 -2041',
    'HTTP 401',
    '业务码 -2013',
    'unknown-private-token',
  ])('never converts an unrelated stop into maintenance (%s)', (reason) => {
    const state = makeState();
    state.stop.reason = reason;
    const renewal = applyNormalWebRenewal(
      fixture.initialSession,
      '123',
      response(),
      fixture.now,
      sessionText,
    );
    expect(() =>
      prepareNormalWebMaintenance({
        sessionText,
        stateText: JSON.stringify(state),
        mpId,
        renewal,
        now,
      }),
    ).toThrow();
  });
  it('adopts only the reviewed same-owner timeout and leaves QR time/index, old stop, authorization and other feeds intact', async () => {
    const { result } = await activate();
    expect(result.normalLoginAt).toBe(fixture.initialSession.capturedAt);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(state.stop).toEqual(makeState().stop);
    expect(state.manualRefreshAuthorization).toEqual(
      makeState().manualRefreshAuthorization,
    );
    expect(state.response).toEqual(makeState().response);
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    expect(config.feeds.MP_WXS_9876543210).toEqual({
      untouched: 'another-feed',
    });
    const maintained = JSON.parse(
      await fs.readFile(result.sessionFile, 'utf8'),
    );
    expect(ownerLatestStopMessage(state, maintained, '123', mpId)).toBeNull();
    expect(await nativeAccountLoginAt('123')).toBe(
      fixture.initialSession.capturedAt,
    );
    const before = await fs.readFile(stateFile, 'utf8');
    const preview = await previewManualWereadBinding(account, mpId);
    expect(preview.connected).toBe(true);
    expect(
      (await confirmManualWereadBinding(account, mpId, preview.revision))
        .connected,
    ).toBe(true);
    expect(await fs.readFile(stateFile, 'utf8')).toBe(before);
    await assertOriginal();
  });
  it('rolls back state if the active config commit fails; immutable before-images remain', async () => {
    const candidate = await persistNormalWebMaintenance(options());
    const text = await fs.readFile(candidate.file, 'utf8');
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (oldFile, newFile) => {
      if (newFile === configFile)
        throw new Error('synthetic-config-commit-failure');
      return rename(oldFile, newFile);
    });
    await expect(
      activateNormalWebMaintenance({
        configFile,
        mpId,
        maintenanceFile: candidate.file,
        expectedMaintenanceSha256: sha(text),
        expectedConfigSha256: sha(configText),
        approval: 'same-owner-timeout-continuation',
        approvedAt: fixture.now,
        now,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateText);
    expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
    expect(
      (await fs.readdir(dir)).some(
        (name) => name.endsWith('.pending') || name.endsWith('.lock'),
      ),
    ).toBe(false);
    await assertOriginal();
  });
  it('blocks stale QR evidence or expired credentials without activating', async () => {
    const candidate = await persistNormalWebMaintenance(options());
    const text = await fs.readFile(candidate.file, 'utf8');
    const args = {
      configFile,
      mpId,
      maintenanceFile: candidate.file,
      expectedMaintenanceSha256: sha(text),
      expectedConfigSha256: sha(configText),
      approval: 'same-owner-timeout-continuation' as const,
      approvedAt: fixture.now,
      now,
    };
    await fs.writeFile(
      indexFile,
      JSON.stringify({
        sessionFile: path.join(dir, 'later-native-login.json'),
      }),
    );
    await expect(activateNormalWebMaintenance(args)).rejects.toThrow();
    await fs.writeFile(
      indexFile,
      JSON.stringify({ sessionFile: originalFile }),
    );
    await expect(
      activateNormalWebMaintenance({ ...args, now: now + 5400000 }),
    ).rejects.toThrow();
    await expect(
      activateNormalWebMaintenance({
        ...args,
        now: Date.parse('2026-10-04T20:19:06Z'),
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateText);
  });
  it('rejects public/scheduled use, consumes one local validation and stops after a new challenge', async () => {
    await activate();
    const config = JSON.parse(await fs.readFile(configFile, 'utf8')).feeds[
      mpId
    ];
    const before = await fs.readFile(stateFile, 'utf8');
    await expect(fetchOwnerWereadLatest(config, 'scheduled')).rejects.toThrow(
      '仅供本机',
    );
    await expect(fetchOwnerWereadLatest(config, 'public')).rejects.toThrow(
      '仅供本机',
    );
    expect(await fs.readFile(stateFile, 'utf8')).toBe(before);
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: '{"errCode":-2041}',
    });
    await expect(
      fetchOwnerWereadLatest(config, 'local-manual'),
    ).rejects.toThrow('-2041');
    await expect(
      fetchOwnerWereadLatest(config, 'local-manual'),
    ).rejects.toThrow('已停止');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(state.normalWebMaintenanceAuthorization.consumedAt).toBe(
      fixture.now,
    );
    expect(state.stop.reason).toBe('业务码 -2041');
  });
  it('supports ten verified bodies followed by a duplicate-safe manual retry; scheduling stays blocked', async () => {
    await activate();
    const config = JSON.parse(await fs.readFile(configFile, 'utf8')).feeds[
      mpId
    ];
    (axios.get as jest.Mock).mockImplementation(async (url, options) => {
      if (url.endsWith('/articles'))
        return {
          status: 200,
          data: JSON.stringify({
            reviews: Array.from({ length: 10 }, (_, i) => {
              const n = i + 1;
              const originalId = String(n).padStart(22, 'a');
              const reviewId = `${mpId}_${originalId}`;
              return {
                subReviews: [
                  {
                    reviewId,
                    review: {
                      reviewId,
                      type: 16,
                      bookId: '',
                      belongBookId: mpId,
                      mpInfo: {
                        originalId,
                        title: `synthetic-${n}`,
                        mp_name: config.name,
                        time: 1700000100 - n,
                      },
                    },
                  },
                ],
              };
            }),
          }),
        };
      const n = Number(options.params.reviewId.slice(-2).replace(/a/g, ''));
      return {
        status: 200,
        data: `<meta property="og:url" content="https://mp.weixin.qq.com/s/${String(n).padStart(22, 'a')}"><h1 id="activity-name">synthetic-${n}</h1><span id="js_name">${config.name}</span><div id="js_content">synthetic-body-${n}</div><script>var biz="${config.biz}";var mid="${100 + n}";var idx="1";var sn="abcd";var ct=${1700000100 - n};</script>`,
      };
    });
    const first = await fetchOwnerWereadLatest(config, 'local-manual');
    expect(first.articles).toHaveLength(10);
    expect(axios.get).toHaveBeenCalledTimes(11);
    await expect(
      fetchOwnerWereadLatest(config, 'local-manual'),
    ).rejects.toThrow('冷却');
    jest.spyOn(Date, 'now').mockReturnValue(now + 16 * 60000);
    await expect(fetchOwnerWereadLatest(config, 'scheduled')).rejects.toThrow(
      '仅供本机',
    );
    const second = await fetchOwnerWereadLatest(config, 'local-manual');
    expect(second.articles.map((a) => a.id)).toEqual(
      first.articles.map((a) => a.id),
    );
    expect(axios.get).toHaveBeenCalledTimes(22);
    expect(axios.post).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).stop).toEqual(
      makeState().stop,
    );
    expect(await nativeAccountLoginAt('123')).toBe(
      fixture.initialSession.capturedAt,
    );
  });
});
