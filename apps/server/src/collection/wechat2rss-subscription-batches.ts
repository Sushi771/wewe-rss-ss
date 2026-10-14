import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { subscriptionArticleUrl } from './subscription-add';
import { batchStorageLock } from './batch-storage-lock';
import {
  activeRefreshScheduleEnabled,
  automaticSubmissionAllowed,
} from '../feeds/active-refresh-schedule';
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
  state: 'queued' | 'waiting' | 'succeeded' | 'failed' | 'blocked' | 'skipped';
  message: string;
  taskId?: string;
  feedId?: string;
  bodyReady?: boolean;
  /** Text and local media availability are independent of upstream CDN state. */
  textReady?: boolean;
  mediaReady?: boolean;
  localMediaPendingArticleCount?: number;
  upstreamImageBlockedCount?: number;
  imagePendingCount?: number;
  listReady?: boolean;
  code?: SubscriptionTaskCode;
  phase?: 'identity' | 'cache' | 'metadata';
  accepted?: boolean;
  submissionUnknown?: boolean;
  /** Safe preparation failure: no upstream submission was attempted. */
  retryable?: boolean;
  /** Known shared account restrictions may stop the round; unknown submits isolate. */
  stopBatch?: boolean;
  /** Explicit shared throttle/account signal, distinct from an uncertain request. */
  sharedRestriction?: boolean;
  restrictionKind?: 'account' | 'rate-limit';
};
export type PreparedRefresh = {
  outcome?: BatchOutcome;
  /** Network-only update; preparation and all SQLite writes have finished. */
  submit?: () => Promise<BatchOutcome>;
  release: () => void;
  cancel?: () => Promise<void>;
};

