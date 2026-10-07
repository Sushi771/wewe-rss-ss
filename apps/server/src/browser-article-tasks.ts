import { BrowserTaskBroker, BrowserTaskError } from './browser-task';
import { ProviderArticle } from './collection/subscription-provider';
import type { BrowserArticleTaskStatus } from '../../../packages/shared/src/browser-article-task';

type Record = {
  status: BrowserArticleTaskStatus;
  owner: string;
  url: string;
  article?: ProviderArticle;
  destination?: string;
  directoryPickConfirmed?: boolean;
  timer: ReturnType<typeof setTimeout>;
};

/** Bounded application handoff over the existing broker, not a new producer.
 * The application retrieves only status; verified content remains server-side.
 * Save is a separate current authenticated request, never an extension callback.
 */
export class BrowserArticleTasks {
  private readonly records = new Map<string, Record>();
  constructor(private readonly broker: BrowserTaskBroker) {}
  capability() {
    return {
      ...this.broker.capability(),
      destinationBound: this.broker.requiresDisclosure(),
      refreshAvailable: false as const,
      refreshCode: 'DIRECTORY_ROUTE_UNVERIFIED' as const,
    };
  }
  requiresDisclosure() {
    return this.broker.requiresDisclosure();
  }
  issue(
    url: string,
    owner: string,
    destination?: string,
    directoryPickConfirmed = false,
  ) {
    this.prune();
    if (
      this.records.size >= 32 ||
      [...this.records.values()].filter((record) =>
        ['waiting', 'claimed', 'ready', 'saving'].includes(record.status.state),
      ).length >= 4
    )
      throw new BrowserTaskError('TASK_CAPACITY', 409);
    const issued = this.broker.issue({ url }, destination);
    const record: Record = {
      status: {
        taskId: issued.taskId,
        expiresAt: issued.expiresAt,
        state: 'waiting',
        ...(destination ? { destinationBound: true } : {}),
      },
      owner,
      url,
      ...(destination ? { destination } : {}),
      ...(destination && directoryPickConfirmed
        ? { directoryPickConfirmed: true }
        : {}),
      timer: setTimeout(
        () => this.expire(record),
        Date.parse(issued.expiresAt) - Date.now(),
      ),
    };
    record.timer.unref?.();
    this.records.set(issued.taskId, record);
    void issued.result.then(
      (article) => {
        if (!['waiting', 'claimed'].includes(record.status.state)) return;
        if (Date.now() >= Date.parse(record.status.expiresAt)) {
          this.expire(record);
          return;
        }
        record.article = article;
        record.status.state = 'ready';
      },
      (error) => {
        if (!['waiting', 'claimed'].includes(record.status.state)) return;
        const code = error instanceof BrowserTaskError ? error.code : '';
        this.finish(
          record,
          code === 'TASK_EXPIRED'
            ? 'expired'
            : code === 'TASK_CANCELLED'
              ? 'cancelled'
              : 'failed',
          ['TASK_EXPIRED', 'TASK_CANCELLED'].includes(code)
            ? code
            : 'OBSERVATION_REJECTED',
        );
      },
    );
    return { ...record.status };
  }
  private prune() {
    for (const [id, record] of this.records) {
      if (
        Date.now() >= Date.parse(record.status.expiresAt) + 60_000 &&
        record.status.state !== 'saving'
      ) {
        this.expire(record);
        clearTimeout(record.timer);
        this.records.delete(id);
      }
    }
  }
  private get(taskId: unknown, owner: string) {
    this.prune();
    const record =
      typeof taskId === 'string' ? this.records.get(taskId) : undefined;
    if (!record || record.owner !== owner)
      throw new BrowserTaskError('TASK_GONE', 410);
    if (Date.now() >= Date.parse(record.status.expiresAt)) this.expire(record);
    return record;
  }
  status(taskId: unknown, owner: string) {
    const record = this.get(taskId, owner);
    if (['waiting', 'claimed'].includes(record.status.state)) {
      try {
        record.status.state = this.broker.phase(record.status.taskId);
      } catch {
        /* The result promise publishes the terminal status next microtask. */
      }
    }
    return { ...record.status };
  }
  cancel(taskId: unknown, owner: string) {
    const record = this.get(taskId, owner);
    if (record.status.state === 'saving')
      throw new BrowserTaskError('TASK_SAVING', 409);
    if (['waiting', 'claimed', 'ready'].includes(record.status.state)) {
      this.broker.cancel(record.status.taskId);
      this.finish(record, 'cancelled', 'TASK_CANCELLED');
    }
    return { ...record.status };
  }
  beginSave(taskId: unknown, owner: string) {
    const record = this.get(taskId, owner);
    if (record.status.code === 'SAVE_DIRECTORY_CHANGED')
      throw new BrowserTaskError('SAVE_DIRECTORY_CHANGED', 409);
    if (record.status.state !== 'ready' || !record.article)
      throw new BrowserTaskError('TASK_NOT_READY', 409);
    record.status.state = 'saving';
    delete record.status.code;
    clearTimeout(record.timer);
    return {
      url: record.url,
      article: record.article,
      ...(record.destination ? { destination: record.destination } : {}),
      ...(record.directoryPickConfirmed
        ? { directoryPickConfirmed: true }
        : {}),
    };
  }
  saved(taskId: unknown, owner: string) {
    this.finish(this.get(taskId, owner), 'saved');
  }
  saveFailed(
    taskId: unknown,
    owner: string,
    code:
      | 'SAVE_RETRY_REQUIRED'
      | 'SAVE_DIRECTORY_CHANGED' = 'SAVE_RETRY_REQUIRED',
  ) {
    const record = this.get(taskId, owner);
    if (Date.now() >= Date.parse(record.status.expiresAt)) {
      this.finish(record, 'expired', 'TASK_EXPIRED');
    } else {
      record.status.state = 'ready';
      record.status.code = code;
      record.timer = setTimeout(
        () => this.expire(record),
        Date.parse(record.status.expiresAt) - Date.now(),
      );
      record.timer.unref?.();
    }
  }
  private expire(record: Record) {
    if (!['waiting', 'claimed', 'ready'].includes(record.status.state)) return;
    this.broker.cancel(record.status.taskId);
    this.finish(record, 'expired', 'TASK_EXPIRED');
  }
  private finish(
    record: Record,
    state: BrowserArticleTaskStatus['state'],
    code?: string,
  ) {
    clearTimeout(record.timer);
    record.article = undefined;
    record.status = { ...record.status, state, ...(code ? { code } : {}) };
    if (!code) delete record.status.code;
  }
  close() {
    for (const record of this.records.values()) {
      this.broker.cancel(record.status.taskId);
      clearTimeout(record.timer);
      record.article = undefined;
    }
    this.records.clear();
  }
}
