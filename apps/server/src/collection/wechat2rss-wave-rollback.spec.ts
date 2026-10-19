import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';
import * as rollbackCompatibility from '../../../../scripts/local-release/refresh-wave-rollback-compat.cjs';

const { compatibleSerialRefreshWorker } = rollbackCompatibility;
// Exact historical serial worker, pinned locally so CI needs no branch refs.
// Original commit f82fadeba752cffbc8934010c0bd05dc35b88675.
const serial = readFileSync(
  path.resolve(
    __dirname,
    '../../scripts/fixtures/serial-refresh-worker.f82fade.ts.txt',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
if (
  createHash('sha256').update(serial).digest('hex') !==
  'b9428c814237d2eb60d55424619c2107418163c50ffe8a8793b10d5931658617'
)
  throw new Error('SERIAL_WORKER_FIXTURE_CHANGED');
function loadWorker(source: string): typeof Wechat2RssSubscriptionBatches {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const exported: Record<string, unknown> = {};
  vm.runInNewContext(compiled, {
    exports: exported,
    require: (name: string) => require(name),
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  return exported.Wechat2RssSubscriptionBatches as typeof Wechat2RssSubscriptionBatches;
}
const Legacy = loadWorker(serial),
  Compatible = loadWorker(compatibleSerialRefreshWorker(serial));

describe('actual serial rollback worker (offline)', () => {
  let directory: string,
    clock: number,
    managers: Wechat2RssSubscriptionBatches[];
  const ids = Array.from({ length: 5 }, (_, i) => `MP_WXS_${1234567000 + i}`);
  const accepted = {
    state: 'waiting' as const,
    accepted: true,
    message: 'fixture accepted',
  };
  const make = (Type: typeof Wechat2RssSubscriptionBatches) => {
    const worker = new Type(
      () => path.join(directory, 'fixture.db'),
      () => 'fixture-account',
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => clock,
    );
    managers.push(worker);
    return worker;
  };
  const file = (id: string) =>
    path.join(directory, '.wechat2rss-subscription-batches', id + '.json');
  it.each([
    ['wave', Wechat2RssSubscriptionBatches],
    ['compatible serial', Compatible],
  ])(
    '%s records stopped interrupted claims as unknown without restart',
    async (_name, Type) => {
      const worker = make(Type as typeof Wechat2RssSubscriptionBatches);
      jest.spyOn(worker as any, 'schedule').mockImplementation(() => {});
      const submit = jest.fn();
      worker.attachRefresh(submit);
      const batch = await worker.enqueueRefresh(ids);
      const record = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
      record.state = 'stopped';
      record.items.forEach((item: any) => {
        item.state = 'submitting';
        item.preparationRetries = 3;
      });
      await fs.writeFile(file(batch.batchId), JSON.stringify(record));
      await worker.runDue();
      const retained = JSON.parse(
        await fs.readFile(file(batch.batchId), 'utf8'),
      );
      expect(retained.state).toBe('stopped');
      expect(
        retained.items.every(
          (item: any) =>
            item.state === 'blocked' &&
            item.submissionUnknown &&
            item.preparationRetries === 3,
        ),
      ).toBe(true);
      expect(submit).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['wave', Wechat2RssSubscriptionBatches],
    ['compatible serial', Compatible],
  ])(
    '%s retains a late receipt without undoing queued stop',
    async (_name, Type) => {
      const worker = make(Type as typeof Wechat2RssSubscriptionBatches);
      jest.spyOn(worker as any, 'schedule').mockImplementation(() => {});
      worker.attachRefresh(jest.fn());
      const batch = await worker.enqueueRefresh(ids.slice(0, 2));
      const record = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
      record.state = 'running';
      record.items[0].state = 'submitting';
      await fs.writeFile(file(batch.batchId), JSON.stringify(record));
      const internal = worker as any;
      const persist = internal.persistWrite.bind(worker);
      let unblock!: () => void;
      let blocked = false;
      jest
        .spyOn(internal, 'persistWrite')
        .mockImplementationOnce(async (b: any) => {
          blocked = true;
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
          return persist(b);
        });
      const writes = jest.spyOn(internal, 'write');
      const preceding = internal.write(record);
      await until(() => blocked);
      const stopping = worker.stop(batch.batchId);
      await until(() => writes.mock.calls.length >= 2);
      const receipt = JSON.parse(JSON.stringify(record));
      Object.assign(receipt.items[0], {
        state: 'waiting',
        accepted: true,
        submissionUnknown: false,
        message: 'fixture accepted',
      });
      const saving = internal.write(receipt, 'receipt', 0);
      unblock();
      await preceding;
      await stopping;
      expect(await saving).toBe(true);
      const retained = JSON.parse(
        await fs.readFile(file(batch.batchId), 'utf8'),
      );
      expect(retained.state).toBe('stopped');
      expect(retained.items[0]).toMatchObject({
        state: 'waiting',
        accepted: true,
      });
      expect(retained.items[1].state).toBe('cancelled');
    },
  );
  it.each([
    ['wave', Wechat2RssSubscriptionBatches],
    ['compatible serial', Compatible],
  ])(
    '%s keeps a queued stop ahead of restriction release',
    async (_name, Type) => {
      const worker = make(Type as typeof Wechat2RssSubscriptionBatches);
      jest.spyOn(worker as any, 'schedule').mockImplementation(() => {});
      worker.attachRefresh(jest.fn());
      const batch = await worker.enqueueRefresh(ids.slice(0, 2));
      const record = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
      record.state = 'paused';
      Object.assign(record.items[0], {
        state: 'blocked',
        sharedRestriction: true,
        restrictionKind: 'rate-limit',
        stopBatch: true,
        accepted: false,
      });
      await fs.writeFile(file(batch.batchId), JSON.stringify(record));
      const internal = worker as any;
      const persist = internal.persistWrite.bind(worker);
      let unblock!: () => void;
      let blocked = false;
      jest
        .spyOn(internal, 'persistWrite')
        .mockImplementationOnce(async (b: any) => {
          blocked = true;
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
          return persist(b);
        });
      const writes = jest.spyOn(internal, 'write');
      const preceding = internal.write(record);
      await until(() => blocked);
      const stopping = worker.stop(batch.batchId);
      await until(() => writes.mock.calls.length >= 2);
      worker.attachRestrictionCheck(async () => true);
      const releasing = internal.releaseSharedRestriction(record);
      await until(() => writes.mock.calls.length >= 3);
      unblock();
      await preceding;
      await stopping;
      expect(await releasing).toBe(false);
      const retained = JSON.parse(
        await fs.readFile(file(batch.batchId), 'utf8'),
      );
      expect(retained.state).toBe('stopped');
      expect(retained.items[0].sharedRestriction).toBe(true);
      expect(retained.items[0].state).toBe('blocked');
      expect(retained.items[1].state).toBe('cancelled');
    },
  );
  it.each([
    ['wave', Wechat2RssSubscriptionBatches],
    ['compatible serial', Compatible],
  ])(
    '%s preserves a stop while an account check awaits',
    async (_name, Type) => {
      const worker = make(Type as typeof Wechat2RssSubscriptionBatches);
      jest.spyOn(worker as any, 'schedule').mockImplementation(() => {});
      const submit = jest.fn();
      worker.attachRefresh(submit);
      const holder = await worker.enqueueRefresh(ids.slice(0, 1));
      const old = { batchId: randomUUID() };
      const blocked = JSON.parse(
        await fs.readFile(file(holder.batchId), 'utf8'),
      );
      blocked.state = 'paused';
      Object.assign(blocked.items[0], {
        state: 'blocked',
        sharedRestriction: true,
        restrictionKind: 'rate-limit',
        stopBatch: true,
        accepted: false,
      });
      await fs.writeFile(file(holder.batchId), JSON.stringify(blocked));
      const previous = JSON.parse(
        await fs.readFile(file(holder.batchId), 'utf8'),
      );
      previous.batchId = old.batchId;
      previous.items = ids.slice(1, 3).map((feedId, index) => ({
        index,
        feedId,
        state: 'queued',
        message: 'fixture pending',
        retryable: true,
        accepted: false,
        stopBatch: false,
      }));
      previous.purpose = 'scheduled-refresh';
      previous.intentKey = 'c'.repeat(64);
      previous.state = 'paused';
      Object.assign(previous.items[0], {
        state: 'failed',
        retryable: true,
        accepted: false,
        stopBatch: false,
        preparationRetries: 3,
      });
      await fs.writeFile(file(old.batchId), JSON.stringify(previous));
      let finish!: (clear: boolean) => void;
      let entered = false;
      worker.attachRestrictionCheck(() => {
        if (entered) return Promise.resolve(false);
        entered = true;
        return new Promise<boolean>((resolve) => {
          finish = resolve;
        });
      });
      const due = worker.runDue();
      await until(() => entered);
      await worker.stop(old.batchId);
      finish(false);
      await due;
      // Recovery must also reject a stale object at its persistence boundary.
      await (worker as any).recoverPreparation(previous);
      const retained = JSON.parse(await fs.readFile(file(old.batchId), 'utf8'));
      expect(retained.state).toBe('stopped');
      expect(retained.items[0].state).toBe('failed');
      expect(retained.items[0].preparationRetries).toBe(3);
      expect(retained.items[1].state).toBe('cancelled');
      expect(submit).not.toHaveBeenCalled();
    },
  );
  async function until(check: () => boolean) {
    for (let i = 0; i < 1000; i++) {
      if (check()) return;
      await new Promise<void>((r) => setTimeout(r, 2));
    }
    throw new Error('Fixture barrier not reached');
  }
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-wave-rollback-'));
    await fs.writeFile(path.join(directory, 'fixture.db'), 'fixture');
    clock = Date.parse('2026-10-14T01:00:00Z');
    managers = [];
  });
  afterEach(async () => {
    managers.forEach((m) => m.close());
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('wewe-wave-rollback-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  it('compatible worker honors restriction, unknown and cooldown from new state', async () => {
    const current = make(Wechat2RssSubscriptionBatches);
    current.attachRefresh(async () => accepted);
    current.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        if (id === ids[0]) throw new Error('WECHAT2RSS_RATE_LIMITED');
        return accepted;
      },
    }));
    const batch = await current.enqueueRefresh(ids);
    await current.runDue();
    current.close();
    const before = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
    expect(before.items[0].sharedRestriction).toBe(true);
    expect(before.nextSubmissionAt).toBe(clock + 120000);
    const legacy = make(Legacy) as any;
    const oldRecord = await legacy.read(batch.batchId);
    expect(oldRecord.items[0].sharedRestriction).toBe(true);
    const rollback = make(Compatible),
      refresh = jest.fn().mockResolvedValue(accepted);
    rollback.attachRefresh(refresh);
    expect((await rollback.list())[0].state).toBe('paused');
    await rollback.enqueueRefresh(['MP_WXS_9876543210']);
    await rollback.runDue();
    expect(refresh).not.toHaveBeenCalled();
    const retained = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
    expect(retained.nextSubmissionAt).toBe(before.nextSubmissionAt);
    expect(retained.items[0].submissionUnknown).toBe(true);
    expect(retained.items[0].sharedRestriction).toBe(true);
    clock += 150000;
    await rollback.runDue();
    expect(refresh.mock.calls.every((call) => call[0] !== ids[0])).toBe(true);
    expect(
      JSON.parse(await fs.readFile(file(batch.batchId), 'utf8')).state,
    ).toBe('paused');
  });
  it('demonstrates that the unmodified serial worker ignores the restriction and resumes unsent work', async () => {
    const current = make(Wechat2RssSubscriptionBatches),
      tail = 'MP_WXS_1234567999';
    current.attachRefresh(async () => accepted);
    current.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        if (id === ids[0]) throw new Error('WECHAT2RSS_RATE_LIMITED');
        return accepted;
      },
    }));
    const batch = await current.enqueueRefresh([...ids, tail]);
    await current.runDue();
    current.close();
    const legacy = make(Legacy),
      refresh = jest.fn().mockResolvedValue(accepted);
    legacy.attachRefresh(refresh);
    clock += 150000;
    await legacy.runDue();
    expect(refresh).toHaveBeenCalledWith(tail, 'submit');
    const record = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
    expect(record.items[0].sharedRestriction).toBe(true);
    expect(record.state).toBe('running');
  });
  it('recovers all five interrupted claims as unknown without reissuing an update', async () => {
    const current = make(Wechat2RssSubscriptionBatches),
      releases: Array<() => void> = [];
    current.attachRefresh(async () => accepted);
    current.attachRefreshPreparation(async () => ({
      release: () => {},
      submit: async () => {
        await new Promise<void>((r) => releases.push(r));
        return accepted;
      },
    }));
    const batch = await current.enqueueRefresh(ids);
    const pending = current.runDue();
    await until(() => releases.length === 5);
    current.close();
    releases.forEach((r) => r());
    await pending;
    const rollback = make(Compatible),
      refresh = jest.fn().mockResolvedValue(accepted);
    rollback.attachRefresh(refresh);
    clock += 60000;
    await rollback.runDue();
    const record = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
    expect(
      record.items.every(
        (i: any) =>
          i.state === 'blocked' && i.submissionUnknown && i.accepted === false,
      ),
    ).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, 'fixture.db'), 'utf8')).toBe(
      'fixture',
    );
  });
  it('is idempotent for compatible serial source and rejects a concurrent worker as rollback base', () => {
    const compatible = compatibleSerialRefreshWorker(serial);
    expect(compatibleSerialRefreshWorker(compatible)).toBe(compatible);
    expect(() =>
      compatibleSerialRefreshWorker('private async runRefreshWave('),
    ).toThrow('ROLLBACK_REQUIRES_SERIAL_BASE');
    expect(() =>
      compatibleSerialRefreshWorker(
        '// Bounded-wave rollback state compatibility.',
      ),
    ).toThrow('ROLLBACK_REBUILD_REQUIRED');
  });
  it('compatible serial recovery cannot treat a not-submitted proof as restriction release', async () => {
    const current = make(Wechat2RssSubscriptionBatches);
    current.attachRefresh(async () => accepted);
    current.attachRefreshPreparation(async (id) => ({
      release: () => {},
      submit: async () => {
        if (id === ids[0]) throw new Error('WECHAT2RSS_RATE_LIMITED');
        return accepted;
      },
    }));
    const batch = await current.enqueueRefresh([...ids, 'MP_WXS_1234567999']);
    await current.runDue();
    current.close();
    const rollback = make(Compatible),
      refresh = jest.fn().mockResolvedValue(accepted);
    rollback.attachRefresh(refresh);
    rollback.attachReconciliation(async () => 'not-submitted');
    clock += 150000;
    await rollback.runDue();
    const record = JSON.parse(await fs.readFile(file(batch.batchId), 'utf8'));
    expect(record.items[0].submissionUnknown).toBe(false);
    expect(record.items[0].sharedRestriction).toBe(true);
    expect(record.state).toBe('paused');
    expect(refresh).not.toHaveBeenCalled();
    const check = jest.fn().mockResolvedValue(false);
    rollback.attachRestrictionCheck(check);
    await rollback.runDue();
    expect(refresh).not.toHaveBeenCalled();
    clock += 120000;
    check.mockResolvedValue(true);
    await rollback.runDue();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
