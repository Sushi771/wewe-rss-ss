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
});
