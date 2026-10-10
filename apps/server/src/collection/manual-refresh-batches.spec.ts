import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BatchOutcome,
  Wechat2RssSubscriptionBatches,
} from './wechat2rss-subscription-batches';

describe('manual refresh through the original batch scheduler (offline)', () => {
  let directory: string, clock: number;
  const managers: Wechat2RssSubscriptionBatches[] = [];
  const ids = ['MP_WXS_1234567890', 'MP_WXS_2234567890'];
  const accepted: BatchOutcome = {
    state: 'waiting',
    accepted: true,
    message: '上游已受理。',
  };
  const make = (run = jest.fn().mockResolvedValue(accepted)) => {
    const submit = jest.fn();
    const manager = new Wechat2RssSubscriptionBatches(
      () => path.join(directory, 'fixture.db'),
      () => 'synthetic-instance',
      submit,
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    manager.attachRefresh(run);
    managers.push(manager);
    return { manager, run, submit };
  };
  beforeEach(async () => {
    clock = 100000;
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wewe-manual-refresh-'),
    );
    await fs.writeFile(path.join(directory, 'fixture.db'), 'synthetic');
  });
  afterEach(async () => {
    managers.splice(0).forEach((manager) => manager.close());
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('wewe-manual-refresh-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  it('persists exact unique inputs and acknowledges immediately; simultaneous and later clicks reuse one batch', async () => {
    const { manager, run, submit } = make();
    const [a, b] = await Promise.all([
      manager.enqueueRefresh([...ids, ids[0]]),
      manager.enqueueRefresh(ids),
    ]);
    expect(a.batchId).toBe(b.batchId);
    expect(b.reused).toBe(true);
    expect(a.items.map((item) => item.feedId)).toEqual(ids);
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await manager.runDue();
    expect((await manager.enqueueRefresh([...ids].reverse())).batchId).toBe(
      a.batchId,
    );
  });
  it('waiting caches do not block later submissions, with at least 30-second serial spacing', async () => {
    const { manager, run } = make();
    await manager.enqueueRefresh(ids);
    await manager.runDue();
    await manager.runDue();
    expect(run.mock.calls).toEqual([[ids[0], 'submit']]);
    clock += 30000;
    await manager.runDue();
    expect(run.mock.calls).toEqual([
      [ids[0], 'submit'],
      [ids[1], 'submit'],
    ]);
    await manager.runDue();
    expect(run.mock.calls[2]).toEqual([ids[0], 'cache']);
    expect((await manager.list())[0].items.every((item) => item.accepted)).toBe(
      true,
    );
  });
  it('a submitted request with an unknown result pauses, and resume/click/restart never sends it again', async () => {
    const { manager, run } = make(
      jest.fn().mockRejectedValue(new Error('synthetic secret URL')),
    );
    const batch = await manager.enqueueRefresh(ids);
    await manager.runDue();
    expect((await manager.list())[0]).toMatchObject({
      state: 'paused',
      items: [{ state: 'blocked', accepted: false }, { state: 'queued' }],
    });
    await manager.resume(batch.batchId);
    clock += 60000;
    await manager.runDue();
    expect((await manager.enqueueRefresh(ids)).batchId).toBe(batch.batchId);
    const second = make();
    await second.manager.init();
    await second.manager.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
    expect(JSON.stringify(await manager.list())).not.toContain('secret');
  });
  it('shutdown at submitting recovers as unknown without /add replay', async () => {
    let finish!: (value: BatchOutcome) => void;
    const { manager } = make(
      jest.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await manager.enqueueRefresh(ids);
    const work = manager.runDue();
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    manager.close();
    finish(accepted);
    await work;
    const second = make();
    await second.manager.runDue();
    expect((await second.manager.list())[0].state).toBe('paused');
    expect(second.run).not.toHaveBeenCalled();
  });
  it('stop during submission cancels only unsent items; confirmed accepted work continues as cache reads', async () => {
    let finish!: (value: BatchOutcome) => void;
    const { manager, run } = make(
      jest.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const batch = await manager.enqueueRefresh(ids);
    const work = manager.runDue();
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    await manager.stop(batch.batchId);
    finish(accepted);
    await work;
    run.mockResolvedValue({
      state: 'succeeded',
      accepted: true,
      bodyReady: true,
      message: '缓存已同步。',
    });
    clock += 30000;
    await manager.runDue();
    expect(run.mock.calls).toEqual([
      [ids[0], 'submit'],
      [ids[0], 'cache'],
    ]);
    expect((await manager.list())[0]).toMatchObject({
      state: 'stopped',
      items: [{ state: 'succeeded' }, { state: 'cancelled' }],
    });
  });
  it('bounded cache checks pause safely and cache-only resume cannot resubmit', async () => {
    const { manager, run } = make();
    const batch = await manager.enqueueRefresh([ids[0]]);
    await manager.runDue();
    for (let check = 0; check < 10; check++) {
      clock += 30000;
      await manager.runDue();
    }
    expect((await manager.list())[0].state).toBe('paused');
    await manager.resume(batch.batchId);
    await manager.runDue();
    expect(run.mock.calls.filter((call) => call[1] === 'submit')).toHaveLength(
      1,
    );
  });
  it('ordinary subscription intents retain their purpose and cannot run concurrently with manual submissions', async () => {
    const { manager } = make();
    const old = await manager.enqueue([
      'https://mp.weixin.qq.com/s/' + 'a'.repeat(22),
    ]);
    expect(old.purpose).toBe('subscription');
    await expect(manager.enqueueRefresh(ids)).rejects.toThrow('BATCH_BUSY');
    expect((await manager.list())[0].batchId).toBe(old.batchId);
  });
  it('a fixed original-click intent reuses completed and stopped records after restart; a new click stays distinct', async () => {
    const intentKey = 'a'.repeat(64);
    const { manager, run } = make(
      jest.fn().mockResolvedValue({
        state: 'succeeded',
        accepted: true,
        message: '缓存已同步。',
      }),
    );
    const original = await manager.enqueueRefresh([ids[0]], intentKey);
    await manager.runDue();
    expect((await manager.list())[0].state).toBe('completed');
    manager.close();
    const recovered = make();
    expect(
      await recovered.manager.enqueueRefresh(ids, intentKey),
    ).toMatchObject({ batchId: original.batchId, reused: true, intentKey });
    clock += 30000;
    await recovered.manager.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect(recovered.run).not.toHaveBeenCalled();
    const newClick = await recovered.manager.enqueueRefresh(ids);
    expect(newClick.batchId).not.toBe(original.batchId);
    await recovered.manager.stop(newClick.batchId);
    const cancelledKey = 'b'.repeat(64);
    const stopped = await recovered.manager.enqueueRefresh(ids, cancelledKey);
    await recovered.manager.stop(stopped.batchId);
    expect(
      await recovered.manager.enqueueRefresh(ids, cancelledKey),
    ).toMatchObject({
      batchId: stopped.batchId,
      state: 'stopped',
      reused: true,
    });
    await expect(
      recovered.manager.enqueueRefresh(ids, '../unsafe'),
    ).rejects.toThrow('BATCH_INVALID');
  });
});
