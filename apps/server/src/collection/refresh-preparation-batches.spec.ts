import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PreparedRefresh,
  Wechat2RssSubscriptionBatches,
} from './wechat2rss-subscription-batches';

describe('durable preparation failures without source submission (synthetic)', () => {
  let root: string, clock: number;
  const managers: Wechat2RssSubscriptionBatches[] = [];
  const ids = ['MP_WXS_1234567890', 'MP_WXS_2234567890'];
  const saved = new Map<string, string | undefined>();
  function make(prepare: () => Promise<PreparedRefresh>) {
    const m = new Wechat2RssSubscriptionBatches(
      () => path.join(root, 'fixture.db'),
      () => 'synthetic-only',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    m.attachRefresh(async () => {
      throw Error('SUBMISSION_FORBIDDEN');
    });
    m.attachRefreshPreparation(prepare);
    managers.push(m);
    return m;
  }
  beforeEach(async () => {
    clock = Date.parse('2026-11-13T01:00:00Z');
    for (const [key, value] of Object.entries({
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      WECHAT2RSS_ENABLED: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    })) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-prepare-diagnostic-'));
    await fs.writeFile(path.join(root, 'fixture.db'), 'synthetic, not SQLite');
  });
  afterEach(async () => {
    managers.splice(0).forEach((m) => m.close());
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    if (
      path.basename(root).startsWith('wewe-prepare-diagnostic-') &&
      (await fs.realpath(path.dirname(root))) ===
        (await fs.realpath(os.tmpdir()))
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('persists a source protection block across restart without retrying, skipping, or unknown conversion', async () => {
    const prepare = jest.fn(async () => {
      throw Error('WECHAT2RSS_SOURCE_STOPPED');
    });
    const first = make(prepare);
    const created = await first.enqueueRefresh(
      ids,
      '1'.repeat(64),
      'scheduled-refresh',
    );
    await first.runDue();
    expect(prepare).toHaveBeenCalledTimes(1);
    const read = (await first.list()).find(
      (x) => x.batchId === created.batchId,
    )!;
    expect(read.state).toBe('paused');
    expect(read.items[0]).toMatchObject({
      state: 'blocked',
      accepted: false,
      submissionUnknown: false,
      stopBatch: true,
      preparationFailure: {
        code: 'WECHAT2RSS_SOURCE_STOPPED',
        stage: 'prepare-callback',
      },
    });
    expect(read.items[1].state).toBe('queued');
    first.close();
    clock += 25 * 3600000;
    const recovered = make(prepare);
    await recovered.runDue();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(
      (await recovered.list()).find((x) => x.batchId === created.batchId)!
        .items[0],
    ).toMatchObject({
      state: 'blocked',
      accepted: false,
      submissionUnknown: false,
      preparationFailure: read.items[0].preparationFailure,
    });
  });
  it('retains code/stage through all eight original backoffs and terminal exhaustion after restart', async () => {
    const prepare = jest.fn(async () => {
      throw Error('WECHAT2RSS_NETWORK_ERROR');
    });
    let m = make(prepare);
    await m.enqueueRefresh(
      ids.slice(0, 1),
      '2'.repeat(64),
      'scheduled-refresh',
    );
    for (let attempt = 1; attempt <= 8; attempt++) {
      await m.runDue();
      expect(prepare).toHaveBeenCalledTimes(attempt);
      const item = (await m.list())[0].items[0];
      expect(item.preparationFailure).toEqual({
        code: 'WECHAT2RSS_NETWORK_ERROR',
        stage: 'prepare-callback',
      });
      expect(item.preparationRetries).toBe(attempt);
      if (attempt < 8) {
        expect(item.state).toBe('queued');
        expect(item.retryAfter).toBe(
          clock + Math.min(1800000, 30000 * 2 ** attempt),
        );
        clock = item.retryAfter! - 1;
        await m.runDue();
        expect(prepare).toHaveBeenCalledTimes(attempt);
        clock++;
      } else
        expect(item).toMatchObject({
          state: 'failed',
          retryExhausted: 'attempt-limit',
          accepted: false,
          submissionUnknown: false,
        });
      if (attempt === 2) {
        m.close();
        m = make(prepare);
      }
    }
    expect((await m.list())[0].state).toBe('completed');
    clock += 1800000;
    await m.runDue();
    expect(prepare).toHaveBeenCalledTimes(8);
  });
  it('never reclassifies an invoked closure source-stopped error as safe preparation or replays an unknown', async () => {
    const send = jest.fn(async () => {
      throw Error('WECHAT2RSS_SOURCE_STOPPED');
    });
    const prepare = jest
      .fn(async () => ({ release: () => {}, submit: send }))
      .mockRejectedValueOnce(Error('WECHAT2RSS_NETWORK_ERROR'));
    const first = make(prepare);
    await first.enqueueRefresh(
      ids.slice(0, 1),
      '3'.repeat(64),
      'scheduled-refresh',
    );
    await first.runDue();
    const preparation = (await first.list())[0].items[0];
    expect(preparation.preparationFailure?.code).toBe(
      'WECHAT2RSS_NETWORK_ERROR',
    );
    clock = preparation.retryAfter!;
    await first.runDue();
    const original = (await first.list())[0].items[0];
    expect(original).toMatchObject({
      state: 'blocked',
      accepted: false,
      submissionUnknown: true,
    });
    expect(original.preparationFailure).toBeUndefined();
    first.close();
    clock += 3600000;
    const recovered = make(prepare);
    await recovered.runDue();
    expect(send).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect((await recovered.list())[0].items[0]).toMatchObject({
      accepted: false,
      submissionUnknown: true,
    });
  });
  it('clears an earlier preparation diagnostic when a later closure is accepted', async () => {
    const send = jest.fn(async () => ({
      state: 'waiting' as const,
      accepted: true,
      submissionUnknown: false,
      stopBatch: false,
      message: 'synthetic accepted',
    }));
    const prepare = jest
      .fn(async () => ({ release: () => {}, submit: send }))
      .mockRejectedValueOnce(Error('WECHAT2RSS_REQUEST_TIMEOUT'));
    const m = make(prepare);
    await m.enqueueRefresh(
      ids.slice(0, 1),
      '5'.repeat(64),
      'scheduled-refresh',
    );
    await m.runDue();
    const first = (await m.list())[0].items[0];
    expect(first.preparationFailure).toBeDefined();
    clock = first.retryAfter!;
    await m.runDue();
    const item = (await m.list())[0].items[0];
    expect(item).toMatchObject({ accepted: true, submissionUnknown: false });
    expect(item.preparationFailure).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps the diagnostic and performs no extra preparation after the original 24-hour retry deadline', async () => {
    const prepare = jest.fn(async () => {
      throw Error('WECHAT2RSS_REQUEST_TIMEOUT');
    });
    const m = make(prepare);
    await m.enqueueRefresh(
      ids.slice(0, 1),
      '4'.repeat(64),
      'scheduled-refresh',
    );
    await m.runDue();
    clock += 24 * 3600000;
    await m.runDue();
    const item = (await m.list())[0].items[0];
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(item).toMatchObject({
      state: 'failed',
      retryExhausted: 'deadline',
      accepted: false,
      submissionUnknown: false,
      preparationFailure: {
        code: 'WECHAT2RSS_REQUEST_TIMEOUT',
        stage: 'prepare-callback',
      },
    });
  });
});
