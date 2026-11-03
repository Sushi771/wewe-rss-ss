import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AutomaticMediaQueue,
  AutomaticMediaDependencies,
} from './automatic-media-queue';
import {
  automaticMediaPlan,
  automaticMediaSources,
} from '../collection/automatic-media-body';
import { SavedMediaSnapshot } from '../collection/saved-media-writeback';
import { canonicalArticleUrl } from '../collection/collection-format';
import {
  ImageRequestBlockedError,
  ImageRequestTransientError,
} from '../collection/image-fetch';
import {
  archiveProviderImages,
  supplementSavedBodyImages,
} from '../collection/archive-provider-images';

describe('durable bounded automatic WeChat media lane (offline)', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  const url = 'https://mmbiz.qpic.cn/exact-resource?wx_fmt=png';
  let root: string, file: string, now: number;
  let capacityTestWork: Promise<unknown> | undefined;
  const trackCapacity = (work: () => Promise<void>) => {
    capacityTestWork = work();
    return capacityTestWork;
  };
  let rows: Map<string, SavedMediaSnapshot>;
  let deps: AutomaticMediaDependencies;
  let fetch: jest.Mock, commit: jest.Mock, publish: jest.Mock, stop: jest.Mock;
  const row = (n: number, sources = [url]): SavedMediaSnapshot => {
    const identity = canonicalArticleUrl(
      `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${n}&idx=1`,
    );
    return {
      id: identity.id,
      mpId: identity.mpId,
      sourceUrl: identity.url,
      verifiedSourceUrl: identity.url,
      contentHtml: `<aside>user note</aside><div id="js_content">saved text${sources.map((source) => `<img data-src="${source}">`).join('')}</div>`,
      title: 'synthetic',
      publishTime: 1760000000,
      updatedAt: new Date(1760000000000),
      lastBodyStatus: 'images-pending',
    };
  };
  const queue = () => new AutomaticMediaQueue(file, deps);
  const stateFile = () =>
    path.join(root, '.wechat2rss-automatic-media', 'queue.json');
  const state = async () => JSON.parse(await fs.readFile(stateFile(), 'utf8'));
  beforeEach(async () => {
    capacityTestWork = undefined;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'automatic-media-offline-'));
    file = path.join(root, 'data.db');
    await fs.writeFile(file, 'synthetic identity only');
    now = 1760000000000;
    rows = new Map([row(1), row(2)].map((entry) => [entry.id, entry]));
    fetch = jest.fn().mockResolvedValue({ bytes: png, type: 'image/png' });
    publish = jest.fn();
    stop = jest.fn().mockResolvedValue(undefined);
    commit = jest.fn(
      async (
        before: SavedMediaSnapshot,
        images: ReadonlyMap<string, string>,
      ) => {
        const current = rows.get(before.id)!;
        if (
          current.contentHtml !== before.contentHtml ||
          current.sourceUrl !== before.sourceUrl ||
          current.verifiedSourceUrl !== before.verifiedSourceUrl ||
          current.updatedAt?.getTime() !== before.updatedAt?.getTime()
        )
          throw Error('SAVED_MEDIA_CONFLICT');
        const plan = automaticMediaPlan(before, images);
        const archived = await archiveProviderImages(plan.page, {
          verifiedImages: images,
          preserveTextOnImageFailure: true,
        });
        current.contentHtml =
          supplementSavedBodyImages(
            current.contentHtml!,
            archived.articles[0],
            { preserveFragment: true },
          ) || current.contentHtml;
      },
    );
    deps = {
      now: () => now,
      fetch,
      commit,
      publish,
      stop,
      canFetch: () => true,
      scan: async () => ({
        rows: [...rows.values()].map((entry) => ({ ...entry })),
        cursor: '',
        end: true,
      }),
      load: async (id) => (rows.has(id) ? { ...rows.get(id)! } : undefined),
    };
  });
  afterEach(async () => {
    // Jest's timeout does not cancel the body. Join it before removing its
    // files, without converting the timeout into a passing test.
    await capacityTestWork?.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }, 40000);
  it('deduplicates an exact URL across articles/jobs/restarts, then stores inline bytes without losing notes', async () => {
    await queue().tick();
    now += 1001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(2);
    for (const entry of rows.values()) {
      expect(entry.contentHtml).toContain('<aside>user note</aside>');
      expect(automaticMediaSources(entry.contentHtml!).ready).toBe(true);
    }
    expect((await state()).articles).toHaveLength(0);
  });
  it('does not normalize distinct URL parameters into one resource', async () => {
    rows = new Map(
      [row(1), row(2, [url + '&variant=2'])].map((entry) => [entry.id, entry]),
    );
    await queue().tick();
    now += 1001;
    await queue().tick();
    expect(fetch.mock.calls.map(([source]) => source)).toEqual([
      url,
      url + '&variant=2',
    ]);
  });
  it('persists timeout/5xx backoff across restart and exhausts a finite four-attempt budget', async () => {
    rows.delete(row(2).id);
    fetch.mockRejectedValue(new ImageRequestTransientError());
    await queue().tick();
    now += 1000;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const gap of [60_000, 300_000, 1_800_000]) {
      now += gap;
      await queue().tick();
    }
    now += 86_400_000;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(publish.mock.lastCall[0][0]).toMatchObject({
      failed: 1,
      attempts: 4,
      code: 'MEDIA_RETRY_EXHAUSTED',
    });
  });
  it.each([401, 403, 429])(
    'persists safety denial %s before SQL and never clears it on restart',
    async (status) => {
      fetch.mockRejectedValue(new ImageRequestBlockedError(status));
      stop.mockImplementation(async () => {
        expect((await state()).blocked).toBe(true);
      });
      await queue().tick();
      now += 86_400_000;
      await queue().tick();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(publish.mock.lastCall[1]).toBe('IMAGE_REQUEST_BLOCKED');
    },
  );
  it('holds a durable single consumer claim while HTTP is outstanding, without blocking the caller', async () => {
    let resolve!: (value: { bytes: Buffer; type: string }) => void;
    fetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = queue().tick();
    while (!resolve) await new Promise((done) => setImmediate(done));
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve({ bytes: png, type: 'image/png' });
    await first;
  });
  it('downloads at most one resource per tick and keeps a one-second global start gap', async () => {
    rows = new Map([[row(1).id, row(1, [url, url + '&second=1'])]]);
    const worker = queue();
    await worker.tick();
    await worker.tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1001;
    await worker.tick();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reuses persisted bytes with downloads disabled, but makes zero new HTTP requests', async () => {
    const worker = queue();
    await worker.tick();
    deps.canFetch = () => false;
    now += 1001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(2);
    rows.set(row(3, [url + '&new=1']).id, row(3, [url + '&new=1']));
    now += 60_000;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed body after HTTP, then reuses bytes with a fresh CAS snapshot', async () => {
    rows.delete(row(2).id);
    fetch.mockImplementationOnce(async () => {
      rows.get(row(1).id)!.contentHtml += '<p>new user note</p>';
      return { bytes: png, type: 'image/png' };
    });
    await queue().tick();
    expect(rows.get(row(1).id)!.contentHtml).not.toContain('data:image/');
    expect(publish.mock.lastCall[0][0].code).toBe('MEDIA_BODY_CHANGED');
    now += 60_001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows.get(row(1).id)!.contentHtml).toContain('new user note');
    expect(automaticMediaSources(rows.get(row(1).id)!.contentHtml!).ready).toBe(
      true,
    );
  });
  it('recovers a committed write with lost ACK by rescanning; no duplicate request or false readiness', async () => {
    rows.delete(row(2).id);
    const apply = commit.getMockImplementation()!;
    commit.mockImplementationOnce(async (...args) => {
      await apply(...args);
      throw Error('ACK_LOST');
    });
    await queue().tick();
    now += 60_001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect((await state()).articles).toHaveLength(0);
  });
  it('keeps unknown decorations visible and skips valid existing inline images', async () => {
    rows.delete(row(2).id);
    rows.get(row(1).id)!.contentHtml +=
      '<img><div style="background:url(x)">decoration</div>';
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(publish.mock.lastCall[0][0]).toMatchObject({
      pending: 0,
      unconfirmed: 1,
    });
    now += 60_001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not fetch unverified/conflicting source identities', async () => {
    rows.delete(row(2).id);
    rows.get(row(1).id)!.sourceUrl = row(3).sourceUrl;
    await queue().tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(publish.mock.lastCall[0][0].code).toBe('MEDIA_IDENTITY_UNVERIFIED');
  });
  it('fails closed on corrupt queue or cached bytes without deleting them', async () => {
    await queue().tick();
    await fs.writeFile(stateFile(), '{corrupt');
    now += 1001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(stateFile(), 'utf8')).toBe('{corrupt');
    expect(publish.mock.lastCall[1]).toBe('MEDIA_WORKER_UNAVAILABLE');
  });
  it('close prevents late SQL writes but preserves successful bytes for the next process', async () => {
    rows.delete(row(2).id);
    const worker = queue();
    fetch.mockImplementationOnce(async () => {
      worker.close();
      return { bytes: png, type: 'image/png' };
    });
    await worker.tick();
    expect(commit).not.toHaveBeenCalled();
    now += 1001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('bounds HTTP attempts to 120 per persisted hourly window without blocking cached-byte writes', async () => {
    rows = new Map(
      [row(1), row(2, [url + '&n=2']), row(3, [url + '&n=3'])].map((entry) => [
        entry.id,
        entry,
      ]),
    );
    await queue().tick();
    const saved = await state();
    saved.windowCount = 119;
    await fs.writeFile(stateFile(), JSON.stringify(saved));
    now += 1001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 1001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await state()).windowCount).toBe(120);
    now += 3_600_000;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([0, 1, 600])(
    'queries volume space once per capacity assessment with %i cache files',
    async (count) => {
      deps.canFetch = () => false;
      const worker = queue();
      await worker.tick();
      const folder = path.join(root, '.wechat2rss-automatic-media', 'bytes');
      for (let n = 0; n < count; n++)
        await fs.writeFile(
          path.join(folder, `${n.toString(16).padStart(64, '0')}.json`),
          '{}',
        );
      const capacity = worker as unknown as {
        capacity(required: number): Promise<void>;
      };
      const disk = jest.spyOn(fs, 'statfs');
      try {
        await capacity.capacity(14_000_000);
        expect(disk).toHaveBeenCalledTimes(1);
        expect(disk).toHaveBeenCalledWith(await fs.realpath(folder), {
          bigint: true,
        });
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        disk.mockRestore();
      }
    },
  );
  it('exits on the byte quota before querying volume space or spending HTTP', async () => {
    deps.canFetch = () => false;
    const worker = queue();
    await worker.tick();
    const folder = path.join(root, '.wechat2rss-automatic-media', 'bytes');
    for (let n = 0; n < 153; n++)
      await fs.writeFile(
        path.join(folder, `${n.toString(16).padStart(64, '0')}.json`),
        '{}',
      );
    const original = fs.lstat.bind(fs);
    const stat = jest.spyOn(fs as any, 'lstat').mockImplementation(async (name: any) => {
      const result = await original(name);
      if (/^[a-f0-9]{64}\.json$/.test(path.basename(String(name)))) Object.assign(result, { size: 14_000_000 });
      return result;
    });
    const capacity = worker as unknown as {
      capacity(required: number): Promise<void>;
    };
    const disk = jest.spyOn(fs, 'statfs');
    try {
      await expect(capacity.capacity(14_000_000)).rejects.toThrow(
        'MEDIA_STORAGE_CAPACITY',
      );
      expect(disk).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      disk.mockRestore();
    }
  });
  it.each([-1, 0])(
    'preserves the 4 GiB plus requested reservation disk boundary (delta %i)',
    async (delta) => {
      deps.canFetch = () => false;
      const worker = queue();
      await worker.tick();
      const actual = await fs.statfs(root, { bigint: true });
      const capacity = worker as unknown as {
        capacity(required: number): Promise<void>;
      };
      const disk = jest.spyOn(fs, 'statfs').mockResolvedValue({
        ...actual,
        bsize: 1n,
        bavail: BigInt(4 * 1024 ** 3 + 14_000_000 + delta),
      });
      try {
        if (delta < 0)
          await expect(capacity.capacity(14_000_000)).rejects.toThrow(
            'MEDIA_STORAGE_CAPACITY',
          );
        else
          await expect(capacity.capacity(14_000_000)).resolves.toBeUndefined();
        expect(disk).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        disk.mockRestore();
      }
    },
  );

  it('pauses before HTTP when its own cache is full and keeps the queue readable', async () => {
    deps.canFetch = () => false;
    await queue().tick();
    const folder = path.join(root, '.wechat2rss-automatic-media', 'bytes');
    for (let n = 0; n < 153; n++)
      await fs.writeFile(
        path.join(folder, `${n.toString(16).padStart(64, '0')}.json`),
        '{}',
      );
    const original = fs.lstat.bind(fs);
    const stat = jest.spyOn(fs as any, 'lstat').mockImplementation(async (name: any) => {
      const result = await original(name);
      if (/^[a-f0-9]{64}\.json$/.test(path.basename(String(name)))) Object.assign(result, { size: 14_000_000 });
      return result;
    });
    try {
      deps.canFetch = () => true;
      await queue().tick();
      expect(fetch).not.toHaveBeenCalled();
      expect((await state()).articles).toHaveLength(2);
      expect(publish.mock.lastCall[1]).toBe('MEDIA_STORAGE_CAPACITY');
    } finally { stat.mockRestore(); }
  });
  it('retains backoff and cached bytes when SQL repeatedly fails, then reports a finite save failure', async () => {
    rows.delete(row(2).id);
    commit.mockRejectedValue(Error('SQL_BUSY'));
    await queue().tick();
    for (const gap of [60_001, 300_001, 1_800_001, 86_400_000]) {
      now += gap;
      await queue().tick();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(4);
    expect(publish.mock.lastCall[0][0]).toMatchObject({
      failed: 1,
      attempts: 4,
      code: 'MEDIA_SAVE_RETRY',
    });
  });
  it('continues after a crash leaves its own temp bytes; never treats the temp as cached data', async () => {
    deps.canFetch = () => false;
    await queue().tick();
    await fs.writeFile(
      path.join(
        root,
        '.wechat2rss-automatic-media',
        'bytes',
        `${'a'.repeat(64)}.json.00000000-0000-0000-0000-000000000000.tmp`,
      ),
      'partial',
    );
    deps.canFetch = () => true;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('still sets the independent safety marker when the blocked queue write fails', async () => {
    let failed = false;
    const rename = fs.rename.bind(fs);
    const spy = jest.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (failed && String(args[1]).endsWith('queue.json'))
        throw Error('QUEUE_DISK_FAILURE');
      return rename(...args);
    });
    fetch.mockImplementationOnce(async () => {
      failed = true;
      throw new ImageRequestBlockedError(403);
    });
    try {
      await queue().tick();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(publish.mock.lastCall[1]).toBe('IMAGE_REQUEST_BLOCKED');
    } finally {
      spy.mockRestore();
    }
  });
  it('rejects old source metadata after HTTP and reuses bytes only with the fresh saved version', async () => {
    rows.delete(row(2).id);
    fetch.mockImplementationOnce(async () => {
      const current = rows.get(row(1).id)!;
      current.sourceUrl += '&sn=new-saved-proof';
      current.updatedAt = new Date(current.updatedAt!.getTime() + 1);
      return { bytes: png, type: 'image/png' };
    });
    await queue().tick();
    expect(rows.get(row(1).id)!.contentHtml).not.toContain('data:image/');
    now += 60_001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows.get(row(1).id)!.contentHtml).toContain('data:image/');
    expect(rows.get(row(1).id)!.sourceUrl).toContain('new-saved-proof');
  });

  const bodyLimited = async (count = 3) => {
    const item = row(
      1,
      Array.from({ length: count }, (_, n) => url + '&n=' + n),
    );
    item.contentHtml += '<img data-wewe-image-unconfirmed="1">';
    rows = new Map([[item.id, item]]);
    commit.mockRejectedValue(Error('MEDIA_BODY_LIMIT'));
    await queue().tick();
    expect((await state()).articles[0]).toMatchObject({
      writes: 4,
      code: 'MEDIA_BODY_LIMIT',
    });
    return item;
  };
  it('drains only queued resources after a real body projection limit; restart reuses every cached byte', async () => {
    const item = row(1, [url, url + '&n=1', url + '&n=2']);
    item.contentHtml += 'x'.repeat(
      7_999_700 - Buffer.byteLength(item.contentHtml!),
    );
    const before = item.contentHtml;
    rows = new Map([[item.id, item]]);
    await queue().tick();
    expect((await state()).articles[0].code).toBe('MEDIA_BODY_LIMIT');
    expect(commit).toHaveBeenCalledTimes(1);
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 2; n++) {
      now += 1001;
      await queue().tick();
    }
    now += 60_001;
    await queue().tick();
    expect(fetch.mock.calls.map(([source]) => source)).toEqual([
      url,
      url + '&n=1',
      url + '&n=2',
    ]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(item.contentHtml).toBe(before);
    const saved = await state();
    expect(saved.windowCount).toBe(3);
    expect(
      Object.values(saved.resources).map((resource: any) => resource.attempts),
    ).toEqual([1, 1, 1]);
    expect(
      (
        await fs.readdir(
          path.join(root, '.wechat2rss-automatic-media', 'bytes'),
        )
      ).filter((name) => name.endsWith('.json')),
    ).toHaveLength(3);
    expect(publish.mock.lastCall[0][0]).toMatchObject({
      failed: 1,
      code: 'MEDIA_BODY_LIMIT',
    });
  }, 40_000);
  it('preserves unknown slots and the body failure after cache completion, without repeated SQL or HTTP', async () => {
    const item = await bodyLimited();
    const before = item.contentHtml;
    for (let n = 0; n < 3; n++) {
      now += 60_001;
      await queue().tick();
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(item.contentHtml).toBe(before);
    expect(item.contentHtml).toContain('data-wewe-image-unconfirmed');
    expect(publish.mock.lastCall[0][0]).toMatchObject({
      failed: 1,
      unconfirmed: 1,
      code: 'MEDIA_BODY_LIMIT',
    });
  });
  it('retains the persisted hourly allowance and download gate in cache-only mode', async () => {
    await bodyLimited();
    const saved = await state();
    saved.windowCount = 120;
    await fs.writeFile(stateFile(), JSON.stringify(saved));
    now += 1001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await state()).windowCount).toBe(120);
    now += 3_600_001;
    deps.canFetch = () => false;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    deps.canFetch = () => true;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await state()).windowCount).toBe(1);
  });
  it('keeps cache-only retry backoff finite and preserves blocked-source stops across restart', async () => {
    await bodyLimited();
    fetch.mockRejectedValue(new ImageRequestTransientError());
    for (const gap of [1001, 60_001, 300_001, 1_800_001]) {
      now += gap;
      await queue().tick();
    }
    const saved = await state();
    const failed = Object.values(saved.resources).find(
      (resource: any) => resource.state === 'failed',
    );
    expect(failed).toMatchObject({
      attempts: 4,
      code: 'MEDIA_RETRY_EXHAUSTED',
    });
    fetch.mockRejectedValue(new ImageRequestBlockedError(403));
    now += 1001;
    await queue().tick();
    now += 86_400_000;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await state()).blocked).toBe(true);
    expect(publish.mock.lastCall[1]).toBe('IMAGE_REQUEST_BLOCKED');
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('does not spend an attempt when capacity fails in cache-only mode', async () => {
    await bodyLimited();
    const actual = await fs.statfs(root, { bigint: true });
    const disk = jest
      .spyOn(fs, 'statfs')
      .mockResolvedValue({ ...actual, bsize: 1n, bavail: 4n * 1024n ** 3n });
    try {
      now += 1001;
      await queue().tick();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((await state()).windowCount).toBe(1);
      expect(publish.mock.lastCall[1]).toBe('MEDIA_STORAGE_CAPACITY');
    } finally {
      disk.mockRestore();
    }
  });
  it('closing cache-only work before dispatch spends nothing; reopening resumes without resetting history', async () => {
    const item = await bodyLimited();
    now += 1001;
    const worker = queue();
    deps.load = async () => {
      worker.close();
      return { ...item };
    };
    await worker.tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await state()).windowCount).toBe(1);
    deps.load = async () => ({ ...item });
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await state()).windowCount).toBe(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('keeps successful cache-only bytes on close during HTTP and never downloads them again', async () => {
    await bodyLimited(2);
    now += 1001;
    const worker = queue();
    fetch.mockImplementationOnce(async () => {
      worker.close();
      return { bytes: png, type: 'image/png' };
    });
    await worker.tick();
    now += 60_001;
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect((await state()).windowCount).toBe(2);
    expect(
      (
        await fs.readdir(
          path.join(root, '.wechat2rss-automatic-media', 'bytes'),
        )
      ).filter((name) => name.endsWith('.json')),
    ).toHaveLength(2);
  });
  it('does not reuse an old body-limit exemption for a changed or conflicting author snapshot', async () => {
    const item = await bodyLimited();
    item.sourceUrl = row(3).sourceUrl;
    now += 60_001;
    await queue().tick();
    await queue().tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await state()).articles[0].code).toBe('MEDIA_IDENTITY_UNVERIFIED');
  });
  it('2GiB isolated: serialized bytes plus 14MB reservation has an exact boundary across restart', () => trackCapacity(async () => {
    const started = performance.now();
    deps.canFetch = () => false;
    const worker = queue(); await worker.tick();
    const folder = path.join(root, '.wechat2rss-automatic-media', 'bytes');
    for (let n=0;n<153;n++) await fs.writeFile(path.join(folder, `${n.toString(16).padStart(64,'0')}.json`), '{}');
    const prepared = performance.now();
    const original = fs.lstat.bind(fs);
    const stat = jest.spyOn(fs as any,'lstat').mockImplementation(async (name: any) => {
      const result = await original(name); const base = path.basename(String(name));
      const n = parseInt(base.slice(0,64),16);
      if (/^[a-f0-9]{64}\.json$/.test(base) && n < 153) Object.assign(result,{size:n<152?14_000_000:5_483_648});
      return result;
    });
    try {
      const first=worker as unknown as {capacity(n:number):Promise<void>};
      await expect(first.capacity(14_000_000)).resolves.toBeUndefined();
      await expect(first.capacity(14_000_001)).rejects.toThrow('MEDIA_STORAGE_CAPACITY');
      const checked = performance.now();
      const restarted=queue(); await restarted.tick();
      const again=restarted as unknown as {capacity(n:number):Promise<void>};
      await expect(again.capacity(14_000_000)).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      console.info('capacity timing ms', { setup: Math.round(prepared-started), checks: Math.round(checked-prepared), restart: Math.round(performance.now()-checked) });
    } finally {stat.mockRestore();}
  }));
  it('2GiB isolated: concurrent queue instances serialize one outbound attempt', async () => {
    rows = new Map([row(1),row(2,[url+'&n=2'])].map((entry)=>[entry.id,entry]));
    fetch.mockImplementation(async()=>{ await new Promise((resolve)=>setTimeout(resolve,100)); return {bytes:png,type:'image/png'}; });
    const a=queue(), b=queue(); await Promise.all([a.tick(),b.tick()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('2GiB isolated: concurrent reservation near quota never starts a second fetch after restart', () => trackCapacity(async () => {
    const started = performance.now();
    deps.canFetch=()=>false; rows=new Map([row(1),row(2,[url+'&n=2'])].map((entry)=>[entry.id,entry]));
    const first=queue(); await first.tick();
    const folder=path.join(root,'.wechat2rss-automatic-media','bytes');
    for(let n=0;n<153;n++) await fs.writeFile(path.join(folder,`${n.toString(16).padStart(64,'0')}.json`),'{}');
    const prepared = performance.now();
    const original=fs.lstat.bind(fs);
    const stat=jest.spyOn(fs as any,'lstat').mockImplementation(async(name:any)=>{const result=await original(name);const base=path.basename(String(name));const n=parseInt(base.slice(0,64),16);if(/^[a-f0-9]{64}\.json$/.test(base)&&n<153)Object.assign(result,{size:n<152?14_000_000:5_483_648});return result;});
    try {
      deps.canFetch=()=>true; fetch.mockImplementation(async()=>{await new Promise((resolve)=>setTimeout(resolve,100));return {bytes:png,type:'image/png'};});
      await Promise.all([first.tick(),queue().tick()]); expect(fetch).toHaveBeenCalledTimes(1);
      const concurrent = performance.now();
      now+=1001; await queue().tick(); expect(fetch).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(expect.anything(),'MEDIA_STORAGE_CAPACITY');
      console.info('capacity concurrency timing ms', { setup: Math.round(prepared-started), concurrent: Math.round(concurrent-prepared), restart: Math.round(performance.now()-concurrent) });
    } finally {stat.mockRestore();}
  }));

});
