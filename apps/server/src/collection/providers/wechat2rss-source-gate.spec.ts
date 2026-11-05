import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Wechat2RssSourceGate } from '../wechat2rss-source-gate';
import { Wechat2RssProvider } from './wechat2rss';
import { fetchAllowedImage } from '../image-fetch';
import { archiveProviderImages } from '../archive-provider-images';
import { ProviderPage } from '../subscription-provider';

function operation<T>(provider: Wechat2RssProvider, body: () => Promise<T>) {
  return (
    provider as unknown as {
      runSourceOperation<U>(fn: () => Promise<U>): Promise<U>;
    }
  ).runSourceOperation(body);
}

async function fixture() {
  const file = join(
    mkdtempSync(join(tmpdir(), 'wewe-source-gate-')),
    'fixture.sqlite',
  );
  const url = `file:${file.replace(/\\/g, '/')}`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const sql = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20261014000000_wechat2rss_source_gate/migration.sql',
    ),
    'utf8',
  );
  for (const statement of sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await db.$executeRawUnsafe(statement);
  return { db, url };
}

describe('persistent source gate using synthetic responses', () => {
  afterEach(() => jest.restoreAllMocks());

  it('clears after a validated response, persists restriction and blocks a restarted provider', async () => {
    const { db, url } = await fixture();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ err: '', data: [], meta: { total: 0 } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('', { status: 429 }));
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      new Wechat2RssSourceGate(db),
    );
    await expect(provider.listSubscriptions()).resolves.toEqual([]);
    await expect(provider.listSubscriptions()).rejects.toThrow(
      'WECHAT2RSS_SOURCE_RESTRICTED',
    );
    await db.$disconnect();
    const reopened = new PrismaClient({ datasources: { db: { url } } });
    const restarted = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      new Wechat2RssSourceGate(reopened),
    );
    await expect(restarted.listSubscriptions()).rejects.toThrow(
      'WECHAT2RSS_SOURCE_STOPPED',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await reopened.$disconnect();
  });

  it('keeps invalid business response pending across restart', async () => {
    const { db, url } = await fixture();
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ err: '', data: 'invalid' }), {
        status: 200,
      }),
    );
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      new Wechat2RssSourceGate(db),
    );
    await expect(provider.listSubscriptions()).rejects.toThrow(
      'WECHAT2RSS_LIST_INVALID',
    );
    await db.$disconnect();
    const reopened = new PrismaClient({ datasources: { db: { url } } });
    const restarted = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      new Wechat2RssSourceGate(reopened),
    );
    await expect(restarted.listSubscriptions()).rejects.toThrow(
      'WECHAT2RSS_SOURCE_STOPPED',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await reopened.$disconnect();
  });

  it('persists a restriction even when nested code swallows it and blocks the next request', async () => {
    const { db, url } = await fixture();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 403 }));
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      new Wechat2RssSourceGate(db),
    );
    await expect(
      operation(provider, async () => {
        try {
          await provider.listSubscriptions();
        } catch {
          /* synthetic consumer */
        }
        try {
          await provider.listSubscriptions();
        } catch {
          /* synthetic consumer */
        }
      }),
    ).rejects.toThrow('WECHAT2RSS_SOURCE_RESTRICTED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await db.$disconnect();
    const reopened = new PrismaClient({ datasources: { db: { url } } });
    const rows = await reopened.$queryRaw<
      Array<{ state: string; status: number }>
    >`SELECT state, status FROM Wechat2RssSourceGate WHERE id = 1`;
    expect(rows).toEqual([{ state: 'stopped', status: 403 }]);
    await reopened.$disconnect();
  });

  it('waits for an in-flight restricted response when a concurrent request is rejected', async () => {
    const { db } = await fixture();
    let respond!: (response: Response) => void;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      new Wechat2RssSourceGate(db),
    );
    const result = operation(provider, () =>
      Promise.all([provider.listSubscriptions(), provider.listSubscriptions()]),
    );
    const rejected = expect(result).rejects.toThrow();
    while (!respond) await new Promise((resolve) => setTimeout(resolve, 1));
    respond(new Response('', { status: 429 }));
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await db.$queryRaw<
      Array<{ state: string; status: number }>
    >`SELECT state, status FROM Wechat2RssSourceGate WHERE id = 1`;
    expect(rows).toEqual([{ state: 'stopped', status: 429 }]);
    await db.$disconnect();
  });

  it('blocks detached requests while their durable begin is still pending', async () => {
    const { db } = await fixture();
    const gate = new Wechat2RssSourceGate(db);
    const begin = gate.begin.bind(gate);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(gate, 'begin').mockImplementation(async () => {
      await held;
      return begin();
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('UNEXPECTED_SYNTHETIC_FETCH'));
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      gate,
    );
    let detached!: Promise<unknown>;
    const result = operation(provider, async () => {
      detached = provider.listSubscriptions().catch(() => undefined);
    });
    const rejected = expect(result).rejects.toThrow(
      'WECHAT2RSS_SOURCE_STOPPED',
    );
    release();
    await rejected;
    await detached;
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await db.$queryRaw<
      Array<{ state: string }>
    >`SELECT state FROM Wechat2RssSourceGate WHERE id = 1`;
    expect(rows).toEqual([{ state: 'pending' }]);
    await db.$disconnect();
  });

  it('shares image restrictions with provider calls after restart', async () => {
    const { db, url } = await fixture();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 403 }));
    const gate = new Wechat2RssSourceGate(db);
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/synthetic', undefined, gate),
    ).rejects.toThrow('IMAGE_REQUEST_BLOCKED');
    await db.$disconnect();
    const reopened = new PrismaClient({ datasources: { db: { url } } });
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      new Wechat2RssSourceGate(reopened),
    );
    await expect(provider.listSubscriptions()).rejects.toThrow(
      'WECHAT2RSS_SOURCE_STOPPED',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await reopened.$disconnect();
  });

  it('blocks scoped image requests after a provider restriction', async () => {
    const { db } = await fixture();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 429 }));
    const gate = new Wechat2RssSourceGate(db);
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic',
      gate,
    );
    await expect(provider.listSubscriptions()).rejects.toThrow(
      'WECHAT2RSS_SOURCE_RESTRICTED',
    );
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/synthetic', undefined, gate),
    ).rejects.toThrow('IMAGE_REQUEST_BLOCKED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await db.$disconnect();
  });

  it('continues after a definite ordinary image failure, while unknown transport remains pending', async () => {
    const { db } = await fixture();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      )
      .mockRejectedValueOnce(new Error('synthetic transport failure'));
    const gate = new Wechat2RssSourceGate(db);
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/a', undefined, gate),
    ).rejects.toThrow('IMAGE_RESPONSE_INVALID');
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/b', undefined, gate),
    ).resolves.toMatchObject({ type: 'image/png' });
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/c', undefined, gate),
    ).rejects.toThrow('IMAGE_REQUEST_BLOCKED');
    await expect(
      fetchAllowedImage('https://mmbiz.qpic.cn/d', undefined, gate),
    ).rejects.toThrow('IMAGE_REQUEST_BLOCKED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rows = await db.$queryRaw<
      Array<{ state: string }>
    >`SELECT state FROM Wechat2RssSourceGate WHERE id = 1`;
    expect(rows).toEqual([{ state: 'pending' }]);
    await db.$disconnect();
  });

  it('archives a later article after a definite image failure in the scoped account', async () => {
    const { db } = await fixture();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );
    const gate = new Wechat2RssSourceGate(db);
    const page = {
      articles: [
        {
          id: 'a',
          contentHtml:
            '<div class="rich_media_content">first<img src="https://mmbiz.qpic.cn/a"></div>',
        },
        {
          id: 'b',
          contentHtml:
            '<div class="rich_media_content">second<img src="https://mmbiz.qpic.cn/b"></div>',
        },
      ],
      coverage: 'recent-window',
      upstreamCount: 2,
      bodyMissing: 0,
      imageBlocked: 0,
    } as unknown as ProviderPage;
    const archived = await archiveProviderImages(page, {
      imageSourceGate: () => gate,
      preserveTextOnImageFailure: true,
    });
    expect(archived.imageBlocked).toBe(1);
    expect(archived.articles[1].contentHtml).toContain(
      'data:image/png;base64,',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await db.$disconnect();
  });
});
