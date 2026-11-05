import { SqliteWriteCoordinator } from './sqlite-write-coordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SQLite admission before connections and transactions', () => {
  it('drains an existing write, then backup, then new writes without replay', async () => {
    const gate = new SqliteWriteCoordinator();
    const existing = deferred(),
      copying = deferred();
    const events: string[] = [];
    const first = gate.write(async () => {
      events.push('first');
      await existing.promise;
    });
    const snapshot = gate.snapshot(async () => {
      events.push('backup');
      await copying.promise;
    });
    const second = gate.write(async () => {
      events.push('second');
      return 2;
    });
    await Promise.resolve();
    expect(events).toEqual(['first']);
    existing.resolve();
    await first;
    await Promise.resolve();
    expect(events).toEqual(['first', 'backup']);
    copying.resolve();
    await snapshot;
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first', 'backup', 'second']);
  });

  it('admits statements of an already admitted transaction without deadlocking a queued backup', async () => {
    const gate = new SqliteWriteCoordinator();
    const begun = deferred(),
      continueTx = deferred();
    const transaction = gate.write(async () => {
      begun.resolve();
      await continueTx.promise;
      return gate.write(async () => 42);
    });
    await begun.promise;
    const backup = gate.snapshot(async () => 'verified');
    continueTx.resolve();
    await expect(transaction).resolves.toBe(42);
    await expect(backup).resolves.toBe('verified');
  });

  it('rejects a backup requested from inside an admitted transaction instead of deadlocking', async () => {
    const gate = new SqliteWriteCoordinator();
    await expect(
      gate.write(() => gate.snapshot(async () => 1)),
    ).rejects.toThrow('已开始');
    await expect(gate.snapshot(async () => 2)).resolves.toBe(2);
  });

  it('does not run expired or overflowing queue entries later', async () => {
    jest.useFakeTimers();
    try {
      const gate = new SqliteWriteCoordinator(10, 1);
      const held = deferred();
      const backup = gate.snapshot(() => held.promise);
      await Promise.resolve();
      const operation = jest.fn(async () => 1);
      const queued = gate.write(operation);
      const rejected = expect(queued).rejects.toThrow('尚未开始');
      await expect(gate.write(operation)).rejects.toThrow('队列已满');
      await jest.advanceTimersByTimeAsync(10);
      await rejected;
      held.resolve();
      await backup;
      expect(operation).not.toHaveBeenCalled();
      await expect(gate.write(operation)).resolves.toBe(1);
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps writes out of the engine while child exit is uncertain', async () => {
    const gate = new SqliteWriteCoordinator();
    const first = {},
      second = {};
    gate.fence(first);
    gate.fence(second);
    const operation = jest.fn(async () => 1);
    const queued = gate.write(operation);
    gate.unfence(second);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    gate.unfence(first);
    await expect(queued).resolves.toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not let a detached expired async context bypass a later backup', async () => {
    const gate = new SqliteWriteCoordinator();
    const later = deferred(),
      copying = deferred();
    const operation = jest.fn(async () => 1);
    let detached!: Promise<number>;
    await gate.write(async () => {
      detached = later.promise.then(() => gate.write(operation));
    });
    const snapshot = gate.snapshot(() => copying.promise);
    await Promise.resolve();
    later.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    copying.resolve();
    await snapshot;
    await expect(detached).resolves.toBe(1);
  });

  it('releases admission after a failed verified backup without replaying a pending write', async () => {
    const gate = new SqliteWriteCoordinator();
    const held = deferred();
    const snapshot = gate.snapshot(async () => {
      await held.promise;
      throw new Error('verification failed');
    });
    const rejected = expect(snapshot).rejects.toThrow('verification failed');
    const operation = jest.fn(async () => 1);
    const queued = gate.write(operation);
    held.resolve();
    await rejected;
    await expect(queued).resolves.toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('waits for a nested write that started before its caller returned', async () => {
    const gate = new SqliteWriteCoordinator();
    const begun = deferred(),
      finish = deferred();
    let detached!: Promise<void>;
    await gate.write(async () => {
      detached = gate.write(async () => {
        begun.resolve();
        await finish.promise;
      });
      await begun.promise;
    });
    const operation = jest.fn(async () => 'verified');
    const snapshot = gate.snapshot(operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    finish.resolve();
    await detached;
    await expect(snapshot).resolves.toBe('verified');
  });
});
