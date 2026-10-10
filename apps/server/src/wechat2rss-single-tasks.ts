import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { ArticleDownloadError, downloadArticleUrl } from './article-download';
import {
  LocalArticleStore,
  validateLocalDirectory,
} from './article-local-save';
import { prepareWechat2RssSingleDownload } from './wechat2rss-single-download';
import { readWechat2RssSingleCandidates } from './wechat2rss-single-candidates';
import { canonicalArticleUrl } from './collection/collection-format';

type State =
  | 'waiting'
  | 'saving'
  | 'saved'
  | 'blocked'
  | 'failed'
  | 'cancelled';
type Saved = Awaited<ReturnType<LocalArticleStore['save']>>;
type Prepare = Awaited<ReturnType<typeof prepareWechat2RssSingleDownload>>;
type Task = {
  version: 1;
  revision: number;
  taskId: string;
  owner: string;
  instance: string;
  url: string;
  directory: string;
  state: State;
  message: string;
  startedAt: number;
  deadline: number;
  nextCheckAt: number;
  attempts: number;
  batchId?: string;
  feedId?: string;
  code?: string;
  selected?: Awaited<ReturnType<typeof readWechat2RssSingleCandidates>>[number];
  result?: Saved;
};
type Batch = {
  batchId: string;
  state: string;
  updatedAt?: number;
  items: Array<{
    state: string;
    feedId?: string;
    bodyReady?: boolean;
    articleUrl?: string;
    articleUrlHash?: string;
  }>;
};
export type SingleDownloadQueue = {
  addSingleDownloadBatch(urls: string[]): Promise<unknown>;
  subscriptionBatchList(): Promise<unknown>;
  stopSubscriptionBatch(id: string): Promise<unknown>;
  resumeSubscriptionBatch(id: string): Promise<unknown>;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const active = (t: Task) => ['waiting', 'saving'].includes(t.state);
const unavailable = () =>
  new ArticleDownloadError('下载任务不可用。', 404, {
    code: 'SINGLE_TASK_UNAVAILABLE',
  });
const view = (t: Task) => ({
  revision: t.revision,
  taskId: t.taskId,
  state: t.state,
  message: t.message,
  startedAt: t.startedAt,
  deadline: t.deadline,
  destination: t.directory,
  ...(t.feedId ? { feedId: t.feedId } : {}),
  ...(t.code ? { code: t.code } : {}),
  ...(t.selected
    ? {
        selectedArticle: {
          articleId: t.selected.articleId,
          title: t.selected.title,
          publishTime: t.selected.publishTime,
        },
      }
    : {}),
  ...(t.result
    ? { saved: true, ...t.result, contentSource: 'wechat2rss-cache' as const }
    : {}),
});
export const singleCachePending = (error: unknown) =>
  error instanceof ArticleDownloadError &&
  [
    'WECHAT2RSS_SINGLE_NOT_SUBSCRIBED',
    'WECHAT2RSS_SINGLE_CACHE_MISS',
    'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
    'WECHAT2RSS_SINGLE_BODY_MISSING',
  ].includes(error.diagnostic?.code || '');

/** Private download continuations, driven ONLY by the existing subscription
 * queue's consumer hook. No timer, independent /addurl request or page fetch.
 * The original native directory and owner remain fixed across restarts. */
export class Wechat2RssSingleTasks {
  private directory?: string;
  private busy = false;
  private stopped = false;
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly database: () => string,
    private readonly instance: () => string,
    private readonly queue: SingleDownloadQueue,
    private readonly save: (
      prepare: Prepare,
      directory: string,
      startedAt: number,
    ) => Promise<Saved>,
    private readonly canRun: () => boolean = () => true,
    private readonly now: () => number = Date.now,
    private readonly prepare: typeof prepareWechat2RssSingleDownload = prepareWechat2RssSingleDownload,
    private readonly readCandidates: typeof readWechat2RssSingleCandidates = readWechat2RssSingleCandidates,
  ) {}

  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(run, run);
    this.mutations = result.catch(() => undefined);
    return result;
  }
  private async storage() {
    if (this.directory) return this.directory;
    const database = await fs.realpath(this.database());
    const directory = join(dirname(database), '.wechat2rss-single-downloads');
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.realpath(directory)) !== directory) throw unavailable();
    this.directory = directory;
    return directory;
  }
  private id(url: string, owner: string, directory: string) {
    return hash(JSON.stringify([url, owner, directory]));
  }
  private async read(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw unavailable();
    try {
      const file = join(await this.storage(), id + '.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000)
        throw unavailable();
      const t = JSON.parse(await fs.readFile(file, 'utf8')) as Task;
      if (
        t.version !== 1 ||
        !Number.isSafeInteger(t.revision) ||
        t.revision < 1 ||
        t.taskId !== id ||
        !/^[a-f0-9]{64}$/.test(t.owner) ||
        !/^[a-f0-9]{64}$/.test(t.instance) ||
        downloadArticleUrl(t.url) !== t.url ||
        this.id(t.url, t.owner, t.directory) !== id ||
        ![
          'waiting',
          'saving',
          'saved',
          'blocked',
          'failed',
          'cancelled',
        ].includes(t.state) ||
        typeof t.message !== 'string' ||
        t.message.length > 400 ||
        ![t.startedAt, t.deadline, t.nextCheckAt, t.attempts].every(
          Number.isSafeInteger,
        ) ||
        t.attempts < 0 ||
        t.attempts > 10 ||
        t.deadline - t.startedAt !== 900000 ||
        (t.batchId !== undefined && !/^[a-f0-9-]{36}$/.test(t.batchId)) ||
        (t.feedId !== undefined && !/^MP_WXS_\d{5,15}$/.test(t.feedId)) ||
        (t.code !== undefined &&
          !/^(?:WECHAT2RSS_|SINGLE_)[A-Z_]{1,65}$/.test(t.code))
      )
        throw unavailable();
      await validateLocalDirectory(t.directory);
      if (t.selected) {
        const identity = canonicalArticleUrl(
          downloadArticleUrl(t.selected.url),
        );
        if (
          identity.id !== t.selected.articleId ||
          identity.mpId !== t.feedId ||
          typeof t.selected.title !== 'string' ||
          !t.selected.title.trim() ||
          t.selected.title.length > 1000 ||
          !Number.isSafeInteger(t.selected.publishTime) ||
          t.selected.publishTime <= 0
        )
          throw unavailable();
      }
      if (
        t.result &&
        (t.state !== 'saved' ||
          typeof t.result.markdownPath !== 'string' ||
          typeof t.result.directory !== 'string' ||
          !relative(t.directory, t.result.directory) ||
          relative(t.directory, t.result.directory).startsWith('..') ||
          isAbsolute(relative(t.directory, t.result.directory)) ||
          dirname(t.result.markdownPath) !== t.result.directory ||
          extname(t.result.markdownPath).toLowerCase() !== '.md')
      )
        throw unavailable();
      return t;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw unavailable();
    }
  }
  private async write(t: Task) {
    t.revision++;
    const file = join(await this.storage(), t.taskId + '.json');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(t));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  private async records() {
    const names = (await fs.readdir(await this.storage())).filter((n) =>
      /^[a-f0-9]{64}\.json$/.test(n),
    );
    if (names.length > 1000) throw unavailable();
    const tasks: Task[] = [];
    for (const name of names) {
      try {
        const task = await this.read(name.slice(0, -5));
        if (task) tasks.push(task);
      } catch {
        console.warn('[WECHAT2RSS_SINGLE_TASK_INVALID]');
      }
    }
    return tasks;
  }
  async enqueue(raw: unknown, owner: string, directory: string) {
    return this.mutate(async () => {
      const url = downloadArticleUrl(raw);
      if (!/^[a-f0-9]{64}$/.test(owner)) throw unavailable();
      directory = await validateLocalDirectory(directory);
      const taskId = this.id(url, owner, directory);
      const old = await this.read(taskId);
      if (old && old.state !== 'cancelled') return view(old);
      const startedAt = this.now();
      const t: Task = {
        version: 1,
        revision: old?.revision || 0,
        taskId,
        owner,
        url,
        directory,
        instance: hash(this.instance()),
        state: 'waiting',
        message:
          '正在等待 Wechat2RSS；需要时会订阅该公众号，正文就绪后自动保存。',
        startedAt,
        deadline: startedAt + 900000,
        nextCheckAt: startedAt,
        attempts: 0,
      };
      await this.write(t); // Persist intent before the shared queue accepts it.
      return view(t);
    });
  }
  async list(owner: string) {
    const tasks = (await this.records())
      .filter((t) => t.owner === owner)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 20);
    return Promise.all(tasks.map((t) => this.display(t)));
  }
  private async display(t: Task) {
    const result = view(t);
    // Derive publisher and current batch revision from the original redacted
    // receipt. Older records remain usable without rewriting their intent.
    if (t.batchId) {
      try {
        const receipt = await this.receipt(t);
        const feedId = receipt?.item.feedId;
        if (feedId && /^MP_WXS_\d{5,15}$/.test(feedId)) result.feedId = feedId;
        return {
          ...result,
          ...(receipt
            ? {
                batchState: receipt.batch.state,
                batchUpdatedAt: receipt.batch.updatedAt,
              }
            : {}),
        };
      } catch {
        /* A missing local receipt does not authorize a new request. */
      }
    }
    return result;
  }
  private async receipt(t: Task) {
    const batches = (await this.queue.subscriptionBatchList()) as Batch[];
    const batch = Array.isArray(batches)
      ? batches.find((b) => b.batchId === t.batchId)
      : undefined;
    const item = batch?.items?.[0];
    return item && item.articleUrlHash === hash(t.url)
      ? { batch: batch!, item }
      : undefined;
  }
  async get(id: string, owner: string) {
    const t = await this.read(id);
    if (!t || t.owner !== owner) throw unavailable();
    return this.display(t);
  }
  async hasPending() {
    return !this.stopped && (await this.records()).some(active);
  }
  private async candidateContext(id: string, owner: string) {
    const t = await this.read(id);
    if (!t || t.owner !== owner) throw unavailable();
    if (t.instance !== hash(this.instance()))
      throw new ArticleDownloadError(
        '来源实例已变化，不能使用原任务选择文章。',
        409,
      );
    if (!['blocked', 'failed', 'saved'].includes(t.state))
      throw new ArticleDownloadError(
        '请先等待下载结果；已取消的任务不能选择文章。',
        409,
      );
    const item = (await this.receipt(t))?.item;
    if (!item || !/^MP_WXS_\d{5,15}$/.test(item.feedId || ''))
      throw new ArticleDownloadError(
        '原任务没有可核验的公众号回执，不能选择其他文章。',
        409,
      );
    return { task: t, feedId: item.feedId! };
  }
  async candidates(id: string, owner: string) {
    const context = await this.candidateContext(id, owner);
    const articles = await this.readCandidates(context.feedId);
    // No signed URL or body is exposed; a selection sends only the stable ID.
    return {
      taskId: id,
      destination: context.task.directory,
      articles: articles.map(({ articleId, title, publishTime }) => ({
        articleId,
        title,
        publishTime,
      })),
    };
  }
  async select(id: string, owner: string, articleId: unknown) {
    if (
      typeof articleId !== 'string' ||
      !/^WX_\d{5,15}_\d+_[1-9]\d*$/.test(articleId)
    )
      throw new ArticleDownloadError('请选择列表中的一篇文章。', 400);
    const context = await this.candidateContext(id, owner);
    if (context.task.state === 'saved') {
      if (context.task.selected?.articleId === articleId)
        return view(context.task);
      throw new ArticleDownloadError('原任务已经保存，请新建下载。', 409);
    }
    // Re-read existing upstream cache. Never trust a frontend URL/publisher or
    // turn a vanished candidate into a subscription or original-page request.
    const selected = (await this.readCandidates(context.feedId)).find(
      (a) => a.articleId === articleId,
    );
    if (!selected)
      throw new ArticleDownloadError(
        '所选文章已不在当前可验证缓存，请重新选择。',
        409,
      );
    return this.mutate(async () => {
      const t = await this.read(id);
      if (!t || t.owner !== owner) throw unavailable();
      if (
        t.revision !== context.task.revision ||
        !['failed', 'blocked'].includes(t.state)
      )
        throw new ArticleDownloadError('下载状态已变化，请重新读取。', 409);
      t.selected = selected;
      t.feedId = context.feedId;
      t.state = 'waiting';
      t.startedAt = this.now();
      t.deadline = t.startedAt + 900000;
      t.nextCheckAt = this.now();
      t.attempts = 0;
      delete t.code;
      t.message = '已确认所选缓存文章，正在保存到原任务目录。';
      await this.write(t);
      return view(t);
    });
  }
  async snapshot(backupFile: string) {
    const target = join(dirname(backupFile), '.wechat2rss-single-downloads');
    await fs.mkdir(target, { recursive: true });
    for (const task of await this.records())
      await fs.copyFile(
        join(await this.storage(), task.taskId + '.json'),
        join(target, task.taskId + '.json'),
      );
  }
  async cancel(id: string, owner: string) {
    const t = await this.mutate(async () => {
      const t = await this.read(id);
      if (!t || t.owner !== owner) throw unavailable();
      if (t.state === 'saving')
        throw new ArticleDownloadError('正在落盘，请等待保存结果。', 409);
      if (t.state !== 'saved') {
        t.state = 'cancelled';
        t.message = '下载已取消。已受理的公众号订阅会保留。';
        await this.write(t);
      }
      return t;
    });
    if (t.state === 'cancelled' && t.batchId)
      await this.queue.stopSubscriptionBatch(t.batchId);
    return view(t);
  }
  async resume(id: string, owner: string) {
    const t = await this.read(id);
    if (!t || t.owner !== owner) throw unavailable();
    if (['blocked', 'failed', 'cancelled'].includes(t.state)) {
      return this.mutate(async () => {
        const current = await this.read(id);
        if (!current || current.owner !== owner) throw unavailable();
        if (current.revision !== t.revision) return view(current);
        // Resume the download's cache check, not the collection batch. A user's
        // stopped queue stays stopped and its original receipt is never lost.
        current.startedAt = this.now();
        current.deadline = current.startedAt + 900000;
        current.nextCheckAt = this.now();
        current.attempts = 0;
        delete current.code;
        current.state = 'waiting';
        current.message =
          '正在检查原请求已有缓存；不会恢复已停止的订阅队列、重复订阅或强制更新。';
        await this.write(current);
        return view(current);
      });
    }
    return view(t);
  }
  private async update(id: string, update: (t: Task) => void) {
    return this.mutate(async () => {
      const current = await this.read(id);
      if (!current || !active(current)) return;
      update(current);
      await this.write(current);
      return current;
    });
  }
  async runDue() {
    if (this.busy || this.stopped || !this.canRun()) return;
    this.busy = true;
    try {
      let t = (await this.records())
        .filter(active)
        .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
        .find((t) => t.nextCheckAt <= this.now());
      if (!t) return;
      if (
        t.instance !== hash(this.instance()) ||
        this.now() >= t.deadline ||
        t.attempts >= 10
      ) {
        await this.update(t.taskId, (t) => {
          t.state = 'failed';
          if (t.instance !== hash(this.instance())) {
            t.code = 'SINGLE_INSTANCE_CHANGED';
            t.message = 'Wechat2RSS 实例配置已变化，下载已停止，未保存。';
          } else {
            t.code =
              t.attempts >= 10
                ? 'SINGLE_CACHE_READ_LIMIT'
                : 'SINGLE_WAIT_EXPIRED';
            t.message =
              t.attempts >= 10
                ? '已检查缓存 10 次，仍未取得目标正文，下载已停止，未保存。Wechat2RSS 不保证历史文章。'
                : '等待订阅正文已超过 15 分钟，下载已停止，未保存。';
          }
        });
        return;
      }
      t = await this.update(t.taskId, (t) => {
        t.state = 'waiting';
        t.nextCheckAt = this.now() + 30000;
      });
      if (!t) return;
      if (!t.batchId) {
        try {
          const batch = (await this.queue.addSingleDownloadBatch([
            t.url,
          ])) as Batch;
          if (!batch || !/^[a-f0-9-]{36}$/.test(batch.batchId))
            throw unavailable();
          const updated = await this.update(t.taskId, (t) => {
            t.batchId = batch.batchId;
          });
          if (!updated) {
            await this.queue.stopSubscriptionBatch(batch.batchId);
            return;
          }
          t = updated;
        } catch {
          // A different durable batch may own the shared queue. Keep this intent
          // without a separate submitter or an unguarded /addurl replay.
          let busy = false;
          try {
            const batches =
              (await this.queue.subscriptionBatchList()) as Batch[];
            busy =
              Array.isArray(batches) &&
              batches.some((b) =>
                ['queued', 'running', 'paused'].includes(b.state),
              );
          } catch {
            /* Unavailable local records cannot authorize a retry. */
          }
          await this.update(t.taskId, (t) => {
            t.state = busy ? 'waiting' : 'blocked';
            t.message = busy
              ? '正在等待现有订阅队列；请求已保留。'
              : '按需订阅未能受理，已停止；请检查来源和任务状态后继续。';
          });
          return;
        }
      }
      const receipt = await this.receipt(t);
      const batch = receipt?.batch;
      const item = receipt?.item;
      if (!item) {
        await this.update(t.taskId, (t) => {
          t.state = 'failed';
          t.message = '订阅受理记录缺失，已停止；不会重新发送新增。';
        });
        return;
      }
      const queueUnavailable =
        ['blocked', 'failed', 'cancelled'].includes(item.state) ||
        batch?.state === 'paused' ||
        batch?.state === 'stopped';
      const feedId = /^MP_WXS_\d{5,15}$/.test(item.feedId || '')
        ? item.feedId
        : undefined;
      if (queueUnavailable && !feedId) {
        await this.update(t.taskId, (t) => {
          t.state =
            item.state === 'blocked' || batch?.state === 'paused'
              ? 'blocked'
              : 'failed';
          t.message =
            '订阅队列已停止或受限；请处理账号状态后继续原请求，未保存。';
        });
        return;
      }
      if (
        !t.selected &&
        !queueUnavailable &&
        item.state !== 'succeeded' &&
        item.bodyReady !== true
      )
        return;
      await this.update(t.taskId, (t) => {
        t.attempts++;
        if (feedId) t.feedId = feedId;
      });
      let prepared: Prepare;
      try {
        prepared = await this.prepare(t.selected?.url || t.url, item.feedId);
      } catch (error) {
        await this.update(t.taskId, (t) => {
          const code =
            error instanceof ArticleDownloadError
              ? error.diagnostic?.code
              : undefined;
          if (code && /^(?:WECHAT2RSS_|SINGLE_)[A-Z_]{1,65}$/.test(code))
            t.code = code;
          if (
            code === 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE' &&
            (queueUnavailable ||
              item.bodyReady === true ||
              batch?.state === 'completed')
          ) {
            // Actual Wechat2RSS feeds may have complete long-URL bodies but no
            // short alias. A completed publisher update cannot prove which one
            // the user requested; repeated reads would misrepresent readiness.
            t.state = 'failed';
            t.message =
              '公众号已订阅，但缓存没有该短链接的原文身份映射，无法确定目标，未保存。可在下方明确选择一篇已缓存文章下载。';
          } else if (singleCachePending(error)) {
            if (queueUnavailable) {
              t.state = 'blocked';
              t.message =
                '原订阅队列已停止或暂停，现有缓存尚无这篇完整正文，未保存；不会恢复采集或重复新增。';
            } else
              t.message =
                '订阅已受理，仍在等待该篇可核验正文；不会重复新增或按标题猜文。';
          } else {
            t.state = 'failed';
            t.message =
              error instanceof ArticleDownloadError
                ? error.message
                : '正文读取失败，已停止，未保存。';
          }
        });
        return;
      }
      if (this.stopped || !this.canRun()) return;
      const saving = await this.update(t.taskId, (t) => {
        t.state = 'saving';
        delete t.code;
        t.message = '正在保存已核验的正文和图片。';
      });
      if (!saving) return; // Cancellation during a read cannot publish files.
      try {
        const result = await this.save(
          prepared,
          saving.directory,
          saving.startedAt,
        );
        await this.update(saving.taskId, (t) => {
          t.state = 'saved';
          t.result = result;
          t.message =
            result.mediaComplete === false
              ? '正文和有效图片已保存；媒体完整性未确认。'
              : result.alreadySaved
                ? '已保存，保留已有笔记。'
                : '正文和图片已保存。';
        });
      } catch (error) {
        await this.update(saving.taskId, (t) => {
          t.state = 'failed';
          if (
            error instanceof ArticleDownloadError &&
            error.diagnostic?.code === 'EXPORT_SOURCE_MISSING'
          ) {
            t.code = 'SINGLE_EXPORT_SOURCE_MISSING';
            t.message =
              '尚未取得该文章的可信公众号和分组信息，未保存；已保留原确认根和回执。';
          } else
            t.message =
              '本机保存未完成；已保留原目录和订阅回执，请检查保存路径。';
        });
      }
    } finally {
      this.busy = false;
    }
  }
  close() {
    this.stopped = true;
  }
}
