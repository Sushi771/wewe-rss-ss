import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';

describe('accepted refresh cache isolation (synthetic durable records)', () => {
  const env = { ...process.env };
  const ids = ['MP_WXS_1234567890', 'MP_WXS_2234567890', 'MP_WXS_3234567890'];
  const managers: Wechat2RssSubscriptionBatches[] = [];
  let root: string, clock: number;
  const make = (run: jest.Mock) => {
    const manager = new Wechat2RssSubscriptionBatches(
      () => path.join(root, 'fixture.db'),
      () => 'synthetic',
      jest.fn().mockRejectedValue(Error('ADD_FORBIDDEN')),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    manager.attachRefresh(run);
    managers.push(manager);
    return manager;
  };
  const file = (id: string) =>
    path.join(root, '.wechat2rss-subscription-batches', id + '.json');
  const seedLegacy = async (manager: Wechat2RssSubscriptionBatches) => {
    const b = await manager.enqueueRefresh(
      ids,
      'a'.repeat(64),
      'scheduled-refresh',
    );
    const record = JSON.parse(await fs.readFile(file(b.batchId), 'utf8'));
    record.state = 'paused';
    record.items.forEach((item: any, index: number) =>
      Object.assign(item, {
        accepted: true,
        submissionUnknown: false,
        state: index === 0 ? 'blocked' : 'waiting',
        refreshChecks: index === 0 ? 1 : 0,
        refreshAfter: clock - 1,
        ...(index === 0 ? { stopBatch: true, retryable: false } : {}),
      }),
    );
    await fs.writeFile(file(b.batchId), JSON.stringify(record));
    return b;
  };
  beforeEach(async () => {
    clock = Date.parse('2026-10-12T14:00:00+08:00');
    Object.assign(process.env, {
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      WECHAT2RSS_ENABLED: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'refresh-cache-isolation-'));
    await fs.writeFile(path.join(root, 'fixture.db'), 'synthetic');
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NETWORK_FORBIDDEN'));
  });
  afterEach(async () => {
    managers.splice(0).forEach((manager) => manager.close());
    jest.restoreAllMocks();
    process.env = { ...env };
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^refresh-cache-isolation-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  it('one thrown cache callback does not prevent later accepted caches completing', async () => {
    const run = jest.fn(async (id: string, stage: string) => {
      if (stage === 'submit')
        return { state: 'waiting', accepted: true, message: 'accepted' };
      if (id === ids[0])
        throw Object.assign(Error('synthetic private path'), { code: 'P2028' });
      return { state: 'succeeded', accepted: true, message: 'ready' };
    });
    const manager = make(run);
    const b = await manager.enqueueRefresh(
      ids,
      'a'.repeat(64),
      'scheduled-refresh',
    );
    for (let index = 0; index < 6; index++) {
      await manager.runDue();
      clock += 30000;
    }
    const view = (await manager.list()).find((x) => x.batchId === b.batchId)!;
    expect(view.state).not.toBe('paused');
    expect(
      view.items.slice(1).every((item) => item.state === 'succeeded'),
    ).toBe(true);
    expect(view.items[0]).toMatchObject({
      accepted: true,
      stopBatch: false,
      failureReason: 'CACHE_STORAGE_TIMEOUT',
    });
    expect(JSON.stringify(view)).not.toContain('synthetic private path');
    expect(run.mock.calls.filter((call) => call[1] === 'submit')).toHaveLength(
      3,
    );
  });
  it('restart recovers legacy accepted-only paused work using local cache without resubmission', async () => {
    const run = jest.fn().mockResolvedValue({
      state: 'succeeded',
      accepted: true,
      message: 'ready',
    });
    const first = make(run),
      b = await seedLegacy(first);
    first.close();
    const recovered = make(run);
    for (let index = 0; index < 3; index++) {
      await recovered.runDue();
      clock += 30000;
    }
    expect(run).toHaveBeenCalledTimes(3);
    for (const [id, stage, automatic, options] of run.mock.calls) {
      expect(ids).toContain(id);
      expect(stage).toBe('cache');
      expect(automatic).toBe(false);
      expect(options).toEqual({ cacheOnly: true });
    }
    expect(
      (await recovered.list())
        .find((x) => x.batchId === b.batchId)
        ?.items.every((x) => x.state === 'succeeded'),
    ).toBe(true);
  });
  it('a later all-retained intent is deferred rather than falsely completed', async () => {
    const run = jest.fn().mockResolvedValue({
      state: 'succeeded',
      accepted: true,
      message: 'ready',
    });
    const manager = make(run),
      original = await seedLegacy(manager);
    clock = Date.parse('2026-10-12T17:30:00+08:00');
    const joined = await manager.enqueueRefresh(
      ids,
      'b'.repeat(64),
      'scheduled-refresh',
    );
    expect(joined.state).toBe('deferred');
    expect(joined.items.every((x) => x.state === 'skipped')).toBe(true);
    expect((joined as any).retainedBatchIds).toContain(original.batchId);
    expect(run).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) {
      await manager.runDue();
      clock += 30000;
    }
    expect(run.mock.calls.every((call) => call[1] === 'cache')).toBe(true);
  });
  it('does not reset backoff or the attempt limit across restart and later rounds', async () => {
    const run = jest
      .fn()
      .mockRejectedValue(Object.assign(Error('secret'), { code: 'P2028' }));
    const first = make(run),
      b = await seedLegacy(first);
    const record = JSON.parse(await fs.readFile(file(b.batchId), 'utf8'));
    record.items = record.items.slice(0, 1);
    record.items[0].refreshChecks = 8;
    await fs.writeFile(file(b.batchId), JSON.stringify(record));
    await first.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    const before = (await first.list())[0].items[0].refreshAfter!;
    first.close();
    const recovered = make(run);
    clock += 30000;
    await recovered.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await recovered.list())[0].items[0].refreshAfter).toBe(before);
    clock = before;
    await recovered.runDue();
    expect(run).toHaveBeenCalledTimes(2);
    expect((await recovered.list())[0].items[0]).toMatchObject({
      state: 'failed',
      refreshChecks: 10,
      cacheRetryExhausted: 'attempt-limit',
      accepted: true,
    });
    const next = await recovered.enqueueRefresh(
      [ids[0]],
      'c'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.state).toBe('deferred');
    clock += 3600000;
    await recovered.runDue();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('expires accepted recovery before a cache callback after its absolute deadline', async () => {
    const run = jest
      .fn()
      .mockResolvedValue({ state: 'succeeded', accepted: true });
    const manager = make(run),
      b = await seedLegacy(manager);
    clock += 24 * 3600000;
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
    expect(
      (await manager.list())
        .find((x) => x.batchId === b.batchId)
        ?.items.every((x) => x.cacheRetryExhausted === 'deadline'),
    ).toBe(true);
  });
  it('a lost final cache receipt cannot renew the check budget after restart', async () => {
    const run = jest.fn().mockRejectedValue(Error('cache failed'));
    const first = make(run),
      b = await seedLegacy(first);
    const record = JSON.parse(await fs.readFile(file(b.batchId), 'utf8'));
    record.items = record.items.slice(0, 1);
    record.items[0].refreshChecks = 9;
    await fs.writeFile(file(b.batchId), JSON.stringify(record));
    const original = (first as any).persistWrite.bind(first);
    const persist = jest
      .spyOn(first as any, 'persistWrite')
      .mockImplementation(async (...args: any[]) => {
        if (args[0].items[0].cacheRetryExhausted)
          throw Error('synthetic receipt write lost');
        return original(...args);
      });
    await expect(first.runDue()).rejects.toThrow(
      'synthetic receipt write lost',
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await fs.readFile(file(b.batchId), 'utf8')).items[0]
        .refreshChecks,
    ).toBe(10);
    first.close();
    persist.mockRestore();
    const recovered = make(run);
    clock += 3600000;
    await recovered.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await recovered.list())[0].items[0]).toMatchObject({
      state: 'failed',
      accepted: true,
      cacheRetryExhausted: 'attempt-limit',
      refreshChecks: 10,
    });
  });
  it('persists cache exhaustion while retaining an explicit stopped batch', async () => {
    const run = jest.fn();
    const manager = make(run),
      b = await seedLegacy(manager);
    const record = JSON.parse(await fs.readFile(file(b.batchId), 'utf8'));
    record.state = 'stopped';
    record.items = record.items.slice(0, 1);
    Object.assign(record.items[0], {
      state: 'waiting',
      stopBatch: false,
      refreshChecks: 10,
    });
    await fs.writeFile(file(b.batchId), JSON.stringify(record));
    await manager.runDue();
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
    expect((await manager.list())[0]).toMatchObject({
      state: 'stopped',
      items: [
        expect.objectContaining({
          state: 'failed',
          accepted: true,
          cacheRetryExhausted: 'attempt-limit',
        }),
      ],
    });
  });
  it.each([
    'WECHAT2RSS_ACCOUNT_CHALLENGED',
    'WECHAT2RSS_RATE_LIMITED',
    'CACHE_SYNC_STARTUP_BLOCKED',
  ])('retains an explicit shared or startup gate: %s', async (message) => {
    const run = jest.fn().mockRejectedValue(Error(message));
    const manager = make(run),
      b = await seedLegacy(manager);
    await manager.runDue();
    expect(
      (await manager.list()).find((x) => x.batchId === b.batchId),
    ).toMatchObject({
      state: 'paused',
      items: [
        expect.objectContaining({
          state: 'blocked',
          stopBatch: true,
          failurePoint: 'global-gate',
        }),
        expect.anything(),
        expect.anything(),
      ],
    });
    const next = await manager.enqueueRefresh(
      [...ids, 'MP_WXS_4234567890'],
      'd'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.state).toBe('deferred');
    expect(next.items.every((x) => x.state === 'skipped')).toBe(true);
    expect(run.mock.calls.every((call) => call[1] === 'cache')).toBe(true);
  });
  it('preserves an explicit stop and uncertain receipt without guessing acceptance', async () => {
    const run = jest
      .fn()
      .mockResolvedValue({ state: 'succeeded', accepted: true });
    const manager = make(run),
      b = await seedLegacy(manager);
    const record = JSON.parse(await fs.readFile(file(b.batchId), 'utf8'));
    record.state = 'stopped';
    record.items = [record.items[0]];
    record.items[0].accepted = false;
    record.items[0].submissionUnknown = true;
    await fs.writeFile(file(b.batchId), JSON.stringify(record));
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
    expect((await manager.list())[0]).toMatchObject({
      state: 'stopped',
      items: [
        expect.objectContaining({ accepted: false, submissionUnknown: true }),
      ],
    });
  });
  it('a new subscription can run while an older cache is in bounded backoff', async () => {
    const run = jest.fn(async (_id: string, stage: string) =>
      stage === 'submit'
        ? { state: 'waiting', accepted: true }
        : { state: 'failed', accepted: true, stopBatch: false },
    );
    const manager = make(run),
      b = await seedLegacy(manager);
    const record = JSON.parse(await fs.readFile(file(b.batchId), 'utf8'));
    record.items = record.items.slice(0, 1);
    await fs.writeFile(file(b.batchId), JSON.stringify(record));
    await manager.runDue();
    const joined = await manager.enqueueRefresh(
      [ids[0], ids[1]],
      'e'.repeat(64),
      'scheduled-refresh',
    );
    expect(joined).toMatchObject({
      state: 'queued',
      items: [
        expect.objectContaining({ state: 'skipped' }),
        expect.objectContaining({ state: 'queued' }),
      ],
    });
    await manager.runDue();
    expect(
      run.mock.calls
        .filter((call) => call[1] === 'submit')
        .map((call) => call[0]),
    ).toEqual([ids[1]]);
    expect(joined.retainedBatchIds).toEqual([b.batchId]);
  });
});
