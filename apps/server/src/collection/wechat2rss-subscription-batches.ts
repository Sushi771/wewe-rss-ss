import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { subscriptionArticleUrl } from './subscription-add';

type ItemState =
  | 'queued'
  | 'submitting'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'skipped';
export type BatchOutcome = {
  state: 'queued' | 'waiting' | 'succeeded' | 'failed' | 'blocked';
  message: string;
  taskId?: string;
  feedId?: string;
  bodyReady?: boolean;
};
type Item = Omit<BatchOutcome, 'state'> & {
  index: number;
  articleUrl?: string;
  state: ItemState;
};
type Batch = {
  version: 1;
  batchId: string;
  instance: string;
  signature: string;
  purpose?: 'subscription' | 'single-download';
  createdAt: number;
  updatedAt: number;
  nextSubmissionAt: number;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'stopped';
  items: Item[];
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const live = (b: Batch) => ['queued', 'running', 'paused'].includes(b.state);
const view = (b: Batch) => ({
  batchId: b.batchId,
  state: b.state,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
  items: b.items.map((item) => ({
    index: item.index,
    state: item.state,
    message: item.message,
    taskId: item.taskId,
    feedId: item.feedId,
    bodyReady: item.bodyReady,
    // Bind internal consumers to the original intent without publishing URLs.
    articleUrlHash: item.articleUrl ? hash(item.articleUrl) : undefined,
  })),
});

/** Persist the whole authorized input before submitting anything. Only submit
 * calls the original one-shot receipt guarded add; status checks are local.
 * Recovery of a submitting item uses that same receipt, never an unguarded add.
 */
export class Wechat2RssSubscriptionBatches {
  private directory?: string;
  private initialized = false;
  private stopped = false;
  private busy = false;
  private accepting = false;
  private timer?: NodeJS.Timeout;
  private consumer?: {
    hasPending(): Promise<boolean>;
    runDue(): Promise<void>;
    snapshot?(backupFile: string): Promise<void>;
  };

  /** A single-download processor may share this scheduler. It owns its private
   * records and file validation, and must never create another polling timer. */
  attachConsumer(consumer: {
    hasPending(): Promise<boolean>;
    runDue(): Promise<void>;
    snapshot?(backupFile: string): Promise<void>;
  }) {
    if (this.consumer && this.consumer !== consumer)
      throw new Error('BATCH_CONSUMER_EXISTS');
    this.consumer = consumer;
    this.schedule();
  }
  wake() {
    this.schedule();
  }

  constructor(
    private readonly database: () => string,
    private readonly instance: () => string,
    private readonly submit: (
      url: string,
      purpose?: 'subscription' | 'single-download',
    ) => Promise<BatchOutcome>,
    private readonly task: (id: string) => Promise<BatchOutcome | null>,
    private readonly resumeTask: (id: string) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  private async storage() {
    if (this.directory) return this.directory;
    const database = await fs.realpath(this.database());
    const directory = path.join(
      path.dirname(database),
      '.wechat2rss-subscription-batches',
    );
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.realpath(directory)) !== directory)
      throw new Error('BATCH_STORAGE_INVALID');
    this.directory = directory;
    return directory;
  }
  private async read(id: string): Promise<Batch | undefined> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('BATCH_INVALID');
    try {
      const file = path.join(await this.storage(), id + '.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000)
        throw new Error('BATCH_INVALID');
      const b = JSON.parse(await fs.readFile(file, 'utf8')) as Batch;
      if (
        b.version !== 1 ||
        b.batchId !== id ||
        !/^[a-f0-9]{64}$/.test(b.instance) ||
        !/^[a-f0-9]{64}$/.test(b.signature) ||
        (b.purpose !== undefined &&
          !['subscription', 'single-download'].includes(b.purpose)) ||
        !['queued', 'running', 'paused', 'completed', 'stopped'].includes(
          b.state,
        ) ||
        ![b.createdAt, b.updatedAt, b.nextSubmissionAt].every(
          Number.isSafeInteger,
        ) ||
        !Array.isArray(b.items) ||
        !b.items.length ||
        b.items.length > 20
      )
        throw new Error('BATCH_INVALID');
      b.items.forEach((item, index) => {
        if (
          item.index !== index ||
          ![
            'queued',
            'submitting',
            'waiting',
            'succeeded',
            'failed',
            'blocked',
            'cancelled',
            'skipped',
          ].includes(item.state) ||
          typeof item.message !== 'string' ||
          item.message.length > 300 ||
          (item.taskId !== undefined && !/^[a-f0-9]{64}$/.test(item.taskId)) ||
          (item.feedId !== undefined &&
            !/^MP_WXS_\d{5,15}$/.test(item.feedId)) ||
          (item.bodyReady !== undefined &&
            typeof item.bodyReady !== 'boolean') ||
          (item.articleUrl !== undefined &&
            subscriptionArticleUrl(item.articleUrl) !== item.articleUrl) ||
          (['queued', 'submitting', 'waiting'].includes(item.state) &&
            !item.articleUrl)
        )
          throw new Error('BATCH_INVALID');
      });
      return b;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  private async write(b: Batch) {
    b.updatedAt = this.now();
    const file = path.join(await this.storage(), b.batchId + '.json');
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      const h = await fs.open(temp, 'wx', 0o600);
      try {
        await h.writeFile(JSON.stringify(b));
        await h.sync();
      } finally {
        await h.close();
      }
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  private async records() {
    const names = (await fs.readdir(await this.storage())).filter((n) =>
      /^[a-f0-9-]{36}\.json$/.test(n),
    );
    if (names.length > 1000) throw new Error('BATCH_LIMIT');
    const result: Batch[] = [];
    for (const n of names) {
      try {
        const b = await this.read(n.slice(0, -5));
        if (b) result.push(b);
      } catch {
        console.warn('[WECHAT2RSS_BATCH_INVALID]');
      }
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }
  async list() {
    return (await this.records())
      .sort(
        (a, b) =>
          Number(live(b)) - Number(live(a)) || b.createdAt - a.createdAt,
      )
      .slice(0, 100)
      .map(view);
  }
  async enqueue(
    urls: string[],
    purpose: 'subscription' | 'single-download' = 'subscription',
  ) {
    if (this.accepting) throw new Error('BATCH_BUSY');
    this.accepting = true;
    try {
      if (!urls.length || urls.length > 20) throw new Error('BATCH_INVALID');
      const seen = new Set<string>();
      const items: Item[] = urls.map((raw, index) => {
        let articleUrl: string;
        try {
          articleUrl = subscriptionArticleUrl(raw);
        } catch {
          return {
            index,
            state: 'failed',
            message: '链接格式无效，未提交；其余有效链接继续处理。',
          };
        }
        if (seen.has(articleUrl))
          return {
            index,
            state: 'skipped',
            message: '重复链接已跳过，未重复提交。',
          };
        seen.add(articleUrl);
        return {
          index,
          articleUrl,
          state: 'queued',
          message: '等待串行处理。',
        };
      });
      const signature = hash(
        JSON.stringify([purpose, items.map((i) => i.articleUrl || i.state)]),
      );
      const records = await this.records();
      const same = records.find((b) => live(b) && b.signature === signature);
      if (same) return view(same);
      if (records.some(live)) throw new Error('BATCH_BUSY');
      const b: Batch = {
        version: 1,
        batchId: randomUUID(),
        instance: hash(this.instance()),
        signature,
        purpose,
        createdAt: this.now(),
        updatedAt: this.now(),
        nextSubmissionAt: Math.max(
          this.now(),
          ...records.map((record) => record.nextSubmissionAt),
        ),
        state: items.some((i) => i.state === 'queued') ? 'queued' : 'completed',
        items,
      };
      await this.write(b);
      this.schedule();
      return view(b);
    } finally {
      this.accepting = false;
    }
  }
  async stop(id: string) {
    const b = await this.read(id);
    if (!b) return null;
    if (!live(b)) return view(b);
    b.state = 'stopped';
    for (const item of b.items)
      if (item.state === 'queued') {
        item.state = 'cancelled';
        item.message = '剩余请求已停止，未发送。';
      }
    await this.write(b);
    return view(b);
  }
  async resume(id: string) {
    const b = await this.read(id);
    if (!b || b.state !== 'paused') return b ? view(b) : null;
    if (b.instance !== hash(this.instance()))
      throw new Error('BATCH_INSTANCE_CHANGED');
    for (const item of b.items)
      if (['failed', 'blocked'].includes(item.state) && item.articleUrl) {
        if (item.taskId) {
          await this.resumeTask(item.taskId);
          item.state = 'waiting';
        } else item.state = 'queued';
        item.message = '已恢复检查；已有回执不会重新提交新增。';
        break;
      }
    b.state = 'running';
    await this.write(b);
    this.schedule();
    return view(b);
  }
  async snapshot(backupFile: string) {
    const target = path.join(
      path.dirname(backupFile),
      '.wechat2rss-subscription-batches',
    );
    await fs.mkdir(target, { recursive: true });
    for (const b of await this.records())
      await fs.copyFile(
        path.join(await this.storage(), b.batchId + '.json'),
        path.join(target, b.batchId + '.json'),
      );
    await this.consumer?.snapshot?.(backupFile);
  }
  async init() {
    this.stopped = false;
    this.initialized = true;
    if (
      (await this.records()).some((b) =>
        ['queued', 'running'].includes(b.state),
      ) ||
      (await this.consumer?.hasPending())
    )
      this.schedule();
  }
  private schedule() {
    if (!this.initialized || this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDue().catch(() =>
        console.warn('[WECHAT2RSS_BATCH_STOPPED]'),
      );
    }, 5000);
    this.timer.unref();
  }
  async runDue() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.consumer?.runDue();
      if (this.stopped) return;
      const b = (await this.records()).find((b) =>
        ['queued', 'running'].includes(b.state),
      );
      if (!b) return;
      if (b.instance !== hash(this.instance())) {
        b.state = 'paused';
        await this.write(b);
        return;
      }
      // A completed body's metadata task can still detect a later restriction.
      // Pause unsent requests rather than advancing behind that failed check.
      for (const prior of b.items)
        if (prior.taskId && prior.state === 'succeeded') {
          const status = await this.task(prior.taskId);
          if (status?.state === 'blocked') {
            Object.assign(prior, status);
            b.state = 'paused';
            await this.write(b);
            return;
          }
        }
      const item = b.items.find((i) =>
        ['submitting', 'waiting', 'queued'].includes(i.state),
      );
      if (!item) {
        b.state = 'completed';
        await this.write(b);
        return;
      }
      let result: BatchOutcome | null;
      if (item.state === 'waiting') {
        result = item.taskId ? await this.task(item.taskId) : null;
        if (!result)
          result = {
            state: 'failed',
            message: '接续记录缺失，队列暂停；不会重发新增。',
          };
      } else {
        if (item.state === 'queued' && b.nextSubmissionAt > this.now()) return;
        item.state = 'submitting';
        b.state = 'running';
        b.nextSubmissionAt = this.now() + 30000;
        await this.write(b); // Includes all unsent URLs before the first upstream call.
        try {
          result = await this.submit(item.articleUrl!, b.purpose);
        } catch {
          result = {
            state: 'failed',
            message: '请求未完成，队列已暂停；请检查状态后继续。',
          };
        }
      }
      if (this.stopped) return; // Preserve in-flight disk state for guarded recovery.
      const current = await this.read(b.batchId);
      if (!current) return;
      Object.assign(current.items[item.index], result);
      if (result.bodyReady && ['waiting', 'succeeded'].includes(result.state))
        current.items[item.index].state = 'succeeded';
      if (
        ['failed', 'blocked'].includes(current.items[item.index].state) &&
        current.state !== 'stopped'
      )
        current.state = 'paused';
      else if (current.state !== 'stopped')
        current.state = current.items.some((i) =>
          ['queued', 'submitting', 'waiting'].includes(i.state),
        )
          ? 'running'
          : 'completed';
      await this.write(current);
    } finally {
      this.busy = false;
      if (
        !this.stopped &&
        ((await this.records()).some((b) =>
          ['queued', 'running'].includes(b.state),
        ) ||
          (await this.consumer?.hasPending()))
      )
        this.schedule();
    }
  }
  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
