import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { activateReviewedWereadBatch } from './owner-weread-batch-resume';
import { fetchOwnerWereadLatest } from './owner-weread-latest';
import {
  ownerLatestAuthHash,
  ownerLatestReviewedBatchAuthorized,
} from './owner-weread-session-state';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { ownerSessionCookie, OwnerWebSession } from './owner-web-search';
import { previewNormalWebMaintenanceBinding } from '../weread/normal-web-maintenance';

jest.mock('axios');
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest.fn().mockResolvedValue({
    integrityCheck: 'ok',
    backup: 'synthetic-copy',
    sha256: 'a'.repeat(64),
  }),
}));
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const at = Date.parse('2026-10-04T20:00:51.576Z'),
  now = Date.parse('2026-10-04T20:30:00Z');
const mpId = 'MP_WXS_1234567890',
  name = 'synthetic-feed',
  biz = 'MTIzNDU2Nzg5MA==';
const originalId = (n: number) => String(n).padStart(22, 'a');
const bodyTime = (n: number) => 1700000000 - n * 86400;
const body = (n: number) =>
  `<meta property="og:url" content="https://mp.weixin.qq.com/s/${originalId(n)}"><h1 id="activity-name">sample-${n}</h1><span id="js_name">${name}</span><div id="js_content">original-body-${n}</div><script>var biz="${biz}";var mid="${100 + n}";var idx="1";var sn="abcd";var ct=${bodyTime(n)};</script>`;
const directory = () =>
  JSON.stringify({
    reviews: Array.from({ length: 20 }, (_, i) => {
      const n = i + 1,
        id = `${mpId}_${originalId(n)}`;
      return {
        subReviews: [
          {
            reviewId: id,
            review: {
              reviewId: id,
              type: 16,
              bookId: '',
              belongBookId: mpId,
              mpInfo: {
                originalId: originalId(n),
                title: `sample-${n}`,
                mp_name: name,
                time: bodyTime(n) + (n === 3 ? 38 : 0),
              },
            },
          },
        ],
      };
    }),
  });

