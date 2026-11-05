import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';
import { Wechat2RssSubscriptionTasks } from './wechat2rss-subscription-tasks';

describe('explicit recovery hold (isolated durable queues)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-recovery-hold-'));
    await fs.writeFile(path.join(root, 'fixture.db'), 'fixture');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it('leaves existing tasks and batches byte-identical and rejects all mutations', async () => {
    const database = () => path.join(root, 'fixture.db');
    const instance = () => 'synthetic';
    const input = {
      articleUrl: 'https://mp.weixin.qq.com/s/' + 'a'.repeat(22),
      feedPath: '/feed/1234567890.xml',
      phase: 'identity' as const,
    };
    const taskRun = jest.fn();
    const submit = jest.fn();
    const refresh = jest.fn();
    const ordinaryTask = new Wechat2RssSubscriptionTasks(
      database,
      instance,
      taskRun,
      () => 1000000,
    );
    const task = await ordinaryTask.enqueue(input);
    ordinaryTask.close();
    const ordinaryBatch = new Wechat2RssSubscriptionBatches(
      database,
      instance,
      submit,
      jest.fn(),
      jest.fn(),
      () => 1000000,
    );
    ordinaryBatch.attachRefresh(refresh);
    const batch = await ordinaryBatch.enqueueRefresh(['MP_WXS_1234567890']);
    ordinaryBatch.close();
    const taskFile = path.join(
      root,
      '.wechat2rss-subscription-tasks',
      task.taskId + '.json',
    );
    const batchFile = path.join(
      root,
      '.wechat2rss-subscription-batches',
      batch.batchId + '.json',
    );
    // Model a process interrupted after a submission began. The hold must not
    // normalize or replay either this ambiguous item or its accepted task.
    const interrupted = JSON.parse(await fs.readFile(batchFile, 'utf8'));
    interrupted.state = 'running';
    interrupted.items[0].state = 'submitting';
    interrupted.items[0].submissionUnknown = true;
    await fs.writeFile(batchFile, JSON.stringify(interrupted));
    const before = await Promise.all([
      fs.readFile(taskFile),
      fs.readFile(batchFile),
    ]);
    const heldTask = new Wechat2RssSubscriptionTasks(
      database,
      instance,
      taskRun,
      () => 2000000,
      true,
    );
    const heldBatch = new Wechat2RssSubscriptionBatches(
      database,
      instance,
      submit,
      jest.fn(),
      jest.fn(),
      () => 2000000,
      true,
    );
    heldBatch.attachRefresh(refresh);
    await heldTask.init();
    await heldBatch.init();
    heldBatch.wake();
    await heldTask.runDue();
    await heldBatch.runDue();
    await expect(heldTask.enqueue(input)).rejects.toThrow(
      'SUBSCRIPTION_TASK_RECOVERY_HELD',
    );
    await expect(heldTask.resume(task.taskId)).rejects.toThrow(
      'SUBSCRIPTION_TASK_RECOVERY_HELD',
    );
    await expect(
      heldTask.setResult(task.taskId, {
        state: 'failed',
        phase: 'identity',
        message: 'fixture',
      }),
    ).rejects.toThrow('SUBSCRIPTION_TASK_RECOVERY_HELD');
    await expect(heldBatch.enqueue([input.articleUrl])).rejects.toThrow(
      'BATCH_RECOVERY_HELD',
    );
    await expect(
      heldBatch.enqueueRefresh(['MP_WXS_1234567890']),
    ).rejects.toThrow('BATCH_RECOVERY_HELD');
    await expect(heldBatch.stop(batch.batchId)).rejects.toThrow(
      'BATCH_RECOVERY_HELD',
    );
    await expect(heldBatch.resume(batch.batchId)).rejects.toThrow(
      'BATCH_RECOVERY_HELD',
    );
    await expect(heldBatch.resumeCacheOnly(batch.batchId)).rejects.toThrow(
      'BATCH_RECOVERY_HELD',
    );
    expect(
      await Promise.all([fs.readFile(taskFile), fs.readFile(batchFile)]),
    ).toEqual(before);
    expect(taskRun).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    heldTask.close();
    heldBatch.close();
  });
  it('does not create storage on held initialization', async () => {
    const database = () => path.join(root, 'fixture.db');
    const heldTask = new Wechat2RssSubscriptionTasks(
      database,
      () => 'synthetic',
      jest.fn(),
      Date.now,
      true,
    );
    const heldBatch = new Wechat2RssSubscriptionBatches(
      database,
      () => 'synthetic',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      Date.now,
      true,
    );
    await heldTask.init();
    await heldBatch.init();
    await heldTask.runDue();
    await heldBatch.runDue();
    expect(await fs.readdir(root)).toEqual(['fixture.db']);
  });
});
