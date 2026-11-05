import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const DAY = 86400000;
const OFFSET = 8 * 3600000;
const SLOTS = [9 * 60 + 15, 14 * 60, 17 * 60 + 30];
const local = (now: number) => {
  const date = new Date(now + OFFSET);
  return {
    day: Math.floor((now + OFFSET) / DAY) * DAY - OFFSET,
    date: date.toISOString().slice(0, 10),
    minute: date.getUTCHours() * 60 + date.getUTCMinutes(),
  };
};
export const activeRefreshScheduleEnabled = (env: NodeJS.ProcessEnv) =>
  env.WECHAT2RSS_ACTIVE_SCHEDULE === '1' &&
  env.ENABLE_SCHEDULED_UPDATES === '1' &&
  env.DISABLE_SCHEDULED_UPDATES !== '1' &&
  env.WECHAT2RSS_ENABLED === '1';

/** Shanghai has a fixed UTC+08 offset. Never create an evening catch-up round. */
export function latestActiveRefreshRound(now: number, notBefore: number) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(notBefore)) return;
  const today = local(now);
  if (today.minute < SLOTS[0] || today.minute > SLOTS[2]) return;
  const minute = [...SLOTS].reverse().find((slot) => slot <= today.minute)!;
  const due = today.day + minute * 60000;
  if (due < notBefore) return;
  const label = `${today.date}/${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return {
    label,
    due,
    intentKey: createHash('sha256')
      .update(`wechat2rss-active-v1/${label}`)
      .digest('hex'),
  };
}
export function nextActiveRefreshTime(now: number) {
  const today = local(now);
  return (
    SLOTS.map((slot) => today.day + slot * 60000).find((due) => due > now) ??
    today.day + DAY + SLOTS[0] * 60000
  );
}
export function automaticSubmissionAllowed(now: number) {
  return local(now).minute >= 6 * 60;
}

/** The shared activation watermark prevents first deployment from replaying a
 * missed round. Restarts reuse it; only the latest same-day round is offered to
 * the durable queue, whose intentKey remains authoritative for acceptance. */
export class ActiveRefreshScheduler {
  private stateWork: Promise<void> = Promise.resolve();
  private accepting = new Set<string>();
  constructor(
    private readonly database: () => string,
    private readonly enqueue: (intentKey: string) => Promise<unknown>,
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
        '.wechat2rss-active-schedule.json',
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
      await this.enqueue(round.intentKey);
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
