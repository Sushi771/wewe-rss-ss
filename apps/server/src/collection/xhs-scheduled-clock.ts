import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { latestActiveRefreshRound, nextActiveRefreshTime, automaticSubmissionAllowed } from '../feeds/active-refresh-schedule';
const local = (now:number) => ({date:new Date(now+8*3600000).toISOString().slice(0,10)});
export class XhsScheduledClock {
  private stateWork: Promise<void> = Promise.resolve();
  private accepting = new Set<string>();
  constructor(
    private readonly database: () => string,
    private readonly enqueue: (round: string, intentKey: string) => Promise<unknown>,
  ) {}
  private stateChange<T>(work: () => Promise<T>): Promise<T> {
    const result = this.stateWork.then(work);
    this.stateWork = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async tick(now = Date.now()) {
    if (!Number.isSafeInteger(now)) return;
    const ready = await this.stateChange(async () => {
      const database = await fs.realpath(this.database());
      const file = path.join(
        path.dirname(database),
        '.xiaohongshu-active-schedule.json',
      );
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              version: 1,
              notBefore: nextActiveRefreshTime(now),
            }),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
        throw new Error('SCHEDULE_STATE_INVALID');
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.version !== 1 || !Number.isSafeInteger(state.notBefore))
        throw new Error('SCHEDULE_STATE_INVALID');
      const observed = latestActiveRefreshRound(now, state.notBefore);
      const pending = state.pending;
      if (pending !== undefined) {
        const expected = latestActiveRefreshRound(pending.due, state.notBefore);
        if (
          !expected ||
          expected.due !== pending.due ||
          expected.intentKey !== pending.intentKey
        )
          throw new Error('SCHEDULE_STATE_INVALID');
      }
      // A previously observed same-day intent survives acceptance failures,
      // including DB/worker-lock failures in the last 17:30 minute. A fresh
      // evening deployment still cannot invent an unobserved catch-up round.
      const round =
        pending &&
        local(pending.due).date === local(now).date &&
        (!observed || pending.due >= observed.due)
          ? pending
          : observed;
      if (!round || !automaticSubmissionAllowed(now)) return;
      const persist = async (next: typeof state) => {
        const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(next));
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fs.rename(temporary, file);
        } finally {
          await fs.unlink(temporary).catch(() => undefined);
        }
      };
      await persist({ ...state, pending: round });
      return { round, file, persist };
    });
    if (!ready) return;
    const { round, file, persist } = ready;
    // DB acceptance runs outside the short state critical section. A later
    // slot is queued for persistence rather than dropped by a busy callback.
    if (this.accepting.has(round.intentKey)) return;
    this.accepting.add(round.intentKey);
    try {
      await this.enqueue(round.label, round.intentKey);
      await this.stateChange(async () => {
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        if (current.pending?.intentKey === round.intentKey)
          await persist({
            version: 1,
            notBefore: Math.max(current.notBefore, round.due + 1),
          });
      });
    } finally {
      this.accepting.delete(round.intentKey);
    }
  }
}
