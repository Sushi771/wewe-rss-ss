import { AsyncLocalStorage } from 'node:async_hooks';
import { assertIncrementalWriteAdmission } from './incremental-write';

type Kind = 'write' | 'backup';
type Entry = {
  kind: Kind;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Admission is BEFORE Prisma's engine/connection/transaction. No replay. */
export class SqliteWriteCoordinator {
  private writes = 0;
  private backup = false;
  private queue: Entry[] = [];
  private fences = new Set<object>();
  private context = new AsyncLocalStorage<{ active: boolean }>();

  constructor(
    private waitMs = 75000,
    private maxQueued = 256,
  ) {}

  fence(owner: object) {
    this.fences.add(owner);
  }

  unfence(owner: object) {
    this.fences.delete(owner);
    this.drain();
  }

  hasWriteAdmission() {
    return this.context.getStore()?.active === true;
  }

  private acquire(kind: Kind): Promise<() => void> {
    if (this.queue.length >= this.maxQueued)
      return Promise.reject(
        new Error('SQLite 写入等待队列已满，本次尚未开始写入'),
      );
    return new Promise((resolve, reject) => {
      const entry: Entry = {
        kind,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new Error('SQLite 备份协调等待超时，本次尚未开始写入'));
          this.drain();
        }, this.waitMs),
      };
      this.queue.push(entry);
      this.drain();
    });
  }

  private drain() {
    if (this.backup || this.fences.size) return;
    while (this.queue.length) {
      const entry = this.queue[0];
      if (entry.kind === 'backup' && this.writes) return;
      this.queue.shift();
      clearTimeout(entry.timer);
      if (entry.kind === 'backup') this.backup = true;
      else this.writes++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        if (entry.kind === 'backup') this.backup = false;
        else this.writes--;
        this.drain();
      });
      if (entry.kind === 'backup') return;
    }
  }

  async write<T>(operation: () => Promise<T>): Promise<T> {
    // Transaction middleware runs inside the admission acquired by $transaction.
    // Expired detached async contexts must not bypass a later backup.
    let release: () => void;
    const nested = this.context.getStore()?.active === true;
    if (nested) {
      // Track nested admission independently: a deliberately detached operation
      // can outlive its caller and must still prevent a backup from starting.
      this.writes++;
      release = () => {
        this.writes--;
        this.drain();
      };
    } else {
      release = await this.acquire('write');
    }
    const permit = { active: true };
    try {
      const incremental = assertIncrementalWriteAdmission();
      if (incremental) await incremental;
      if (!nested && this.fences.size)
        throw new Error('SQLite write fenced before engine execution');
      return await this.context.run(permit, operation);
    } finally {
      permit.active = false;
      release();
    }
  }

  async snapshot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active)
      throw new Error('不能在已开始的 SQLite 事务中申请备份');
    const release = await this.acquire('backup');
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// One configured application database. External maintenance writers are outside
// this process and must not run concurrently with production backup operations.
export const sqliteWrites = new SqliteWriteCoordinator();
