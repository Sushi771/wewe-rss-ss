import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';
import * as rollbackCompatibility from '../../../../scripts/local-release/refresh-wave-rollback-compat.cjs';

const { compatibleSerialRefreshWorker } = rollbackCompatibility;
// Load the actual committed serial worker, not a hand-written imitation. CI's
// source checkout includes history; this performs no network access.
const serial = execFileSync(
  'git',
  [
    'show',
    'f82fadeba752cffbc8934010c0bd05dc35b88675:apps/server/src/collection/wechat2rss-subscription-batches.ts',
  ],
  {
    cwd: path.resolve(__dirname, '../../../..'),
    encoding: 'utf8',
    windowsHide: true,
  },
);
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
  });
});
