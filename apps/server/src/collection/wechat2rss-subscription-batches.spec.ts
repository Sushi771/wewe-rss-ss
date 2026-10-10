import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BatchOutcome,
  Wechat2RssSubscriptionBatches,
} from './wechat2rss-subscription-batches';

describe('durable authorized batch (offline)', () => {
  let directory: string, database: string, clock: number;
  let managers: Wechat2RssSubscriptionBatches[];
  const urls = ['a', 'b', 'c'].map(
    (v) => 'https://mp.weixin.qq.com/s/' + v.repeat(22),
  );
  const id = 'a'.repeat(64);
  const success: BatchOutcome = { state: 'succeeded', message: '已完成。' };
  const waiting: BatchOutcome = {
    state: 'waiting',
    message: '正在读取。',
    taskId: id,
    feedId: 'MP_WXS_1234567890',
  };
  const make = (
    submit = jest.fn().mockResolvedValue(success),
    task = jest.fn().mockResolvedValue(waiting),
    resume = jest.fn(),
  ) => {
    const manager = new Wechat2RssSubscriptionBatches(
      () => database,
      () => 'fixture-instance-token',
      submit,
      task,
      resume,
      () => clock,
    );
    managers.push(manager);
    return { manager, submit, task, resume };
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-batch-'));
    database = path.join(directory, 'fixture.db');
    await fs.writeFile(database, 'fixture');
    clock = 100000;
    managers = [];
  });
  afterEach(async () => {
    managers.forEach((m) => m.close());
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('wewe-batch-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  it('saves all inputs before any call, submits serially with 30s spacing, and reads status locally', async () => {
    const { manager, submit } = make();
    const batch = await manager.enqueue(urls);
    expect(submit).not.toHaveBeenCalled();
    const disk = JSON.parse(
      await fs.readFile(
        path.join(
          directory,
          '.wechat2rss-subscription-batches',
          batch.batchId + '.json',
        ),
        'utf8',
      ),
    );
    expect(disk.items.map((i: any) => i.articleUrl)).toEqual(urls);
    expect(JSON.stringify(await manager.list())).not.toContain(urls[0]);
    await manager.runDue();
    await manager.runDue();
    expect(submit).toHaveBeenCalledTimes(1);
    clock += 30000;
    await manager.runDue();
    clock += 30000;
    await manager.runDue();
    expect(submit.mock.calls.map((a) => a[0])).toEqual(urls);
    expect((await manager.list())[0].state).toBe('completed');
  });
  it('waits for actual cache completion before the next URL and recovers all unsent inputs on restart', async () => {
    const submit = jest
      .fn()
      .mockResolvedValueOnce(waiting)
      .mockResolvedValue(success);
    const task = jest.fn().mockResolvedValue(waiting);
    const first = make(submit, task).manager;
    await first.enqueue(urls);
    await first.runDue();
    first.close();
    const second = make(submit, task).manager;
    await second.init();
    clock += 30000;
    await second.runDue();
    expect(submit).toHaveBeenCalledTimes(1);
    task.mockResolvedValue(success);
    await second.runDue();
    await second.runDue();
    expect(submit).toHaveBeenCalledTimes(2);
    clock += 30000;
    await second.runDue();
    expect(submit.mock.calls.map((a) => a[0])).toEqual(urls);
  });
  it('does not resubmit a recovered waiting request even on multiple status reads', async () => {
    const { manager, submit } = make(jest.fn().mockResolvedValue(waiting));
    await manager.enqueue(urls);
    await manager.runDue();
    for (let i = 0; i < 5; i++) {
      await manager.list();
      await manager.runDue();
    }
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('pauses the whole batch on account restrictions, never advances behind a ready body with blocked state', async () => {
    const { manager, submit, task } = make(
      jest.fn().mockResolvedValue(waiting),
    );
    const batch = await manager.enqueue(urls);
    await manager.runDue();
    task.mockResolvedValue({ ...waiting, state: 'blocked', bodyReady: true });
    clock += 30000;
    await manager.runDue();
    await manager.runDue();
    expect((await manager.list())[0]).toMatchObject({
      state: 'paused',
      items: [{ state: 'blocked' }, { state: 'queued' }, { state: 'queued' }],
    });
    expect(submit).toHaveBeenCalledTimes(1);
    await expect(manager.enqueue([urls[1]])).rejects.toThrow('BATCH_BUSY');
    expect(
      (await manager.stop(batch.batchId))?.items
        .slice(1)
        .every((i) => i.state === 'cancelled'),
    ).toBe(true);
  });
  it('stop cancels only unsent items and survives an in-flight reply', async () => {
    let complete!: (value: BatchOutcome) => void;
    const { manager, submit } = make(
      jest.fn(() => new Promise((r) => (complete = r))),
    );
    const batch = await manager.enqueue(urls);
    const running = manager.runDue();
    while (!complete) await new Promise((r) => setImmediate(r));
    await manager.stop(batch.batchId);
    complete(waiting);
    await running;
    clock += 60000;
    await manager.runDue();
    expect((await manager.list())[0]).toMatchObject({
      state: 'stopped',
      items: [
        { state: 'waiting' },
        { state: 'cancelled' },
        { state: 'cancelled' },
      ],
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('shutdown preserves a submitting record for the original receipt-guarded recovery', async () => {
    let complete!: (value: BatchOutcome) => void;
    const { manager } = make(jest.fn(() => new Promise((r) => (complete = r))));
    await manager.enqueue(urls);
    const work = manager.runDue();
    while (!complete) await new Promise((r) => setImmediate(r));
    manager.close();
    complete(waiting);
    await work;
    expect((await manager.list())[0].items[0].state).toBe('submitting');
    const recover = make(jest.fn().mockResolvedValue(waiting));
    await recover.manager.runDue();
    expect(recover.submit).toHaveBeenCalledTimes(1); // The service callback recovers its one-shot receipt.
    expect((await recover.manager.list())[0].items[0].state).toBe('waiting');
  });
  it('marks invalid inputs and exact duplicates without storing credentials or stopping other valid inputs', async () => {
    const { manager, submit } = make();
    const batch = await manager.enqueue([
      'https://mp.weixin.qq.com/s/a?token=secret',
      urls[0],
      urls[0],
      'invalid',
      urls[1],
    ]);
    expect(batch.items.map((i) => i.state)).toEqual([
      'failed',
      'queued',
      'skipped',
      'failed',
      'queued',
    ]);
    const contents = await fs.readFile(
      path.join(
        directory,
        '.wechat2rss-subscription-batches',
        batch.batchId + '.json',
      ),
      'utf8',
    );
    expect(contents).not.toContain('secret');
    await manager.runDue();
    clock += 30000;
    await manager.runDue();
    expect(submit.mock.calls.map((a) => a[0])).toEqual(urls.slice(0, 2));
  });
  it('deduplicates a live batch and protects resume/status from arbitrary upstream errors', async () => {
    const { manager, submit } = make(
      jest.fn().mockRejectedValue(Error('fixture-secret-token')),
    );
    const first = await manager.enqueue(urls);
    expect((await manager.enqueue(urls)).batchId).toBe(first.batchId);
    await manager.runDue();
    expect((await manager.list())[0].state).toBe('paused');
    expect(JSON.stringify(await manager.list())).not.toContain(
      'fixture-secret-token',
    );
    submit.mockResolvedValue(waiting);
    await manager.resume(first.batchId);
    clock += 30000;
    await manager.runDue();
    expect((await manager.list())[0].items[0].state).toBe('waiting');
  });
  it('backs up all persisted inputs and rejects corrupted task IDs and symlinks', async () => {
    const { manager } = make();
    const batch = await manager.enqueue(urls);
    const backup = path.join(directory, 'backup', 'db.sqlite');
    await fs.mkdir(path.dirname(backup));
    await fs.writeFile(backup, 'copy');
    await manager.snapshot(backup);
    const name = batch.batchId + '.json';
    expect(
      await fs.readFile(
        path.join(
          path.dirname(backup),
          '.wechat2rss-subscription-batches',
          name,
        ),
        'utf8',
      ),
    ).toEqual(
      await fs.readFile(
        path.join(directory, '.wechat2rss-subscription-batches', name),
        'utf8',
      ),
    );
    await expect(manager.stop('../arbitrary')).rejects.toThrow('BATCH_INVALID');
  });
  it('shares one scheduler with a durable download processor without losing queued inputs', async () => {
    const { manager, submit } = make();
    const processor = {
      hasPending: jest.fn().mockResolvedValue(true),
      runDue: jest.fn().mockResolvedValue(undefined),
    };
    manager.attachConsumer(processor);
    await manager.init();
    await manager.runDue();
    expect(processor.runDue).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    await manager.enqueue(urls);
    await manager.runDue();
    expect(processor.runDue).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('defers behind another active collection without failing or submitting the next item', async () => {
    const submit = jest
      .fn()
      .mockResolvedValueOnce({ state: 'queued', message: '等待内部锁。' })
      .mockResolvedValue(success);
    const { manager } = make(submit);
    await manager.enqueue(urls);
    await manager.runDue();
    expect((await manager.list())[0]).toMatchObject({
      state: 'running',
      items: [{ state: 'queued' }, { state: 'queued' }, { state: 'queued' }],
    });
    await manager.runDue();
    expect(submit).toHaveBeenCalledTimes(1);
    clock += 30000;
    await manager.runDue();
    expect(submit.mock.calls.map((a) => a[0])).toEqual([urls[0], urls[0]]);
  });
});
