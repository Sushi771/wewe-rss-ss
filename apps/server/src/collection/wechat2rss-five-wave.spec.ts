import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BatchOutcome,
  PreparedRefresh,
  Wechat2RssSubscriptionBatches,
} from './wechat2rss-subscription-batches';

describe('five-request waves (offline)', () => {
  let directory: string,
    clock: number,
    managers: Wechat2RssSubscriptionBatches[];
  const ids = Array.from({ length: 14 }, (_, i) => `MP_WXS_${1234560000 + i}`);
  const accepted: BatchOutcome = {
    state: 'waiting',
    accepted: true,
    message: 'fixture accepted',
  };
  function make() {
    const m = new Wechat2RssSubscriptionBatches(
      () => path.join(directory, 'fixture.db'),
      () => 'fixture-instance',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    m.attachRefresh(async () => ({
      state: 'succeeded',
      accepted: true,
      textReady: true,
      listReady: true,
      message: 'fixture cache',
    }));
    managers.push(m);
    return m;
  }
  async function until(check: () => boolean) {
    for (let i = 0; i < 1000; i++) {
      if (check()) return;
      await new Promise<void>((r) => setTimeout(r, 2));
    }
    throw new Error('Fixture barrier not reached');
  }
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-five-wave-'));
    await fs.writeFile(path.join(directory, 'fixture.db'), 'fixture');
    clock = Date.parse('2026-10-14T01:00:00Z');
    managers = [];
  });
  afterEach(async () => {
    managers.forEach((m) => m.close());
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('wewe-five-wave-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  it.each([1, 4, 5, 6, 14])(
    'submits %i sources in full waves and one exact tail, never a sixth active request',
    async (n) => {
      const m = make();
      let active = 0,
        peak = 0,
        preparing = 0,
        preparePeak = 0;
      const waves: number[] = [];
      const released: Array<() => void> = [];
      let sent = 0;
      m.attachRefreshPreparation(async (): Promise<PreparedRefresh> => {
        preparing++;
        preparePeak = Math.max(preparePeak, preparing);
        await Promise.resolve();
        preparing--;
        return {
          release: () => {},
          submit: async () => {
            active++;
            sent++;
            peak = Math.max(peak, active);
            await new Promise<void>((r) => released.push(r));
            active--;
            return accepted;
          },
        };
      });
      const batch = await m.enqueueRefresh(ids.slice(0, n));
      while (sent < n) {
        const running = m.runDue();
        const count = Math.min(5, n - sent);
        await until(() => released.length === count);
        waves.push(released.length);
        const raw = JSON.parse(
          await fs.readFile(
            path.join(
              directory,
              '.wechat2rss-subscription-batches',
              batch.batchId + '.json',
            ),
            'utf8',
          ),
        );
        expect(
          raw.items.filter((i: any) => i.state === 'submitting'),
        ).toHaveLength(count);
        released.splice(0).forEach((r) => r());
        await running;
        const before = sent;
        await m.runDue();
        expect(sent).toBe(before);
        clock += 30000;
      }
      expect(waves).toEqual(
        Array.from({ length: Math.ceil(n / 5) }, (_, i) =>
          Math.min(5, n - i * 5),
        ),
      );
      expect(peak).toBe(Math.min(5, n));
      expect(preparePeak).toBe(1);
      for (let i = 0; i < n; i++) {
        await m.runDue();
        clock += 30000;
      }
      const final = (await m.list()).find((b) => b.batchId === batch.batchId);
      expect(final!.items.every((i) => i.accepted && i.textReady)).toBe(true);
    },
  );
  it('shares storage admission across managers and manual/scheduled records', async () => {
    const first = make(),
      second = make();
    let active = 0,
      peak = 0;
    const releases: Array<() => void> = [];
    const prepare = async () => ({
      release: () => {},
      submit: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        active--;
        return accepted;
      },
    });
    first.attachRefreshPreparation(prepare);
    second.attachRefreshPreparation(prepare);
    await first.enqueueRefresh(ids);
    const running = first.runDue();
    await until(() => releases.length === 5);
    await second.runDue();
    expect(releases).toHaveLength(5);
    releases.forEach((r) => r());
    await running;
    expect(peak).toBe(5);
  });
  it('retains an uncertain receipt without replay while independent sources proceed', async () => {
    const m = make();
    const calls: string[] = [];
    m.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        calls.push(id);
        if (id === ids[0]) throw new Error('fixture disconnect');
        return accepted;
      },
    }));
    const batch = await m.enqueueRefresh(ids.slice(0, 6));
    await m.runDue();
    clock += 30000;
    await m.runDue();
    expect(calls).toEqual(ids.slice(0, 6));
    expect(
      (await m.list()).find((b) => b.batchId === batch.batchId)!.items[0]
        .submissionUnknown,
    ).toBe(true);
    clock += 30000;
    await m.runDue();
    expect(calls.filter((id) => id === ids[0])).toHaveLength(1);
  });
  it('429 retains uncertainty, stops subsequent waves and enforces shared cooldown', async () => {
    const m = make();
    const calls: string[] = [];
    m.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        calls.push(id);
        if (id === ids[0]) throw new Error('WECHAT2RSS_RATE_LIMITED');
        return accepted;
      },
    }));
    const batch = await m.enqueueRefresh(ids);
    await m.runDue();
    expect(calls).toHaveLength(5);
    clock += 30000;
    await m.runDue();
    expect(calls).toHaveLength(5);
    const final = (await m.list()).find((b) => b.batchId === batch.batchId);
    expect(final!.state).toBe('paused');
    expect(final!.items[0].submissionUnknown).toBe(true);
  });
  it('known account restriction cancels prepared closures before launch', async () => {
    const m = make();
    const submit = jest.fn().mockResolvedValue(accepted),
      cancel = jest.fn();
    let count = 0;
    m.attachRefreshPreparation(async () =>
      ++count === 2
        ? {
            release: () => {},
            outcome: {
              state: 'blocked',
              accepted: false,
              stopBatch: true,
              sharedRestriction: true,
              message: 'fixture account restriction',
            },
          }
        : { release: () => {}, cancel, submit },
    );
    await m.enqueueRefresh(ids);
    await m.runDue();
    expect(submit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('preserves successful peers and schedules only failed preparation for a bounded retry', async () => {
    const m = make();
    const attempts: string[] = [],
      sent: string[] = [];
    let failed = false;
    m.attachRefreshPreparation(async (id) => {
      attempts.push(id);
      if (id === ids[1] && !failed) {
        failed = true;
        return {
          release: () => {},
          outcome: {
            state: 'failed',
            accepted: false,
            retryable: true,
            stopBatch: false,
            message: 'fixture backup failure',
          },
        };
      }
      return {
        release: () => {},
        submit: async () => {
          sent.push(id);
          return accepted;
        },
      };
    });
    const batch = await m.enqueueRefresh(ids.slice(0, 5));
    await m.runDue();
    expect(sent).toEqual([ids[0], ids[2], ids[3], ids[4]]);
    clock += 60000;
    await m.runDue();
    expect(sent.filter((id) => id === ids[1])).toHaveLength(1);
    expect(sent.filter((id) => id === ids[0])).toHaveLength(1);
    expect(
      (await m.list()).find((b) => b.batchId === batch.batchId)!.items[1]
        .preparationRetries,
    ).toBe(1);
  });
  it('retains unknown receipts after restart and never resets preparation budgets', async () => {
    const first = make(),
      calls: string[] = [];
    first.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        calls.push(id);
        throw new Error('fixture uncertain');
      },
    }));
    const batch = await first.enqueueRefresh(ids.slice(0, 5));
    await first.runDue();
    first.close();
    const next = make();
    next.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        calls.push(id);
        return accepted;
      },
    }));
    clock += 60000;
    await next.runDue();
    expect(calls).toHaveLength(5);
    expect(
      (await next.list())
        .find((b) => b.batchId === batch.batchId)!
        .items.every((i) => i.submissionUnknown),
    ).toBe(true);
  });
  it('models 14 network completions in 77s with serial 1s preparation, 3s network and 30s wave spacing', async () => {
    const m = make(),
      started = clock;
    const releases: Array<() => void> = [],
      launches: number[] = [];
    let sent = 0;
    m.attachRefreshPreparation(async () => {
      clock += 1000;
      return {
        release: () => {},
        submit: async () => {
          sent++;
          launches.push(clock - started);
          await new Promise<void>((r) => releases.push(r));
          return accepted;
        },
      };
    });
    const batch = await m.enqueueRefresh(ids);
    for (const count of [5, 5, 4]) {
      const pending = m.runDue();
      await until(() => releases.length === count);
      clock += 3000;
      releases.splice(0).forEach((r) => r());
      await pending;
      if (sent < 14) {
        const record = JSON.parse(
          await fs.readFile(
            path.join(
              directory,
              '.wechat2rss-subscription-batches',
              batch.batchId + '.json',
            ),
            'utf8',
          ),
        );
        clock = record.nextSubmissionAt;
      }
    }
    expect(launches).toEqual([
      ...Array(5).fill(5000),
      ...Array(5).fill(40000),
      ...Array(4).fill(74000),
    ]);
    expect(clock - started).toBe(77000);
  });
  it('shares one admission across manual and scheduled intents', async () => {
    const keys = [
      'WECHAT2RSS_ACTIVE_SCHEDULE',
      'ENABLE_SCHEDULED_UPDATES',
      'DISABLE_SCHEDULED_UPDATES',
      'WECHAT2RSS_ENABLED',
    ];
    const saved = keys.map((k) => process.env[k]);
    try {
      keys.forEach(
        (k) => (process.env[k] = k === 'DISABLE_SCHEDULED_UPDATES' ? '0' : '1'),
      );
      const m = make();
      let active = 0,
        peak = 0;
      const submitted: boolean[] = [];
      m.attachRefreshPreparation(async (_id, automatic) => ({
        release: () => {},
        submit: async () => {
          active++;
          peak = Math.max(peak, active);
          submitted.push(automatic);
          await Promise.resolve();
          active--;
          return accepted;
        },
      }));
      await m.enqueueRefresh(ids.slice(0, 5));
      await m.enqueueRefresh(
        ids.slice(5, 6),
        'a'.repeat(64),
        'scheduled-refresh',
      );
      for (let i = 0; i < 20; i++) {
        await m.runDue();
        clock += 30000;
      }
      expect(submitted.filter(Boolean)).toHaveLength(1);
      expect(submitted.filter((v) => !v)).toHaveLength(5);
      expect(peak).toBe(5);
    } finally {
      keys.forEach((k, i) =>
        saved[i] === undefined
          ? delete process.env[k]
          : (process.env[k] = saved[i]),
      );
    }
  });
  it('recovers all five interrupted claims as unknown after worker shutdown without replay', async () => {
    const first = make(),
      releases: Array<() => void> = [];
    first.attachRefreshPreparation(async () => ({
      release: () => {},
      submit: async () => {
        await new Promise<void>((r) => releases.push(r));
        return accepted;
      },
    }));
    const batch = await first.enqueueRefresh(ids.slice(0, 5));
    const pending = first.runDue();
    await until(() => releases.length === 5);
    first.close();
    releases.forEach((r) => r());
    await pending;
    const next = make(),
      submit = jest.fn().mockResolvedValue(accepted);
    next.attachRefreshPreparation(async () => ({ release: () => {}, submit }));
    clock += 60000;
    await next.runDue();
    const restored = (await next.list()).find(
      (b) => b.batchId === batch.batchId,
    )!;
    expect(
      restored.items.every(
        (i) =>
          i.submissionUnknown && i.accepted === false && i.state === 'blocked',
      ),
    ).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
  it('rechecks the automatic deadline after preparation without resetting its budget or sending', async () => {
    const keys = [
      'WECHAT2RSS_ACTIVE_SCHEDULE',
      'ENABLE_SCHEDULED_UPDATES',
      'DISABLE_SCHEDULED_UPDATES',
      'WECHAT2RSS_ENABLED',
    ];
    const saved = keys.map((k) => process.env[k]);
    try {
      keys.forEach(
        (k) => (process.env[k] = k === 'DISABLE_SCHEDULED_UPDATES' ? '0' : '1'),
      );
      const m = make(),
        submit = jest.fn().mockResolvedValue(accepted),
        cancel = jest.fn();
      m.attachRefreshPreparation(async () => {
        clock += 20;
        return { release: () => {}, cancel, submit };
      });
      const batch = await m.enqueueRefresh(
        ids.slice(0, 1),
        'b'.repeat(64),
        'scheduled-refresh',
      );
      const file = path.join(
        directory,
        '.wechat2rss-subscription-batches',
        batch.batchId + '.json',
      );
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      record.createdAt = clock - 24 * 3600000 + 10;
      Object.assign(record.items[0], {
        retryable: true,
        accepted: false,
        stopBatch: false,
        preparationRetries: 3,
        retryDeadlineAt: clock + 10,
      });
      await fs.writeFile(file, JSON.stringify(record));
      await m.runDue();
      const final = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(submit).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(final.items[0].preparationRetries).toBe(4);
      expect(final.items[0].retryExhausted).toBe('deadline');
    } finally {
      keys.forEach((k, i) =>
        saved[i] === undefined
          ? delete process.env[k]
          : (process.env[k] = saved[i]),
      );
    }
  });
  it('not-submitted proof cannot clear a 429 restriction; a separate fresh check may release temporary cooldown', async () => {
    const m = make(),
      calls: string[] = [];
    m.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        calls.push(id);
        if (id === ids[0] && calls.length === 1)
          throw new Error('WECHAT2RSS_RATE_LIMITED');
        return accepted;
      },
    }));
    const batch = await m.enqueueRefresh(ids.slice(0, 6));
    await m.runDue();
    m.attachReconciliation(async () => 'not-submitted');
    clock += 150000;
    await m.runDue();
    expect(calls).toHaveLength(5);
    let record = JSON.parse(
      await fs.readFile(
        path.join(
          directory,
          '.wechat2rss-subscription-batches',
          batch.batchId + '.json',
        ),
        'utf8',
      ),
    );
    expect(record.state).toBe('paused');
    expect(record.items[0].sharedRestriction).toBe(true);
    expect(record.items[0].submissionUnknown).toBe(false);
    const check = jest.fn().mockResolvedValue(false);
    m.attachRestrictionCheck(check);
    await m.runDue();
    expect(calls).toHaveLength(5);
    clock += 120000;
    check.mockResolvedValue(true);
    await m.runDue();
    record = JSON.parse(
      await fs.readFile(
        path.join(
          directory,
          '.wechat2rss-subscription-batches',
          batch.batchId + '.json',
        ),
        'utf8',
      ),
    );
    expect(record.items[0].sharedRestriction).toBe(false);
    expect(calls).toHaveLength(7);
  });
  it('known account restriction requires explicit resume plus a fresh healthy account check', async () => {
    const m = make(),
      send = jest.fn().mockResolvedValue(accepted);
    let first = true;
    m.attachRefreshPreparation(async () =>
      first
        ? ((first = false),
          {
            release: () => {},
            outcome: {
              state: 'blocked',
              accepted: false,
              sharedRestriction: true,
              restrictionKind: 'account',
              stopBatch: true,
              message: 'fixture account restriction',
            },
          })
        : { release: () => {}, submit: send },
    );
    const batch = await m.enqueueRefresh(ids.slice(0, 1));
    await m.runDue();
    const check = jest.fn().mockResolvedValue(true);
    m.attachRestrictionCheck(check);
    clock += 150000;
    await m.runDue();
    expect(check).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await m.resume(batch.batchId);
    await m.runDue();
    expect(check).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
