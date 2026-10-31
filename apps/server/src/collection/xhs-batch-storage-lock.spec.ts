import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { batchStorageLock } from './batch-storage-lock';

describe('same-path admission around the durable file claim', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'lock-synthetic-')); });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

  it('keeps contenders out while the owner is live and while its unlink is settling', async () => {
    const lock = path.join(dir, 'worker.lock');
    const owner = await batchStorageLock(dir);
    expect(owner).toEqual(expect.any(Function));
    expect(await fs.readFile(lock, 'utf8')).toBe(String(process.pid));
    await expect(batchStorageLock(dir)).resolves.toBeUndefined();
    const unlink = fs.unlink.bind(fs);
    let entered!: () => void, unblock!: () => void;
    const enteredUnlink = new Promise<void>((resolve) => { entered = resolve; });
    const allowed = new Promise<void>((resolve) => { unblock = resolve; });
    const delayed = jest.spyOn(fs, 'unlink').mockImplementation(async (p) => {
      if (p === lock) { entered(); await allowed; }
      return unlink(p);
    });
    const releasing = owner!();
    await enteredUnlink;
    await expect(batchStorageLock(dir)).resolves.toBeUndefined();
    unblock();
    await releasing;
    delayed.mockRestore();
    const next = await batchStorageLock(dir);
    expect(next).toEqual(expect.any(Function));
    await owner!(); // an old release must never remove a later owner's claim
    expect(await fs.readFile(lock, 'utf8')).toBe(String(process.pid));
    await next!();
  });

  it('propagates real permission errors and does not pretend to own a claim', async () => {
    const lock = path.join(dir, 'worker.lock');
    const open = fs.open.bind(fs);
    const denied = jest.spyOn(fs, 'open').mockImplementation((async (...args: any[]) => {
      if (args[0] === lock) throw Object.assign(new Error('synthetic access denied'), { code: 'EPERM' });
      return (open as any)(...args);
    }) as any);
    await expect(batchStorageLock(dir)).rejects.toMatchObject({ code: 'EPERM' });
    denied.mockRestore();
    const next = await batchStorageLock(dir);
    expect(next).toEqual(expect.any(Function));
    await next!();
  });

  it('honours an externally created live-owner claim and recovers a proven dead owner', async () => {
    const lock = path.join(dir, 'worker.lock');
    await fs.writeFile(lock, String(process.pid));
    await expect(batchStorageLock(dir)).resolves.toBeUndefined();
    expect(await fs.readFile(lock, 'utf8')).toBe(String(process.pid));
    await fs.writeFile(lock, '987654321');
    const realKill = process.kill.bind(process);
    const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: any) => {
      if (pid === 987654321) throw Object.assign(new Error('synthetic dead owner'), { code: 'ESRCH' });
      return realKill(pid, signal);
    }) as typeof process.kill);
    const recovered = await batchStorageLock(dir);
    expect(recovered).toEqual(expect.any(Function));
    expect(await fs.readFile(lock, 'utf8')).toBe(String(process.pid));
    await recovered!();
    kill.mockRestore();
  });
});
