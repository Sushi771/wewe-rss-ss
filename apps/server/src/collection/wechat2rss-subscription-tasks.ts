import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { subscriptionArticleUrl } from './subscription-add';
import { CacheFailureReason, cacheFailureReasons } from './cache-failure';

type TaskState = 'pending' | 'running' | 'succeeded' | 'blocked' | 'failed';
export type SubscriptionTaskCode =
  | 'SUBSCRIPTION_PAUSED'
  | 'CACHE_PENDING'
  | 'CACHE_READ_FAILED'
  | 'CACHE_IMAGES_PENDING'
  | 'LEGACY_IDENTITY_UNVERIFIED'
  | 'SOURCE_CHANGED';
export type SubscriptionTaskResult = {
  state: TaskState;
  phase: 'identity' | 'cache' | 'metadata';
  message: string;
  feedId?: string;
  listReady?: boolean;
  bodyReady?: boolean;
  imagePendingCount?: number;
  code?: SubscriptionTaskCode;
  failureReason?: CacheFailureReason;
};
export type SubscriptionTask = SubscriptionTaskResult & {
  version: 1;
  taskId: string;
  articleUrl: string;
  feedPath: string;
  instance: string;
  startedAt: number;
  /** The bounded read window starts when this serialized task first runs. */
  firstCheckAt?: number;
  deadline: number;
  nextCheckAt: number;
  attempts: number;
};
const pending = (state: TaskState) =>
  state === 'pending' || state === 'running';
const publicView = (task: SubscriptionTask) => ({
  taskId: task.taskId,
  state: task.state,
  phase: task.phase,
  message: task.message,
  feedId: task.feedId,
  listReady: task.listReady,
  bodyReady: task.bodyReady,
  imagePendingCount: task.imagePendingCount,
  code: task.code,
  failureReason: task.failureReason,
  startedAt: task.startedAt,
  deadline: task.deadline,
});
const key = (value: string) => createHash('sha256').update(value).digest('hex');
export const subscriptionTaskId = (input: string) => {
  const url = new URL(subscriptionArticleUrl(input));
  url.hash = '';
  url.searchParams.sort();
  return key(url.toString());
};

/** Durable continuation of an already accepted request. The runner must never
 * submit /addurl or /add. One task at a time; 30s spacing, ten checks, five minutes.
 * Persisted running tasks recover as reads after a restart, never as new adds.
 */
export class Wechat2RssSubscriptionTasks {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private directory?: string;
  private initialized = false;
  private mutations: Promise<unknown> = Promise.resolve();
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(run, run);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  constructor(
    private readonly database: () => string,
    private readonly instance: () => string,
    private readonly run: (
      task: SubscriptionTask,
    ) => Promise<SubscriptionTaskResult>,
    private readonly now: () => number = Date.now,
  ) {}

