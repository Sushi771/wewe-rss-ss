import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';

describe('terminal refresh admission (synthetic durable records only)', () => {
  const env = { ...process.env };
  const ids = Array.from({ length: 14 }, (_, i) => `MP_WXS_${1234500000 + i}`);
  const managers: Wechat2RssSubscriptionBatches[] = [];
  const ready = {
    state: 'succeeded',
    accepted: true,
    submissionUnknown: false,
    message: 'synthetic ready',
  };
  let root: string, clock: number, template: any;
  const file = (id: string) =>
    path.join(root, '.wechat2rss-subscription-batches', id + '.json');
  const disk = async (id: string) =>
    JSON.parse(await fs.readFile(file(id), 'utf8'));
  const make = (run = jest.fn().mockResolvedValue(ready)) => {
    const manager = new Wechat2RssSubscriptionBatches(
      () => path.join(root, 'fixture.db'),
      () => 'synthetic-terminal-admission',
      jest.fn().mockRejectedValue(Error('ADD_FORBIDDEN')),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    manager.attachRefresh(run);
    managers.push(manager);
    return { manager, run };
  };
  const seed = async (items: any[], overrides: any = {}) => {
    const record = {
      ...template,
      batchId: randomUUID(),
      intentKey: randomUUID().replaceAll('-', '').repeat(2),
      createdAt: clock - 5 * 86400000,
      updatedAt: clock - 5 * 86400000 + 1000,
      nextSubmissionAt: clock - 5 * 86400000,
      state: 'completed',
      items: items.map((item, index) => ({
        index,
        feedId: ids[index],
        message: 'synthetic old work',
        ...item,
      })),
      ...overrides,
    };
    await fs.writeFile(file(record.batchId), JSON.stringify(record));
    return record;
  };
  beforeEach(async () => {
    clock = Date.parse('2026-10-17T09:15:00+08:00');
    Object.assign(process.env, {
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      WECHAT2RSS_ENABLED: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-terminal-admission-'));
    await fs.writeFile(path.join(root, 'fixture.db'), 'synthetic');
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    const first = make();
    const initial = await first.manager.enqueueRefresh(
      ids,
      'a'.repeat(64),
      'scheduled-refresh',
    );
    template = await disk(initial.batchId);
    await fs.rm(file(initial.batchId));
    first.manager.close();
  });
  afterEach(async () => {
    managers.splice(0).forEach((m) => m.close());
    jest.restoreAllMocks();
    process.env = { ...env };
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^wewe-terminal-admission-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  it.each(['completed-exhausted', 'legacy-paused'])(
    'a new 14-source round proceeds after %s accepted cache work ends, never replaying its old claim',
    async (kind) => {
      const old = await seed(
        ids.map((_, i) =>
          i < 12
            ? { ...ready }
            : {
                state:
                  kind === 'legacy-paused'
                    ? i === 12
                      ? 'blocked'
                      : 'waiting'
                    : 'failed',
                accepted: true,
                submissionUnknown: false,
                stopBatch: i === 12,
                retryable: false,
                refreshChecks: 1,
                ...(kind === 'completed-exhausted'
                  ? { cacheRetryExhausted: 'deadline' }
                  : {}),
              },
        ),
        { state: kind === 'legacy-paused' ? 'paused' : 'completed' },
      );
      const { manager, run } = make();
      const next = await manager.enqueueRefresh(
        ids,
        'b'.repeat(64),
        'scheduled-refresh',
      );
      expect(next.items.filter((i) => i.state === 'queued')).toHaveLength(14);
      for (let i = 0; i < 14; i++) {
        await manager.runDue();
        clock += 30000;
      }
      expect(
        run.mock.calls.filter((c) => c[1] === 'submit').map((c) => c[0]),
      ).toEqual(ids);
      expect(run.mock.calls.every((c) => c[3]?.claimKey === next.batchId)).toBe(
        true,
      );
      expect(
        (await disk(old.batchId)).items
          .slice(12)
          .every((i: any) => i.accepted === true),
      ).toBe(true);
      manager.close();
      const restarted = make();
      await restarted.manager.init();
      expect(
        (
          await restarted.manager.enqueueRefresh(
            ids,
            'b'.repeat(64),
            'scheduled-refresh',
          )
        ).batchId,
      ).toBe(next.batchId);
      await restarted.manager.runDue();
      expect(restarted.run).not.toHaveBeenCalled();
    },
  );
  it.each([0, 5 * 86400000])(
    'retires plain queued children of a completed parent (age=%s) without reviving them on restart',
    async (age) => {
      const old = await seed([{ state: 'queued', accepted: false }], {
        createdAt: clock - age,
        updatedAt: clock - age,
        nextSubmissionAt: clock - age,
      });
      const first = make();
      await first.manager.init();
      await first.manager.runDue();
      first.manager.close();
      const { manager, run } = make();
      const next = await manager.enqueueRefresh(
        [ids[0]],
        'c'.repeat(64),
        'scheduled-refresh',
      );
      expect(next.items[0].state).toBe('queued');
      await manager.runDue();
      expect(run.mock.calls).toEqual([
        [ids[0], 'submit', true, { claimKey: next.batchId }],
      ]);
      expect((await disk(old.batchId)).items[0]).toMatchObject({
        state: 'cancelled',
        accepted: false,
      });
    },
  );
  it.each(['queued', 'running'])(
    'retains a genuinely active %s parent instead of issuing a duplicate',
    async (state) => {
      const old = await seed([{ state: 'queued', accepted: false }], {
        state,
        createdAt: clock - 60000,
        updatedAt: clock - 50000,
        nextSubmissionAt: clock - 60000,
      });
      const { manager, run } = make();
      const next = await manager.enqueueRefresh(
        [ids[0], ids[1]],
        'd'.repeat(64),
        'scheduled-refresh',
      );
      expect(next.items.map((i) => i.state)).toEqual(['skipped', 'queued']);
      for (let i = 0; i < 2; i++) {
        await manager.runDue();
        clock += 30000;
      }
      expect(run.mock.calls.filter((c) => c[0] === ids[0])).toEqual([
        [ids[0], 'submit', true, { claimKey: old.batchId }],
      ]);
    },
  );
  it('does not let a deadline field alone make an expired ordinary queue a valid retry', async () => {
    const old = await seed(
      [
        {
          state: 'queued',
          accepted: false,
          retryDeadlineAt: clock - 4 * 86400000,
        },
      ],
      { state: 'running' },
    );
    const { manager, run } = make();
    const next = await manager.enqueueRefresh(
      [ids[0]],
      'f'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.items[0].state).toBe('queued');
    await manager.runDue();
    expect((await disk(old.batchId)).items[0].state).toBe('cancelled');
    expect(run.mock.calls).toEqual([
      [ids[0], 'submit', true, { claimKey: next.batchId }],
    ]);
  });
  it('retains an explicit bounded preparation retry while its original budget is valid', async () => {
    const old = await seed(
      [
        {
          state: 'queued',
          accepted: false,
          submissionUnknown: false,
          retryable: true,
          stopBatch: false,
          preparationRetries: 2,
          retryDeadlineAt: clock - 60000 + 86400000,
          retryAfter: clock,
        },
      ],
      {
        createdAt: clock - 60000,
        updatedAt: clock - 50000,
        nextSubmissionAt: clock - 60000,
      },
    );
    const { manager, run } = make();
    const next = await manager.enqueueRefresh(
      [ids[0], ids[1]],
      'f'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.items.map((i) => i.state)).toEqual(['skipped', 'queued']);
    await manager.runDue();
    expect(run.mock.calls[0]).toEqual([
      ids[0],
      'submit',
      true,
      { claimKey: old.batchId },
    ]);
    expect((await disk(old.batchId)).items[0].preparationRetries).toBe(3);
  });
  it('keeps a live accepted cache receipt while retiring only the closed unsent tail', async () => {
    const old = await seed(
      [
        {
          state: 'waiting',
          accepted: true,
          submissionUnknown: false,
          refreshAfter: clock - 1,
        },
        { state: 'queued', accepted: false },
      ],
      {
        createdAt: clock - 60000,
        updatedAt: clock - 50000,
        nextSubmissionAt: clock - 60000,
      },
    );
    const { manager, run } = make();
    const next = await manager.enqueueRefresh(
      ids.slice(0, 2),
      'f'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.items.map((i) => i.state)).toEqual(['skipped', 'queued']);
    await manager.runDue();
    clock += 30000;
    await manager.runDue();
    expect(run.mock.calls.filter((c) => c[1] === 'submit')).toEqual([
      [ids[1], 'submit', true, { claimKey: next.batchId }],
    ]);
    expect(
      run.mock.calls.filter((c) => c[1] === 'cache').map((c) => c[0]),
    ).toEqual([ids[0]]);
    expect((await disk(old.batchId)).items[1].state).toBe('cancelled');
  });
  it('an ended historical cache receipt does not block a new intent preparation retry', async () => {
    const old = await seed([
      {
        state: 'failed',
        accepted: true,
        cacheRetryExhausted: 'deadline',
        stopBatch: false,
      },
    ]);
    const { manager, run } = make(
      jest
        .fn()
        .mockResolvedValueOnce({
          state: 'failed',
          accepted: false,
          submissionUnknown: false,
          retryable: true,
          stopBatch: false,
        })
        .mockResolvedValue(ready),
    );
    const next = await manager.enqueueRefresh(
      [ids[0]],
      'f'.repeat(64),
      'scheduled-refresh',
    );
    await manager.runDue();
    clock = (await disk(next.batchId)).items[0].retryAfter;
    await manager.runDue();
    expect(run.mock.calls.map((c) => c[3].claimKey)).toEqual([
      next.batchId,
      next.batchId,
    ]);
    expect((await disk(old.batchId)).items[0]).toMatchObject({
      accepted: true,
      cacheRetryExhausted: 'deadline',
    });
    expect((await disk(next.batchId)).items[0]).toMatchObject({
      state: 'succeeded',
      preparationRetries: 2,
    });
    expect((await disk(next.batchId)).items[0].waitingForReceipt).not.toBe(
      true,
    );
  });
  it.each([
    'submitting',
    'unknown',
    'queued-unknown',
    'claimed-queued',
    'waiting-unconfirmed',
  ])(
    'keeps %s evidence blocking across terminal parents and restart',
    async (kind) => {
      const item: any = {
        state:
          kind === 'submitting'
            ? 'submitting'
            : kind === 'claimed-queued' || kind === 'queued-unknown'
              ? 'queued'
              : kind === 'waiting-unconfirmed'
                ? 'waiting'
                : 'blocked',
        accepted: false,
      };
      if (kind === 'unknown' || kind === 'queued-unknown')
        item.submissionUnknown = true;
      if (kind === 'claimed-queued')
        item.refreshClaimedAt = clock - 4 * 86400000;
      const old = await seed([item]);
      const { manager, run } = make();
      await manager.enqueueRefresh(
        ids.slice(0, 2),
        'e'.repeat(64),
        'scheduled-refresh',
      );
      await manager.runDue();
      clock += 30000;
      await manager.runDue();
      expect(run.mock.calls.some((c) => c[0] === ids[0])).toBe(false);
      manager.close();
      const restarted = make();
      await restarted.manager.init();
      await restarted.manager.runDue();
      expect(restarted.run.mock.calls.some((c) => c[0] === ids[0])).toBe(false);
      expect((await disk(old.batchId)).items[0].accepted).toBe(false);
    },
  );
  it('does not steal an actual in-flight worker claim or submit again after its accepted response', async () => {
    let entered!: () => void, finish!: (value: any) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = make(
      jest.fn(() => {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }),
    );
    const original = await first.manager.enqueueRefresh(
      [ids[0]],
      '1'.repeat(64),
      'scheduled-refresh',
    );
    const running = first.manager.runDue();
    await started;
    const second = make();
    try {
      await expect(
        second.manager.enqueueRefresh(
          [ids[0]],
          '2'.repeat(64),
          'scheduled-refresh',
        ),
      ).rejects.toThrow('BATCH_BUSY');
      await second.manager.runDue();
      expect(second.run).not.toHaveBeenCalled();
    } finally {
      finish({
        state: 'waiting',
        accepted: true,
        submissionUnknown: false,
        message: 'accepted',
      });
      await running;
    }
    const next = await second.manager.enqueueRefresh(
      [ids[0]],
      '2'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.items[0].state).toBe('skipped');
    expect(next.retainedBatchIds).toContain(original.batchId);
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
  });
  it('keeps an ended explicit cache-only batch completed and its unsent history intact', async () => {
    const old = await seed(
      [
        { state: 'waiting', accepted: true, submissionUnknown: false },
        { state: 'queued', accepted: false },
      ],
      { cacheOnly: true },
    );
    const { manager, run } = make();
    const next = await manager.enqueueRefresh(
      ids.slice(0, 2),
      '3'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.items.map((i) => i.state)).toEqual(['queued', 'queued']);
    expect(await disk(old.batchId)).toMatchObject({
      state: 'completed',
      items: [
        expect.objectContaining({
          accepted: true,
          cacheRetryExhausted: 'deadline',
        }),
        expect.objectContaining({ state: 'queued', accepted: false }),
      ],
    });
    await manager.runDue();
    expect(run.mock.calls[0][3]).toEqual({ claimKey: next.batchId });
  });
  it('recovers a confirmed accepted submitting label only as cache work', async () => {
    await seed(
      [{ state: 'submitting', accepted: true, submissionUnknown: false }],
      { createdAt: clock - 60000, updatedAt: clock - 50000 },
    );
    const { manager, run } = make();
    const next = await manager.enqueueRefresh(
      [ids[0]],
      '4'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.items[0].state).toBe('skipped');
    await manager.runDue();
    expect(run.mock.calls).toEqual([
      [ids[0], 'cache', false, { cacheOnly: true }],
    ]);
  });
  it('releases an ambiguous historical claim only after read-only not-submitted proof, never by age alone', async () => {
    const old = await seed([
      {
        state: 'queued',
        accepted: false,
        refreshClaimedAt: clock - 4 * 86400000,
      },
    ]);
    const first = make();
    first.manager.attachReconciliation(jest.fn().mockResolvedValue('unknown'));
    await first.manager.runDue();
    expect(first.run).not.toHaveBeenCalled();
    first.manager.close();
    const next = make();
    const proof = jest.fn().mockResolvedValue('not-submitted');
    next.manager.attachReconciliation(proof);
    clock += 60000;
    await next.manager.runDue();
    expect(next.run).not.toHaveBeenCalled();
    expect(proof).toHaveBeenCalled();
    expect((await disk(old.batchId)).items[0]).toMatchObject({
      accepted: false,
      submissionUnknown: false,
      state: 'failed',
      retryExhausted: 'deadline',
    });
    const fresh = await next.manager.enqueueRefresh(
      [ids[0]],
      '5'.repeat(64),
      'scheduled-refresh',
    );
    await next.manager.runDue();
    expect(next.run.mock.calls).toEqual([
      [ids[0], 'submit', true, { claimKey: fresh.batchId }],
    ]);
  });
});
