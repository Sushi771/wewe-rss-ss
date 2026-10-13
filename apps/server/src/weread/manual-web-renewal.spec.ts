import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import axios from 'axios';
import { manualWebSession } from './manual-web-renewal';
import {
  normalWebSha256 as sha,
  NORMAL_WEB_RENEWAL_URL,
} from './normal-web-renewal';
import { OwnerWebSession } from '../collection/owner-web-search';
import { SearchConfig } from '../collection/owner-search-update';
import {
  ownerLatestAuthHash,
  ownerLatestDailyRenewalAuthorized,
  ownerLatestStopMessage,
} from '../collection/owner-weread-session-state';
import { fetchOwnerWereadLatest } from '../collection/owner-weread-latest';
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
const now = Date.parse(fixture.now),
  successAt = now - 20 * 60000;
describe('next local manual refresh normal renewal (synthetic files, zero real HTTP)', () => {
  let root: string,
    c: SearchConfig,
    state: any,
    session: OwnerWebSession,
    text: string;
  const write = async () =>
    fs.writeFile(c.wereadLatestStateFile!, JSON.stringify(state));
  const resolve = () => manualWebSession(c, state, 'local-manual', write);
  beforeEach(async () => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-daily-renewal-'));
    c = {
      mpId: 'MP_WXS_1234567890',
      name: 'synthetic',
      biz: 'MTIzNDU2Nzg5MA==',
      ownerVid: '123',
      sessionFile: path.join(root, 'base.json'),
      stateFile: path.join(root, 'search.json'),
      runtimeStopFile: path.join(root, 'runtime.json'),
      originalStopFiles: [],
      wereadLatestStateFile: path.join(root, 'latest.json'),
      wereadDirectoryEnabled: true,
    };
    session = structuredClone(fixture.initialSession);
    session.cookies.find((v) => v.name === 'wr_skey')!.expires =
      (now - 10000) / 1000;
    text = JSON.stringify(session, null, 2);
    await fs.writeFile(c.sessionFile, text);
    const auth = ownerLatestAuthHash(session, '123', successAt);
    state = {
      lastAttemptAt: successAt - 1000,
      lastSuccessAt: successAt,
      sessionAuthHash: auth,
      response: { stage: 'content-10', httpStatus: 200 },
      articleIds: Array.from(
        { length: 10 },
        (_, n) => 'WX_1234567890_' + (100 + n) + '_1',
      ),
      manualRefreshAuthorization: {
        source: session.source,
        target: c.mpId,
        authHash: auth,
        sessionCapturedAt: session.capturedAt,
        approvedAt: session.capturedAt,
        stopHash: sha('null'),
      },
    };
    await write();
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: fixture.data,
      headers: { 'set-cookie': fixture.setCookies },
    });
  });
  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('reserves once and reuses fixed ordinary renewal, preserving exact scan/binding and requiring one new validation', async () => {
    const result = await resolve();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      NORMAL_WEB_RENEWAL_URL,
      { rq: '%2Fweb%2Fbook%2Fread', ql: false },
      expect.objectContaining({ maxRedirects: 0, proxy: false }),
    );
    const sent = (axios.post as jest.Mock).mock.calls[0][2].headers.Cookie;
    expect(sent).not.toContain('old-web-skey');
    expect(sent).toContain('old-web-refresh');
    expect(result.capturedAt).toBe(session.capturedAt);
    expect(await fs.readFile(c.sessionFile, 'utf8')).toBe(text);
    expect(state.lastSuccessAt).toBe(successAt);
    expect(state.sessionAuthHash).toBe(
      ownerLatestAuthHash(session, '123', successAt),
    );
    expect(state.normalManualRenewalAuthorization.validUntil).toBe(
      '2026-10-04T20:19:06.000Z',
    );
    expect(state.normalManualRenewalAuthorization.parentSessionSha256).toBe(
      sha(text),
    );
    expect(
      ownerLatestDailyRenewalAuthorized(state, result, '123', c.mpId),
    ).toBe(true);
    expect(ownerLatestStopMessage(state, result, '123', c.mpId)).toBeNull();
    expect(await resolve()).toEqual(result);
    expect(axios.post).toHaveBeenCalledTimes(1);
    state.normalManualRenewalAuthorization.consumedAt =
      new Date().toISOString();
    state.lastAttemptAt = now;
    expect(
      ownerLatestDailyRenewalAuthorized(state, result, '123', c.mpId),
    ).toBe(false);
    state.lastSuccessAt = now + 10;
    state.sessionAuthHash = ownerLatestAuthHash(result, '123');
    expect(
      ownerLatestDailyRenewalAuthorized(state, result, '123', c.mpId),
    ).toBe(true);
    state.stop = {
      stage: 'content-1',
      reason: '业务码 -2041',
      sessionAuthHash: state.sessionAuthHash,
    };
    expect(
      ownerLatestDailyRenewalAuthorized(state, result, '123', c.mpId),
    ).toBe(false);
  });
  it.each(['scheduled', 'public'] as const)(
    'does not renew from %s',
    async (trigger) => {
      expect(await manualWebSession(c, state, trigger, write)).toEqual(session);
      expect(axios.post).not.toHaveBeenCalled();
    },
  );
  it('does not renew healthy credentials or rewrite state', async () => {
    jest.setSystemTime(now - 15000);
    const before = await fs.readFile(c.wereadLatestStateFile!, 'utf8');
    expect(await resolve()).toEqual(session);
    expect(axios.post).not.toHaveBeenCalled();
    expect(await fs.readFile(c.wereadLatestStateFile!, 'utf8')).toBe(before);
  });
  it('does not apply a prior binding overlay or expired deadline to a new normal human login', async () => {
    session.cookies.find((v) => v.name === 'wr_skey')!.expires =
      (now + 60000) / 1000;
    await fs.writeFile(c.sessionFile, JSON.stringify(session));
    state.normalManualRenewalAuthorization = {
      bindingSessionSha256: 'f'.repeat(64),
      sessionFile: path.join(root, 'must-not-read.json'),
      validUntil: new Date(now - 1).toISOString(),
    };
    state.reviewedBatchContinuationAuthorization = {
      resultingSessionSha256: 'e'.repeat(64),
      validUntil: new Date(now - 1).toISOString(),
    };
    await write();
    expect(await resolve()).toEqual(session);
    expect(axios.post).not.toHaveBeenCalled();
  });
  it.each([
    'no-success',
    'pending-validation',
    'new-stop',
    'missing-refresh',
    'wrong-owner',
    'cooldown',
    'incomplete-ten',
    'future-success',
  ])('blocks %s before transport', async (kind) => {
    if (kind === 'no-success') delete state.lastSuccessAt;
    if (kind === 'pending-validation') state.lastAttemptAt = successAt + 1;
    if (kind === 'new-stop')
      state.stop = { stage: 'content-1', reason: '腾讯验证或访问限制' };
    if (kind === 'missing-refresh')
      session.cookies = session.cookies.filter((v) => v.name !== 'wr_rt');
    if (kind === 'wrong-owner') session.ownerVid = '999';
    if (kind === 'cooldown') state.lastAttemptAt = now - 1000;
    if (kind === 'incomplete-ten') state.articleIds.pop();
    if (kind === 'future-success') state.lastSuccessAt = now + 1;
    await fs.writeFile(c.sessionFile, JSON.stringify(session));
    await write();
    const before = await fs.readFile(c.wereadLatestStateFile!, 'utf8');
    await expect(resolve()).rejects.toThrow('正常续期');
    expect(axios.post).not.toHaveBeenCalled();
    expect(await fs.readFile(c.wereadLatestStateFile!, 'utf8')).toBe(before);
  });
  it.each([302, 401, 429])(
    'stops HTTP %s without following or retrying, preserving old stop',
    async (status) => {
      (axios.post as jest.Mock).mockResolvedValue({
        status,
        data: { succ: 1 },
        headers: {},
      });
      await expect(resolve()).rejects.toThrow('正常续期');
      await expect(resolve()).rejects.toThrow('正常续期');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(state.stop).toBeUndefined();
      expect(state.normalManualRenewalStop.requests).toBe(1);
      expect(await fs.readFile(c.sessionFile, 'utf8')).toBe(text);
    },
  );
  it('blocks transport failure and an interrupted reserved attempt without retry', async () => {
    (axios.post as jest.Mock).mockRejectedValue(
      new Error('secret-cookie-error'),
    );
    await expect(resolve()).rejects.toThrow('正常续期');
    delete state.normalManualRenewalStop;
    await write();
    await expect(resolve()).rejects.toThrow('正常续期');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state)).not.toContain('secret-cookie-error');
  });
  it('original refresh requests only one renewal before a subsequent refusal, then retains both stops', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: '{"errCode":-2041}',
      headers: {},
    });
    await expect(fetchOwnerWereadLatest(c, 'local-manual')).rejects.toThrow(
      '-2041',
    );
    await expect(fetchOwnerWereadLatest(c, 'local-manual')).rejects.toThrow(
      '已停止',
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(
      await fs.readFile(c.wereadLatestStateFile!, 'utf8'),
    );
    expect(saved.normalManualRenewalAuthorization.normalLoginAt).toBe(
      session.capturedAt,
    );
    expect(saved.stop.reason).toBe('业务码 -2041');
    expect(await fs.readFile(c.sessionFile, 'utf8')).toBe(text);
  });
  it('renews an already successful reviewed time-repair context without changing its old stop or deadline', async () => {
    session.renewedAt = new Date(now - 22 * 60000).toISOString();
    text = JSON.stringify(session);
    await fs.writeFile(c.sessionFile, text);
    state.stop = {
      at: new Date(now - 23 * 60000).toISOString(),
      stage: 'content-3',
      requests: 4,
      reason: '正文与目录的身份、标题或发布时间冲突',
      sessionAuthHash: 'b'.repeat(64),
    };
    const originalAttemptAt = now - 24 * 60000;
    state.normalWebMaintenanceAuthorization = {
      resultingSessionSha256: 'a'.repeat(64),
      resultingAuthHash: 'b'.repeat(64),
      consumedAt: new Date(originalAttemptAt).toISOString(),
    };
    state.reviewedBatchContinuationAuthorization = {
      source: 'same-owner-reviewed-body-time-repair',
      policy: 'one-cache-resume-then-local-manual',
      target: c.mpId,
      resultingAuthHash: state.sessionAuthHash,
      resultingSessionSha256: sha(JSON.stringify(session)),
      parentSessionSha256: 'a'.repeat(64),
      parentAuthHash: 'b'.repeat(64),
      originalAttemptAt,
      normalLoginAt: session.capturedAt,
      renewedAt: session.renewedAt,
      approvedAt: new Date(now - 21 * 60000).toISOString(),
      consumedAt: new Date(now - 21 * 60000).toISOString(),
      validUntil: new Date(now - 10000).toISOString(),
      cacheManifestSha256: 'c'.repeat(64),
      failedStopSha256: sha(JSON.stringify(state.stop)),
      failedResponseSha256: 'd'.repeat(64),
    };
    await write();
    const oldStop = JSON.stringify(state.stop),
      oldRepair = JSON.stringify(state.reviewedBatchContinuationAuthorization);
    const result = await resolve();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(
      ownerLatestDailyRenewalAuthorized(state, result, '123', c.mpId),
    ).toBe(true);
    expect(JSON.stringify(state.stop)).toBe(oldStop);
    expect(JSON.stringify(state.reviewedBatchContinuationAuthorization)).toBe(
      oldRepair,
    );
    expect(result.capturedAt).toBe(session.capturedAt);
  });
  it('original route validates all ten after renewal and later manual refresh reuses the same session', async () => {
    const groups = Array.from({ length: 10 }, (_, i) => {
      const n = i + 1,
        originalId = String(n).padStart(22, 'a'),
        reviewId = c.mpId + '_' + originalId;
      return {
        subReviews: [
          {
            reviewId,
            review: {
              reviewId,
              type: 16,
              bookId: '',
              belongBookId: c.mpId,
              mpInfo: {
                originalId,
                title: 'sample-' + n,
                mp_name: c.name,
                time: 1700000100 - n,
              },
            },
          },
        ],
      };
    });
    (axios.get as jest.Mock).mockImplementation(
      async (url: string, options: any) => {
        if (url.endsWith('/articles'))
          return {
            status: 200,
            data: JSON.stringify({ reviews: groups }),
            headers: {},
          };
        const n = Number(options.params.reviewId.slice(-2).replace(/^a+/, ''));
        return {
          status: 200,
          data: `<meta property="og:url" content="https://mp.weixin.qq.com/s/${String(n).padStart(22, 'a')}"><h1 id="activity-name">sample-${n}</h1><span id="js_name">${c.name}</span><div id="js_content">body-${n}</div><script>var biz="${c.biz}";var mid="${100 + n}";var idx="1";var sn="abcd";var ct=${1700000100 - n};</script>`,
          headers: {},
        };
      },
    );
    const first = await fetchOwnerWereadLatest(c, 'local-manual');
    expect(first.articles).toHaveLength(10);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(11);
    jest.setSystemTime(now + 16 * 60000);
    const second = await fetchOwnerWereadLatest(c, 'local-manual');
    expect(second.articles.map((a) => a.id)).toEqual(
      first.articles.map((a) => a.id),
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(22);
    expect(await fs.readFile(c.sessionFile, 'utf8')).toBe(text);
    state = JSON.parse(await fs.readFile(c.wereadLatestStateFile!, 'utf8'));
    jest.setSystemTime(now + 91 * 60000);
    const nextExpiry = new Date(now + 181 * 60000).toUTCString();
    const nextCookies = fixture.setCookies.map((line: string) =>
      line.startsWith('wr_skey=')
        ? line
            .replace('renewed-web-skey', 'next-web-skey')
            .replace(/Expires=[^;]+/, 'Expires=' + nextExpiry)
        : line,
    );
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: fixture.data,
      headers: { 'set-cookie': nextCookies },
    });
    const next = await resolve();
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(next.capturedAt).toBe(session.capturedAt);
    expect(next.cookies.find((v) => v.name === 'wr_skey')!.value).toBe(
      'next-web-skey',
    );
    expect(await fs.readFile(c.sessionFile, 'utf8')).toBe(text);
  });
});