describe('reviewed original batch resume (synthetic files, no real HTTP)', () => {
  let root: string,
    configFile: string,
    stateFile: string,
    cacheFile: string,
    configText: string,
    stateText: string,
    sessionText: string,
    originalFile: string,
    indexFile: string;
  const session = () => ({
    source: 'owner-confirmed-native-web-login' as const,
    capturedAt: '2026-10-04T15:59:27.219Z',
    renewedAt: '2026-10-04T18:49:07.659Z',
    ownerVid: '123',
    cookies: [
      ['wr_vid', '123'],
      ['wr_skey', 'first-key'],
      ['wr_ql', '0'],
      ['wr_rt', 'live-refresh'],
    ].map(([name, value]) => ({
      name,
      value,
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires:
        name === 'wr_skey' ? Date.parse('2026-10-04T20:19:06Z') / 1000 : -1,
    })),
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-batch-resume-'));
    configFile = path.join(root, 'source.json');
    stateFile = path.join(root, 'latest.json');
    sessionText = JSON.stringify(session());
    const sessionFile = path.join(
      root,
      `normal-maintenance-session-${sha(sessionText)}.json`,
    );
    const original: OwnerWebSession = session();
    delete original.renewedAt;
    original.cookies.find((c) => c.name === 'wr_skey')!.value = 'human-key';
    original.cookies.forEach((c) => (c.expires = -1));
    const originalText = JSON.stringify(original);
    originalFile = path.join(
      root,
      `native-session-${sha(originalText).slice(0, 24)}.json`,
    );
    indexFile = path.join(
      root,
      `native-account-${sha('123').slice(0, 24)}.json`,
    );
    const auth = ownerLatestAuthHash(
      session(),
      '123',
      Date.parse(session().renewedAt),
    );
    stateText = JSON.stringify({
      lastAttemptAt: at,
      sessionAuthHash: auth,
      stop: {
        at: '2026-10-04T20:00:59.894Z',
        stage: 'content-3',
        requests: 4,
        reason: '正文与目录的身份、标题或发布时间冲突',
        sessionAuthHash: auth,
      },
      response: {
        stage: 'content-3',
        httpStatus: 200,
        requests: 4,
        bytes: body(3).length,
      },
      normalWebMaintenanceAuthorization: {
        parentSessionSha256: sha(originalText),
        resultingSessionSha256: sha(sessionText),
        resultingAuthHash: auth,
        consumedAt: new Date(at).toISOString(),
      },
    });
    configText = JSON.stringify({
      feeds: {
        [mpId]: {
          mpId,
          name,
          biz,
          ownerVid: '123',
          sessionFile,
          wereadLatestStateFile: stateFile,
          wereadDirectoryEnabled: true,
          stateFile: path.join(root, 'search'),
          runtimeStopFile: path.join(root, 'runtime'),
          originalStopFiles: [path.join(root, 'old-stop')],
        },
        other: { retained: true },
      },
    });
    await Promise.all([
      fs.writeFile(configFile, configText),
      fs.writeFile(stateFile, stateText),
      fs.writeFile(sessionFile, sessionText),
      fs.writeFile(originalFile, originalText),
      fs.writeFile(indexFile, JSON.stringify({ sessionFile: originalFile })),
    ]);
    const folder = path.join(root, 'cache');
    await fs.mkdir(folder);
    const raw = [directory(), body(1), body(2), body(3)],
      filenames = [
        'directory-0.response',
        'content-1.response',
        'content-2.response',
        'content-3.response',
      ];
    for (let i = 0; i < 4; i++)
      await fs.writeFile(path.join(folder, filenames[i]), raw[i]);
    await fs.writeFile(
      path.join(folder, 'state-at-stop.private.json'),
      stateText,
    );
    cacheFile = path.join(folder, 'manifest.private.json');
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        version: 1,
        source: 'saved-original-manual-refresh-responses',
        target: mpId,
        requests: 4,
        savedBodies: 3,
        selectedArticles: 10,
        verifiedBodies: 2,
        imagesFetched: 0,
        directoryArticles: 20,
        attemptedAt: at,
        configSha256: sha(configText),
        sessionSha256: sha(sessionText),
        stateSha256: sha(stateText),
        currentStopSha256: sha(JSON.stringify(JSON.parse(stateText).stop)),
        responses: filenames.map((filename, i) => ({
          filename,
          stage: filename.replace('.response', ''),
          bytes: Buffer.byteLength(raw[i]),
          sha256: sha(raw[i]),
        })),
      }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const args = async () => ({
    configFile,
    mpId,
    cacheManifestFile: cacheFile,
    cacheManifestSha256: sha(await fs.readFile(cacheFile, 'utf8')),
    expectedConfigSha256: sha(configText),
    expectedStateSha256: sha(stateText),
    expectedSessionSha256: sha(sessionText),
    response: {
      url: 'https://weread.qq.com/web/login/renewal',
      status: 200,
      data: { succ: 1 },
      setCookies: [
        'wr_vid=123; Domain=.weread.qq.com; Path=/; Max-Age=5400',
        'wr_skey=second-key; Domain=.weread.qq.com; Path=/; Max-Age=5400',
      ],
    },
    renewedAt: new Date(now).toISOString(),
    approvedAt: new Date(now).toISOString(),
    approval: 'resume-proven-body-time-contract-repair' as const,
  });
  const binding = async () =>
    JSON.parse(await fs.readFile(configFile, 'utf8')).feeds[mpId];
  const allowNetworkBodies = () => {
    (axios.get as jest.Mock).mockImplementation(async (url, opts) => {
      if (!url.endsWith('/content')) throw Error('unexpected-directory-replay');
      const n = Number(
        opts.params.reviewId.split('_').pop().replace(/^a+/, ''),
      );
      return { status: 200, data: body(n) };
    });
  };

  it('reuses the directory and first three bodies, fetching only 4-10 under the original batch identity', async () => {
    const oldIndex = await fs.readFile(indexFile, 'utf8'),
      oldOriginal = await fs.readFile(originalFile, 'utf8');
    const adopted = await activateReviewedWereadBatch(await args());
    expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(adopted.platformRequests).toBe(0);
    const c = await binding(),
      firstState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(firstState.stop).toEqual(JSON.parse(stateText).stop);
    const preview = await previewNormalWebMaintenanceBinding(
      configFile,
      {
        id: '123',
        status: 1,
        token: JSON.stringify({ wr_vid: '123', wr_skey: 'human-key' }),
      },
      mpId,
    );
    expect(preview).toMatchObject({
      connected: true,
      ready: true,
      connectedAt: new Date(now).toISOString(),
    });
    await expect(fetchOwnerWereadLatest(c, 'public')).rejects.toThrow(
      '仅供本机',
    );
    await expect(fetchOwnerWereadLatest(c, 'scheduled')).rejects.toThrow(
      '仅供本机',
    );
    expect(axios.get).not.toHaveBeenCalled();
    allowNetworkBodies();
    const page = await fetchOwnerWereadLatest(c, 'local-manual');
    expect(page.articles).toHaveLength(10);
    expect(page.articles[2].publishTime).toBe(bodyTime(3));
    expect(axios.get).toHaveBeenCalledTimes(7);
    expect(axios.post).not.toHaveBeenCalled();
    const reviewIds = (axios.get as jest.Mock).mock.calls.map(
      (call) => call[1].params.reviewId,
    );
    expect(reviewIds).toEqual(
      Array.from({ length: 7 }, (_, i) => `${mpId}_${originalId(i + 4)}`),
    );
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(state.response).toMatchObject({ stage: 'content-10', requests: 11 });
    expect(state.batchProgress).toMatchObject({
      originalAttemptAt: at,
      cachedBodies: 3,
      newBodyRequests: 7,
      cachedDirectory: true,
    });
    expect(state.stop).toEqual(JSON.parse(stateText).stop);
    expect(await fs.readFile(indexFile, 'utf8')).toBe(oldIndex);
    expect(await fs.readFile(originalFile, 'utf8')).toBe(oldOriginal);
    expect(
      JSON.parse(await fs.readFile(configFile, 'utf8')).feeds.other,
    ).toEqual({ retained: true });
    expect(
      ownerLatestReviewedBatchAuthorized(
        state,
        JSON.parse(await fs.readFile(c.sessionFile, 'utf8')),
        '123',
        mpId,
        now,
      ),
    ).toBe(true);
    await expect(fetchOwnerWereadLatest(c, 'local-manual')).rejects.toThrow(
      '冷却',
    );
    await expect(activateReviewedWereadBatch(await args())).rejects.toThrow();
    jest.spyOn(Date, 'now').mockReturnValue(now + 16 * 60000);
    (axios.get as jest.Mock).mockImplementation(async (url, options) => {
      if (url.endsWith('/articles')) return { status: 200, data: directory() };
      const n = Number(
        options.params.reviewId.split('_').pop().replace(/^a+/, ''),
      );
      return { status: 200, data: body(n) };
    });
    const repeat = await fetchOwnerWereadLatest(c, 'local-manual');
    expect(repeat.articles.map((article) => article.id)).toEqual(
      page.articles.map((article) => article.id),
    );
    expect(axios.get).toHaveBeenCalledTimes(18);
    expect(
      JSON.parse(await fs.readFile(stateFile, 'utf8')).batchProgress,
    ).toMatchObject({
      cachedDirectory: false,
      cachedBodies: 0,
      newBodyRequests: 10,
    });
  });
  it('stops immediately on a new platform challenge and cannot replay the consumed continuation', async () => {
    await activateReviewedWereadBatch(await args());
    const c = await binding();
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: '{"errCode":-2041}',
    });
    await expect(fetchOwnerWereadLatest(c, 'local-manual')).rejects.toThrow(
      '-2041',
    );
    await expect(fetchOwnerWereadLatest(c, 'local-manual')).rejects.toThrow(
      '已停止',
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    expect(state.stop.stage).toBe('content-4');
    expect(state.stop.requests).toBe(5);
  });
  it('refuses a corrupt cached body before any new request or reservation', async () => {
    await activateReviewedWereadBatch(await args());
    const before = await fs.readFile(stateFile, 'utf8');
    await fs.appendFile(
      path.join(path.dirname(cacheFile), 'content-3.response'),
      'tampered',
    );
    await expect(
      fetchOwnerWereadLatest(await binding(), 'local-manual'),
    ).rejects.toThrow();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await fs.readFile(stateFile, 'utf8')).toBe(before);
  });
  it('does not replay a consumed interrupted batch', async () => {
    await activateReviewedWereadBatch(await args());
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.reviewedBatchContinuationAuthorization.consumedAt = new Date(
      now,
    ).toISOString();
    await fs.writeFile(stateFile, JSON.stringify(state));
    await expect(
      fetchOwnerWereadLatest(await binding(), 'local-manual'),
    ).rejects.toThrow();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it.each(['业务码 -2041', 'HTTP 401', '正文内容缺失'])(
    'never releases an unrelated stop (%s)',
    async (reason) => {
      const state = JSON.parse(stateText);
      state.stop.reason = reason;
      await fs.writeFile(stateFile, JSON.stringify(state));
      await expect(
        activateReviewedWereadBatch({
          ...(await args()),
          expectedStateSha256: sha(JSON.stringify(state)),
        }),
      ).rejects.toThrow();
      expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
      expect(axios.post).not.toHaveBeenCalled();
    },
  );
  it('serializes against another collection and preserves its lock', async () => {
    await fs.writeFile(stateFile + '.lock', 'another-operation');
    await expect(activateReviewedWereadBatch(await args())).rejects.toThrow();
    expect(await fs.readFile(stateFile + '.lock', 'utf8')).toBe(
      'another-operation',
    );
    expect(
      await fs.stat(configFile + '.native-login.lock').catch(() => null),
    ).toBeNull();
  });
  it('rolls back authorization if the config commit fails', async () => {
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      if (b === configFile) throw Error('synthetic-config-failure');
      return rename(a, b);
    });
    await expect(activateReviewedWereadBatch(await args())).rejects.toThrow();
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateText);
    expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
    expect(
      (await fs.readdir(root)).some(
        (f) => f.endsWith('.lock') || f.endsWith('.pending'),
      ),
    ).toBe(false);
  });
  it('does not turn expired renewal evidence into a valid continuation', async () => {
    const input = await args();
    input.renewedAt = new Date(now - 2 * 3600000).toISOString();
    input.approvedAt = new Date(now).toISOString();
    await expect(activateReviewedWereadBatch(input)).rejects.toThrow();
    expect(await fs.readFile(configFile, 'utf8')).toBe(configText);
    expect(() => ownerSessionCookie(session(), '123', now)).toThrow();
  });
});
