import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Wechat2RssSourceGate } from './wechat2rss-source-gate';
import {
  fetchAllowedImage,
  ImageRequestBlockedError,
  ImageRequestTransientError,
} from './image-fetch';
import { archiveProviderImages } from './archive-provider-images';
import { ProviderPage } from './subscription-provider';

const url = 'https://mmbiz.qpic.cn/synthetic-never-requested';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const good = () =>
  new Response(png, { headers: { 'content-type': 'image/png' } });
type GateRow = { state: string; token: string | null; status: number | null };

describe('gated images with real Prisma and isolated SQLite (no network)', () => {
  let db: PrismaClient, databaseUrl: string, gate: Wechat2RssSourceGate;
  let verify: boolean;
  let http: jest.SpyInstance;
  const row = async () =>
    (
      await db.$queryRawUnsafe<GateRow[]>(
        'SELECT state, token, status FROM Wechat2RssSourceGate WHERE id=1',
      )
    )[0];
  const reopen = async () => {
    await db.$disconnect();
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    gate = new Wechat2RssSourceGate(db, () => verify);
  };
  beforeEach(async () => {
    // Every fixture owns a new database. Never use the application's DATABASE_URL.
    const directory = await mkdtemp(join(tmpdir(), 'gated-image-prisma-'));
    databaseUrl = `file:${join(directory, 'synthetic.db').replace(/\\/g, '/')}`;
    verify = true;
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const migration = await readFile(
      join(
        __dirname,
        '../../prisma/migrations/20261014000000_wechat2rss_source_gate/migration.sql',
      ),
      'utf8',
    );
    for (const statement of migration.split(';').filter((part) => part.trim()))
      await db.$executeRawUnsafe(statement);
    gate = new Wechat2RssSourceGate(db, () => verify);
    http = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('UNEXPECTED_SYNTHETIC_FETCH'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db?.$disconnect();
  });

  it.each(
    [408, 500, 502, 503, 504].flatMap((status) =>
      [false, true].map((cancelFails) => [status, cancelFails] as const),
    ),
  )(
    'HTTP %s releases its own intent even with cancel failure %s',
    async (status, cancelFails) => {
      const response = new Response('synthetic', { status });
      if (cancelFails)
        jest
          .spyOn(response.body!, 'cancel')
          .mockRejectedValue(Error('CANCEL_FAILED'));
      http.mockResolvedValueOnce(response).mockResolvedValueOnce(good());
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestTransientError);
      expect(await row()).toEqual({ state: 'idle', token: null, status: null });
      await reopen();
      await expect(fetchAllowedImage(url, undefined, gate)).resolves.toEqual({
        bytes: png,
        type: 'image/png',
      });
      expect(http).toHaveBeenCalledTimes(2);
      expect((await row()).state).toBe('idle');
    },
  );
  it.each(
    [401, 403, 429].flatMap((status) =>
      [false, true].map((cancelFails) => [status, cancelFails] as const),
    ),
  )(
    'restriction %s survives reopen and cancellation failure %s',
    async (status, cancelFails) => {
      const response = new Response('synthetic', { status });
      if (cancelFails)
        jest
          .spyOn(response.body!, 'cancel')
          .mockRejectedValue(Error('CANCEL_FAILED'));
      http.mockResolvedValue(response);
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestBlockedError);
      const stopped = await row();
      expect(stopped).toMatchObject({ state: 'stopped', status });
      await reopen();
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestBlockedError);
      expect(await row()).toEqual(stopped);
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['pending', 'stopped'])(
    'preexisting %s intent prevents dispatch',
    async (state) => {
      await db.$executeRawUnsafe(
        'UPDATE Wechat2RssSourceGate SET state=?, token=?, status=? WHERE id=1',
        state,
        'synthetic-existing-owner',
        state === 'stopped' ? 429 : null,
      );
      const previous = await row();
      await reopen();
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestBlockedError);
      expect(await row()).toEqual(previous);
      expect(http).not.toHaveBeenCalled();
    },
  );
  it('failed begin verification does not dispatch or change idle state', async () => {
    verify = false;
    await expect(
      fetchAllowedImage(url, undefined, gate),
    ).rejects.toBeInstanceOf(ImageRequestBlockedError);
    expect(await row()).toEqual({ state: 'idle', token: null, status: null });
    expect(http).not.toHaveBeenCalled();
  });
  it('keeps pending intent while cancellation is unresolved', async () => {
    let release!: () => void;
    let entered!: () => void;
    const cancelling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Response('synthetic', { status: 503 });
    jest.spyOn(response.body!, 'cancel').mockImplementation(() => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    http.mockResolvedValue(response);
    const work = fetchAllowedImage(url, undefined, gate);
    const rejected = expect(work).rejects.toBeInstanceOf(
      ImageRequestTransientError,
    );
    await cancelling;
    expect((await row()).state).toBe('pending');
    await expect(
      fetchAllowedImage(url, undefined, gate),
    ).rejects.toBeInstanceOf(ImageRequestBlockedError);
    expect(http).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    expect((await row()).state).toBe('idle');
  });
  it.each(['transport', 'AbortError', 'TimeoutError', 'mid-body'])(
    'unknown %s failure retains pending intent',
    async (kind) => {
      if (kind !== 'mid-body')
        http.mockRejectedValue(
          kind === 'transport'
            ? new TypeError('TRANSPORT_FAILED')
            : new DOMException('TRANSPORT_FAILED', kind),
        );
      else {
        let count = 0;
        http.mockResolvedValue(
          new Response(
            new ReadableStream({
              pull(controller) {
                if (count++ === 0) controller.enqueue(png.subarray(0, 12));
                else controller.error(Error('READ_FAILED'));
              },
            }),
            { headers: { 'content-type': 'image/png' } },
          ),
        );
      }
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestBlockedError);
      const pending = await row();
      expect(pending.state).toBe('pending');
      await reopen();
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestBlockedError);
      expect(await row()).toEqual(pending);
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['write', 'verification', 'other-token'])(
    'finish %s failure cannot clear unresolved intent',
    async (kind) => {
      http.mockImplementation(async () => {
        if (kind === 'write')
          await db.$executeRawUnsafe(
            "CREATE TRIGGER refuse_finish BEFORE UPDATE ON Wechat2RssSourceGate WHEN NEW.state = 'idle' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
          );
        if (kind === 'verification') verify = false;
        if (kind === 'other-token')
          await db.$executeRawUnsafe(
            "UPDATE Wechat2RssSourceGate SET token = 'synthetic-other-owner' WHERE id=1",
          );
        return new Response(null, { status: 503 });
      });
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestBlockedError);
      const pending = await row();
      expect(pending.state).toBe('pending');
      if (kind === 'other-token')
        expect(pending.token).toBe('synthetic-other-owner');
      await reopen();
      await expect(
        fetchAllowedImage(url, undefined, gate),
      ).rejects.toBeInstanceOf(ImageRequestBlockedError);
      expect(await row()).toEqual(pending);
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
  it('archives a later article after a known transient without claiming the first image was saved', async () => {
    http
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(good());
    const page: ProviderPage = {
      articles: [1, 2].map((n) => ({
        id: `synthetic-${n}`,
        mpId: 'synthetic-feed',
        url: `https://mp.weixin.qq.com/s/synthetic-${n}`,
        title: 'synthetic',
        publishTime: 1000000000,
        picUrl: '',
        contentHtml: `<div id="js_content">synthetic text<img src="${url}-${n}"></div>`,
      })),
      coverage: 'recent-window',
      upstreamCount: 2,
      bodyMissing: 0,
      imageBlocked: 0,
    };
    const result = await archiveProviderImages(page, {
      imageSourceGate: () => gate,
      preserveTextOnImageFailure: true,
    });
    expect(result.imageBlocked).toBe(1);
    expect(result.mediaRequestBlocked).toBe(false);
    expect(result.articles[0].contentHtml).toContain(
      'data-wewe-image-pending="1"',
    );
    expect(result.articles[0].contentHtml).not.toContain(
      'data:image/png;base64,',
    );
    expect(result.articles[1].contentHtml).toContain(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(http).toHaveBeenCalledTimes(2);
    expect((await row()).state).toBe('idle');
  });
});
