import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanOwnerCandidates } from './owner-candidate-scan';
import { readOwnerSearchConfig } from './owner-search-update';
import { fetchOwnerSearchPage } from './owner-web-search';

jest.mock('./owner-search-update', () => ({
  readOwnerSearchConfig: jest.fn(),
}));
jest.mock('./owner-web-search', () => ({ fetchOwnerSearchPage: jest.fn() }));

describe('owner candidate scan', () => {
  let dir: string;
  const prior = process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE;
  const mpId = 'MP_WXS_1234567890';
  const url =
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=123&idx=1&sn=abcd';
  const candidate = {
    id: 'WX_1234567890_123_1',
    mpId,
    url,
    requestUrl: `${url}&private_extra=hidden`,
    title: '真实候选',
    indexTimestamp: 1790000000,
    discovery: {
      source: 'owner-web-search',
      capturedAt: '2026-10-02T01:00:00.000Z',
      page: 1,
    },
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-candidate-scan-'));
    process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE = path.join(
      dir,
      'snapshot.json',
    );
    (readOwnerSearchConfig as jest.Mock).mockResolvedValue({
      sessionFile: path.join(dir, 'session.json'),
      stateFile: path.join(dir, 'state.json'),
      ownerVid: '123',
      name: '测试号',
      biz: 'MTIzNDU2Nzg5MA==',
      searchMaxPages: 2,
    });
    (fetchOwnerSearchPage as jest.Mock).mockResolvedValue({
      candidates: [candidate],
      pages: 1,
      requests: 1,
      capturedAt: '2026-10-02T01:00:00.000Z',
      truncated: true,
      termination: 'page_budget',
      coverage: 'search-results',
      complete: false,
    });
  });
  afterEach(async () => {
    jest.resetAllMocks();
    if (prior === undefined)
      delete process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE;
    else process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE = prior;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stores a bounded private index snapshot without article bodies or credentials', async () => {
    const result = await scanOwnerCandidates(mpId);
    expect(result).toMatchObject({
      status: 'candidate_scan_only',
      candidates: 1,
      truncated: true,
      complete: false,
    });
    expect(fetchOwnerSearchPage).toHaveBeenCalledWith({
      sessionFile: path.join(dir, 'session.json'),
      stateFile: path.join(dir, 'state.json'),
      ownerVid: '123',
      name: '测试号',
      biz: 'MTIzNDU2Nzg5MA==',
      maxPages: 2,
    });
    const saved = await fs.readFile(
      process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE!,
      'utf8',
    );
    expect(saved).not.toContain('private_extra');
    expect(saved).not.toContain('sessionFile');
    expect(JSON.parse(saved).mpId).toBe(mpId);
    expect(JSON.parse(saved).result.candidates).toEqual([
      {
        id: candidate.id,
        mpId,
        url,
        title: candidate.title,
        indexTimestamp: candidate.indexTimestamp,
        discovery: candidate.discovery,
      },
    ]);
  });

  it('retains the previous snapshot after an upstream stop or wrong publisher', async () => {
    const file = process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE!;
    await fs.writeFile(file, 'prior-success');
    (fetchOwnerSearchPage as jest.Mock).mockRejectedValueOnce(
      new Error('auth_expired'),
    );
    await expect(scanOwnerCandidates(mpId)).rejects.toThrow('auth_expired');
    expect(await fs.readFile(file, 'utf8')).toBe('prior-success');
    (fetchOwnerSearchPage as jest.Mock).mockResolvedValueOnce({
      candidates: [{ ...candidate, mpId: 'MP_WXS_9999999999' }],
      pages: 1,
      requests: 1,
      capturedAt: '2026-10-02T01:00:00.000Z',
      truncated: true,
      termination: 'page_budget',
      coverage: 'search-results',
      complete: false,
    });
    await expect(scanOwnerCandidates(mpId)).rejects.toThrow(
      'OWNER_CANDIDATE_SNAPSHOT_INVALID',
    );
    expect(await fs.readFile(file, 'utf8')).toBe('prior-success');
  });

  it('replaces a prior successful snapshot only after a new complete scan result', async () => {
    const file = process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE!;
    await fs.writeFile(file, 'prior-success');
    await scanOwnerCandidates(mpId);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.mpId).toBe(mpId);
    expect(saved.result.candidates).toHaveLength(1);
  });

  it('rejects an unconfigured destination before any request', async () => {
    delete process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE;
    await expect(scanOwnerCandidates(mpId)).rejects.toThrow(
      'OWNER_CANDIDATE_SNAPSHOT_NOT_CONFIGURED',
    );
    expect(fetchOwnerSearchPage).not.toHaveBeenCalled();
  });
});
