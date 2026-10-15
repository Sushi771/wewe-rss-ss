import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';

function refreshCalls(run: { mock: { calls: unknown[][] } }) {
  return run.mock.calls.map((call) => {
    if (call[1] === 'submit')
      expect(call[3]).toEqual(
        expect.objectContaining({
          claimKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
        }),
      );
    return call[2] === false ? call.slice(0, 2) : call.slice(0, 3);
  });
}

describe('equivalent refresh intent coverage (synthetic only)', () => {
  let directory: string, clock: number, template: any;
  const managers: Wechat2RssSubscriptionBatches[] = [];
  const env = { ...process.env };
  const ids = Array.from({ length: 11 }, (_, i) => `MP_WXS_${2345600000 + i}`);
  const scope = 'wechat2rss-subscription-current-v1';
  const prepared = {
    state: 'failed',
    accepted: false,
    submissionUnknown: false,
    retryable: true,
    stopBatch: false,
    preparationRetries: 3,
    message: 'synthetic unsent preparation failure',
  };
  const ready = {
    state: 'succeeded',
    accepted: true,
    retryable: false,
    submissionUnknown: false,
    message: 'synthetic confirmed current refresh',
  };
  const file = (id: string) =>
    path.join(directory, '.wechat2rss-subscription-batches', `${id}.json`);
  const disk = async (id: string) =>
    JSON.parse(await fs.readFile(file(id), 'utf8'));
  const make = (run = jest.fn().mockResolvedValue(ready)) => {
    const manager = new Wechat2RssSubscriptionBatches(
      () => path.join(directory, 'fixture.db'),
      () => 'synthetic-coverage',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    manager.attachRefresh(run);
    managers.push(manager);
    return { manager, run };
  };
  const seed = async (
    feeds: string[],
    createdAt: number,
    outcome = prepared as any,
    overrides = {} as any,
  ) => {
    const record = {
      ...template,
      batchId: randomUUID(),
      intentKey: undefined,
      refreshScope: undefined,
      createdAt,
      updatedAt: createdAt + 1,
      nextSubmissionAt: createdAt,
      state: 'completed',
      items: feeds.map((feedId, index) => ({
        index,
        feedId,
        ...outcome,
        retryAfter: createdAt + 60000,
        retryDeadlineAt: createdAt + 86400000,
      })),
      ...overrides,
    };
    await fs.writeFile(file(record.batchId), JSON.stringify(record));
    return record;
  };
  beforeEach(async () => {
    clock = Date.parse('2026-10-14T14:20:00+08:00');
    Object.assign(process.env, {
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      WECHAT2RSS_ENABLED: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    });
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wewe-covered-intent-'),
    );
    await fs.writeFile(path.join(directory, 'fixture.db'), 'synthetic');
    const { manager } = make();
    const initial = await manager.enqueueRefresh(
      [ids[0]],
      'a'.repeat(64),
      'scheduled-refresh',
    );
    template = await disk(initial.batchId);
    await fs.rm(file(initial.batchId));
    manager.close();
  });
  afterEach(async () => {
    managers.splice(0).forEach((m) => m.close());
    for (const key of [
      'WECHAT2RSS_ACTIVE_SCHEDULE',
      'WECHAT2RSS_ENABLED',
      'ENABLE_SCHEDULED_UPDATES',
      'DISABLE_SCHEDULED_UPDATES',
    ]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('wewe-covered-intent-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  it('covers thirteen old preparation entries over eleven feeds using two later manual successes, retaining budgets and explainable skips', async () => {
    const morning = await seed(ids.slice(0, 2), clock - 5 * 3600000);
    const afternoon = await seed(ids, clock - 1200000);
    const manual = await seed(ids.slice(0, 2), clock - 60000, ready, {
      purpose: 'manual-refresh',
    });
    const { manager, run } = make();
    await manager.init();
    await manager.runDue();
    for (const original of [morning, afternoon]) {
      const current = await disk(original.batchId);
      for (let i = 0; i < 2; i++) {
        expect(current.items[i]).toMatchObject({
          state: 'skipped',
          accepted: false,
          preparationRetries: 3,
          retryAfter: original.items[i].retryAfter,
          retryDeadlineAt: original.items[i].retryDeadlineAt,
          supersededBy: { batchId: manual.batchId, scope },
        });
        expect(current.items[i].message).toContain('已被覆盖');
      }
    }
    const remaining = (await disk(afternoon.batchId)).items.slice(2);
    clock = Math.max(...remaining.map((item: any) => item.retryAfter));
    for (let i = 0; i < 9; i++) {
      await manager.runDue();
      clock += 30000;
    }
    expect(refreshCalls(run)).toEqual(
      ids.slice(2).map((feedId) => [feedId, 'submit', true]),
    );
    manager.close();
    const again = make();
    await again.manager.init();
    await again.manager.runDue();
    expect(again.run).not.toHaveBeenCalled();
  });
  it.each(['must-execute-batch', 'must-execute-item'])(
    'retains an explicitly required %s despite later success',
    async (kind) => {
      const original = await seed(
        [ids[0]],
        clock - 1200000,
        prepared,
        kind === 'must-execute-batch' ? { mustExecute: true } : {},
      );
      if (kind === 'must-execute-item') {
        original.items[0].mustExecute = true;
        await fs.writeFile(file(original.batchId), JSON.stringify(original));
      }
      await seed([ids[0]], clock - 60000, ready, { purpose: 'manual-refresh' });
      const { manager, run } = make();
      await manager.runDue();
      clock = (await disk(original.batchId)).items[0].retryAfter;
      await manager.runDue();
      expect(refreshCalls(run)).toContainEqual([ids[0], 'submit', true]);
      expect(
        (await disk(original.batchId)).items[0].supersededBy,
      ).toBeUndefined();
    },
  );
  it.each(['explicit-range', 'unknown-batch-field', 'unknown-item-field'])(
    'preserves %s for scope review instead of claiming completion or invoking the default operation',
    async (kind) => {
      const original = await seed(
        [ids[0]],
        clock - 1200000,
        prepared,
        kind === 'explicit-range'
          ? { refreshScope: 'historical-range-v2' }
          : kind === 'unknown-batch-field'
            ? { range: 'all-history' }
            : {},
      );
      if (kind === 'unknown-item-field') {
        original.items[0].range = 'all-history';
        await fs.writeFile(file(original.batchId), JSON.stringify(original));
      }
      await seed([ids[0]], clock - 60000, ready, { purpose: 'manual-refresh' });
      const { manager, run } = make();
      await manager.runDue();
      expect(run).not.toHaveBeenCalled();
      expect((await disk(original.batchId)).items[0]).toMatchObject({
        state: 'blocked',
        accepted: false,
        preparationRetries: 3,
        coverageReviewRequired: true,
        retryAfter: original.items[0].retryAfter,
        retryDeadlineAt: original.items[0].retryDeadlineAt,
      });
      expect(
        (await disk(original.batchId)).items[0].supersededBy,
      ).toBeUndefined();
    },
  );
  it.each([
    'older-request',
    'equal-time',
    'wrong-feed',
    'wrong-instance',
    'different-success-scope',
    'cache-only-success',
  ])('does not treat %s as newer equivalent success evidence', async (kind) => {
    const old = await seed([ids[0]], clock - 1200000);
    await seed(
      [kind === 'wrong-feed' ? ids[1] : ids[0]],
      kind === 'older-request'
        ? old.createdAt - 60000
        : kind === 'equal-time'
          ? old.createdAt
          : clock - 60000,
      ready,
      {
        purpose: 'manual-refresh',
        ...(kind === 'wrong-instance' ? { instance: 'b'.repeat(64) } : {}),
        ...(kind === 'different-success-scope'
          ? { refreshScope: 'historical-range-v2' }
          : {}),
        ...(kind === 'cache-only-success' ? { cacheOnly: true } : {}),
      },
    );
    const { manager, run } = make();
    await manager.runDue();
    clock = (await disk(old.batchId)).items[0].retryAfter;
    await manager.runDue();
    expect(refreshCalls(run)).toContainEqual([ids[0], 'submit', true]);
    expect((await disk(old.batchId)).items[0].supersededBy).toBeUndefined();
  });
  it.each(['accepted', 'unknown'])(
    'holds an old unsent intent while another %s receipt exists, without consuming its attempts',
    async (kind) => {
      const old = await seed([ids[0]], clock - 1200000);
      const other = await seed(
        [ids[0]],
        clock - 60000,
        kind === 'accepted'
          ? {
              state: 'waiting',
              accepted: true,
              message: 'synthetic pending accepted receipt',
              refreshAfter: clock + 60000,
            }
          : {
              state: 'blocked',
              accepted: false,
              submissionUnknown: true,
              stopBatch: false,
              message: 'synthetic unknown receipt',
            },
        { state: kind === 'accepted' ? 'running' : 'completed' },
      );
      const { manager, run } = make();
      const proof = jest.fn().mockResolvedValue('unknown');
      manager.attachReconciliation(proof);
      await manager.runDue();
      clock += 30000;
      await manager.runDue();
      expect(
        run.mock.calls.filter((call) => call[1] === 'submit'),
      ).toHaveLength(0);
      expect((await disk(old.batchId)).items[0]).toMatchObject({
        accepted: false,
        preparationRetries: 3,
        waitingForReceipt: true,
      });
      expect((await disk(other.batchId)).items[0].accepted).toBe(
        kind === 'accepted',
      );
      if (kind === 'unknown') expect(proof).toHaveBeenCalled();
    },
  );
  it('one recovered current refresh covers a later pending legacy intent for the same feed using its durable claim time', async () => {
    const first = await seed([ids[0]], clock - 1200000);
    const later = await seed([ids[0]], clock - 600000);
    const { manager, run } = make();
    const claimedAt = clock;
    await manager.runDue();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await disk(later.batchId)).items[0]).toMatchObject({
      state: 'skipped',
      accepted: false,
      preparationRetries: 3,
      supersededBy: { batchId: first.batchId, claimedAt },
    });
    clock += 30000;
    await manager.runDue();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reads and snapshots counts above the old limit without clamping budgets or changing production-like state', async () => {
    const original = await seed([ids[0]], clock - 600000, {
      ...prepared,
      preparationRetries: 8,
      retryExhausted: 'attempt-limit',
    });
    const before = await fs.readFile(file(original.batchId), 'utf8');
    const { manager } = make();
    expect((await manager.list())[0].items[0].preparationRetries).toBe(8);
    const backup = path.join(directory, 'snapshot', 'fixture.db');
    await fs.mkdir(path.dirname(backup));
    await fs.writeFile(backup, 'synthetic');
    await manager.snapshot(backup);
    expect(
      await fs.readFile(
        path.join(
          path.dirname(backup),
          '.wechat2rss-subscription-batches',
          `${original.batchId}.json`,
        ),
        'utf8',
      ),
    ).toBe(before);
    expect(await fs.readFile(file(original.batchId), 'utf8')).toBe(before);
  });
  it('finishes an old paused preparation-only batch after coverage so independent new slots are not swallowed', async () => {
    const old = await seed([ids[0]], clock - 1200000, prepared, {
      state: 'paused',
    });
    await seed([ids[0]], clock - 60000, ready, { purpose: 'manual-refresh' });
    const { manager } = make();
    await manager.runDue();
    expect((await disk(old.batchId)).state).toBe('completed');
    const next = await manager.enqueueRefresh(
      [ids[1]],
      'b'.repeat(64),
      'scheduled-refresh',
    );
    expect(next.items[0].state).toBe('queued');
  });
  it('accepted cache success covers the held original intent without a second submit callback', async () => {
    const old = await seed([ids[0]], clock - 1200000);
    const accepted = await seed(
      [ids[0]],
      clock - 60000,
      {
        state: 'waiting',
        accepted: true,
        message: 'synthetic accepted',
        refreshAfter: clock,
      },
      { state: 'running', purpose: 'manual-refresh' },
    );
    const { manager, run } = make();
    await manager.runDue();
    expect(refreshCalls(run)).toEqual([[ids[0], 'cache']]);
    expect((await disk(old.batchId)).items[0]).toMatchObject({
      state: 'skipped',
      accepted: false,
      preparationRetries: 3,
      waitingForReceipt: false,
      supersededBy: { batchId: accepted.batchId },
    });
  });
  it('read-only not-submitted proof releases held work; one current update covers both legacy intents', async () => {
    const old = await seed([ids[0]], clock - 1200000);
    const unknown = await seed([ids[0]], clock - 60000, {
      state: 'blocked',
      accepted: false,
      submissionUnknown: true,
      stopBatch: false,
      message: 'synthetic unknown',
    });
    const { manager, run } = make();
    const proof = jest.fn().mockResolvedValue('unknown');
    manager.attachReconciliation(proof);
    await manager.runDue();
    expect(run).not.toHaveBeenCalled();
    proof.mockResolvedValue('not-submitted');
    clock += 60000;
    await manager.runDue();
    expect(refreshCalls(run)).toEqual([[ids[0], 'submit', true]]);
    expect((await disk(old.batchId)).items[0].preparationRetries).toBe(4);
    expect((await disk(unknown.batchId)).items[0]).toMatchObject({
      state: 'skipped',
      accepted: false,
      preparationRetries: 1,
      supersededBy: { batchId: old.batchId },
    });
  });
});
