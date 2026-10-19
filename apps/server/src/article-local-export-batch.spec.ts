import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from '@nestjs/config';
import { saveCachedArticleBatch } from './article-local-export-batch';
import { LocalArticleStore } from './article-local-save';
import { TrpcRouter } from './trpc/trpc.router';
import { TrpcService } from './trpc/trpc.service';
import express from 'express';

const localFetch = global.fetch;

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('node:fs/promises'),
}));

describe('actual cached local batch boundary', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'wewe-local-batch-'));
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NO_UPSTREAM'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  function setup(count = 17) {
    const rows = Array.from({ length: count }, (_, id) => ({
      id: 'article-' + id,
      title: 'Article ' + id,
      sourceUrl: null,
      publishTime: 1791210060,
      contentHtml: '<div id="js_content">Body ' + id + '</div>',
      lastBodyStatus: 'available',
      metrics: null,
      feed: { id: 'MP_WXS_1234567890', mpName: 'Synthetic', group: null },
    }));
    const findMany = jest.fn(async ({ where, select }) =>
      rows
        .filter((row) => where.id.in.includes(row.id))
        .reverse()
        .map((row) => {
          if (select.contentHtml) return row;
          return {
            id: row.id,
            title: row.title,
            sourceUrl: row.sourceUrl,
            publishTime: row.publishTime,
            feed: row.feed,
          };
        }),
    );
    const prisma = { article: { findMany } };
    return {
      rows,
      findMany,
      prisma: prisma as any,
      ids: rows.map((row) => row.id),
    };
  }
  it('freezes metadata, discovers once, reads eight bodies per query and preserves edited files on repeat', async () => {
    const { rows, findMany, prisma, ids } = setup();
    const scan = jest.spyOn(fs, 'opendir');
    const first = await saveCachedArticleBatch(prisma, ids, root);
    expect(first.results.map((row) => row.id)).toEqual(ids);
    expect(first.results.every((row) => row.saved?.status === 'new')).toBe(
      true,
    );
    expect(
      scan.mock.calls.filter(([directory]) => directory === root),
    ).toHaveLength(1);
    expect(findMany.mock.calls[0][0].select.contentHtml).toBeUndefined();
    expect(
      findMany.mock.calls.slice(1).map(([args]) => args.where.id.in.length),
    ).toEqual([8, 8, 1]);
    expect(first.results[0].saved).not.toHaveProperty('receipt');
    expect(first.results[0].saved).not.toHaveProperty('receiptBytes');
    const note = first.results[0].saved!.markdownPath;
    await fs.writeFile(note, 'User notes must remain');
    scan.mockClear();
    const second = await saveCachedArticleBatch(
      prisma,
      [...ids].reverse(),
      root,
    );
    expect(second.results.every((row) => row.saved?.status === 'skipped')).toBe(
      true,
    );
    expect(await fs.readFile(note, 'utf8')).toBe('User notes must remain');
    expect(
      scan.mock.calls.filter(([directory]) => directory === root),
    ).toHaveLength(1);
    expect(await fs.readdir(root)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.wewe-save-/)]),
    );
    expect(rows).toHaveLength(17);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('cancel after the current article stops submission, returns a partial receipt and releases every target lock', async () => {
    const { prisma, ids, findMany } = setup();
    let cancelled = false;
    const original = LocalArticleStore.prototype.save;
    jest
      .spyOn(LocalArticleStore.prototype, 'save')
      .mockImplementation(async function (this: LocalArticleStore, ...args) {
        const saved = await original.apply(this, args);
        cancelled = true;
        return saved;
      });
    const result = await saveCachedArticleBatch(
      prisma,
      ids,
      root,
      () => cancelled,
    );
    expect(result.cancelled).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(
      (await fs.readdir(root)).some((name) => name.startsWith('.wewe-save-')),
    ).toBe(false);
  });
  it('missing frozen membership fails before loading bodies or creating a scope', async () => {
    const { prisma, ids, findMany } = setup();
    findMany.mockResolvedValueOnce([]);
    await expect(saveCachedArticleBatch(prisma, ids, root)).rejects.toThrow(
      'MEMBERS_CHANGED',
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('the new route retains authentication and accepts no request-supplied directory', async () => {
    const { prisma, ids, findMany } = setup();
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { obsidianPath: root, updateDelayTime: 0 },
    });
    const router = new TrpcRouter(
      new TrpcService(prisma, config, {} as any, {} as any),
      prisma,
      config,
      {} as any,
      {} as any,
    );
    await expect(
      router.appRouter
        .createCaller({ errorMsg: 'denied' } as any)
        .article.saveToObsidianBatch({ ids }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      router.appRouter
        .createCaller({ errorMsg: null } as any)
        .article.saveToObsidianBatch({ ids, directory: root } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(findMany).not.toHaveBeenCalled();
  });
  it('the authenticated local HTTP route publishes exact targets and returns no internal receipts', async () => {
    const { prisma, ids } = setup(3);
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { obsidianPath: root, updateDelayTime: 0 },
    });
    const router = new TrpcRouter(
      new TrpcService(prisma, config, {} as any, {} as any),
      prisma,
      config,
      {} as any,
      {} as any,
    );
    const app = express();
    await router.applyMiddleware(app as any);
    const listener = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const port = (listener.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    try {
      const response = await localFetch(
        origin + '/trpc/article.saveToObsidianBatch',
        {
          method: 'POST',
          headers: {
            authorization: 'fixture',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ids }),
        },
      );
      expect(response.status).toBe(200);
      const envelope = (await response.json()) as any;
      const result = envelope.result.data;
      expect(result.cancelled).toBe(false);
      expect(result.results.map((row: { id: string }) => row.id)).toEqual(ids);
      for (const row of result.results) {
        expect(row.saved?.status).toBe('new');
        expect(row.saved).not.toHaveProperty('receiptBytes');
        expect(row.saved).not.toHaveProperty('receiptPath');
        expect(await fs.readFile(row.saved!.markdownPath, 'utf8')).toContain(
          'Body',
        );
      }
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
