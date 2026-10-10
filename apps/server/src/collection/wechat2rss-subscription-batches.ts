import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { subscriptionArticleUrl } from './subscription-add';
import type { SubscriptionTaskCode } from './wechat2rss-subscription-tasks';

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
  imagePendingCount?: number;
  listReady?: boolean;
  code?: SubscriptionTaskCode;
  phase?: 'identity' | 'cache' | 'metadata';
  accepted?: boolean;
};
type Item = Omit<BatchOutcome, 'state'> & {
  index: number;
  articleUrl?: string;
  state: ItemState;
  refreshChecks?: number;
  refreshAfter?: number;
};
type Batch = {
  version: 1;
  batchId: string;
  instance: string;
  signature: string;
  purpose?: 'subscription' | 'single-download' | 'manual-refresh';
  intentKey?: string;
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
  purpose: b.purpose || 'subscription',
  intentKey: b.intentKey,
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
    imagePendingCount: item.imagePendingCount,
    accepted: item.accepted ?? !!item.taskId,
    listReady: item.listReady,
    code: item.code,
    metadataPending: false,
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
  private refreshAcceptance?: Promise<
    ReturnType<typeof view> & { reused: boolean }
  >;
  private timer?: NodeJS.Timeout;
  private consumer?: {
    hasPending(): Promise<boolean>;
    runDue(): Promise<void>;
    snapshot?(backupFile: string): Promise<void>;
  };
  private refresh?: (
    feedId: string,
    stage: 'submit' | 'cache',
  ) => Promise<BatchOutcome>;

  /** Manual refresh shares the existing serial scheduler and durable records. */
  attachRefresh(
    run: (feedId: string, stage: 'submit' | 'cache') => Promise<BatchOutcome>,
  ) {
    if (this.refresh) throw new Error('BATCH_REFRESH_EXISTS');
    this.refresh = run;
  }

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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 500000)
        throw new Error('BATCH_INVALID');
      const b = JSON.parse(await fs.readFile(file, 'utf8')) as Batch;
      if (
        (b.purpose !== 'manual-refresh' && stat.size > 100000) ||
        b.version !== 1 ||
        b.batchId !== id ||
        !/^[a-f0-9]{64}$/.test(b.instance) ||
        !/^[a-f0-9]{64}$/.test(b.signature) ||
        (b.purpose !== undefined &&
          !['subscription', 'single-download', 'manual-refresh'].includes(
            b.purpose,
          )) ||
        !['queued', 'running', 'paused', 'completed', 'stopped'].includes(
          b.state,
        ) ||
        ![b.createdAt, b.updatedAt, b.nextSubmissionAt].every(
          Number.isSafeInteger,
        ) ||
        (b.intentKey !== undefined &&
          (b.purpose !== 'manual-refresh' ||
            !/^[a-f0-9]{64}$/.test(b.intentKey))) ||
        !Array.isArray(b.items) ||
        !b.items.length ||
        b.items.length > (b.purpose === 'manual-refresh' ? 1000 : 20)
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
          (item.imagePendingCount !== undefined &&
            (!Number.isSafeInteger(item.imagePendingCount) ||
              item.imagePendingCount < 0 ||
              item.imagePendingCount > 1000000)) ||
          (item.accepted !== undefined && typeof item.accepted !== 'boolean') ||
          (item.articleUrl !== undefined &&
            subscriptionArticleUrl(item.articleUrl) !== item.articleUrl) ||
          (b.purpose === 'manual-refresh' &&
            (!item.feedId || item.articleUrl || item.taskId)) ||
          (item.refreshChecks !== undefined &&
            (!Number.isSafeInteger(item.refreshChecks) ||
              item.refreshChecks < 0 ||
              item.refreshChecks > 10)) ||
          (item.refreshAfter !== undefined &&
            !Number.isSafeInteger(item.refreshAfter)) ||
          (b.purpose !== 'manual-refresh' &&
            ['queued', 'submitting', 'waiting'].includes(item.state) &&
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
    const batches = (await this.records())
      .sort(
        (a, b) =>
          Number(live(b)) - Number(live(a)) || b.createdAt - a.createdAt,
      )
      .slice(0, 100)
      .map(view);
    // Read the latest durable continuation, including metadata after a batch
    // completed. This projection never resumes a stopped batch or submits work.
    for (const batch of batches) {
      for (const item of batch.items) {
        if (!item.taskId || ['cancelled', 'skipped'].includes(item.state))
          continue;
        const latest = await this.task(item.taskId);
        if (!latest || (item.feedId && latest.feedId !== item.feedId)) continue;
        item.feedId = latest.feedId;
        item.bodyReady = latest.bodyReady;
        item.imagePendingCount = latest.imagePendingCount;
        item.listReady = latest.listReady;
        item.code = latest.code;
        item.message = latest.message;
        item.metadataPending =
          latest.phase === 'metadata' && latest.state === 'waiting';
        item.state =
          latest.bodyReady && latest.state === 'waiting'
            ? 'succeeded'
            : latest.state;
      }
      if (
        batch.state !== 'stopped' &&
        batch.items.length &&
        batch.items.every((item) => item.state === 'succeeded')
      )
        batch.state = 'completed';
    }
    return batches;
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
  async enqueueRefresh(feedIds: string[], intentKey?: string) {
    if (this.refreshAcceptance)
      return { ...(await this.refreshAcceptance), reused: true };
    const pending = this.acceptRefresh(feedIds, intentKey);
    this.refreshAcceptance = pending;
    try {
      return await pending;
    } finally {
      this.refreshAcceptance = undefined;
    }
  }
  private async acceptRefresh(feedIds: string[], intentKey?: string) {
    if (this.accepting) throw new Error('BATCH_BUSY');
    this.accepting = true;
    try {
      if (
        !this.refresh ||
        !feedIds.length ||
        feedIds.length > 1000 ||
        feedIds.some((id) => !/^MP_WXS_\d{5,15}$/.test(id))
      )
        throw new Error('BATCH_INVALID');
      const records = await this.records();
      if (intentKey !== undefined && !/^[a-f0-9]{64}$/.test(intentKey))
        throw new Error('BATCH_INVALID');
      const original =
        intentKey &&
        records.find(
          (b) => b.purpose === 'manual-refresh' && b.intentKey === intentKey,
        );
      if (original) return { ...view(original), reused: true };
      // A repeated overview click rejoins the existing request even if order changed.
      const same = records.find(
        (b) => live(b) && b.purpose === 'manual-refresh',
      );
      if (same) return { ...view(same), reused: true };
      if (records.some(live)) throw new Error('BATCH_BUSY');
      const ids = [...new Set(feedIds)];
      const b: Batch = {
        version: 1,
        batchId: randomUUID(),
        instance: hash(this.instance()),
        signature: hash(JSON.stringify(['manual-refresh', [...ids].sort()])),
        purpose: 'manual-refresh',
        intentKey,
        createdAt: this.now(),
        updatedAt: this.now(),
        nextSubmissionAt: Math.max(
          this.now(),
          ...records.map((record) => record.nextSubmissionAt),
        ),
        state: 'queued',
        items: ids.map((feedId, index) => ({
          index,
          feedId,
          state: 'queued',
          accepted: false,
          message: '等待串行提交上游更新。',
        })),
      };
      await this.write(b);
      this.schedule();
      return { ...view(b), reused: false };
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
    if (b.purpose === 'manual-refresh') {
      // Never turn an interrupted/unknown /add into another submission.
      // Only cache reads of a confirmed accepted request may be resumed.
      for (const item of b.items)
        if (['failed', 'blocked'].includes(item.state) && item.accepted) {
          item.state = 'waiting';
          item.refreshChecks = 0;
          item.refreshAfter = this.now();
          item.message = '已恢复缓存检查；不会再次提交上游更新。';
        }
      if (
        b.items.some(
          (i) =>
            ['failed', 'blocked', 'submitting'].includes(i.state) &&
            !i.accepted,
        )
      )
        return view(b);
      b.state = 'running';
      await this.write(b);
      this.schedule();
      return view(b);
    }
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
      (await this.records()).some(
        (b) =>
          ['queued', 'running'].includes(b.state) ||
          (b.purpose === 'manual-refresh' &&
            b.state === 'stopped' &&
            b.items.some((item) =>
              ['waiting', 'submitting'].includes(item.state),
            )),
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
      const b = (await this.records()).find(
        (b) =>
          ['queued', 'running'].includes(b.state) ||
          (b.purpose === 'manual-refresh' &&
            b.state === 'stopped' &&
            b.items.some((item) =>
              ['waiting', 'submitting'].includes(item.state),
            )),
      );
      if (!b) return;
      if (b.instance !== hash(this.instance())) {
        b.state = 'paused';
        await this.write(b);
        return;
      }
      if (b.purpose === 'manual-refresh') {
        await this.runRefresh(b);
        return;
      }
      // Accepted cache work is independent of later serial submissions. Each
      // new submission still checks the account and keeps its one-shot receipt.
      for (const prior of b.items)
        if (prior.taskId && prior.state !== 'cancelled') {
          const status = await this.task(prior.taskId);
          if (status) {
            Object.assign(prior, status);
            prior.accepted = true;
            if (status.bodyReady && status.state === 'waiting')
              prior.state = 'succeeded';
          }
        }
      const item = b.items.find((i) =>
        ['submitting', 'queued'].includes(i.state),
      );
      if (b.items.some((prior) => prior.state === 'waiting' && !prior.taskId)) {
        b.state = 'paused';
        await this.write(b);
        return;
      }
      if (!item) {
        b.state = b.items.some((item) => item.state === 'waiting')
          ? 'running'
          : 'completed';
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
        b.nextSubmissionAt = this.now() + 5000;
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
        (['failed', 'blocked'].includes(current.items[item.index].state) ||
          (result.state === 'waiting' && !result.taskId)) &&
        !result.taskId &&
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
        ((await this.records()).some(
          (b) =>
            ['queued', 'running'].includes(b.state) ||
            (b.purpose === 'manual-refresh' &&
              b.state === 'stopped' &&
              b.items.some((item) =>
                ['waiting', 'submitting'].includes(item.state),
              )),
        ) ||
          (await this.consumer?.hasPending()))
      )
        this.schedule();
    }
  }
  private async runRefresh(b: Batch) {
    const unknown = b.items.find((i) => i.state === 'submitting');
    if (unknown) {
      unknown.state = 'blocked';
      unknown.accepted = false;
      unknown.message =
        '上游提交回执未确认，已暂停；不会自动重发，请核对原请求。';
      if (b.state !== 'stopped') b.state = 'paused';
      await this.write(b);
      return;
    }
    const item =
      b.items.find(
        (i) => i.state === 'queued' && b.nextSubmissionAt <= this.now(),
      ) ||
      b.items.find(
        (i) => i.state === 'waiting' && (i.refreshAfter || 0) <= this.now(),
      );
    if (!item || !this.refresh) return;
    const stage = item.state === 'queued' ? 'submit' : 'cache';
    if (stage === 'submit') {
      item.state = 'submitting';
      b.state = 'running';
      b.nextSubmissionAt = this.now() + 30000;
      await this.write(b); // Reserve exactly once before an /add can leave the process.
    }
    let result: BatchOutcome;
    try {
      result = await this.refresh(item.feedId!, stage);
    } catch {
      result = {
        state: 'blocked',
        accepted: stage === 'cache',
        message:
          stage === 'submit'
            ? '上游更新回执未确认，已暂停；不会自动重发。'
            : '缓存检查失败，已暂停；上游请求不会重发。',
      };
    }
    if (this.stopped) return;
    const current = await this.read(b.batchId);
    if (!current) return;
    const target = current.items[item.index];
    Object.assign(target, result);
    target.refreshChecks =
      stage === 'cache' ? (target.refreshChecks || 0) + 1 : 0;
    target.refreshAfter = this.now() + 30000;
    if (target.state === 'waiting' && target.refreshChecks >= 10) {
      target.state = 'blocked';
      target.message =
        '上游已受理，缓存同步仍未就绪；已停止检查，已有内容保留。';
    }
    if (current.state !== 'stopped')
      current.state = ['blocked', 'failed'].includes(target.state)
        ? 'paused'
        : current.items.some((i) =>
              ['queued', 'waiting', 'submitting'].includes(i.state),
            )
          ? 'running'
          : 'completed';
    await this.write(current);
  }
  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
