import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

// Serialize same-process contenders through the entire file-claim lifetime.
// Other processes are still governed by the durable file lock below.
const localClaims = new Set<string>();

/** Same-host durable queue mutex. A dead owner's valid PID is recoverable;
 * malformed/empty claims fail closed. Recovery itself is serialized, so a
 * contender cannot remove a newly acquired worker claim. No timed lease can
 * expire while an upstream response is still outstanding. */
export async function batchStorageLock(
  directory: string,
  name = 'worker.lock',
) {
  if (!/^(?:worker|[a-f0-9-]{36}\.write)\.lock$/.test(name))
    throw Error('BATCH_INVALID');
  const identity = path.resolve(directory, name);
  if (localClaims.has(identity)) return;
  localClaims.add(identity);
  try {
    const release = await acquireFileClaim(directory, name);
    if (!release) {
      localClaims.delete(identity);
      return;
    }
    let finished = false;
    return async () => {
      if (finished) return;
      finished = true;
      try {
        await release();
      } finally {
        localClaims.delete(identity);
      }
    };
  } catch (error) {
    localClaims.delete(identity);
    throw error;
  }
}

async function acquireFileClaim(directory: string, name: string) {
  const lock = path.join(directory, name);
  const recovery = lock + '.recovery';
  const take = async () => {
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      try {
        await handle.writeFile(String(process.pid));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        await fs.unlink(lock);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
  };
  // New owners also honor recovery, including the gap after removal of a dead claim.
  try {
    await fs.access(recovery);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const release = await take();
  if (release) return release;
  let guard;
  try {
    guard = await fs.open(recovery, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    const stat = await fs.lstat(lock).catch(() => undefined);
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20))
      return;
    let raw: string;
    try {
      raw = stat ? await fs.readFile(lock, 'utf8') : '';
    } catch (error) {
      // The live owner may release between lstat and readFile. No claim was
      // acquired: return to the caller's existing bounded admission loop.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat && (!/^[1-9]\d{0,9}$/.test(raw) || alive(Number(raw)))) return;
    if (stat) await fs.unlink(lock);
    return await take();
  } finally {
    await guard.close();
    await fs.unlink(recovery);
  }
}
