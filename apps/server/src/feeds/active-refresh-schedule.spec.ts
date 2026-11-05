import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ActiveRefreshScheduler,
  automaticSubmissionAllowed,
  latestActiveRefreshRound,
  nextActiveRefreshTime,
} from './active-refresh-schedule';

const time = (value: string) => Date.parse(`2026-10-12T${value}+08:00`);
describe('Shanghai active refresh schedule (offline)', () => {
  it('serializes completion read-modify-write against the next slot persistence', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'completion-slot-test-'),
    );
    const db = path.join(dir, 'synthetic.db');
    const file = path.join(dir, '.wechat2rss-active-schedule.json');
    await fs.writeFile(db, 'synthetic');
    await fs.writeFile(file, JSON.stringify({ version: 1, notBefore: 0 }));
    let finish!: () => void;
    let releaseWrite!: () => void;
    let completionEntered!: () => void;
    let acceptanceEntered!: () => void;
    const first = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const completing = new Promise<void>((resolve) => {
      completionEntered = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      acceptanceEntered = resolve;
    });
    const originalOpen = fs.open.bind(fs);
    let writes = 0;
    const open = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith('.tmp') && ++writes === 2) {
          completionEntered();
          await barrier;
        }
        return originalOpen(...args);
      });
    const enqueue = jest
      .fn()
      .mockImplementationOnce(() => {
        acceptanceEntered();
        return first;
      })
      .mockRejectedValueOnce(new Error('worker lock busy'));
    const scheduler = new ActiveRefreshScheduler(() => db, enqueue);
    try {
      const old = scheduler.tick(time('17:29:00'));
      await entered;
      finish();
      // The old callback has already read its pending state, but has not
      // renamed the file clearing it. This is the reviewed overwrite window.
      await completing;
      const next = expect(scheduler.tick(time('17:30:00'))).rejects.toThrow(
        'worker lock busy',
      );
      releaseWrite();
      await old;
      await next;
      expect(
        JSON.parse(await fs.readFile(file, 'utf8')).pending.intentKey,
      ).toBe(latestActiveRefreshRound(time('17:30:00'), 0)!.intentKey);
    } finally {
      finish();
      releaseWrite();
      open.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it.each(['09:15:00', '14:00:00', '17:30:00'])(
    'has a stable unique round at %s',
    (slot) => {
      const round = latestActiveRefreshRound(time(slot), 0)!;
      expect(round.due).toBe(time(slot));
      expect(round.label).toBe(`2026-10-12/${slot.slice(0, 5)}`);
      expect(latestActiveRefreshRound(time(slot) + 30000, 0)?.intentKey).toBe(
        round.intentKey,
      );
    },
  );
  it('ignores process timezone and offers only the newest executable missed slot', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(latestActiveRefreshRound(time('16:00:00'), 0)?.due).toBe(
        time('14:00:00'),
      );
      expect(
        new Set(
          ['09:15:00', '14:00:00', '17:30:00'].map(
            (slot) => latestActiveRefreshRound(time(slot), 0)?.intentKey,
          ),
        ).size,
      ).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it.each([
    '00:00:00',
    '05:59:59',
    '06:00:00',
    '09:14:59',
    '17:31:00',
    '23:59:59',
  ])('does not start a round at %s', (slot) => {
    expect(latestActiveRefreshRound(time(slot), 0)).toBeUndefined();
  });
  it('blackout closes exactly at 06:00; evening deployment starts tomorrow', () => {
    expect(automaticSubmissionAllowed(time('05:59:59'))).toBe(false);
    expect(automaticSubmissionAllowed(time('06:00:00'))).toBe(true);
    expect(nextActiveRefreshTime(time('18:00:00'))).toBe(
      Date.parse('2026-10-13T09:15:00+08:00'),
    );
    expect(nextActiveRefreshTime(time('09:15:00'))).toBe(time('14:00:00'));
    expect(latestActiveRefreshRound(NaN, 0)).toBeUndefined();
  });
  it('persists activation across instances and restarts without evening replay', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'active-schedule-test-'),
    );
    const db = path.join(dir, 'synthetic.db');
    await fs.writeFile(db, 'synthetic');
    const enqueue = jest.fn().mockResolvedValue({});
    try {
      const make = () => new ActiveRefreshScheduler(() => db, enqueue);
      await make().tick(time('18:00:00'));
      await make().tick(time('18:01:00'));
      await make().tick(time('23:59:59'));
      expect(enqueue).not.toHaveBeenCalled();
      await make().tick(Date.parse('2026-10-13T09:15:00+08:00'));
      expect(enqueue).toHaveBeenCalledTimes(1);
      enqueue.mockClear();
      await make().tick(Date.parse('2026-10-16T16:00:00+08:00'));
      expect(enqueue.mock.calls).toEqual([
        [
          latestActiveRefreshRound(Date.parse('2026-10-16T16:00:00+08:00'), 0)!
            .intentKey,
        ],
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('retains an observed 17:30 intent after DB/lock failure across restart and minute boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-slot-test-'));
    const db = path.join(dir, 'synthetic.db');
    const file = path.join(dir, '.wechat2rss-active-schedule.json');
    await fs.writeFile(db, 'synthetic');
    await fs.writeFile(file, JSON.stringify({ version: 1, notBefore: 0 }));
    const enqueue = jest
      .fn()
      .mockRejectedValueOnce(new Error('worker lock busy'))
      .mockResolvedValue({});
    const make = () => new ActiveRefreshScheduler(() => db, enqueue);
    try {
      await expect(make().tick(time('17:30:00'))).rejects.toThrow(
        'worker lock busy',
      );
      const intent = latestActiveRefreshRound(time('17:30:00'), 0)!.intentKey;
      expect(
        JSON.parse(await fs.readFile(file, 'utf8')).pending.intentKey,
      ).toBe(intent);
      await make().tick(time('17:31:00'));
      await make().tick(time('17:32:00'));
      expect(enqueue.mock.calls).toEqual([[intent], [intent]]);
      expect(
        JSON.parse(await fs.readFile(file, 'utf8')).pending,
      ).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('does not submit a retained previous-day intent in quiet hours or replay it the next day', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-quiet-test-'));
    const db = path.join(dir, 'synthetic.db');
    await fs.writeFile(db, 'synthetic');
    await fs.writeFile(
      path.join(dir, '.wechat2rss-active-schedule.json'),
      JSON.stringify({
        version: 1,
        notBefore: 0,
        pending: latestActiveRefreshRound(time('17:30:00'), 0),
      }),
    );
    const enqueue = jest.fn().mockResolvedValue({});
    try {
      const scheduler = new ActiveRefreshScheduler(() => db, enqueue);
      await scheduler.tick(Date.parse('2026-10-13T05:00:00+08:00'));
      await scheduler.tick(Date.parse('2026-10-13T06:00:00+08:00'));
      expect(enqueue).not.toHaveBeenCalled();
      await scheduler.tick(Date.parse('2026-10-13T09:15:00+08:00'));
      expect(enqueue.mock.calls).toEqual([
        [
          latestActiveRefreshRound(Date.parse('2026-10-13T09:15:00+08:00'), 0)!
            .intentKey,
        ],
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('records 17:30 while a 17:29 previous-slot acceptance is still waiting', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlap-slot-test-'));
    const db = path.join(dir, 'synthetic.db');
    const file = path.join(dir, '.wechat2rss-active-schedule.json');
    await fs.writeFile(db, 'synthetic');
    await fs.writeFile(file, JSON.stringify({ version: 1, notBefore: 0 }));
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const enqueue = jest
      .fn()
      .mockImplementationOnce(() => {
        started();
        return first;
      })
      .mockRejectedValueOnce(new Error('database locked'));
    const scheduler = new ActiveRefreshScheduler(() => db, enqueue);
    try {
      const waiting = scheduler.tick(time('17:29:00'));
      await entered;
      await expect(scheduler.tick(time('17:30:00'))).rejects.toThrow(
        'database locked',
      );
      const intent = latestActiveRefreshRound(time('17:30:00'), 0)!.intentKey;
      expect(
        JSON.parse(await fs.readFile(file, 'utf8')).pending.intentKey,
      ).toBe(intent);
      finish();
      await waiting;
      expect(
        JSON.parse(await fs.readFile(file, 'utf8')).pending.intentKey,
      ).toBe(intent);
      enqueue.mockResolvedValue({});
      await scheduler.tick(time('17:31:00'));
      expect(enqueue.mock.calls.map(([key]) => key)).toEqual([
        latestActiveRefreshRound(time('14:00:00'), 0)!.intentKey,
        intent,
        intent,
      ]);
    } finally {
      finish();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
