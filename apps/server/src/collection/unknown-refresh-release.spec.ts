import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';
import { batchStorageLock } from './batch-storage-lock';

describe('explicit unknown future-round release (owned files, no upstream)', () => {
  const originalEnv = { ...process.env };
  const oldId = '11111111-1111-4111-8111-111111111111';
  const ids = Array.from({ length: 14 }, (_, i) => `MP_WXS_${1234500000 + i}`);
  const originalIntent = 'a'.repeat(64),
    nextIntent = 'd'.repeat(64);
  const instance = 'synthetic-unknown-release';
  let root: string, clock: number, old: any;
  const managers: Wechat2RssSubscriptionBatches[] = [];
  const source = jest.fn();
  const run = jest.fn();
  const digest = (bytes: string) =>
    createHash('sha256').update(bytes).digest('hex');
  const file = () =>
    path.join(root, '.wechat2rss-subscription-batches', oldId + '.json');
  const make = () => {
    const m = new Wechat2RssSubscriptionBatches(
      () => path.join(root, 'fixture.db'),
      () => instance,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    m.attachRefresh(run);
    (m as any).attachUnknownReleaseSource?.(source);
    managers.push(m);
    return m;
  };
  const request = async (m: any, change: any = {}) => {
    const binding = await m.unknownRefreshReleaseBinding(oldId, ids[13]);
    const evidenceFile = path.join(root, 'observation.txt');
    await fs.writeFile(
      evidenceFile,
      'Synthetic operator-reviewed remote attempt and quiescence evidence; response unavailable.',
    );
    const raw = {
      version: 1,
      action: 'release-future-rounds-only',
      authorized: true,
      ...binding,
      approvedAt: clock,
      futureRoundNotBefore: clock + 60000,
      evidenceSha256: digest(await fs.readFile(evidenceFile, 'utf8')),
      ...change,
    };
    const approvalFile = path.join(root, 'approval.json');
    const text = JSON.stringify(raw);
    await fs.writeFile(approvalFile, text);
    return {
      batchId: oldId,
      feedId: ids[13],
      approvalFile,
      approvalSha256: digest(text),
      evidenceFile,
    };
  };
  beforeEach(async () => {
    clock = Date.parse('2026-10-17T15:00:00+08:00');
    Object.assign(process.env, {
      WECHAT2RSS_ENABLED: '1',
      WECHAT2RSS_ACTIVE_SCHEDULE: '1',
      ENABLE_SCHEDULED_UPDATES: '1',
      DISABLE_SCHEDULED_UPDATES: '0',
    });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'unknown-release-fixture-'));
    await fs.writeFile(path.join(root, 'fixture.db'), 'synthetic');
    await fs.mkdir(path.dirname(file()));
    old = {
      version: 1,
      batchId: oldId,
      instance: digest(instance),
      signature: 'b'.repeat(64),
      purpose: 'scheduled-refresh',
      intentKey: originalIntent,
      createdAt: clock - 3600000,
      updatedAt: clock - 3500000,
      nextSubmissionAt: clock - 3500000,
      state: 'completed',
      items: ids.map((feedId, index) => ({
        index,
        feedId,
        state: index === 13 ? 'blocked' : 'succeeded',
        accepted: index !== 13,
        submissionUnknown: index === 13,
        message:
          index === 13 ? 'Synthetic response uncertain' : 'Synthetic complete',
        ...(index === 13
          ? {
              refreshClaimedAt: clock - 3550000,
              stopBatch: false,
              retryable: false,
            }
          : {}),
      })),
    };
    await fs.writeFile(file(), JSON.stringify(old));
    source.mockReset().mockResolvedValue('c'.repeat(64));
    run.mockReset().mockResolvedValue({
      state: 'succeeded',
      accepted: true,
      submissionUnknown: false,
      message: 'Synthetic ready',
    });
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('REAL_NETWORK_FORBIDDEN'));
  });
  afterEach(async () => {
    managers.splice(0).forEach((m) => m.close());
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^unknown-release-fixture-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  it('reproduces permanent occupation without explicit evidence, even after stop and a day', async () => {
    old.state = 'stopped';
    await fs.writeFile(file(), JSON.stringify(old));
    clock += 86400000;
    const result = await make().enqueueRefresh(
      ids,
      nextIntent,
      'scheduled-refresh',
    );
    expect(result.items.filter((i) => i.state === 'queued')).toHaveLength(13);
    expect(result.coverage!.anomalies).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });
  it('releases only a new future intent, preserves original unknown and 13+1 coverage, and survives restart', async () => {
    const m: any = make();
    const input = await request(m);
    const schedule = jest.spyOn(m, 'schedule');
    await m.releaseUnknownRefreshOccupancy(input);
    expect(schedule).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    const sealed = await fs.readFile(file(), 'utf8');
    const original = await m.enqueueRefresh(
      ids,
      originalIntent,
      'scheduled-refresh',
    );
    expect(original.reused).toBe(true);
    expect(original.coverage).toMatchObject({
      completed: 13,
      anomalies: 1,
      fullyUpdated: false,
    });
    const before = await m.enqueueRefresh(
      ids,
      'e'.repeat(64),
      'scheduled-refresh',
    );
    expect(before.items[13].state).toBe('skipped');
    // The pre-boundary intent is durable and can never be turned into another request.
    clock += 60001;
    const restarted: any = make();
    const after = await restarted.enqueueRefresh(
      ids,
      nextIntent,
      'scheduled-refresh',
    );
    expect(after.items[13].state).toBe('queued');
    const repeated = await restarted.enqueueRefresh(
      ids,
      originalIntent,
      'scheduled-refresh',
    );
    expect(repeated.batchId).toBe(oldId);
    expect(await fs.readFile(file(), 'utf8')).toBe(sealed);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('repeated release is idempotent, including after its approval and future boundary have aged', async () => {
    const m: any = make(),
      input = await request(m);
    await m.releaseUnknownRefreshOccupancy(input);
    const sealed = await fs.readFile(file(), 'utf8');
    clock += 2 * 86400000;
    expect(
      (await (make() as any).releaseUnknownRefreshOccupancy(input)).reused,
    ).toBe(true);
    expect(await fs.readFile(file(), 'utf8')).toBe(sealed);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['completed', 'stopped'])(
    'admits all14 in a new round after explicit release of a %s parent, and never executes the old intent',
    async (state) => {
      old.state = state;
      await fs.writeFile(file(), JSON.stringify(old));
      const m: any = make();
      jest.spyOn(m, 'schedule').mockImplementation(() => {});
      const input = await request(m);
      const result = await m.releaseUnknownRefreshOccupancy(input);
      expect(JSON.stringify(result)).not.toMatch(
        /approval\.json|observation\.txt|unknown-release-fixture/,
      );
      const originalItem = JSON.parse(await fs.readFile(file(), 'utf8'))
        .items[13];
      clock += 60001;
      const next = await m.enqueueRefresh(ids, nextIntent, 'scheduled-refresh');
      expect(next.items.filter((i: any) => i.state === 'queued')).toHaveLength(
        14,
      );
      for (let i = 0; i < 14; i++) {
        await m.runDue();
        clock += 31000;
      }
      expect(run.mock.calls.filter((c) => c[1] === 'submit')).toHaveLength(14);
      expect(run.mock.calls.every((c) => c[3]?.claimKey === next.batchId)).toBe(
        true,
      );
      expect(JSON.parse(await fs.readFile(file(), 'utf8')).items[13]).toEqual(
        originalItem,
      );
      expect(
        (await m.enqueueRefresh(ids, originalIntent, 'scheduled-refresh'))
          .batchId,
      ).toBe(oldId);
      expect(run).toHaveBeenCalledTimes(14);
    },
  );
  it('requires the same evidence files to remain valid after restart, and rejects an instance change', async () => {
    const m: any = make(),
      input = await request(m);
    await m.releaseUnknownRefreshOccupancy(input);
    clock += 60001;
    m.instance = () => 'different-instance';
    expect(
      (await m.enqueueRefresh(ids, nextIntent, 'scheduled-refresh')).items[13]
        .state,
    ).toBe('skipped');
    m.instance = () => instance;
    await fs.unlink(input.approvalFile);
    expect(
      (
        await (make() as any).enqueueRefresh(
          ids,
          'f'.repeat(64),
          'scheduled-refresh',
        )
      ).items[13].state,
    ).toBe('skipped');
  });
  it.each(['future', 'stale'])(
    'rejects %s approval time instead of using time as evidence',
    async (kind) => {
      const m: any = make(),
        input = await request(m, {
          approvedAt: kind === 'future' ? clock + 1 : clock - 3600001,
        });
      await expect(m.releaseUnknownRefreshOccupancy(input)).rejects.toThrow(
        'UNKNOWN_RELEASE',
      );
      expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(old);
    },
  );
  it('retains an atomic release after its acknowledgement is lost and makes the retry idempotent', async () => {
    const m: any = make(),
      input = await request(m),
      write = m.persistWrite.bind(m);
    const lost = jest
      .spyOn(m, 'persistWrite')
      .mockImplementationOnce(async (b: any) => {
        await write(b);
        throw Error('synthetic acknowledgement lost');
      });
    await expect(m.releaseUnknownRefreshOccupancy(input)).rejects.toThrow();
    lost.mockRestore();
    expect((await m.releaseUnknownRefreshOccupancy(input)).reused).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it('does not overwrite an item changed between preview and commit', async () => {
    const m: any = make(),
      input = await request(m);
    source.mockImplementationOnce(async () => {
      old.items[13].message = 'concurrent changed evidence';
      await fs.writeFile(file(), JSON.stringify(old));
      return 'c'.repeat(64);
    });
    await expect(m.releaseUnknownRefreshOccupancy(input)).rejects.toThrow(
      'UNKNOWN_RELEASE',
    );
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(old);
  });
  it.each([
    'instance',
    'intentKey',
    'feedId',
    'batchId',
    'sourceSha256',
    'itemSha256',
    'authorized',
    'version',
    'evidenceSha256',
    'futureRoundNotBefore',
  ])(
    'rejects wrong %s authorization without changing the ledger',
    async (key) => {
      const m: any = make();
      let value: any = 'f'.repeat(64);
      if (key === 'feedId') value = ids[0];
      if (key === 'batchId') value = '22222222-2222-4222-8222-222222222222';
      if (key === 'authorized') value = false;
      if (key === 'version') value = 2;
      if (key === 'futureRoundNotBefore') value = clock - 1;
      const input = await request(m, { [key]: value });
      await expect(m.releaseUnknownRefreshOccupancy(input)).rejects.toThrow(
        'UNKNOWN_RELEASE',
      );
      expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(old);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it.each(['missing', 'empty', 'changed'])(
    'rejects %s evidence',
    async (kind) => {
      const m: any = make(),
        input = await request(m);
      if (kind === 'missing') await fs.unlink(input.evidenceFile);
      else
        await fs.writeFile(
          input.evidenceFile,
          kind === 'empty' ? '' : 'changed',
        );
      await expect(m.releaseUnknownRefreshOccupancy(input)).rejects.toThrow(
        'UNKNOWN_RELEASE',
      );
      expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(old);
    },
  );
  it('rejects a changed source both before release and before admitting a future round', async () => {
    const m: any = make(),
      input = await request(m);
    source.mockResolvedValue('f'.repeat(64));
    await expect(m.releaseUnknownRefreshOccupancy(input)).rejects.toThrow(
      'UNKNOWN_RELEASE',
    );
    source.mockResolvedValue('c'.repeat(64));
    await m.releaseUnknownRefreshOccupancy(input);
    clock += 60001;
    source.mockResolvedValue('f'.repeat(64));
    const next = await m.enqueueRefresh(ids, nextIntent, 'scheduled-refresh');
    expect(next.items[13].state).toBe('skipped');
  });
  it('cannot release while an old executor owns the mutex, and fences a stale writer after release', async () => {
    const m: any = make(),
      input = await request(m),
      stale = JSON.parse(await fs.readFile(file(), 'utf8'));
    const unlock = await batchStorageLock(path.dirname(file()));
    expect(unlock).toBeDefined();
    await expect(m.releaseUnknownRefreshOccupancy(input)).rejects.toThrow(
      'BATCH_BUSY',
    );
    await unlock!();
    await m.releaseUnknownRefreshOccupancy(input);
    const sealed = await fs.readFile(file(), 'utf8');
    stale.state = 'running';
    stale.items[13].state = 'queued';
    stale.items[13].submissionUnknown = false;
    const oldExecutor = JSON.parse(JSON.stringify(stale));
    expect(await m.write(stale)).toBe(false);
    await m.runRefresh(oldExecutor);
    expect(await fs.readFile(file(), 'utf8')).toBe(sealed);
    expect(run).not.toHaveBeenCalled();
  });
  it('does not reconcile the sealed historical unknown into SQL accepted', async () => {
    const m: any = make(),
      input = await request(m);
    await m.releaseUnknownRefreshOccupancy(input);
    const reconcile = jest.fn().mockResolvedValue('accepted');
    m.attachReconciliation(reconcile);
    await m.runDue();
    expect(reconcile).not.toHaveBeenCalled();
    expect(
      JSON.parse(await fs.readFile(file(), 'utf8')).items[13],
    ).toMatchObject({ accepted: false, submissionUnknown: true });
  });
  it.each(['preparation-failure', 'proven-not-submitted'])(
    'continues the bound future intent after %s and restart without replaying the released unknown',
    async (kind) => {
      const m: any = make();
      jest.spyOn(m, 'schedule').mockImplementation(() => {});
      await m.releaseUnknownRefreshOccupancy(await request(m));
      const sealed = await fs.readFile(file(), 'utf8');
      clock += 86400000;
      const next = await m.enqueueRefresh(
        [ids[13]],
        nextIntent,
        'scheduled-refresh',
      );
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(path.dirname(file()), next.batchId + '.json'),
            'utf8',
          ),
        ).items[0],
      ).toMatchObject({
        state: 'queued',
        releaseSourceSha256: 'c'.repeat(64),
      });
      if (kind === 'preparation-failure')
        run.mockResolvedValueOnce({
          state: 'failed',
          accepted: false,
          submissionUnknown: false,
          retryable: true,
          stopBatch: false,
          message: 'Synthetic preparation failed before submission',
        });
      else run.mockRejectedValueOnce(Error('Synthetic unconfirmed callback'));
      await m.runDue();
      expect(run).toHaveBeenCalledTimes(1);
      const nextFile = path.join(path.dirname(file()), next.batchId + '.json');
      const held = JSON.parse(await fs.readFile(nextFile, 'utf8'));
      // State left by the previous coverPreparation implementation at restart.
      held.items[0].waitingForReceipt = true;
      await fs.writeFile(nextFile, JSON.stringify(held));
      m.close();
      clock += 60001;
      const restarted: any = make();
      const reconcile = jest.fn().mockResolvedValue('not-submitted');
      restarted.attachReconciliation(reconcile);
      await restarted.runDue();
      expect(run).toHaveBeenCalledTimes(2);
      expect(
        run.mock.calls.every((call) => call[3]?.claimKey === next.batchId),
      ).toBe(true);
      expect(
        run.mock.calls.every(
          (call) => call[3]?.sourceSha256 === 'c'.repeat(64),
        ),
      ).toBe(true);
      expect(
        (await restarted.list()).find((b: any) => b.batchId === next.batchId),
      ).toMatchObject({ state: 'completed', items: [{ state: 'succeeded' }] });
      expect(
        JSON.parse(await fs.readFile(nextFile, 'utf8')).items[0]
          .waitingForReceipt,
      ).toBe(false);
      expect(await fs.readFile(file(), 'utf8')).toBe(sealed);
      expect(
        reconcile.mock.calls.every((call) => call[2] === next.batchId),
      ).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    'missing-source',
    'changed-source',
    'same-intent',
    'before-release',
    'before-boundary',
    'release-instance',
    'release-intent',
    'release-item',
    'changed-unknown',
    'new-unknown',
    'accepted-cache',
  ])(
    'keeps preparation waiting for %s instead of ignoring historical uncertainty globally',
    async (kind) => {
      const m: any = make();
      jest.spyOn(m, 'schedule').mockImplementation(() => {});
      await m.releaseUnknownRefreshOccupancy(await request(m));
      clock += 86400000;
      const next = await m.enqueueRefresh(
        [ids[13]],
        nextIntent,
        'scheduled-refresh',
      );
      const nextFile = path.join(path.dirname(file()), next.batchId + '.json');
      const current = JSON.parse(await fs.readFile(nextFile, 'utf8'));
      const prior = JSON.parse(await fs.readFile(file(), 'utf8'));
      const records = [prior, current];
      Object.assign(current.items[0], {
        retryable: true,
        submissionUnknown: false,
        stopBatch: false,
        waitingForReceipt: true,
      });
      if (kind === 'missing-source')
        delete current.items[0].releaseSourceSha256;
      if (kind === 'changed-source')
        current.items[0].releaseSourceSha256 = 'f'.repeat(64);
      if (kind === 'same-intent') current.intentKey = originalIntent;
      if (kind === 'before-release')
        current.createdAt = prior.items[13].occupancyRelease.resolvedAt;
      if (kind === 'before-boundary')
        current.createdAt =
          prior.items[13].occupancyRelease.futureRoundNotBefore - 1;
      if (kind === 'release-instance')
        prior.items[13].occupancyRelease.instance = 'f'.repeat(64);
      if (kind === 'release-intent')
        prior.items[13].occupancyRelease.intentKey = nextIntent;
      if (kind === 'release-item') prior.items[13].occupancyRelease.index = 12;
      if (kind === 'changed-unknown')
        prior.items[13].message = 'Changed unknown evidence';
      if (kind === 'new-unknown' || kind === 'accepted-cache') {
        const additional = JSON.parse(JSON.stringify(prior));
        additional.batchId = '22222222-2222-4222-8222-222222222222';
        additional.intentKey = 'f'.repeat(64);
        additional.createdAt = clock - 1000;
        additional.updatedAt = clock;
        additional.items = [{ ...additional.items[13], index: 0 }];
        delete additional.items[0].occupancyRelease;
        if (kind === 'accepted-cache')
          Object.assign(additional.items[0], {
            state: 'waiting',
            accepted: true,
            submissionUnknown: false,
          });
        records.push(additional);
        await fs.writeFile(
          path.join(path.dirname(file()), additional.batchId + '.json'),
          JSON.stringify(additional),
        );
      }
      await fs.writeFile(file(), JSON.stringify(prior));
      await fs.writeFile(nextFile, JSON.stringify(current));
      const sealed = await fs.readFile(file(), 'utf8');
      // Exercise the contextual predicate directly, including bindings that the
      // outer durable-record parser also rejects before any submission.
      await m.coverPreparation(records);
      expect(
        JSON.parse(await fs.readFile(nextFile, 'utf8')).items[0]
          .waitingForReceipt,
      ).toBe(true);
      expect(await fs.readFile(file(), 'utf8')).toBe(sealed);
      expect(run).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
  it('serializes a real concurrent stale receipt writer against release publication', async () => {
    const m: any = make(),
      other: any = make(),
      input = await request(m),
      stale = JSON.parse(await fs.readFile(file(), 'utf8'));
    let entered!: () => void, resume!: () => void;
    const atCommit = new Promise<void>((r) => (entered = r)),
      barrier = new Promise<void>((r) => (resume = r));
    const persist = m.persistWrite.bind(m);
    const pause = jest
      .spyOn(m, 'persistWrite')
      .mockImplementationOnce(async (b: any) => {
        entered();
        await barrier;
        return persist(b);
      });
    const release = m.releaseUnknownRefreshOccupancy(input);
    await atCommit;
    stale.state = 'running';
    stale.items[13].state = 'queued';
    stale.items[13].submissionUnknown = false;
    try {
      await expect(other.write(stale, 'receipt', 13)).rejects.toThrow(
        'BATCH_BUSY',
      );
    } finally {
      resume();
    }
    await release;
    pause.mockRestore();
    expect(await other.write(stale, 'receipt', 13)).toBe(false);
    expect(
      JSON.parse(await fs.readFile(file(), 'utf8')).items[13],
    ).toMatchObject({
      accepted: false,
      submissionUnknown: true,
      occupancyRelease: { action: 'release-future-rounds-only' },
    });
    expect(run).not.toHaveBeenCalled();
  });
});
