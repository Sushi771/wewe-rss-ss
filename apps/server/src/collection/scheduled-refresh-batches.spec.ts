import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';

describe('automatic refresh shares durable manual queue (offline)', () => {
  let directory: string, clock: number;
  const managers: Wechat2RssSubscriptionBatches[] = [];
  const ids = ['MP_WXS_1234567890', 'MP_WXS_2234567890'];
  const env = { ...process.env };
  const make = (
    run = jest.fn().mockResolvedValue({
      state: 'succeeded',
      accepted: true,
      message: 'synthetic ready',
    }),
  ) => {
    const manager = new Wechat2RssSubscriptionBatches(
      () => path.join(directory, 'fixture.db'),
      () => 'synthetic',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    manager.attachRefresh(run);
    managers.push(manager);
    return { manager, run };
  };
  beforeEach(async () => {
    clock = Date.parse('2026-10-12T17:30:00+08:00');
    Object.assign(process.env, {
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      WECHAT2RSS_ENABLED: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    });
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scheduled-refresh-test-'),
    );
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
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('two queue instances claim one round and consume at least 30 seconds apart', async () => {
    const a = make(),
      b = make();
    const key = 'a'.repeat(64);
    const outcome = await Promise.allSettled([
      a.manager.enqueueRefresh(ids, key, 'scheduled-refresh'),
      b.manager.enqueueRefresh(ids, key, 'scheduled-refresh'),
    ]);
    expect(outcome.some((value) => value.status === 'fulfilled')).toBe(true);
    expect(await a.manager.list()).toHaveLength(1);
    await Promise.all([a.manager.runDue(), b.manager.runDue()]);
    expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(1);
    clock += 29999;
    await b.manager.runDue();
    expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(1);
    clock++;
    await b.manager.runDue();
    expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(2);
    const recovered = make();
    expect(
      await recovered.manager.enqueueRefresh(ids, key, 'scheduled-refresh'),
    ).toMatchObject({ reused: true });
    await recovered.manager.runDue();
    expect(recovered.run).not.toHaveBeenCalled();
  });
  it('a failed single-download consumer never blocks independent refresh submissions', async () => {
    const { manager, run } = make();
    const consumer = {
      runDue: jest
        .fn()
        .mockRejectedValue(new Error('synthetic path unavailable')),
      hasPending: jest
        .fn()
        .mockRejectedValue(new Error('synthetic task store unavailable')),
    };
    manager.attachConsumer(consumer);
    await manager.enqueueRefresh(ids, '8'.repeat(64), 'scheduled-refresh');
    await manager.init();
    await manager.runDue();
    clock += 30000;
    await manager.runDue();
    expect(run.mock.calls.map(([id]) => id)).toEqual(ids);
    expect((await manager.list())[0].state).toBe('completed');
    expect(consumer.runDue).toHaveBeenCalledTimes(2);
    expect(consumer.hasPending).toHaveBeenCalled();
  });
  it('an automatic round overlapping manual work records its intent without later replay', async () => {
    const a = make();
    await a.manager.enqueueRefresh(ids);
    const key = 'b'.repeat(64);
    expect(
      await a.manager.enqueueRefresh(ids, key, 'scheduled-refresh'),
    ).toMatchObject({
      purpose: 'scheduled-refresh',
      state: 'completed',
      reused: true,
    });
    await a.manager.runDue();
    clock += 30000;
    await a.manager.runDue();
    const recovered = make();
    expect(
      await recovered.manager.enqueueRefresh(ids, key, 'scheduled-refresh'),
    ).toMatchObject({
      purpose: 'scheduled-refresh',
      state: 'completed',
      reused: true,
    });
    expect(recovered.run).not.toHaveBeenCalled();
  });
  it('the 17:30 tail may run in evening, but cancels unsubmitted work at midnight and only checks accepted cache', async () => {
    const { manager, run } = make(
      jest.fn().mockResolvedValue({
        state: 'waiting',
        accepted: true,
        message: 'synthetic accepted',
      }),
    );
    await manager.enqueueRefresh(
      [...ids, 'MP_WXS_3234567890'],
      'c'.repeat(64),
      'scheduled-refresh',
    );
    await manager.runDue();
    clock = Date.parse('2026-10-12T18:00:00+08:00');
    await manager.runDue();
    expect(run.mock.calls.filter((call) => call[1] === 'submit')).toHaveLength(
      2,
    );
    clock = Date.parse('2026-10-13T00:00:00+08:00');
    await manager.runDue();
    clock = Date.parse('2026-10-13T06:00:00+08:00');
    await manager.runDue();
    expect(run.mock.calls.filter((call) => call[1] === 'submit')).toHaveLength(
      2,
    );
    expect((await manager.list())[0].items[2].state).toBe('cancelled');
  });
  it('new subscriptions overlapping a smaller manual batch stay queued with global spacing', async () => {
    const { manager, run } = make();
    await manager.enqueueRefresh([ids[0]]);
    clock++;
    const automatic = await manager.enqueueRefresh(
      ids,
      '6'.repeat(64),
      'scheduled-refresh',
    );
    expect(automatic.items.map((item) => item.state)).toEqual([
      'skipped',
      'queued',
    ]);
    await manager.runDue();
    clock += 29999;
    await manager.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    clock++;
    await manager.runDue();
    expect(run.mock.calls).toEqual([
      [ids[0], 'submit'],
      [ids[1], 'submit', true],
    ]);
  });
  it('restart after days off expires old unsent automatic items but preserves the newest round', async () => {
    const { manager, run } = make();
    await manager.enqueueRefresh(ids, '7'.repeat(64), 'scheduled-refresh');
    clock = Date.parse('2026-10-15T14:00:00+08:00');
    await manager.enqueueRefresh(ids, '8'.repeat(64), 'scheduled-refresh');
    await manager.runDue();
    await manager.runDue();
    clock += 30000;
    await manager.runDue();
    expect(run.mock.calls).toEqual([
      [ids[0], 'submit', true],
      [ids[1], 'submit', true],
    ]);
    expect(
      (await manager.list())
        .find((record) => record.intentKey === '7'.repeat(64))
        ?.items.every((item) => item.state === 'cancelled'),
    ).toBe(true);
  });
  it('stopping an unknown result does not authorize resubmission through a later round', async () => {
    const { manager, run } = make(
      jest.fn().mockRejectedValue(Error('unknown')),
    );
    const first = await manager.enqueueRefresh(
      ids,
      '9'.repeat(64),
      'scheduled-refresh',
    );
    await manager.runDue();
    await manager.stop(first.batchId);
    clock += 86400000;
    const second = await manager.enqueueRefresh(
      ids,
      '0'.repeat(64),
      'scheduled-refresh',
    );
    expect(second.items.map((item) => item.feedId)).toEqual([ids[1]]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('midnight new automatic items cannot submit, and disabling prevents queued submissions', async () => {
    clock = Date.parse('2026-10-12T05:59:00+08:00');
    const { manager, run } = make();
    await manager.enqueueRefresh(ids, 'd'.repeat(64), 'scheduled-refresh');
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
    clock += 60000;
    process.env.DISABLE_SCHEDULED_UPDATES = '1';
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
  });
  it('an unknown receipt isolates only its author across restart and subsequent slots', async () => {
    const { manager, run } = make(
      jest.fn().mockRejectedValue(new Error('synthetic unknown')),
    );
    const batch = await manager.enqueueRefresh(
      ids,
      'e'.repeat(64),
      'scheduled-refresh',
    );
    await manager.runDue();
    await manager.resume(batch.batchId);
    clock += 60000;
    const next = make();
    await next.manager.runDue();
    await next.manager.enqueueRefresh(ids, 'f'.repeat(64), 'scheduled-refresh');
    await next.manager.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect(next.run).toHaveBeenCalledTimes(1);
    expect(next.run).toHaveBeenCalledWith(ids[1], 'submit', true);
    expect(
      (await manager.list()).find((item) => item.batchId === batch.batchId)
        ?.state,
    ).toBe('completed');
  });
  it('300 subscriptions continue after one unknown, preserve receipts on restart, and exclude it next slot', async () => {
    clock = Date.parse('2026-10-13T09:15:00+08:00');
    const feeds = Array.from(
      { length: 300 },
      (_, index) => `MP_WXS_${1000000000 + index}`,
    );
    const run = jest.fn(async (feed: string) => {
      if (feed === feeds[27]) throw new Error('synthetic unknown');
      return { state: 'succeeded', accepted: true, message: 'synthetic ready' };
    });
    const first = make(run as any);
    await first.manager.enqueueRefresh(
      feeds,
      '1'.repeat(64),
      'scheduled-refresh',
    );
    for (let index = 0; index < 300; index++) {
      await first.manager.runDue();
      clock += 30000;
    }
    const result = (await first.manager.list())[0];
    expect(result.state).toBe('completed');
    expect(
      result.items.filter((item) => item.state === 'succeeded'),
    ).toHaveLength(299);
    expect(result.items[27]).toMatchObject({
      state: 'blocked',
      accepted: false,
    });
    expect(run.mock.calls.filter(([feed]) => feed === feeds[27])).toHaveLength(
      1,
    );
    const next = make();
    clock = Date.parse('2026-10-13T14:00:00+08:00');
    const nextBatch = await next.manager.enqueueRefresh(
      feeds,
      '2'.repeat(64),
      'scheduled-refresh',
    );
    expect(nextBatch.items).toHaveLength(299);
    expect(nextBatch.items.some((item) => item.feedId === feeds[27])).toBe(
      false,
    );
    await Promise.all([first.manager.runDue(), next.manager.runDue()]);
    expect(run.mock.calls.filter(([feed]) => feed === feeds[27])).toHaveLength(
      1,
    );
  }, 30000);
  it('preparation errors retry three times with durable backoff while independent items proceed', async () => {
    const run = jest.fn(async (id: string) =>
      id === ids[0]
        ? {
            state: 'failed',
            accepted: false,
            retryable: true,
            stopBatch: false,
            message: 'no submission',
          }
        : { state: 'succeeded', accepted: true, message: 'ready' },
    );
    const first = make(run as any);
    await first.manager.enqueueRefresh(
      ids,
      '3'.repeat(64),
      'scheduled-refresh',
    );
    await first.manager.runDue();
    clock += 30000;
    await first.manager.runDue();
    expect(run.mock.calls.map(([id]) => id)).toEqual(ids);
    const recovered = make(run as any);
    clock += 30000;
    await recovered.manager.runDue();
    clock += 119999;
    await recovered.manager.runDue();
    expect(run).toHaveBeenCalledTimes(3);
    clock++;
    await recovered.manager.runDue();
    expect(run).toHaveBeenCalledTimes(4);
    expect((await recovered.manager.list())[0].state).toBe('completed');
  });
  it('read-only proof releases an old paused item; unknown proof never releases another author', async () => {
    const { manager, run } = make(
      jest.fn().mockRejectedValueOnce(Error('unknown')).mockResolvedValue({
        state: 'succeeded',
        accepted: true,
        message: 'ready',
      }),
    );
    const first = await manager.enqueueRefresh(
      ids,
      '4'.repeat(64),
      'scheduled-refresh',
    );
    await manager.runDue();
    const file = path.join(
      directory,
      '.wechat2rss-subscription-batches',
      first.batchId + '.json',
    );
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.state = 'paused'; // exact legacy state, before independent items ran
    await fs.writeFile(file, JSON.stringify(record));
    const proof = jest.fn().mockResolvedValue('unknown');
    manager.attachReconciliation(proof);
    clock += 30000;
    await manager.runDue();
    expect(run.mock.calls.map((call) => call[0])).toEqual(ids);
    expect(proof).toHaveBeenCalledWith(ids[0], first.createdAt);
    proof.mockResolvedValue('not-submitted');
    clock += 60000;
    await manager.runDue();
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      ids[0],
      ids[1],
      ids[0],
    ]);
    expect((await manager.list())[0].state).toBe('completed');
  });
});
