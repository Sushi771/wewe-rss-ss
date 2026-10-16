import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BatchOutcome,
  Wechat2RssSubscriptionBatches,
} from './wechat2rss-subscription-batches';

function refreshCalls(run: { mock: { calls: unknown[][] } }) {
  return run.mock.calls.map((call) => {
    if (call[1] === 'submit')
      expect(call[3]).toEqual(
        expect.objectContaining({
          claimKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
        }),
      );
    return call[2] === false ? call.slice(0, 2) : call.slice(0, 3);
  });
}

describe('persistent automatic preparation retries (synthetic only)', () => {
  let directory: string, clock: number;
  const managers: Wechat2RssSubscriptionBatches[] = [];
  const env = { ...process.env };
  const ids = Array.from({ length: 14 }, (_, i) => `MP_WXS_${1234500000 + i}`);
  const failure: BatchOutcome = {
    state: 'failed',
    accepted: false,
    submissionUnknown: false,
    retryable: true,
    stopBatch: false,
    message: 'synthetic preparation failure',
  };
  const success: BatchOutcome = {
    state: 'succeeded',
    accepted: true,
    message: 'synthetic ready',
  };
  const make = (
    run = jest.fn().mockResolvedValue(success),
    instance = 'synthetic-retry-instance',
  ) => {
    const manager = new Wechat2RssSubscriptionBatches(
      () => path.join(directory, 'fixture.db'),
      () => instance,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    manager.attachRefresh(run);
    managers.push(manager);
    return { manager, run };
  };
  const file = (id: string) =>
    path.join(directory, '.wechat2rss-subscription-batches', `${id}.json`);
  const disk = async (id: string) =>
    JSON.parse(await fs.readFile(file(id), 'utf8'));
  const seed = async (
    manager: Wechat2RssSubscriptionBatches,
    feeds = ids,
    key = 'a'.repeat(64),
  ) => {
    const batch = await manager.enqueueRefresh(feeds, key, 'scheduled-refresh');
    const record = await disk(batch.batchId);
    record.state = 'completed';
    record.items.forEach((item: any) =>
      Object.assign(item, failure, {
        preparationRetries: 3,
        retryAfter: clock + 240000,
      }),
    );
    await fs.writeFile(file(batch.batchId), JSON.stringify(record));
    return batch;
  };
  beforeEach(async () => {
    clock = Date.parse('2026-10-14T14:00:00+08:00');
    Object.assign(process.env, {
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      WECHAT2RSS_ENABLED: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-durable-retry-'));
    await fs.writeFile(path.join(directory, 'fixture.db'), 'synthetic');
  });
  afterEach(async () => {
    managers.splice(0).forEach((manager) => manager.close());
    for (const key of [
      'WECHAT2RSS_ACTIVE_SCHEDULE',
      'WECHAT2RSS_ENABLED',
      'ENABLE_SCHEDULED_UPDATES',
      'DISABLE_SCHEDULED_UPDATES',
    ]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('wewe-durable-retry-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  it('restores eleven legacy terminal failures after init, preserving three successes and exact slot intent', async () => {
    const first = make();
    const batch = await seed(first.manager);
    const record = await disk(batch.batchId);
    record.items
      .slice(0, 3)
      .forEach((item: any) =>
        Object.assign(item, success, { retryable: false }),
      );
    await fs.writeFile(file(batch.batchId), JSON.stringify(record));
    first.manager.close();
    const recovered = make();
    await recovered.manager.init();
    expect((recovered.manager as any).timer).toBeDefined();
    await recovered.manager.runDue();
    expect(recovered.run).not.toHaveBeenCalled();
    const migrated = await disk(batch.batchId);
    expect(
      migrated.items
        .slice(3)
        .every(
          (item: any) =>
            item.state === 'queued' &&
            item.preparationRetries === 3 &&
            item.retryDeadlineAt === batch.createdAt + 86400000,
        ),
    ).toBe(true);
    expect(
      await recovered.manager.enqueueRefresh(
        [...ids].reverse(),
        'a'.repeat(64),
        'scheduled-refresh',
      ),
    ).toMatchObject({ batchId: batch.batchId, reused: true });
    clock += 240000;
    for (let i = 0; i < 11; i++) {
      await recovered.manager.runDue();
      clock += 30000;
    }
    expect(refreshCalls(recovered.run)).toEqual(
      ids.slice(3).map((id) => [id, 'submit', true]),
    );
    expect((await recovered.manager.list())[0].state).toBe('completed');
    recovered.manager.close();
    const again = make();
    await again.manager.init();
    await again.manager.runDue();
    expect(again.run).not.toHaveBeenCalled();
  });
  it('stops permanent failures after eight total claims and never replenishes the budget on restart or duplicate scheduling', async () => {
    const { manager, run } = make(jest.fn().mockResolvedValue(failure));
    const batch = await manager.enqueueRefresh(
      [ids[0]],
      'b'.repeat(64),
      'scheduled-refresh',
    );
    for (let attempt = 1; attempt <= 8; attempt++) {
      const attemptStartedAt = clock;
      await manager.runDue();
      expect(run).toHaveBeenCalledTimes(attempt);
      const item = (await disk(batch.batchId)).items[0];
      expect(item.preparationRetries).toBe(attempt);
      expect(item.retryAfter - attemptStartedAt).toBe(
        Math.min(1800000, 30000 * 2 ** attempt),
      );
      clock = item.retryAfter;
    }
    expect((await manager.list())[0]).toMatchObject({
      state: 'completed',
      items: [
        { state: 'failed', retryExhausted: 'attempt-limit', accepted: false },
      ],
    });
    manager.close();
    const next = make();
    await next.manager.init();
    expect((next.manager as any).timer).toBeUndefined();
    await next.manager.enqueueRefresh(
      [ids[0]],
      'b'.repeat(64),
      'scheduled-refresh',
    );
    clock += 3600000;
    await next.manager.runDue();
    expect(next.run).not.toHaveBeenCalled();
    expect((await disk(batch.batchId)).items[0].preparationRetries).toBe(8);
  });
  it('respects the original 24-hour deadline even for legacy terminal items discovered days later', async () => {
    const { manager, run } = make();
    const batch = await seed(manager, [ids[0]]);
    clock += 86400000;
    await manager.init();
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
    expect((await manager.list())[0]).toMatchObject({
      state: 'completed',
      items: [{ state: 'failed', retryExhausted: 'deadline' }],
    });
    expect((await disk(batch.batchId)).items[0].retryDeadlineAt).toBe(
      batch.createdAt + 86400000,
    );
  });
  it('retains safe retries across midnight, observes blackout and disable switch, and deduplicates the next slot', async () => {
    clock = Date.parse('2026-10-14T23:59:00+08:00');
    const first = make(jest.fn().mockResolvedValue(failure));
    const batch = await first.manager.enqueueRefresh(
      [ids[0]],
      'c'.repeat(64),
      'scheduled-refresh',
    );
    await first.manager.runDue();
    first.manager.close();
    const next = make();
    clock = Date.parse('2026-10-15T05:59:00+08:00');
    await next.manager.runDue();
    expect((await disk(batch.batchId)).items[0].state).toBe('queued');
    expect(next.run).not.toHaveBeenCalled();
    clock += 60000;
    process.env.DISABLE_SCHEDULED_UPDATES = '1';
    await next.manager.runDue();
    expect(next.run).not.toHaveBeenCalled();
    process.env.DISABLE_SCHEDULED_UPDATES = '0';
    const newSlot = await next.manager.enqueueRefresh(
      [ids[0]],
      'd'.repeat(64),
      'scheduled-refresh',
    );
    expect(newSlot.items[0].state).toBe('skipped');
    await next.manager.runDue();
    expect(next.run).toHaveBeenCalledTimes(1);
    expect(refreshCalls(next.run)).toContainEqual([ids[0], 'submit', true]);
  });
  it('an earlier backoff does not starve a later independent round', async () => {
    const { manager, run } = make(
      jest.fn().mockResolvedValueOnce(failure).mockResolvedValue(success),
    );
    await manager.enqueueRefresh([ids[0]], 'e'.repeat(64), 'scheduled-refresh');
    await manager.runDue();
    clock += 30000;
    await manager.enqueueRefresh([ids[1]], 'f'.repeat(64), 'scheduled-refresh');
    await manager.runDue();
    expect(run.mock.calls.map((call) => call[0])).toEqual([ids[0], ids[1]]);
  });
  it('rechecks the deadline after asynchronous unknown-receipt reconciliation and continues independent work', async () => {
    const { manager, run } = make();
    const batch = await seed(manager, ids.slice(0, 2));
    const record = await disk(batch.batchId);
    record.state = 'running';
    Object.assign(record.items[0], {
      state: 'queued',
      retryAfter: 0,
      retryDeadlineAt: batch.createdAt + 86400000,
    });
    Object.assign(record.items[1], {
      state: 'blocked',
      retryable: false,
      submissionUnknown: true,
    });
    await fs.writeFile(file(batch.batchId), JSON.stringify(record));
    clock = batch.createdAt + 86400000 - 1;
    await manager.enqueueRefresh([ids[2]], '6'.repeat(64), 'scheduled-refresh');
    const proof = jest.fn(async () => {
      clock += 2;
      return 'unknown' as const;
    });
    manager.attachReconciliation(proof);
    await manager.runDue();
    expect(proof).toHaveBeenCalledTimes(1);
    expect(refreshCalls(run)).toEqual([[ids[2], 'submit', true]]);
    const exhausted = await disk(batch.batchId);
    expect(exhausted.items[0]).toMatchObject({
      state: 'failed',
      retryExhausted: 'deadline',
      accepted: false,
      preparationRetries: 3,
    });
    expect(exhausted.items[1].submissionUnknown).toBe(true);
    manager.close();
    const recovered = make();
    await recovered.manager.init();
    await recovered.manager.runDue();
    expect(recovered.run).not.toHaveBeenCalled();
  });
  it('refuses an exhausted attempt budget at claim time and yields to independent work', async () => {
    const { manager, run } = make();
    const batch = await seed(manager, [ids[0]]);
    clock += 60000;
    await manager.enqueueRefresh([ids[1]], '7'.repeat(64), 'scheduled-refresh');
    const record = await disk(batch.batchId);
    Object.assign(record.items[0], {
      state: 'queued',
      preparationRetries: 8,
      retryAfter: 0,
    });
    await fs.writeFile(file(batch.batchId), JSON.stringify(record));
    // Exercise the final claim gate independently from the earlier recovery pass.
    expect(await (manager as any).runRefresh(record)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect((await disk(batch.batchId)).items[0]).toMatchObject({
      state: 'failed',
      retryExhausted: 'attempt-limit',
      preparationRetries: 8,
    });
    await manager.runDue();
    expect(refreshCalls(run)).toEqual([[ids[1], 'submit', true]]);
  });
  it('does not invoke submission when durable claim persistence crosses the absolute deadline', async () => {
    const { manager, run } = make();
    const batch = await seed(manager, [ids[0]]);
    const record = await disk(batch.batchId);
    record.state = 'running';
    Object.assign(record.items[0], {
      state: 'queued',
      retryAfter: 0,
      retryDeadlineAt: batch.createdAt + 86400000,
    });
    await fs.writeFile(file(batch.batchId), JSON.stringify(record));
    clock = batch.createdAt + 86400000 - 1;
    const write = (manager as any).write.bind(manager);
    jest
      .spyOn(manager as any, 'write')
      .mockImplementation(async (current: any) => {
        const persisted = await write(current);
        if (current.items[0].state === 'submitting') clock += 2;
        return persisted;
      });
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
    expect((await disk(batch.batchId)).items[0]).toMatchObject({
      state: 'failed',
      accepted: false,
      preparationRetries: 4,
      retryExhausted: 'deadline',
    });
  });
  it('a later slot can refresh a previously successful subscription while its peer retains the original retry', async () => {
    const run = jest.fn(async (feed: string) =>
      feed === ids[0] ? failure : success,
    );
    const { manager } = make(run as any);
    const original = await manager.enqueueRefresh(
      ids.slice(0, 2),
      '4'.repeat(64),
      'scheduled-refresh',
    );
    await manager.runDue();
    clock += 30000;
    await manager.runDue();
    clock = Date.parse('2026-10-14T17:30:00+08:00');
    const later = await manager.enqueueRefresh(
      ids.slice(0, 2),
      '5'.repeat(64),
      'scheduled-refresh',
    );
    expect(later.items.map((item) => item.state)).toEqual([
      'skipped',
      'queued',
    ]);
    await manager.runDue(); // Original failed item consumes its next attempt.
    clock += 30000;
    await manager.runDue(); // Original backoff yields to the new successful item.
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      ids[0],
      ids[1],
      ids[0],
      ids[1],
    ]);
    expect((await disk(original.batchId)).items[0].preparationRetries).toBe(2);
    expect(
      await manager.enqueueRefresh(
        ids.slice(0, 2),
        '5'.repeat(64),
        'scheduled-refresh',
      ),
    ).toMatchObject({ batchId: later.batchId, reused: true });
    await manager.runDue();
    expect(run).toHaveBeenCalledTimes(4);
  });
  it('a crash during a retry consumes its claim; only explicit read-only proof permits another attempt', async () => {
    let finish!: (outcome: BatchOutcome) => void;
    const run = jest
      .fn()
      .mockResolvedValueOnce(failure)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const first = make(run);
    const batch = await first.manager.enqueueRefresh(
      [ids[0]],
      '1'.repeat(64),
      'scheduled-refresh',
    );
    await first.manager.runDue();
    clock += 60000;
    const work = first.manager.runDue();
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    expect((await disk(batch.batchId)).items[0]).toMatchObject({
      state: 'submitting',
      preparationRetries: 2,
    });
    first.manager.close();
    finish(success);
    await work;
    const next = make();
    const proof = jest.fn().mockResolvedValue('unknown');
    next.manager.attachReconciliation(proof);
    await next.manager.runDue();
    clock += 60000;
    await next.manager.runDue();
    expect(next.run).not.toHaveBeenCalled();
    expect((await disk(batch.batchId)).items[0].submissionUnknown).toBe(true);
    proof.mockResolvedValue('not-submitted');
    clock += 60000;
    await next.manager.runDue();
    expect(next.run).toHaveBeenCalledTimes(1);
    expect((await disk(batch.batchId)).items[0]).toMatchObject({
      state: 'succeeded',
      preparationRetries: 3,
    });
  });
  it('concurrent workers and repeated intents claim one retry, keeping the persisted backoff', async () => {
    const a = make(),
      b = make();
    const batch = await seed(a.manager, [ids[0]]);
    await Promise.all([a.manager.runDue(), b.manager.runDue()]);
    const before = (await disk(batch.batchId)).items[0];
    clock += 239999;
    await a.manager.enqueueRefresh(
      [ids[0]],
      'a'.repeat(64),
      'scheduled-refresh',
    );
    await Promise.all([a.manager.runDue(), b.manager.runDue()]);
    expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(0);
    expect((await disk(batch.batchId)).items[0].retryAfter).toBe(
      before.retryAfter,
    );
    clock++;
    await Promise.all([a.manager.runDue(), b.manager.runDue()]);
    expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(1);
  });
  it.each([
    'accepted',
    'unknown',
    'unclassified',
    'stopped',
    'cache-only',
    'wrong-instance',
  ])(
    'does not resubmit %s terminal work; only accepted receipts can resume cache',
    async (kind) => {
      const first = make();
      const batch = await seed(first.manager, [ids[0]]);
      const record = await disk(batch.batchId);
      if (kind === 'accepted') record.items[0].accepted = true;
      if (kind === 'unknown') record.items[0].submissionUnknown = true;
      if (kind === 'unclassified') {
        delete record.items[0].retryable;
        delete record.items[0].accepted;
      }
      if (kind === 'stopped') record.state = 'stopped';
      if (kind === 'cache-only') record.cacheOnly = true;
      await fs.writeFile(file(batch.batchId), JSON.stringify(record));
      first.manager.close();
      const next = make(
        undefined,
        kind === 'wrong-instance' ? 'different' : undefined,
      );
      const proof = jest.fn().mockResolvedValue('unknown');
      next.manager.attachReconciliation(proof);
      clock += 300000;
      await next.manager.init();
      await next.manager.runDue();
      if (kind === 'accepted')
        expect(next.run.mock.calls).toEqual([
          [ids[0], 'cache', false, { cacheOnly: true }],
        ]);
      else expect(next.run).not.toHaveBeenCalled();
      if (kind !== 'unknown') expect(proof).not.toHaveBeenCalled();
    },
  );
  it('never clears an accepted receipt from contradictory retry flags or cache outcomes', async () => {
    const { manager, run } = make(
      jest
        .fn()
        .mockResolvedValueOnce({
          state: 'waiting',
          accepted: true,
          message: 'synthetic accepted',
        })
        .mockResolvedValue({ ...failure, accepted: false }),
    );
    await manager.enqueueRefresh([ids[0]], '2'.repeat(64), 'scheduled-refresh');
    await manager.runDue();
    clock += 30000;
    await manager.runDue();
    clock += 60000;
    await manager.runDue();
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      'submit',
      'cache',
      'cache',
    ]);
    expect((await manager.list())[0].items[0]).toMatchObject({
      accepted: true,
      state: 'waiting',
      cacheOnly: true,
    });
  });
  it('stop during a safe failure does not resurrect unsent work after restart', async () => {
    let finish!: (outcome: BatchOutcome) => void;
    const first = make(
      jest.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const batch = await first.manager.enqueueRefresh(
      [ids[0]],
      '3'.repeat(64),
      'scheduled-refresh',
    );
    const work = first.manager.runDue();
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    await first.manager.stop(batch.batchId);
    finish(failure);
    await work;
    expect((await disk(batch.batchId)).items[0].state).toBe('cancelled');
    first.manager.close();
    clock += 60000;
    const next = make();
    await next.manager.init();
    await next.manager.runDue();
    expect(next.run).not.toHaveBeenCalled();
  });
});
