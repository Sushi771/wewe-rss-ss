import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { scanOwnerCandidates } from '../collection/owner-candidate-scan';

jest.mock('../collection/owner-candidate-scan', () => ({
  scanOwnerCandidates: jest.fn(),
}));

const mpId = 'MP_WXS_1234567890';
const url =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=100&idx=1&sn=abcd';
const candidate = {
  id: 'WX_1234567890_100_1',
  mpId,
  url,
  title: '搜索候选标题',
  indexTimestamp: 1700000000,
  requestUrl: 'private-original-request',
  discovery: { privateField: 'private-discovery' },
};
function snapshot(candidates: unknown[] = [candidate]) {
  return {
    result: {
      candidates,
      pages: 5,
      requests: 5,
      capturedAt: '2026-10-01T17:25:04.363Z',
      truncated: true,
      termination: 'page_budget',
      coverage: 'search-results',
      complete: false,
      token: 'private-token',
    },
    after: { privateDatabaseField: 'private-database' },
  };
}

describe('protected read-only search candidates', () => {
  const previousEnv = { ...process.env };
  let directory: string;
  let router: TrpcRouter;
  let databaseWrite: jest.Mock;
  const config = {
    get: (key: string) =>
      key === 'platform' ? { url: '' } : { updateDelayTime: 0 },
  };
  const caller = (errorMsg: string | null = null) =>
    router.appRouter.createCaller({ errorMsg });
  const writeSnapshot = (value: unknown) =>
    fs.writeFile(
      process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE!,
      JSON.stringify(value),
    );

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-candidates-'));
    process.env.OWNER_SEARCH_CANDIDATE_FEED_ID = mpId;
    process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE = path.join(
      directory,
      'private-snapshot.json',
    );
    databaseWrite = jest.fn();
    const prisma = {
      feed: { update: databaseWrite, upsert: databaseWrite },
      article: { update: databaseWrite, upsert: databaseWrite },
    };
    const service = new TrpcService(
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
    router = new TrpcRouter(
      service,
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
    (scanOwnerCandidates as jest.Mock).mockResolvedValue({
      status: 'candidate_scan_only',
      candidates: 1,
      pages: 1,
      capturedAt: '2026-10-02T01:00:00.000Z',
      truncated: true,
      complete: false,
    });
    await writeSnapshot(snapshot());
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    (scanOwnerCandidates as jest.Mock).mockReset();
    process.env = { ...previousEnv };
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('rejects anonymous access before opening the private file', async () => {
    const read = jest.spyOn(fs, 'readFile');
    await expect(
      caller('请先登录').feed.searchCandidates({ mpId }),
    ).rejects.toThrow('请先登录');
    expect(read).not.toHaveBeenCalled();
  });

  it('scans only the bound feed and leaves article persistence untouched', async () => {
    await expect(
      caller('请先登录').feed.scanCandidates({ mpId }),
    ).rejects.toThrow('请先登录');
    await expect(
      caller().feed.scanCandidates({ mpId: 'MP_WXS_9876543210' }),
    ).rejects.toThrow('未配置候选扫描');
    expect(scanOwnerCandidates).not.toHaveBeenCalled();
    expect(await caller().feed.scanCandidates({ mpId })).toMatchObject({
      status: 'candidate_scan_only',
      candidates: 1,
      complete: false,
    });
    expect(scanOwnerCandidates).toHaveBeenCalledWith(mpId);
    expect(databaseWrite).not.toHaveBeenCalled();
  });

  it('masks a failed scan and preserves the existing snapshot', async () => {
    const file = process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE!;
    const before = await fs.readFile(file, 'utf8');
    (scanOwnerCandidates as jest.Mock).mockRejectedValueOnce(
      new Error('private session path'),
    );
    await expect(caller().feed.scanCandidates({ mpId })).rejects.toThrow(
      '候选扫描未完成',
    );
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(databaseWrite).not.toHaveBeenCalled();
  });

  it('binds to configured feed and ignores caller-provided paths', async () => {
    const read = jest.spyOn(fs, 'readFile');
    expect(
      await caller().feed.searchCandidates({ mpId: 'MP_WXS_9876543210' }),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const result = await caller().feed.searchCandidates({
      mpId,
      path: path.join(directory, 'not-used.json'),
    } as any);
    expect(result?.candidates).toHaveLength(1);
    delete process.env.OWNER_SEARCH_CANDIDATE_FEED_ID;
    expect(await caller().feed.searchCandidates({ mpId })).toBeNull();
  });

  it('returns only safe fields without network, file changes or database writes', async () => {
    const request = jest.spyOn(axios, 'get');
    const data = snapshot();
    data.result.complete = true;
    // Extra original-request fields must never leak into links or response data.
    await writeSnapshot({
      ...data,
      result: {
        ...data.result,
        candidates: [{ ...candidate, url: `${url}&Cookie=private-cookie` }],
      },
    });
    const before = await fs.readFile(
      process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE!,
      'utf8',
    );
    const write = jest.spyOn(fs, 'writeFile');
    const result = await caller().feed.searchCandidates({ mpId });
    expect(result).toEqual({
      mpId,
      candidates: [
        {
          id: candidate.id,
          mpId,
          title: candidate.title,
          url,
          indexTimestamp: candidate.indexTimestamp,
        },
      ],
      capturedAt: data.result.capturedAt,
      pages: 5,
      requests: 5,
      truncated: true,
      termination: 'page_budget',
      coverage: 'search-results',
      complete: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(request).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(databaseWrite).not.toHaveBeenCalled();
    expect(
      await fs.readFile(
        process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE!,
        'utf8',
      ),
    ).toBe(before);
  });

  it.each([
    { ...candidate, mpId: 'MP_WXS_9876543210' },
    { ...candidate, id: 'WX_1234567890_101_1' },
    { ...candidate, url: url.replace('mp.weixin.qq.com', 'example.com') },
    { ...candidate, url: url.replace('https:', 'http:') },
    { ...candidate, url: url.replace('https://', 'https://owner:secret@') },
    { ...candidate, url: `${url}&mid=101` },
    { ...candidate, url: url.replace('sn=abcd', 'sn=invalid') },
    { ...candidate, url: `${url}#private-fragment` },
    { ...candidate, title: '' },
    { ...candidate, indexTimestamp: 1700000000.5 },
  ])('rejects invalid candidate identities or fields %#', async (invalid) => {
    await writeSnapshot(snapshot([invalid]));
    await expect(caller().feed.searchCandidates({ mpId })).rejects.toThrow(
      '搜索候选快照不可用',
    );
  });

  it('rejects duplicate IDs and malformed metadata without private errors', async () => {
    await writeSnapshot(snapshot([candidate, candidate]));
    await expect(caller().feed.searchCandidates({ mpId })).rejects.toThrow(
      '搜索候选快照不可用',
    );
    const data = snapshot();
    data.result.termination = 'private-path-or-token';
    await writeSnapshot(data);
    await expect(caller().feed.searchCandidates({ mpId })).rejects.toThrow(
      /^搜索候选快照不可用，请检查服务器私有配置或重新核验快照。$/,
    );
  });

  it('requires explicit root feed identity for empty snapshots', async () => {
    await writeSnapshot(snapshot([]));
    await expect(caller().feed.searchCandidates({ mpId })).rejects.toThrow(
      '搜索候选快照不可用',
    );
    await writeSnapshot({ ...snapshot([]), mpId });
    expect(
      (await caller().feed.searchCandidates({ mpId }))?.candidates,
    ).toEqual([]);
    await writeSnapshot({ ...snapshot(), mpId: 'MP_WXS_9876543210' });
    await expect(caller().feed.searchCandidates({ mpId })).rejects.toThrow(
      '搜索候选快照不可用',
    );
  });

  it('keeps null index timestamps distinct from publication times', async () => {
    await writeSnapshot(snapshot([{ ...candidate, indexTimestamp: null }]));
    const result = await caller().feed.searchCandidates({ mpId });
    expect(result?.candidates[0].indexTimestamp).toBeNull();
    expect(result?.candidates[0]).not.toHaveProperty('publishTime');
  });

  it('rejects relative, missing, oversized and non-file snapshots safely', async () => {
    for (const file of [
      'relative.json',
      path.join(directory, 'missing.json'),
      directory,
    ]) {
      process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE = file;
      await expect(caller().feed.searchCandidates({ mpId })).rejects.toThrow(
        /^搜索候选快照不可用，请检查服务器私有配置或重新核验快照。$/,
      );
    }
    const oversized = path.join(directory, 'oversized.json');
    await fs.writeFile(oversized, ' '.repeat(2 * 1024 * 1024 + 1));
    process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE = oversized;
    const read = jest.spyOn(fs, 'readFile');
    await expect(caller().feed.searchCandidates({ mpId })).rejects.toThrow(
      '搜索候选快照不可用',
    );
    expect(read).not.toHaveBeenCalled();
  });
});
