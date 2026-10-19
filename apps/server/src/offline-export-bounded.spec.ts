import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TrpcService } from './trpc/trpc.service';
import { TrpcRouter } from './trpc/trpc.router';
import { LocalArticleStore } from './article-local-save';

describe('bounded cached-only offline feed export', () => {
  let root: string;
  const feed = { id: 'MP_WXS_1234567890', mpName: 'Synthetic', group: null };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-bounded-export-'));
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NO_NETWORK'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  function setup(count = 19) {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: 'article-' + i,
      title: 'Article ' + i,
      sourceUrl: null,
      contentHtml: '<div id="js_content"><p>Body ' + i + '</p></div>',
      lastBodyStatus: 'available',
      metrics: null,
      publishTime: 1791210060,
    }));
    const findMany = jest.fn(async ({ select, where }) => {
      if (!select.contentHtml) return rows.map(({ id }) => ({ id }));
      // Deliberately reversed DB order: output membership follows the first read.
      return rows.filter((row) => where.id.in.includes(row.id)).reverse();
    });
    const prisma = {
      feed: { findUnique: jest.fn().mockResolvedValue(feed) },
      article: { findMany },
    };
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const router = new TrpcRouter(
      new TrpcService(prisma as any, config, {} as any, {} as any),
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    return { router, findMany, rows };
  }
  it('freezes at most 5000 identities and reads no more than eight complete bodies at once', async () => {
    const { router, findMany } = setup();
    expect(await router.buildOfflineFeedDirectory(feed.id, root)).toMatchObject(
      { articles: 19, complete: 19, incomplete: [] },
    );
    expect(findMany.mock.calls[0][0]).toMatchObject({
      take: 5001,
      select: { id: true },
      orderBy: [{ publishTime: 'desc' }, { id: 'asc' }],
    });
    expect(
      findMany.mock.calls.slice(1).map(([args]) => args.where.id.in.length),
    ).toEqual([8, 8, 3]);
    for (const [args] of findMany.mock.calls.slice(1))
      expect(args.where.mpId).toBe(feed.id);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('rejects overflow before loading any body', async () => {
    const { router, findMany } = setup(5001);
    await expect(
      router.buildOfflineFeedDirectory(feed.id, root),
    ).rejects.toThrow('limit');
    expect(findMany).toHaveBeenCalledTimes(1);
  });
  it('does not silently omit a deleted frozen member or include new rows', async () => {
    const { router, findMany } = setup(2);
    findMany.mockImplementationOnce(async () => [
      { id: 'deleted' },
      { id: 'article-0' },
    ]);
    await expect(
      router.buildOfflineFeedDirectory(feed.id, root),
    ).rejects.toThrow('membership changed');
  });
  it('honors cancellation before the first body request', async () => {
    const { router, findMany } = setup();
    await expect(
      router.buildOfflineFeedDirectory(feed.id, root, {}, () => true),
    ).rejects.toThrow('cancelled');
    expect(findMany).toHaveBeenCalledTimes(1);
  });
  it('bounds retained discovery to 64 members and preserves missing-body fallback', async () => {
    const { router, rows } = setup(65);
    rows[1].contentHtml = '';
    const batch = jest.spyOn(LocalArticleStore.prototype, 'withRetainedBatch');
    try {
      const result = await router.buildOfflineFeedDirectory(feed.id, root);
      expect(batch.mock.calls.map(([members]) => members.length)).toEqual([
        64, 1,
      ]);
      expect(result).toMatchObject({ articles: 65, complete: 64 });
      expect(result?.incomplete).toHaveLength(1);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      batch.mockRestore();
    }
  }, 30000);
});
