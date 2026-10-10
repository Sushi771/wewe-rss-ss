import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SubscriptionTaskResult,
  Wechat2RssSubscriptionTasks,
} from './wechat2rss-subscription-tasks';

describe('accepted subscription task persistence (offline)', () => {
  let root: string, database: string, now: number, instance: string;
  let queues: Wechat2RssSubscriptionTasks[];
  const input = {
    articleUrl: 'https://mp.weixin.qq.com/s/' + 'a'.repeat(22),
    feedPath: '/feed/1234567890.xml',
    phase: 'identity' as const,
  };
  const done: SubscriptionTaskResult = {
    state: 'succeeded',
    phase: 'cache',
    feedId: 'MP_WXS_1234567890',
    message: '已自动入库。',
  };
  const make = (run: (task: any) => Promise<SubscriptionTaskResult>) => {
    const q = new Wechat2RssSubscriptionTasks(
      () => database,
      () => instance,
      run,
      () => now,
    );
    queues.push(q);
    return q;
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-subscription-tasks-'));
    database = path.join(root, 'synthetic.db');
    await fs.writeFile(database, 'fixture');
    now = 1000000;
    instance = 'synthetic-instance-and-token';
    queues = [];
  });
  afterEach(async () => {
    queues.forEach((q) => q.close());
    if (
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('wewe-subscription-tasks-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('persists immediately, has no upstream action on status reads, and completes automatically', async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({ ...done, state: 'pending' })
      .mockResolvedValueOnce(done);
    const q = make(run);
    await q.init();
    const first = await q.enqueue(input);
    expect(first.state).toBe('pending');
    await q.list();
    await q.get(first.taskId);
    await q.runDue();
    expect(run).not.toHaveBeenCalled();
    now += 30000;
    await q.runDue();
    expect((await q.get(first.taskId))?.state).toBe('pending');
    now += 30000;
    await q.runDue();
    expect((await q.get(first.taskId))?.state).toBe('succeeded');
    now += 30000;
    await q.runDue();
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await q.list())).not.toMatch(
      /synthetic-instance|\/feed\/|https:\/\//,
    );
  });
  it('persists partial text completion across restart and retries only after explicit resume', async () => {
    const run = jest.fn();
    run.mockResolvedValue({
      ...done,
      code: 'CACHE_IMAGES_PENDING',
      bodyReady: false,
      imagePendingCount: 1,
    });
    const q = make(run);
    const first = await q.enqueue(input);
    now += 30000;
    await q.runDue();
    q.close();
    const fresh = make(jest.fn().mockResolvedValue(done));
    await fresh.init();
    expect(await fresh.get(first.taskId)).toMatchObject({
      state: 'succeeded',
      code: 'CACHE_IMAGES_PENDING',
      imagePendingCount: 1,
    });
    await fresh.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await fresh.resume(first.taskId)).toMatchObject({
      state: 'pending',
    });
    expect((await fresh.get(first.taskId))?.imagePendingCount).toBeUndefined();
  });
  it('recovers a crashed running record with the same ID/path and never invents a new add', async () => {
    const q = make(jest.fn());
    const first = await q.enqueue(input);
    q.close();
    const file = path.join(
      root,
      '.wechat2rss-subscription-tasks',
      first.taskId + '.json',
    );
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    persisted.state = 'running';
    persisted.attempts = 1;
    await fs.writeFile(file, JSON.stringify(persisted));
    const run = jest.fn().mockResolvedValue(done),
      resumed = make(run);
    await resumed.init();
    now += 30000;
    await resumed.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
      taskId: first.taskId,
      feedPath: input.feedPath,
      attempts: 2,
    });
    expect((await resumed.get(first.taskId))?.state).toBe('succeeded');
  });
  it('deduplicates the same accepted request and keeps its original deadline', async () => {
    const q = make(jest.fn().mockResolvedValue(done));
    const a = await q.enqueue(input);
    now += 5000;
    expect(await q.enqueue(input)).toEqual(a);
    expect(await q.list()).toHaveLength(1);
  });
  it.each(['blocked', 'failed'] as const)(
    'stops %s without retry until an explicit continuation',
    async (state) => {
      const run = jest
          .fn()
          .mockResolvedValueOnce({ ...done, state })
          .mockResolvedValueOnce(done),
        q = make(run);
      await q.init();
      const a = await q.enqueue(input);
      now += 30000;
      await q.runDue();
      now += 60000;
      await q.runDue();
      expect(run).toHaveBeenCalledTimes(1);
      expect((await q.get(a.taskId))?.state).toBe(state);
      const resumed = await q.resume(a.taskId);
      expect(resumed?.taskId).toBe(a.taskId);
      expect(resumed?.state).toBe('pending');
      now += 30000;
      await q.runDue();
      expect((await q.get(a.taskId))?.state).toBe('succeeded');
      expect(run).toHaveBeenCalledTimes(2);
    },
  );
  it('turns a read exception into a safe terminal failure without replay', async () => {
    const run = jest.fn().mockRejectedValue(Error('private-token-url')),
      q = make(run);
    await q.init();
    const a = await q.enqueue(input);
    now += 30000;
    await q.runDue();
    now += 30000;
    await q.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await q.get(a.taskId))?.state).toBe('failed');
    expect(JSON.stringify(await q.list())).not.toContain('private-token-url');
  });
  it('expires after the bounded window without starting another check', async () => {
    const run = jest.fn().mockResolvedValue({ ...done, state: 'pending' }),
      q = make(run);
    await q.init();
    const a = await q.enqueue(input);
    now += 30000;
    await q.runDue();
    now += 300000;
    await q.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await q.get(a.taskId))?.state).toBe('failed');
  });
  it('gives a queued first read its own bounded window and preserves it across restart', async () => {
    const run = jest
      .fn()
      .mockResolvedValue({ ...done, state: 'pending', code: 'CACHE_PENDING' });
    const q = make(run);
    await q.init();
    const first = await q.enqueue(input);
    now += 360000; // Earlier serialized body imports occupied the worker.
    await q.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
      startedAt: first.startedAt,
      firstCheckAt: now,
      deadline: now + 300000,
    });
    q.close();
    const complete = jest.fn().mockResolvedValue(done),
      recovered = make(complete);
    await recovered.init();
    now += 30000;
    await recovered.runDue();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].firstCheckAt).toBe(now - 30000);
    expect((await recovered.get(first.taskId))?.state).toBe('succeeded');
    expect((await recovered.get(first.taskId))?.code).toBeUndefined();
  });
  it('stops if private instance configuration changed without reading another instance', async () => {
    const run = jest.fn(),
      q = make(run);
    await q.init();
    const a = await q.enqueue(input);
    instance = 'replacement-instance';
    now += 30000;
    await q.runDue();
    expect(run).not.toHaveBeenCalled();
    expect((await q.get(a.taskId))?.state).toBe('failed');
  });
  it('does not expire the sixth queued task while five slow cache reads are serialized', async () => {
    const run = jest.fn().mockImplementation(async () => {
      now += 70000;
      return done;
    });
    const q = make(run);
    await q.init();
    const ids: string[] = [];
    for (const letter of ['a', 'b', 'c', 'd', 'e', 'f']) {
      ids.push(
        (
          await q.enqueue({
            ...input,
            articleUrl: 'https://mp.weixin.qq.com/s/' + letter.repeat(22),
          })
        ).taskId,
      );
      now++;
    }
    now += 30000;
    for (let index = 0; index < 6; index++) await q.runDue();
    expect(run.mock.calls.map(([task]) => task.taskId)).toEqual(ids);
    expect((await q.list()).every((task) => task.state === 'succeeded')).toBe(
      true,
    );
  });
  it('serializes due tasks and does not let an older pending task starve the next one', async () => {
    const run = jest.fn().mockResolvedValue({ ...done, state: 'pending' }),
      q = make(run);
    await q.init();
    const a = await q.enqueue(input);
    now++;
    const b = await q.enqueue({
      ...input,
      articleUrl: 'https://mp.weixin.qq.com/s/' + 'b'.repeat(22),
      feedPath: '/feed/9876543210.xml',
    });
    now += 30000;
    await q.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    now += 30000;
    await q.runDue();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([task]) => task.taskId)).toEqual([
      a.taskId,
      b.taskId,
    ]);
  });
  it('skips corrupted persisted records and cannot traverse outside its directory', async () => {
    const q = make(jest.fn()),
      a = await q.enqueue(input);
    const file = path.join(
      root,
      '.wechat2rss-subscription-tasks',
      a.taskId + '.json',
    );
    const t = JSON.parse(await fs.readFile(file, 'utf8'));
    t.articleUrl = 'https://other.example/';
    await fs.writeFile(file, JSON.stringify(t));
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      expect(await q.list()).toEqual([]);
      await expect(q.get('../elsewhere')).rejects.toThrow(
        'SUBSCRIPTION_TASK_INVALID',
      );
    } finally {
      warning.mockRestore();
    }
  });
  it('preserves an in-flight read on shutdown and backs up the durable record', async () => {
    let finish!: (result: SubscriptionTaskResult) => void;
    const q = make(() => new Promise((r) => (finish = r)));
    const task = await q.enqueue(input);
    now += 30000;
    const work = q.runDue();
    while (!finish) await new Promise((r) => setImmediate(r));
    q.close();
    finish(done);
    await work;
    expect((await q.get(task.taskId))?.state).toBe('running');
    const backup = path.join(root, 'backup', 'copy.db');
    await fs.mkdir(path.dirname(backup));
    await fs.writeFile(backup, 'copy');
    await q.snapshot(backup);
    const name = task.taskId + '.json';
    expect(
      await fs.readFile(
        path.join(root, 'backup', '.wechat2rss-subscription-tasks', name),
        'utf8',
      ),
    ).toEqual(
      await fs.readFile(
        path.join(root, '.wechat2rss-subscription-tasks', name),
        'utf8',
      ),
    );
    const recovered = make(jest.fn().mockResolvedValue(done));
    now += 30000;
    await recovered.runDue();
    expect((await recovered.get(task.taskId))?.state).toBe('succeeded');
  });
  it('does not overwrite a newer foreground completion with a late pending read', async () => {
    let finish!: (result: SubscriptionTaskResult) => void;
    const q = make(() => new Promise((r) => (finish = r)));
    const task = await q.enqueue(input);
    now += 30000;
    const work = q.runDue();
    while (!finish) await new Promise((r) => setImmediate(r));
    await q.setResult(task.taskId, done);
    finish({ ...done, state: 'pending', phase: 'identity' });
    await work;
    expect(await q.get(task.taskId)).toMatchObject({
      state: 'succeeded',
      phase: 'cache',
    });
  });
});