type Item = Omit<BatchOutcome, 'state'> & {
  index: number;
  articleUrl?: string;
  state: ItemState;
  refreshChecks?: number;
  refreshAfter?: number;
  preparationRetries?: number;
  retryAfter?: number;
  retryDeadlineAt?: number;
  retryExhausted?: 'attempt-limit' | 'deadline';
  nextReceiptCheck?: number;
  refreshScope?: string;
  mustExecute?: boolean;
  coverageReviewRequired?: boolean;
  waitingForReceipt?: boolean;
  refreshClaimedAt?: number;
  supersededBy?: {
    batchId: string;
    createdAt: number;
    scope: string;
    claimedAt: number;
  };
};
type Batch = {
  version: 1;
  batchId: string;
  instance: string;
  signature: string;
  purpose?:
    | 'subscription'
    | 'single-download'
    | 'manual-refresh'
    | 'scheduled-refresh';
  intentKey?: string;
  refreshScope?: string;
  mustExecute?: boolean;
  /** A durable continuation of accepted cache work, never unsent submissions. */
  cacheOnly?: boolean;
  createdAt: number;
  updatedAt: number;
  nextSubmissionAt: number;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'stopped';
  items: Item[];
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const isRefresh = (b: Batch) =>
  ['manual-refresh', 'scheduled-refresh'].includes(b.purpose || '');
const live = (b: Batch) => ['queued', 'running', 'paused'].includes(b.state);
const AUTOMATIC_PREPARATION_LIMIT = 8;
const AUTOMATIC_RETRY_WINDOW = 24 * 3600000;
const CURRENT_REFRESH_SCOPE = 'wechat2rss-subscription-current-v1';
const batchFields = new Set([
  'version',
  'batchId',
  'instance',
  'signature',
  'purpose',
  'intentKey',
  'cacheOnly',
  'createdAt',
  'updatedAt',
  'nextSubmissionAt',
  'state',
  'items',
  'refreshScope',
  'mustExecute',
]);
const itemFields = new Set([
  'index',
  'articleUrl',
  'state',
  'message',
  'taskId',
  'feedId',
  'bodyReady',
  'textReady',
  'mediaReady',
  'localMediaPendingArticleCount',
  'upstreamImageBlockedCount',
  'imagePendingCount',
  'listReady',
  'code',
  'phase',
  'accepted',
  'submissionUnknown',
  'retryable',
  'stopBatch',
  'sharedRestriction',
  'restrictionKind',
  'refreshChecks',
  'refreshAfter',
  'preparationRetries',
  'retryAfter',
  'retryDeadlineAt',
  'retryExhausted',
  'nextReceiptCheck',
  'refreshScope',
  'mustExecute',
  'coverageReviewRequired',
  'supersededBy',
  'waitingForReceipt',
  'refreshClaimedAt',
]);
/** Legacy v1 manual/automatic refreshes share the audited current /add contract.
 * Unknown metadata or an explicit different scope cannot establish equivalence. */
const refreshScope = (b: Batch, item: Item) =>
  isRefresh(b) &&
  Object.keys(b).every((key) => batchFields.has(key)) &&
  Object.keys(item).every((key) => itemFields.has(key)) &&
  [b.mustExecute, item.mustExecute].every(
    (value) => value === undefined || typeof value === 'boolean',
  ) &&
  (item.refreshScope ?? b.refreshScope ?? CURRENT_REFRESH_SCOPE) ===
    CURRENT_REFRESH_SCOPE
    ? CURRENT_REFRESH_SCOPE
    : undefined;
const safePreparation = (item: Item) =>
  item.retryable === true &&
  item.accepted === false &&
  !item.submissionUnknown &&
  item.stopBatch === false &&
  ['queued', 'failed'].includes(item.state);
const automaticRecovery = (b: Batch) =>
  b.purpose === 'scheduled-refresh' &&
  !b.items.some((item) => item.sharedRestriction === true) &&
  !b.cacheOnly &&
  b.state !== 'stopped' &&
  !b.items.some(
    (item) =>
      !item.submissionUnknown &&
      ['blocked', 'failed'].includes(item.state) &&
      item.stopBatch !== false,
  ) &&
  b.items.some((item) => safePreparation(item) && !item.retryExhausted);
const isolatedRefresh = (b: Batch) =>
  isRefresh(b) &&
  !b.items.some((item) => item.sharedRestriction === true) &&
  b.items.some((item) => item.submissionUnknown) &&
  !b.items.some(
    (item) =>
      !item.submissionUnknown &&
      ['blocked', 'failed'].includes(item.state) &&
      item.stopBatch !== false,
  );
const view = (b: Batch) => ({
  batchId: b.batchId,
  purpose: b.purpose || 'subscription',
  intentKey: b.intentKey,
  cacheOnly: b.cacheOnly === true,
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
    textReady: item.textReady,
    mediaReady: item.mediaReady,
    localMediaPendingArticleCount: item.localMediaPendingArticleCount,
    upstreamImageBlockedCount: item.upstreamImageBlockedCount,
    imagePendingCount: item.imagePendingCount,
    accepted: item.accepted ?? !!item.taskId,
    listReady: item.listReady,
    code: item.code,
    stopBatch: item.stopBatch,
    submissionUnknown: item.submissionUnknown,
    preparationRetries: item.preparationRetries,
    retryAfter: item.retryAfter,
    retryDeadlineAt: item.retryDeadlineAt,
    retryExhausted: item.retryExhausted,
    coverageReviewRequired: item.coverageReviewRequired,
    waitingForReceipt: item.waitingForReceipt,
    supersededBy: item.supersededBy,
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
    automatic?: boolean,
    options?: { cacheOnly: boolean },
  ) => Promise<BatchOutcome>;
  private prepareRefresh?: (
    feedId: string,
    automatic: boolean,
    waveKey: string,
  ) => Promise<PreparedRefresh>;
  attachRefreshPreparation(
    prepare: NonNullable<Wechat2RssSubscriptionBatches['prepareRefresh']>,
  ) {
    if (this.prepareRefresh) throw new Error('BATCH_PREPARATION_EXISTS');
    this.prepareRefresh = prepare;
  }

  private restrictionCheck?: () => Promise<boolean>;
  attachRestrictionCheck(check: () => Promise<boolean>) {
    this.restrictionCheck = check;
  }
  private async releaseSharedRestriction(b: Batch, explicit = false) {
    let restricted = b.items.filter((i) => i.sharedRestriction === true);
    if (
      !restricted.length ||
      !this.restrictionCheck ||
      this.now() < b.nextSubmissionAt ||
      (!explicit &&
        restricted.some((i) => i.restrictionKind !== 'rate-limit')) ||
      b.instance !== hash(this.instance()) ||
      b.state === 'stopped' ||
      (b.purpose === 'scheduled-refresh' &&
        (!activeRefreshScheduleEnabled(process.env) ||
          !automaticSubmissionAllowed(this.now())))
    )
      return false;
    let clear = false;
    try {
      clear = await this.restrictionCheck();
    } catch {
      /* remain restricted */
    }
    const latest = await this.read(b.batchId);
    if (
      this.stopped ||
      !latest ||
      this.now() < latest.nextSubmissionAt ||
      latest.state === 'stopped' ||
      latest.instance !== hash(this.instance()) ||
      (!explicit &&
        latest.items.some(
          (i) =>
            i.sharedRestriction === true && i.restrictionKind !== 'rate-limit',
        ))
    )
      return false;
    Object.assign(b, latest);
    restricted = b.items.filter((i) => i.sharedRestriction === true);

    if (!clear) {
      if (!explicit) {
        b.nextSubmissionAt = this.now() + 120000;
        await this.write(b);
      }
      return false;
    }
    for (const item of restricted) {
      item.sharedRestriction = false;
      item.stopBatch = false;
      if (
        item.state === 'blocked' &&
        !item.accepted &&
        !item.submissionUnknown
      ) {
        item.state = 'queued';
        item.retryable = true;
      }
    }
    b.state = b.items.some((i) =>
      ['queued', 'waiting', 'submitting'].includes(i.state),
    )
      ? 'running'
      : 'completed';
    await this.write(b);
    return true;
  }

  private reconcile?: (
    feedId: string,
    createdAt: number,
  ) => Promise<'not-submitted' | 'unknown'>;
  attachReconciliation(
    check: NonNullable<Wechat2RssSubscriptionBatches['reconcile']>,
  ) {
    this.reconcile = check;
  }

  /** Manual refresh shares the existing serial scheduler and durable records. */
  attachRefresh(
    run: (
      feedId: string,
      stage: 'submit' | 'cache',
      automatic?: boolean,
      options?: { cacheOnly: boolean },
    ) => Promise<BatchOutcome>,
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
  private consumerUnavailable = false;
  private warnConsumerUnavailable() {
    if (!this.consumerUnavailable)
      console.warn('[WECHAT2RSS_DOWNLOAD_CONSUMER_UNAVAILABLE]');
    this.consumerUnavailable = true;
  }
  private async consumerPending() {
    try {
      return Boolean(await this.consumer?.hasPending());
    } catch {
      this.warnConsumerUnavailable();
      // Retain the consumer's durable work; its storage failure cannot suppress
      // independent subscription refreshes or authorize another submission.
      return true;
    }
  }
  private async runConsumer() {
    try {
      await this.consumer?.runDue();
      this.consumerUnavailable = false;
    } catch {
      this.warnConsumerUnavailable();
    }
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
        (!isRefresh(b) && stat.size > 100000) ||
        b.version !== 1 ||
        b.batchId !== id ||
        !/^[a-f0-9]{64}$/.test(b.instance) ||
        !/^[a-f0-9]{64}$/.test(b.signature) ||
        (b.purpose !== undefined &&
          ![
            'subscription',
            'single-download',
            'manual-refresh',
            'scheduled-refresh',
          ].includes(b.purpose)) ||
        !['queued', 'running', 'paused', 'completed', 'stopped'].includes(
          b.state,
        ) ||
        ![b.createdAt, b.updatedAt, b.nextSubmissionAt].every(
          Number.isSafeInteger,
        ) ||
        (b.intentKey !== undefined &&
          (!isRefresh(b) || !/^[a-f0-9]{64}$/.test(b.intentKey))) ||
        (b.cacheOnly !== undefined &&
          (!isRefresh(b) || typeof b.cacheOnly !== 'boolean')) ||
        !Array.isArray(b.items) ||
        !b.items.length ||
        b.items.length > (isRefresh(b) ? 1000 : 20)
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
          ['textReady', 'mediaReady'].some(
            (key) => item[key] !== undefined && typeof item[key] !== 'boolean',
          ) ||
          ['localMediaPendingArticleCount', 'upstreamImageBlockedCount'].some(
            (key) =>
              item[key] !== undefined &&
              (!Number.isSafeInteger(item[key]) ||
                item[key] < 0 ||
                item[key] > 1000000),
          ) ||
          (item.accepted !== undefined && typeof item.accepted !== 'boolean') ||
          (item.restrictionKind !== undefined &&
            !['account', 'rate-limit'].includes(item.restrictionKind)) ||
          (item.sharedRestriction !== undefined &&
            typeof item.sharedRestriction !== 'boolean') ||
          (item.submissionUnknown !== undefined &&
            typeof item.submissionUnknown !== 'boolean') ||
          (item.stopBatch !== undefined &&
            typeof item.stopBatch !== 'boolean') ||
          (item.retryable !== undefined &&
            typeof item.retryable !== 'boolean') ||
          (item.preparationRetries !== undefined &&
            (!Number.isSafeInteger(item.preparationRetries) ||
              item.preparationRetries < 0 ||
              item.preparationRetries > AUTOMATIC_PREPARATION_LIMIT)) ||
          (item.retryAfter !== undefined &&
            !Number.isSafeInteger(item.retryAfter)) ||
          (item.retryDeadlineAt !== undefined &&
            (!Number.isSafeInteger(item.retryDeadlineAt) ||
              item.retryDeadlineAt !== b.createdAt + AUTOMATIC_RETRY_WINDOW)) ||
          (item.retryExhausted !== undefined &&
            !['attempt-limit', 'deadline'].includes(item.retryExhausted)) ||
          (item.nextReceiptCheck !== undefined &&
            !Number.isSafeInteger(item.nextReceiptCheck)) ||
          (item.articleUrl !== undefined &&
            subscriptionArticleUrl(item.articleUrl) !== item.articleUrl) ||
          (isRefresh(b) && (!item.feedId || item.articleUrl || item.taskId)) ||
          (item.refreshChecks !== undefined &&
            (!Number.isSafeInteger(item.refreshChecks) ||
              item.refreshChecks < 0 ||
              item.refreshChecks > 10)) ||
          (item.refreshAfter !== undefined &&
            !Number.isSafeInteger(item.refreshAfter)) ||
          (!isRefresh(b) &&
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
  private readonly batchWrites = new Map<string, Promise<void>>();
  private async write(b: Batch, preserveStopped = false) {
    const previous = this.batchWrites.get(b.batchId) || Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(async () => {
        if (preserveStopped) {
          const latest = await this.read(b.batchId);
          if (!latest || latest.state === 'stopped') {
            if (latest) Object.assign(b, latest);
            return;
          }
        }
        await this.persistWrite(b);
      });
    this.batchWrites.set(b.batchId, pending);
    try {
      await pending;
    } finally {
      if (this.batchWrites.get(b.batchId) === pending)
        this.batchWrites.delete(b.batchId);
    }
  }
  private async persistWrite(b: Batch) {
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
    const release = await batchStorageLock(await this.storage());
    if (!release) throw new Error('BATCH_BUSY');
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
      await release();
    }
  }
  async enqueueRefresh(
    feedIds: string[],
    intentKey?: string,
    purpose: 'manual-refresh' | 'scheduled-refresh' = 'manual-refresh',
  ) {
    if (this.refreshAcceptance && purpose === 'manual-refresh')
      return { ...(await this.refreshAcceptance), reused: true };
    if (this.refreshAcceptance) await this.refreshAcceptance;
    const pending = this.acceptRefresh(feedIds, intentKey, purpose);
    this.refreshAcceptance = pending;
    try {
      return await pending;
    } finally {
      this.refreshAcceptance = undefined;
    }
  }
  private async acceptRefresh(
    feedIds: string[],
    intentKey: string | undefined,
    purpose: 'manual-refresh' | 'scheduled-refresh',
  ) {
    if (this.accepting) throw new Error('BATCH_BUSY');
    const release = await batchStorageLock(await this.storage());
    if (!release) throw new Error('BATCH_BUSY');
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
        records.find((b) => isRefresh(b) && b.intentKey === intentKey);
      if (original) return { ...view(original), reused: true };
      // Restore legacy terminal preparation failures before cross-slot deduplication.
      // The original intent and retry budget remain authoritative.
      await this.coverPreparation(records);
      for (const record of records) await this.recoverPreparation(record);
      const uncertain = new Set(
        records
          .filter(isRefresh)
          .flatMap((record) =>
            record.items
              .filter(
                (item) => item.submissionUnknown || item.state === 'submitting',
              )
              .map((item) => item.feedId),
          ),
      );
      // A repeated overview click rejoins the existing request even if order changed.
      const same = records.find((b) => live(b) && isRefresh(b));
      if (same) {
        if (purpose === 'scheduled-refresh' && intentKey) {
          const existing = new Set(
            records
              .filter((record) => live(record) && isRefresh(record))
              .flatMap((record) =>
                record.items
                  .filter(
                    (item) =>
                      (['queued', 'waiting', 'submitting'].includes(
                        item.state,
                      ) ||
                        item.submissionUnknown ||
                        (item.accepted === true &&
                          item.state !== 'succeeded')) &&
                      !(
                        record.purpose === 'scheduled-refresh' &&
                        item.state === 'queued' &&
                        !item.retryDeadlineAt &&
                        Math.floor((this.now() + 8 * 3600000) / 86400000) >
                          Math.floor(
                            (record.createdAt + 8 * 3600000) / 86400000,
                          )
                      ),
                  )
                  .map((item) => item.feedId),
              ),
          );
          const fresh =
            same.state === 'paused'
              ? []
              : [...new Set(feedIds)].filter(
                  (id) => !existing.has(id) && !uncertain.has(id),
                );
          const joined: Batch = {
            ...same,
            batchId: randomUUID(),
            purpose,
            refreshScope: CURRENT_REFRESH_SCOPE,
            intentKey,
            state: fresh.length ? 'queued' : 'completed',
            createdAt: this.now(),
            updatedAt: this.now(),
            items: [...new Set(feedIds)].map((feedId, index) => ({
              index,
              feedId,
              state: fresh.includes(feedId) ? 'queued' : 'skipped',
              accepted: false,
              message: fresh.includes(feedId)
                ? 'Waiting behind existing refresh work.'
                : 'Existing refresh round retained; no duplicate automatic submission.',
            })),
          };
          await this.write(joined);
          this.schedule();
          return { ...view(joined), reused: true };
        }
        return { ...view(same), reused: true };
      }
      if (records.some(live)) throw new Error('BATCH_BUSY');
      const ids = [...new Set(feedIds)].filter((id) => !uncertain.has(id));
      if (!ids.length) throw new Error('BATCH_UNCONFIRMED');
      const b: Batch = {
        version: 1,
        batchId: randomUUID(),
        instance: hash(this.instance()),
        signature: hash(JSON.stringify([purpose, [...ids].sort()])),
        purpose,
        intentKey,
        refreshScope: CURRENT_REFRESH_SCOPE,
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
      await release();
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
    if (b?.cacheOnly) throw new Error('BATCH_CACHE_ONLY');
    if (!b || b.state !== 'paused') return b ? view(b) : null;
    if (b.instance !== hash(this.instance()))
      throw new Error('BATCH_INSTANCE_CHANGED');
    if (isRefresh(b)) {
      if (
        b.items.some((i) => i.sharedRestriction === true) &&
        !(await this.releaseSharedRestriction(b, true))
      )
        return view(b);
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
  /** Explicit local recovery: the original unsent queue remains visibly unsent.
   * The storage mutex prevents converting a batch while a worker is in flight.
   * Repeated delivery and restart retain this mode and cannot emit /add. */
  async resumeCacheOnly(id: string) {
    const release = await batchStorageLock(await this.storage());
    if (!release) throw new Error('BATCH_BUSY');
    try {
      const b = await this.read(id);
      if (!b) return null;
      if (!isRefresh(b)) throw new Error('BATCH_INVALID');
      if (b.instance !== hash(this.instance()))
        throw new Error('BATCH_INSTANCE_CHANGED');
      if (b.cacheOnly) return view(b);
      if (
        b.items.some(
          (item) => item.state === 'submitting' || item.submissionUnknown,
        )
      )
        throw new Error('BATCH_UNCONFIRMED');
      b.cacheOnly = true;
      for (const item of b.items) {
        if (
          item.accepted &&
          ['waiting', 'failed', 'blocked'].includes(item.state)
        ) {
          item.state = 'waiting';
          item.refreshChecks = 0;
          item.refreshAfter = this.now();
          item.stopBatch = undefined;
          item.message = 'Cache-only continuation; no new upstream request.';
        }
      }
      b.state = b.items.some((item) => item.state === 'waiting')
        ? 'running'
        : 'completed';
      await this.write(b);
      this.schedule();
      return view(b);
    } finally {
      await release();
    }
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
          automaticRecovery(b) ||
          (this.restrictionCheck &&
            b.items.some(
              (i) =>
                i.sharedRestriction === true &&
                i.restrictionKind === 'rate-limit',
            )) ||
          (b.state === 'paused' && isolatedRefresh(b)) ||
          (isRefresh(b) && b.items.some((item) => item.submissionUnknown)) ||
          (isRefresh(b) &&
            b.state === 'stopped' &&
            b.items.some((item) =>
              ['waiting', 'submitting'].includes(item.state),
            )),
      ) ||
      (await this.consumerPending())
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
  /** Upgrade only explicit unsent failures. Never infer safety from an error
   * message, a missing accepted flag, or a terminal batch state. */
  private async recoverPreparation(b: Batch) {
    if (!automaticRecovery(b) || b.instance !== hash(this.instance())) return;
    let changed = false;
    for (const item of b.items) {
      if (!safePreparation(item) || item.retryExhausted) continue;
      const deadline = b.createdAt + AUTOMATIC_RETRY_WINDOW;
      if (!item.retryDeadlineAt) {
        item.retryDeadlineAt = deadline;
        changed = true;
      }
      const exhausted =
        (item.preparationRetries || 0) >= AUTOMATIC_PREPARATION_LIMIT
          ? 'attempt-limit'
          : this.now() >= deadline
            ? 'deadline'
            : undefined;
      if (exhausted) {
        item.state = 'failed';
        item.retryExhausted = exhausted;
        item.message = '补试次数或期限已用尽，本次更新未提交。';
        changed = true;
      } else if (item.state === 'failed') {
        item.state = 'queued';
        // Old retries already have a persisted delay; never shorten it on restart.
        item.retryAfter = Math.max(item.retryAfter || 0, b.updatedAt + 60000);
        item.message = '未提交的准备失败项已恢复，后台将按原计划补试。';
        changed = true;
      }
    }
    if (!changed) return;
    b.state = b.items.some((item) =>
      ['queued', 'waiting', 'submitting'].includes(item.state),
    )
      ? 'running'
      : 'completed';
    await this.write(b, true);
  }
  /** A later equivalent success satisfies an older unsent update intent. This
   * is an explanatory skip, never a fabricated success or another submission. */
  private async coverPreparation(records: Batch[]) {
    const successes = new Map<
      string,
      { batchId: string; createdAt: number; scope: string; claimedAt: number }
    >();
    const unresolved = new Set<string>();
    const instance = hash(this.instance());
    for (const b of records) {
      if (b.instance === instance && isRefresh(b))
        for (const item of b.items)
          if (
            item.submissionUnknown ||
            item.state === 'submitting' ||
            (item.accepted === true && item.state !== 'succeeded')
          )
            unresolved.add(`${b.instance}/${item.feedId}`);
      if (
        b.instance !== instance ||
        b.cacheOnly ||
        b.createdAt > this.now() ||
        b.updatedAt < b.createdAt ||
        b.updatedAt > this.now()
      )
        continue;
      for (const item of b.items) {
        const scope = refreshScope(b, item);
        if (
          !scope ||
          item.state !== 'succeeded' ||
          item.accepted !== true ||
          item.submissionUnknown
        )
          continue;
        const key = `${b.instance}/${item.feedId}`;
        const claimedAt = item.refreshClaimedAt ?? b.createdAt;
        if (
          !Number.isSafeInteger(claimedAt) ||
          claimedAt < b.createdAt ||
          claimedAt > b.updatedAt
        )
          continue;
        if (!successes.has(key) || successes.get(key)!.claimedAt < claimedAt)
          successes.set(key, {
            batchId: b.batchId,
            createdAt: b.createdAt,
            scope,
            claimedAt,
          });
      }
    }
    for (const b of records) {
      if (
        !isRefresh(b) ||
        b.instance !== instance ||
        b.cacheOnly ||
        b.state === 'stopped'
      )
        continue;
      let changed = false;
      for (const item of b.items) {
        if (!safePreparation(item)) continue;
        const scope = refreshScope(b, item);
        if (!scope) {
          item.state = 'blocked';
          item.coverageReviewRequired = true;
          item.message =
            '刷新范围无法确认，保留原意图；核对前不会补试或标为成功。';
          changed = true;
          continue;
        }
        const key = `${b.instance}/${item.feedId}`;
        const newer = successes.get(key);
        const required =
          (b.mustExecute !== undefined && b.mustExecute !== false) ||
          (item.mustExecute !== undefined && item.mustExecute !== false);
        if (
          !required &&
          newer &&
          newer.claimedAt > b.createdAt &&
          newer.scope === scope
        ) {
          item.state = 'skipped';
          item.waitingForReceipt = false;
          item.supersededBy = newer;
          item.message =
            '较晚的同等订阅刷新已成功；本条旧未提交意图已被覆盖，不再补试。';
          changed = true;
        } else if (unresolved.has(key)) {
          if (!item.waitingForReceipt) {
            item.waitingForReceipt = true;
            item.message =
              '同订阅另有已受理或未知回执，原补试意图保留；核对前不重复提交。';
            changed = true;
          }
        } else if (item.waitingForReceipt) {
          item.waitingForReceipt = false;
          changed = true;
        }
      }
      if (!changed) continue;
      if (
        b.state !== 'paused' ||
        !b.items.some(
          (item) =>
            !item.submissionUnknown &&
            ['blocked', 'failed'].includes(item.state) &&
            item.stopBatch !== false,
        )
      )
        b.state = b.items.some((item) =>
          ['queued', 'waiting', 'submitting'].includes(item.state),
        )
          ? 'running'
          : 'completed';
      await this.write(b, true);
    }
  }
  async runDue() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let release: (() => Promise<void>) | undefined;
    let cacheOnlyRun = false;
    try {
      release = await batchStorageLock(await this.storage());
      if (!release) return;
      // A cache-only recovery must not wake the shared download consumer.
      cacheOnlyRun = (await this.records()).some(
        (record) => record.cacheOnly && live(record),
      );
      if (!cacheOnlyRun) await this.runConsumer();
      if (this.stopped) return;
      const pending = await this.records();
      for (const record of pending) await this.releaseSharedRestriction(record);
      const latestRecords = await this.records();
      await this.coverPreparation(latestRecords);
      for (const record of latestRecords) await this.recoverPreparation(record);
      // Read-only reconciliation can prove preparation failed before the one-shot
      // reservation. An unknown receipt alone never authorizes another /add.
      if (this.reconcile)
        for (const record of await this.records()) {
          if (!isRefresh(record) || record.instance !== hash(this.instance()))
            continue;
          for (const item of record.items) {
            if (
              !item.submissionUnknown ||
              item.accepted === true ||
              item.state === 'succeeded' ||
              (item.nextReceiptCheck || 0) > this.now()
            )
              continue;
            item.nextReceiptCheck = this.now() + 60000;
            let proof: 'not-submitted' | 'unknown' = 'unknown';
            try {
              proof = await this.reconcile(item.feedId!, record.createdAt);
            } catch {
              /* remain unknown */
            }
            if (proof === 'not-submitted') {
              item.submissionUnknown = false;
              item.stopBatch = false;
              const expired =
                record.purpose === 'scheduled-refresh' &&
                Math.floor((this.now() + 8 * 3600000) / 86400000) >
                  Math.floor((record.createdAt + 8 * 3600000) / 86400000);
              item.state =
                record.state === 'stopped' || record.cacheOnly || expired
                  ? 'cancelled'
                  : 'queued';
              if (
                record.purpose === 'scheduled-refresh' &&
                !record.cacheOnly &&
                record.state !== 'stopped'
              ) {
                // Proof permits another bounded preparation attempt, never a
                // budget reset. Count the interrupted first attempt as well.
                item.accepted = false;
                item.retryable = true;
                item.preparationRetries = item.preparationRetries || 1;
                item.retryDeadlineAt =
                  record.createdAt + AUTOMATIC_RETRY_WINDOW;
                item.state = 'queued';
                if (
                  this.now() >= item.retryDeadlineAt ||
                  item.preparationRetries >= AUTOMATIC_PREPARATION_LIMIT
                ) {
                  item.state = 'failed';
                  item.retryExhausted =
                    this.now() >= item.retryDeadlineAt
                      ? 'deadline'
                      : 'attempt-limit';
                }
              }
              item.message = '本地预留账本确认未提交；独立队列自动继续。';
              if (
                item.state === 'queued' &&
                !record.items.some((i) => i.sharedRestriction === true) &&
                !record.items.some(
                  (prior) =>
                    !prior.submissionUnknown &&
                    ['blocked', 'failed'].includes(prior.state) &&
                    prior.stopBatch !== false,
                )
              )
                record.state = 'running';
            }
            await this.write(record);
          }
        }
      // Newly proven unsent work must also respect later equivalent successes.
      await this.coverPreparation(await this.records());
      // Older versions paused the whole refresh after one uncertain receipt.
      // Keep that item blocked forever, but automatically release independent work.
      for (const record of await this.records()) {
        if (record.state !== 'paused' || !isolatedRefresh(record)) continue;
        if (record.instance !== hash(this.instance())) continue;
        record.state = record.items.some((item) =>
          ['queued', 'waiting', 'submitting'].includes(item.state),
        )
          ? 'running'
          : 'completed';
        await this.write(record);
      }
      const candidates = (await this.records()).filter(
        (b) =>
          ['queued', 'running'].includes(b.state) ||
          (isRefresh(b) &&
            b.state === 'stopped' &&
            b.items.some((item) =>
              ['waiting', 'submitting'].includes(item.state),
            )),
      );
      // A delayed retry in one round must not monopolize independent later work.
      let b: Batch | undefined;
      for (const candidate of candidates) {
        if (candidate.instance !== hash(this.instance())) {
          candidate.state = 'paused';
          await this.write(candidate);
          return;
        }
        if (isRefresh(candidate)) {
          if (await this.runRefresh(candidate)) return;
          continue;
        }
        b = candidate;
        break;
      }
      if (!b) return;
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
          result = await this.submit(
            item.articleUrl!,
            b.purpose === 'single-download'
              ? 'single-download'
              : 'subscription',
          );
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
      if (release) await release();
      this.busy = false;
      if (
        !this.stopped &&
        ((await this.records()).some(
          (b) =>
            ['queued', 'running'].includes(b.state) ||
            automaticRecovery(b) ||
            (this.restrictionCheck &&
              b.items.some(
                (i) =>
                  i.sharedRestriction === true &&
                  i.restrictionKind === 'rate-limit',
              )) ||
            (this.reconcile &&
              isRefresh(b) &&
              b.items.some((item) => item.submissionUnknown)) ||
            (isRefresh(b) &&
              b.state === 'stopped' &&
              b.items.some((item) =>
                ['waiting', 'submitting'].includes(item.state),
              )),
        ) ||
          (!cacheOnlyRun && (await this.consumerPending())))
      )
        this.schedule();
    }
  }
  private async runRefresh(b: Batch) {
    if (this.stopped) return false;
    let changed = false;
    const unknowns = b.items.filter((i) => i.state === 'submitting');
    if (unknowns.length) {
      for (const unknown of unknowns) {
        unknown.state = unknown.accepted === true ? 'waiting' : 'blocked';
        unknown.submissionUnknown = unknown.accepted !== true;
        unknown.message =
          '本号提交回执未确认；其他订阅继续，本号不会自动重发。';
      }
      if (b.state !== 'stopped')
        b.state = b.items.some((item) =>
          ['queued', 'waiting'].includes(item.state),
        )
          ? 'running'
          : 'completed';
      await this.write(b);
      changed = true;
    }
    // Carrying the 17:30 tail through midnight would submit new requests in
    // the user's blackout. Ordinary unsent work expires at midnight; explicit
    // preparation retries retain their absolute deadline and obey quiet hours.
    if (b.purpose === 'scheduled-refresh' && !b.cacheOnly) {
      const day = (value: number) =>
        Math.floor((value + 8 * 3600000) / 86400000);
      if (day(this.now()) > day(b.createdAt)) {
        let expired = false;
        for (const pending of b.items)
          if (pending.state === 'queued' && !pending.retryDeadlineAt) {
            pending.state = 'cancelled';
            pending.message =
              'Previous automatic round expired at Shanghai midnight; not submitted.';
            expired = true;
          }
        if (
          !b.items.some((i) => ['queued', 'waiting'].includes(i.state)) &&
          b.state !== 'completed'
        ) {
          b.state = 'completed';
          await this.write(b);
          return true;
        }
        if (expired) {
          await this.write(b);
          changed = true;
        }
      }
    }
    const maySubmit =
      !b.items.some((i) => i.sharedRestriction === true) &&
      !b.cacheOnly &&
      (b.purpose !== 'scheduled-refresh' ||
        (activeRefreshScheduleEnabled(process.env) &&
          automaticSubmissionAllowed(this.now())));
    if (
      maySubmit &&
      this.prepareRefresh &&
      b.nextSubmissionAt <= this.now() &&
      b.items.some(
        (i) =>
          i.state === 'queued' &&
          !i.accepted &&
          !i.submissionUnknown &&
          !i.retryExhausted &&
          !i.waitingForReceipt &&
          (i.retryAfter || 0) <= this.now(),
      )
    ) {
      if (
        (await this.records()).some(
          (record) => record.nextSubmissionAt > this.now(),
        )
      )
        return changed;
      return this.runRefreshWave(b);
    }
    const item =
      b.items.find(
        (i) =>
          maySubmit &&
          i.state === 'queued' &&
          i.accepted !== true &&
          !i.submissionUnknown &&
          !i.retryExhausted &&
          !i.waitingForReceipt &&
          b.nextSubmissionAt <= this.now() &&
          (i.retryAfter || 0) <= this.now(),
      ) ||
      b.items.find(
        (i) => i.state === 'waiting' && (i.refreshAfter || 0) <= this.now(),
      );
    if (!item || !this.refresh) return changed;
    const stage = item.state === 'queued' ? 'submit' : 'cache';
    const retryClaim =
      stage === 'submit' &&
      b.purpose === 'scheduled-refresh' &&
      safePreparation(item);
    const claimExhaustion = (claimed = false) => {
      if (!retryClaim) return undefined;
      return this.now() >=
        (item.retryDeadlineAt || b.createdAt + AUTOMATIC_RETRY_WINDOW)
        ? 'deadline'
        : !claimed &&
            (item.preparationRetries || 0) >= AUTOMATIC_PREPARATION_LIMIT
          ? 'attempt-limit'
          : undefined;
    };
    const expireClaim = async (
      exhausted: NonNullable<ReturnType<typeof claimExhaustion>>,
    ) => {
      item.state = 'failed';
      item.retryExhausted = exhausted;
      item.message = '补试次数或期限已用尽，本次更新未提交。';
      b.state = b.items.some((pending) =>
        ['queued', 'waiting', 'submitting'].includes(pending.state),
      )
        ? 'running'
        : 'completed';
      await this.write(b);
    };
    if (stage === 'submit') {
      if (
        (await this.records()).some(
          (record) => record.nextSubmissionAt > this.now(),
        )
      )
        return changed;
      // Recovery and receipt reads may cross the deadline. Check again after
      // the last asynchronous read, before reserving this attempt on disk.
      const exhausted = claimExhaustion();
      if (exhausted) {
        await expireClaim(exhausted);
        return false; // Yield to independent later rounds.
      }
      // Persist the bounded attempt before the callback can run. An interrupted
      // attempt consumes its budget and becomes unknown until read-only proof.
      if (retryClaim)
        item.preparationRetries = (item.preparationRetries || 0) + 1;
      item.refreshClaimedAt = this.now();
      item.state = 'submitting';
      b.state = 'running';
      b.nextSubmissionAt = this.now() + 30000;
      await this.write(b); // Reserve exactly once before an /add can leave the process.
      // Persistence itself can cross the deadline. No callback has run yet,
      // so this process can safely terminate the claim without a platform call.
      const expiredAfterWrite = claimExhaustion(true);
      if (expiredAfterWrite) {
        await expireClaim(expiredAfterWrite);
        return false;
      }
    }
    let result: BatchOutcome;
    try {
      result = b.cacheOnly
        ? await this.refresh(item.feedId!, 'cache', false, { cacheOnly: true })
        : b.purpose === 'scheduled-refresh'
          ? await this.refresh(item.feedId!, stage, true)
          : await this.refresh(item.feedId!, stage);
    } catch (error) {
      const local =
        stage === 'cache' &&
        (error as { stopBatch?: boolean } | null)?.stopBatch === false;
      result = {
        state: local ? 'failed' : 'blocked',
        stopBatch: !local,
        accepted: stage === 'cache',
        submissionUnknown: stage === 'submit',
        message:
          stage === 'submit'
            ? '本号更新回执未确认；其他订阅继续，本号不会自动重发。'
            : local
              ? '本地缓存处理失败；其他订阅继续，本次请求不会重发。'
              : '缓存检查失败，已暂停；上游请求不会重发。',
      };
    }
    return this.finishRefresh(b, item, stage, result, retryClaim);
  }
  /** One storage-locked worker owns a wave across manual and scheduled intents.
   * Prepare serially, send only network closures concurrently, persist receipts
   * through one chain. A wave never authorizes a sixth in-flight request. */
  private async runRefreshWave(b: Batch) {
    if (b.items.some((i) => i.sharedRestriction === true)) {
      if (b.state !== 'stopped') {
        b.state = 'paused';
        await this.write(b);
      }
      return true;
    }
    const selected = b.items
      .filter(
        (i) =>
          i.state === 'queued' &&
          !i.accepted &&
          !i.submissionUnknown &&
          !i.retryExhausted &&
          !i.waitingForReceipt &&
          (i.retryAfter || 0) <= this.now(),
      )
      .slice(0, 5);
    const prepared: Array<{
      item: Item;
      job: PreparedRefresh;
      retryClaim: boolean;
    }> = [];
    const automatic = b.purpose === 'scheduled-refresh';
    const waveKey = `${b.batchId}/${this.now()}`;
    try {
      for (const original of selected) {
        if (this.stopped) break;
        const current = await this.read(b.batchId);
        if (
          !current ||
          current.state === 'stopped' ||
          current.state === 'paused'
        )
          break;
        const item = current.items[original.index];
        if (item.state !== 'queued' || item.accepted || item.submissionUnknown)
          continue;
        const retryClaim = automatic && safePreparation(item);
        const deadline =
          item.retryDeadlineAt || current.createdAt + AUTOMATIC_RETRY_WINDOW;
        if (
          retryClaim &&
          (this.now() >= deadline ||
            (item.preparationRetries || 0) >= AUTOMATIC_PREPARATION_LIMIT)
        ) {
          item.retryExhausted =
            this.now() >= deadline ? 'deadline' : 'attempt-limit';
          await this.write(current);
          await this.finishRefresh(
            current,
            item,
            'submit',
            {
              state: 'failed',
              accepted: false,
              stopBatch: false,
              message: 'Preparation budget exhausted before submission.',
            },
            retryClaim,
          );
          continue;
        }
        if (retryClaim)
          item.preparationRetries = (item.preparationRetries || 0) + 1;
        item.refreshClaimedAt = this.now();
        item.state = 'submitting';
        current.state = 'running';
        await this.write(current);
        let job: PreparedRefresh;
        try {
          job = await this.prepareRefresh!(item.feedId!, automatic, waveKey);
        } catch {
          job = {
            outcome: {
              state: 'failed',
              accepted: false,
              retryable: true,
              stopBatch: false,
              message: 'Serial preparation failed; update not sent.',
            },
            release: () => {},
          };
        }
        if (!job.submit) {
          job.release();
          const outcome = job.outcome || {
            state: 'failed' as const,
            accepted: false,
            retryable: true,
            stopBatch: false,
            message: 'Missing network closure; update not sent.',
          };
          await this.finishRefresh(
            current,
            item,
            'submit',
            outcome,
            retryClaim,
          );
          if (outcome.stopBatch === true) break;
        } else prepared.push({ item, job, retryClaim });
      }
      // Recheck persisted stop/restriction/window/deadline after asynchronous
      // preparation, before any closure can issue a request.
      let current = await this.read(b.batchId);
      const allowed =
        !this.stopped &&
        current &&
        !['stopped', 'paused'].includes(current.state) &&
        (!automatic ||
          (activeRefreshScheduleEnabled(process.env) &&
            automaticSubmissionAllowed(this.now())));
      const send: typeof prepared = [];
      for (const entry of prepared) {
        const expired =
          entry.retryClaim &&
          this.now() >=
            (entry.item.retryDeadlineAt ||
              b.createdAt + AUTOMATIC_RETRY_WINDOW);
        if (!allowed || expired) {
          await entry.job.cancel?.();
          await this.finishRefresh(
            b,
            entry.item,
            'submit',
            {
              state: expired ? 'failed' : 'queued',
              accepted: false,
              submissionUnknown: false,
              stopBatch: false,
              retryable: expired,
              message:
                'Prepared update not sent: stop, account restriction, window or deadline.',
            },
            entry.retryClaim,
          );
        } else send.push(entry);
      }
      if (!send.length) return true;
      current = await this.read(b.batchId);
      if (!current) return true;
      current.nextSubmissionAt = this.now() + 30000;
      await this.write(current); // Durable global batch spacing before launch.
      current = await this.read(b.batchId);
      if (
        this.stopped ||
        !current ||
        ['stopped', 'paused'].includes(current.state)
      ) {
        for (const entry of send) {
          await entry.job.cancel?.();
          await this.finishRefresh(
            b,
            entry.item,
            'submit',
            {
              state: 'queued',
              accepted: false,
              submissionUnknown: false,
              stopBatch: false,
              message: 'Stopped after preparation; update not sent.',
            },
            entry.retryClaim,
          );
        }
        return true;
      }
      let persistence = Promise.resolve();
      const receipts = await Promise.allSettled(
        send.map(async (entry) => {
          let result: BatchOutcome;
          let cancelBeforeReceipt = false;
          try {
            if (
              entry.retryClaim &&
              this.now() >=
                (entry.item.retryDeadlineAt ||
                  b.createdAt + AUTOMATIC_RETRY_WINDOW)
            ) {
              cancelBeforeReceipt = true;
              result = {
                state: 'failed',
                accepted: false,
                retryable: true,
                submissionUnknown: false,
                stopBatch: false,
                message:
                  'Preparation deadline crossed before launch; update not sent.',
              };
            } else result = await entry.job.submit!();
          } catch (error) {
            const code = (error as Error)?.message;
            if (code === 'WECHAT2RSS_AUTOMATIC_WINDOW_CLOSED') {
              cancelBeforeReceipt = true;
              result = {
                state: 'queued',
                accepted: false,
                submissionUnknown: false,
                stopBatch: false,
                message: 'Automatic window closed before update request.',
              };
            } else
              result = {
                state: 'blocked',
                accepted: false,
                submissionUnknown: true,
                stopBatch: code === 'WECHAT2RSS_RATE_LIMITED',
                sharedRestriction: code === 'WECHAT2RSS_RATE_LIMITED',
                restrictionKind:
                  code === 'WECHAT2RSS_RATE_LIMITED' ? 'rate-limit' : undefined,
                message: 'Update response uncertain; retained without replay.',
              };
          }
          const queued = persistence.then(async () => {
            if (cancelBeforeReceipt) await entry.job.cancel?.();
            await this.finishRefresh(
              b,
              entry.item,
              'submit',
              result,
              entry.retryClaim,
            );
          });
          persistence = queued.catch(() => {});
          await queued;
        }),
      );
      await persistence;
      if (receipts.some((receipt) => receipt.status === 'rejected'))
        throw new Error('WAVE_RECEIPT_STORAGE_FAILED');
      return true;
    } finally {
      prepared.forEach((entry) => entry.job.release());
    }
  }
  private async finishRefresh(
    b: Batch,
    item: Item,
    stage: 'submit' | 'cache',
    result: BatchOutcome,
    retryClaim = false,
  ) {
    // Late callbacks after process shutdown leave claims uncertain. A persisted
    // batch stop still retains live receipts while this worker remains open.
    if (this.stopped) return true;
    const current = await this.read(b.batchId);
    if (!current) return true;
    const target = current.items[item.index];
    Object.assign(target, result);
    if (
      current.state === 'stopped' &&
      target.state === 'queued' &&
      !target.accepted
    )
      target.state = 'cancelled';
    if (result.sharedRestriction)
      current.nextSubmissionAt = Math.max(
        current.nextSubmissionAt,
        this.now() + 120000,
      );
    if (stage === 'cache') target.accepted = true;
    if (
      stage === 'submit' &&
      result.retryable === true &&
      result.stopBatch === false &&
      ['failed', 'queued'].includes(result.state) &&
      target.accepted === false &&
      !target.submissionUnknown
    ) {
      const automatic = current.purpose === 'scheduled-refresh';
      const limit = automatic ? AUTOMATIC_PREPARATION_LIMIT : 3;
      if (!retryClaim)
        target.preparationRetries = Math.min(
          limit,
          (target.preparationRetries || 0) + 1,
        );
      target.stopBatch = false;
      if (automatic)
        target.retryDeadlineAt = current.createdAt + AUTOMATIC_RETRY_WINDOW;
      target.retryExhausted =
        target.preparationRetries! >= limit
          ? 'attempt-limit'
          : automatic && this.now() >= target.retryDeadlineAt!
            ? 'deadline'
            : undefined;
      target.state = target.retryExhausted
        ? 'failed'
        : current.state === 'stopped'
          ? 'cancelled'
          : 'queued';
      target.retryAfter =
        this.now() + Math.min(1800000, 30000 * 2 ** target.preparationRetries!);
      target.message = target.retryExhausted
        ? '补试次数或期限已用尽，本次更新未提交。'
        : '提交前准备失败，后台已保存限次补试计划。';
    }
    if (
      target.accepted ||
      target.submissionUnknown ||
      ['succeeded', 'skipped'].includes(target.state)
    )
      target.retryable = false;
    if (stage === 'submit' && target.state === 'waiting' && !target.accepted) {
      target.state = 'blocked';
      target.submissionUnknown = true;
      target.message = '本号提交回执未确认；其他订阅继续，本号不会自动重发。';
    }
    target.refreshChecks =
      stage === 'cache' ? (target.refreshChecks || 0) + 1 : 0;
    target.refreshAfter = this.now() + 30000;
    if (target.state === 'waiting' && target.refreshChecks >= 10) {
      target.state = 'failed';
      target.stopBatch = false;
      target.message =
        '上游已受理，缓存同步仍未就绪；已停止检查，已有内容保留。';
    }
    if (current.state !== 'stopped')
      current.state = current.items.some(
        (i) =>
          i.sharedRestriction === true ||
          (!i.submissionUnknown &&
            ['blocked', 'failed'].includes(i.state) &&
            i.stopBatch === true),
      )
        ? 'paused'
        : !target.submissionUnknown &&
            ['blocked', 'failed'].includes(target.state) &&
            !(
              target.stopBatch === false &&
              (stage === 'cache' || target.accepted || target.retryable)
            )
          ? 'paused'
          : current.items.some((i) =>
                (current.cacheOnly
                  ? ['waiting']
                  : ['queued', 'waiting', 'submitting']
                ).includes(i.state),
              )
            ? 'running'
            : 'completed';
    await this.write(current);
    if (target.state === 'succeeded' && target.accepted)
      await this.coverPreparation(await this.records());
    return true;
  }
  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