  private async storage() {
    if (this.directory) return this.directory;
    const database = await fs.realpath(this.database());
    const directory = path.join(
      path.dirname(database),
      '.wechat2rss-subscription-tasks',
    );
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.realpath(directory)) !== directory)
      throw new Error('SUBSCRIPTION_TASK_STORAGE_INVALID');
    this.directory = directory;
    return directory;
  }

  private async read(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error('SUBSCRIPTION_TASK_INVALID');
    const file = path.join(await this.storage(), id + '.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
        throw new Error('SUBSCRIPTION_TASK_INVALID');
      const task = JSON.parse(
        await fs.readFile(file, 'utf8'),
      ) as SubscriptionTask;
      const url = new URL(task.articleUrl);
      if (
        task.version !== 1 ||
        task.taskId !== id ||
        key(url.toString()) !== id ||
        url.protocol !== 'https:' ||
        url.hostname !== 'mp.weixin.qq.com' ||
        url.username ||
        url.password ||
        url.port ||
        subscriptionArticleUrl(task.articleUrl) !== task.articleUrl ||
        task.articleUrl.length > 4096 ||
        !/^\/s(?:\/[^/?#]+)?$/.test(url.pathname) ||
        !/^\/feed\/[A-Za-z0-9_-]+\.(?:xml|json)$/.test(task.feedPath) ||
        !/^[a-f0-9]{64}$/.test(task.instance) ||
        !['pending', 'running', 'succeeded', 'blocked', 'failed'].includes(
          task.state,
        ) ||
        !['identity', 'cache', 'metadata'].includes(task.phase) ||
        (task.listReady !== undefined && typeof task.listReady !== 'boolean') ||
        (task.bodyReady !== undefined && typeof task.bodyReady !== 'boolean') ||
        (task.imagePendingCount !== undefined &&
          (!Number.isSafeInteger(task.imagePendingCount) ||
            task.imagePendingCount < 0 ||
            task.imagePendingCount > 1000000)) ||
        (task.code !== undefined &&
          ![
            'SUBSCRIPTION_PAUSED',
            'CACHE_PENDING',
            'CACHE_READ_FAILED',
            'CACHE_IMAGES_PENDING',
            'LEGACY_IDENTITY_UNVERIFIED',
            'SOURCE_CHANGED',
          ].includes(task.code)) ||
        typeof task.message !== 'string' ||
        (task.failureReason !== undefined &&
          !cacheFailureReasons.includes(task.failureReason)) ||
        task.message.length > 300 ||
        (task.feedId !== undefined && !/^MP_WXS_\d{5,15}$/.test(task.feedId)) ||
        ![task.startedAt, task.deadline, task.nextCheckAt, task.attempts].every(
          Number.isSafeInteger,
        ) ||
        task.attempts < 0 ||
        task.attempts > 10 ||
        (task.firstCheckAt !== undefined &&
          (!Number.isSafeInteger(task.firstCheckAt) ||
            task.firstCheckAt < task.startedAt)) ||
        task.deadline - (task.firstCheckAt ?? task.startedAt) !== 300000
      )
        throw new Error('SUBSCRIPTION_TASK_INVALID');
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(task: SubscriptionTask) {
    const file = path.join(await this.storage(), task.taskId + '.json');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(task));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async list() {
    const names = (await fs.readdir(await this.storage())).filter((n) =>
      /^[a-f0-9]{64}\.json$/.test(n),
    );
    if (names.length > 1000) throw new Error('SUBSCRIPTION_TASK_LIMIT');
    const tasks: SubscriptionTask[] = [];
    for (const name of names) {
      try {
        const task = await this.read(name.slice(0, -5));
        if (task) tasks.push(task);
      } catch {
        console.warn('[WECHAT2RSS_TASK_INVALID]');
      }
    }
    return tasks
      .sort(
        (a, b) =>
          Number(pending(b.state)) - Number(pending(a.state)) ||
          b.startedAt - a.startedAt,
      )
      .slice(0, 100)
      .map(publicView);
  }

  async get(id: string) {
    const task = await this.read(id);
    return task ? publicView(task) : null;
  }

  async setResult(id: string, result: SubscriptionTaskResult) {
    return this.mutate(async () => {
      const task = await this.read(id);
      if (!task) throw new Error('SUBSCRIPTION_TASK_INVALID');
      delete task.code;
      delete task.failureReason;
      delete task.imagePendingCount;
      Object.assign(task, result);
      await this.write(task);
      return publicView(task);
    });
  }

  async snapshot(backupFile: string) {
    const directory = await this.storage();
    const target = path.join(
      path.dirname(backupFile),
      '.wechat2rss-subscription-tasks',
    );
    await fs.mkdir(target, { recursive: true });
    for (const name of await fs.readdir(directory)) {
      if (
        /^[a-f0-9]{64}\.json$/.test(name) &&
        (await this.read(name.slice(0, -5)))
      )
        await fs.copyFile(path.join(directory, name), path.join(target, name));
    }
  }

  async enqueue(input: {
    articleUrl: string;
    feedPath: string;
    feedId?: string;
    phase: 'identity' | 'cache' | 'metadata';
  }) {
    const url = new URL(subscriptionArticleUrl(input.articleUrl));
    url.hash = '';
    url.searchParams.sort();
    const articleUrl = url.toString(),
      taskId = key(articleUrl);
    const old = await this.read(taskId);
    if (old && pending(old.state)) {
      this.schedule();
      return publicView(old);
    }
    const startedAt = this.now();
    const task: SubscriptionTask = {
      ...input,
      articleUrl,
      taskId,
      version: 1,
      instance: key(this.instance()),
      state: 'pending',
      startedAt,
      firstCheckAt: undefined,
      code: undefined,
      failureReason: undefined,
      imagePendingCount: undefined,
      deadline: startedAt + 300000,
      nextCheckAt: startedAt + 30000,
      attempts: 0,
      message: '请求已受理，正在自动等待订阅和文章；关闭弹窗后仍会继续。',
    };
    await this.write(task);
    this.schedule();
    return publicView(task);
  }

  async resume(id: string) {
    const task = await this.read(id);
    if (!task) return null;
    if (
      pending(task.state) ||
      (task.state === 'succeeded' && task.code !== 'CACHE_IMAGES_PENDING')
    )
      return publicView(task);
    return this.enqueue(task);
  }

  async init() {
    this.stopped = false;
    this.initialized = true;
    // Validate persisted records before scheduling; no network on construction.
    if ((await this.list()).some((task) => pending(task.state)))
      this.schedule();
  }

  private schedule() {
    if (!this.initialized || this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDue().catch(() => console.warn('[WECHAT2RSS_TASK_STOPPED]'));
    }, 30000);
    this.timer.unref();
  }

  async runDue() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const views = await this.list();
      const tasks: SubscriptionTask[] = [];
      for (const item of views) {
        if (pending(item.state)) {
          const task = await this.read(item.taskId);
          if (task) tasks.push(task);
        }
      }
      for (const task of tasks.sort((a, b) => a.nextCheckAt - b.nextCheckAt)) {
        if (
          (task.attempts > 0 && this.now() >= task.deadline) ||
          task.attempts >= 10
        ) {
          task.state = 'failed';
          task.message = task.bodyReady
            ? '文章正文与图片已入库，公众号信息等待已结束；可继续核对名称，不会重新添加。'
            : '自动等待已结束，订阅或文章仍未就绪；请检查账号状态后继续检查，不会重新添加。';
          await this.write(task);
          continue;
        }
        if (task.instance !== key(this.instance())) {
          task.state = 'failed';
          task.message = '实例配置已变化，本次接续停止；原请求保留。';
          await this.write(task);
          continue;
        }
        if (task.nextCheckAt > this.now()) continue;
        const started = await this.mutate(async () => {
          const current = await this.read(task.taskId);
          if (
            !current ||
            !pending(current.state) ||
            current.nextCheckAt > this.now()
          )
            return false;
          current.state = 'running';
          if (current.attempts === 0) {
            current.firstCheckAt = this.now();
            current.deadline = current.firstCheckAt + 300000;
          }
          current.attempts++;
          current.nextCheckAt = this.now() + 30000;
          await this.write(current);
          Object.assign(task, current);
          return true;
        });
        if (!started) continue;
        let result: SubscriptionTaskResult;
        try {
          result = await this.run(task);
        } catch {
          result = {
            state: 'failed',
            phase: task.phase,
            message:
              '接续读取失败，已停止；请检查实例和账号状态，不会重新添加。',
          };
        }
        if (this.stopped) return; // Leave running on disk for restart recovery.
        await this.mutate(async () => {
          const current = await this.read(task.taskId);
          // A foreground completion or phase change owns the newer result.
          if (
            !current ||
            current.state !== 'running' ||
            current.attempts !== task.attempts ||
            current.phase !== task.phase ||
            current.feedId !== task.feedId
          )
            return;
          delete current.code;
          delete current.failureReason;
          delete current.imagePendingCount;
          Object.assign(current, result);
          await this.write(current);
        });
        break; // One serialized task per wake; never fan out upstream reads.
      }
    } finally {
      this.busy = false;
      if (
        !this.stopped &&
        (await this.list()).some((task) => pending(task.state))
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
