import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  saveNativeAccountSession,
  previewManualWereadBinding,
  confirmManualWereadBinding,
} from './owner-weread-binding';
import {
  ownerLatestAuthHash,
  ownerLatestStopMessage,
} from './owner-weread-session-state';
import { OwnerWebSession, ownerSessionCookie } from './owner-web-search';
import { readOwnerSearchConfig } from './owner-search-update';
import { fetchOwnerWereadLatest } from './owner-weread-latest';
jest.mock('axios');
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

describe('normal native login to explicitly confirmed manual Provider binding (offline)', () => {
  let dir: string,
    configFile: string,
    stateFile: string,
    session: OwnerWebSession,
    priorSession: OwnerWebSession;
  const mpId = 'MP_WXS_1234567890';
  const priorEnv = process.env.OWNER_SEARCH_CONFIG_FILE;
  const account = () => ({
    id: '123',
    name: 'selected-owner',
    status: 1,
    token: JSON.stringify({ wr_vid: '123', wr_skey: 'fresh-native-fixture' }),
  });
  const makeSession = (token: string): OwnerWebSession => ({
    source: 'owner-confirmed-native-web-login',
    ownerVid: '123',
    capturedAt: new Date().toISOString(),
    cookies: ['wr_vid', 'wr_skey'].map((name) => ({
      name,
      value: name === 'wr_vid' ? '123' : token,
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    })),
  });
  beforeEach(async () => {
    jest.resetAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-manual-bind-'));
    configFile = path.join(dir, 'source.json');
    stateFile = path.join(dir, 'latest.json');
    process.env.OWNER_SEARCH_CONFIG_FILE = configFile;
    session = makeSession('fresh-native-fixture');
    priorSession = makeSession('previous-failed-fixture');
    await fs.writeFile(
      path.join(dir, 'old-session.json'),
      JSON.stringify(priorSession),
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        feeds: {
          [mpId]: {
            mpId,
            name: '测试号',
            biz: 'MTIzNDU2Nzg5MA==',
            ownerVid: '123',
            sessionFile: path.join(dir, 'old-session.json'),
            stateFile: path.join(dir, 'search.json'),
            runtimeStopFile: path.join(dir, 'original-runtime.json'),
            originalStopFiles: [path.join(dir, 'original-stop.json')],
            wereadLatestStateFile: stateFile,
            wereadDirectoryEnabled: false,
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(dir, 'original-stop.json'),
      'retained-original-stop',
    );
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        sessionAuthHash: ownerLatestAuthHash(priorSession, '123'),
        lastAttemptAt: Date.now() - 16 * 60000,
        response: { stage: 'cover', httpStatus: 401, requests: 1 },
        stop: {
          at: '2025-01-01T00:00:00Z',
          stage: 'cover',
          reason: 'HTTP 401',
          requests: 1,
          sessionAuthHash: ownerLatestAuthHash(priorSession, '123'),
        },
      }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (priorEnv === undefined) delete process.env.OWNER_SEARCH_CONFIG_FILE;
    else process.env.OWNER_SEARCH_CONFIG_FILE = priorEnv;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const text = (file: string) => fs.readFile(file, 'utf8');
  it('persists an unbound server-issued login and previews without changing bindings, stops or sending requests', async () => {
    const configBefore = await text(configFile),
      stateBefore = await text(stateFile);
    const missing = await previewManualWereadBinding(account(), mpId);
    expect(missing.ready).toBe(false);
    await saveNativeAccountSession(configFile, session);
    const preview = await previewManualWereadBinding(account(), mpId);
    expect(preview.ready).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('fresh-native-fixture');
    expect(JSON.stringify(preview)).not.toContain(dir);
    expect(await text(configFile)).toBe(configBefore);
    expect(await text(stateFile)).toBe(stateBefore);
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('connects the confirmed login to the existing latest-ten HTTP/body/image pipeline; repeats keep the historical stop and cooldown', async () => {
    const configBefore = await text(configFile),
      stateBefore = await text(stateFile);
    await saveNativeAccountSession(configFile, session);
    const preview = await previewManualWereadBinding(account(), mpId);
    const result = await confirmManualWereadBinding(
      account(),
      mpId,
      preview.revision,
    );
    expect(JSON.stringify(result)).not.toContain('fresh-native-fixture');
    expect(await text(configFile + `.before-manual-${preview.revision}`)).toBe(
      configBefore,
    );
    expect(await text(stateFile + `.before-manual-${preview.revision}`)).toBe(
      stateBefore,
    );
    const c = await readOwnerSearchConfig(mpId);
    expect(c.wereadDirectoryEnabled).toBe(true);
    expect(JSON.parse(await text(stateFile)).stop).toEqual(
      JSON.parse(stateBefore).stop,
    );
    expect(
      ownerLatestStopMessage(
        JSON.parse(await text(stateFile)),
        session,
        '123',
        mpId,
      ),
    ).toBeNull();
    // A caller holding the previous config remains stopped after account selection.
    expect(
      ownerLatestStopMessage(
        JSON.parse(await text(stateFile)),
        priorSession,
        '123',
        mpId,
      ),
    ).not.toBeNull();
    (axios.get as jest.Mock).mockImplementation(async (url, options) => {
      if (url.endsWith('/articles'))
        return {
          status: 200,
          data: JSON.stringify({
            reviews: Array.from({ length: 10 }, (_, i) => {
              const originalId = String(i + 1).padStart(22, 'a'),
                reviewId = `${mpId}_${originalId}`;
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
                        title: `title-${i + 1}`,
                        mp_name: '测试号',
                        time: 1700000100 - i,
                      },
                    },
                  },
                ],
              };
            }),
          }),
        };
      const n = Number(
        options.params.reviewId.slice(mpId.length + 1).replace(/^a+/, ''),
      );
      return {
        status: 200,
        data: `<meta property="og:url" content="https://mp.weixin.qq.com/s/${String(n).padStart(22, 'a')}"><h1 id="activity-name">title-${n}</h1><span id="js_name">测试号</span><div id="js_content">body-${n}</div><script>var biz="MTIzNDU2Nzg5MA==";var mid="${100 + n}";var idx="1";var sn="abcd";var ct=${1700000101 - n};</script>`,
      };
    });
    expect((await fetchOwnerWereadLatest(c)).articles).toHaveLength(10);
    expect((axios.get as jest.Mock).mock.calls[0][1].headers.Cookie).toContain(
      'wr_skey=fresh-native-fixture',
    );
    expect((axios.get as jest.Mock).mock.calls).toHaveLength(11);
    await expect(fetchOwnerWereadLatest(c)).rejects.toThrow('冷却期');
    expect(axios.get).toHaveBeenCalledTimes(11);
    const nextTime = Date.now() + 16 * 60000;
    jest.spyOn(Date, 'now').mockReturnValue(nextTime);
    expect((await fetchOwnerWereadLatest(c)).articles).toHaveLength(10);
    expect(axios.get).toHaveBeenCalledTimes(22);
    expect(JSON.parse(await text(stateFile)).stop).toEqual(
      JSON.parse(stateBefore).stop,
    );
    expect(await text(path.join(dir, 'original-stop.json'))).toBe(
      'retained-original-stop',
    );
    expect(await text(stateFile + `.before-manual-${preview.revision}`)).toBe(
      stateBefore,
    );
  });
  it('a refusal on the confirmed session stops it permanently and the binding button cannot authorize it again', async () => {
    await saveNativeAccountSession(configFile, session);
    const preview = await previewManualWereadBinding(account(), mpId);
    await confirmManualWereadBinding(account(), mpId, preview.revision);
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: '{"errCode":-2041}',
    });
    const c = await readOwnerSearchConfig(mpId);
    await expect(fetchOwnerWereadLatest(c)).rejects.toThrow('业务码 -2041');
    await expect(fetchOwnerWereadLatest(c)).rejects.toThrow('已停止');
    expect((await previewManualWereadBinding(account(), mpId)).ready).toBe(
      false,
    );
    await expect(
      confirmManualWereadBinding(account(), mpId, preview.revision),
    ).rejects.toThrow('不能重复授权重试');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
  it('uses only the explicitly selected normal-login account and preserves the former owner evidence', async () => {
    const configBefore = await text(configFile),
      stateBefore = await text(stateFile);
    const selected = {
      ...account(),
      id: '456',
      token: JSON.stringify({ wr_vid: '456', wr_skey: 'fresh-native-fixture' }),
    };
    const selectedSession: OwnerWebSession = {
      ...session,
      ownerVid: '456',
      cookies: session.cookies.map((c) =>
        c.name === 'wr_vid' ? { ...c, value: '456' } : c,
      ),
    };
    await saveNativeAccountSession(configFile, selectedSession);
    const preview = await previewManualWereadBinding(selected, mpId);
    expect(preview.ready).toBe(true);
    await confirmManualWereadBinding(selected, mpId, preview.revision);
    const config = await readOwnerSearchConfig(mpId);
    expect(config.ownerVid).toBe('456');
    expect(JSON.parse(await text(stateFile)).stop).toEqual(
      JSON.parse(stateBefore).stop,
    );
    expect(await text(configFile + `.before-manual-${preview.revision}`)).toBe(
      configBefore,
    );
    expect(
      ownerLatestStopMessage(
        JSON.parse(await text(stateFile)),
        selectedSession,
        '456',
        mpId,
      ),
    ).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('rejects inconsistent historical authentication ownership instead of using it to release a stop', async () => {
    await saveNativeAccountSession(configFile, session);
    const state = JSON.parse(await text(stateFile));
    state.sessionAuthHash = 'a'.repeat(64);
    await fs.writeFile(stateFile, JSON.stringify(state));
    expect((await previewManualWereadBinding(account(), mpId)).ready).toBe(
      false,
    );
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('preserves and proves legacy stopped-cookie ownership instead of clearing its marker', async () => {
    const state = JSON.parse(await text(stateFile));
    delete state.sessionAuthHash;
    delete state.stop.sessionAuthHash;
    state.sessionHash = createHash('sha256')
      .update(ownerSessionCookie(priorSession, '123'))
      .digest('hex');
    await fs.writeFile(stateFile, JSON.stringify(state));
    const before = await text(stateFile);
    await saveNativeAccountSession(configFile, session);
    const preview = await previewManualWereadBinding(account(), mpId);
    expect(preview.ready).toBe(true);
    await confirmManualWereadBinding(account(), mpId, preview.revision);
    const approved = JSON.parse(await text(stateFile));
    expect(approved.stop).toEqual(state.stop);
    expect(ownerLatestStopMessage(approved, session, '123', mpId)).toBeNull();
    expect((await previewManualWereadBinding(account(), mpId)).ready).toBe(
      true,
    );
    expect(await text(stateFile + `.before-manual-${preview.revision}`)).toBe(
      before,
    );
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('does not authorize an older saved native session after a newer failure or a changed stop', async () => {
    session.capturedAt = '2024-01-01T00:00:00Z';
    await saveNativeAccountSession(configFile, session);
    expect((await previewManualWereadBinding(account(), mpId)).ready).toBe(
      false,
    );
    session = makeSession('fresh-native-fixture');
    await saveNativeAccountSession(configFile, session);
    const preview = await previewManualWereadBinding(account(), mpId);
    await confirmManualWereadBinding(account(), mpId, preview.revision);
    const state = JSON.parse(await text(stateFile));
    state.stop.reason = 'HTTP 403';
    expect(ownerLatestStopMessage(state, session, '123', mpId)).not.toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('rejects stale previews and active refresh locks without changing the binding or issuing requests', async () => {
    await saveNativeAccountSession(configFile, session);
    const preview = await previewManualWereadBinding(account(), mpId);
    const configBefore = await text(configFile);
    await fs.writeFile(stateFile + '.lock', 'existing-refresh');
    await expect(
      confirmManualWereadBinding(account(), mpId, preview.revision),
    ).rejects.toThrow();
    expect(await text(stateFile + '.lock')).toBe('existing-refresh');
    await fs.unlink(stateFile + '.lock');
    const state = JSON.parse(await text(stateFile));
    state.lastAttemptAt++;
    await fs.writeFile(stateFile, JSON.stringify(state));
    await expect(
      confirmManualWereadBinding(account(), mpId, preview.revision),
    ).rejects.toThrow('已变化');
    expect(await text(configFile)).toBe(configBefore);
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('cannot reuse a previous failed native token by relabeling its capture time or account metadata', async () => {
    session = makeSession('previous-failed-fixture');
    await saveNativeAccountSession(configFile, session);
    expect(
      (
        await previewManualWereadBinding(
          {
            ...account(),
            token: JSON.stringify({
              wr_vid: '123',
              wr_skey: 'previous-failed-fixture',
            }),
          },
          mpId,
        )
      ).ready,
    ).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('restores the prior state when committing the selected-account config fails', async () => {
    await saveNativeAccountSession(configFile, session);
    const preview = await previewManualWereadBinding(account(), mpId);
    const configBefore = await text(configFile),
      stateBefore = await text(stateFile);
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === configFile) throw new Error('CONFIG_COMMIT_FAILED');
      return rename(from, to);
    });
    await expect(
      confirmManualWereadBinding(account(), mpId, preview.revision),
    ).rejects.toThrow('CONFIG_COMMIT_FAILED');
    expect(await text(configFile)).toBe(configBefore);
    expect(await text(stateFile)).toBe(stateBefore);
    expect(
      (await fs.readdir(dir)).some(
        (name) => name.endsWith('.pending') || name.endsWith('.lock'),
      ),
    ).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('requires genuine indexed native-login provenance and matching current account credentials', async () => {
    await expect(
      saveNativeAccountSession(configFile, {
        ...session,
        source: 'owner-confirmed-dedicated-web-login',
      }),
    ).rejects.toThrow();
    await saveNativeAccountSession(configFile, session);
    expect(
      (await previewManualWereadBinding({ ...account(), token: '{}' }, mpId))
        .ready,
    ).toBe(false);
    const index = JSON.parse(
      await text(
        path.join(
          dir,
          `native-account-${createHash('sha256').update('123').digest('hex').slice(0, 24)}.json`,
        ),
      ),
    );
    await fs.writeFile(
      index.sessionFile,
      JSON.stringify({ ...session, capturedAt: '2025-01-01T00:00:00Z' }),
    );
    expect((await previewManualWereadBinding(account(), mpId)).ready).toBe(
      false,
    );
    expect(axios.get).not.toHaveBeenCalled();
  });
});
