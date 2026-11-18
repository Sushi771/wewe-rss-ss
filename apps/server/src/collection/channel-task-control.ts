import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { batchStorageLock } from './batch-storage-lock';

export type CollectionChannel = 'wechat' | 'xiaohongshu';
export type HistoryRef = { kind: string; id: string; digest: string };
export type ChannelState = {
  version: 1;
  revision: number;
  paused: boolean;
  archived: HistoryRef[];
  receipts: Array<{ digest: string; backupSha256: string; at: number }>;
};
const scope = new AsyncLocalStorage<{
  channel: CollectionChannel;
  database: string;
  active: boolean;
  lease: { users: number; exclusive: boolean; release: () => Promise<void> };
}>();
export const historyDigest = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    )
    .digest('hex');
export function assertChannel(
  channel: unknown,
): asserts channel is CollectionChannel {
  if (channel !== 'wechat' && channel !== 'xiaohongshu')
    throw Error('CHANNEL_INVALID');
}
export function configuredTaskDatabase() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw.startsWith('file:')) throw Error('CHANNEL_SQLITE_REQUIRED');
  const name = decodeURIComponent(raw.slice(5).split('?')[0]);
  if (!name || /[\0\r\n]/.test(name)) throw Error('CHANNEL_SQLITE_REQUIRED');
  return path.isAbsolute(name)
    ? name
    : path.resolve(process.cwd(), 'prisma', name);
}
export async function taskDatabaseFor(db: {
  $queryRawUnsafe<T>(sql: string): Promise<T>;
}) {
  const rows = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>(
    'PRAGMA database_list',
  );
  const file = rows.find((r) => r.name === 'main')?.file;
  if (!file) throw Error('CHANNEL_SQLITE_REQUIRED');
  return fs.realpath(file);
}
async function directory(
  database: string,
  channel: CollectionChannel,
  create = false,
) {
  assertChannel(channel);
  const db = await fs.realpath(database);
  const folder = path.join(
    path.dirname(db),
    '.collection-channel-control',
    channel,
  );
  if (create) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    // Reject linked parent directories as well as linked state files.
    for (const item of [path.dirname(folder), folder]) {
      const stat = await fs.lstat(item);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(item)) !== item
      )
        throw Error('CHANNEL_STATE_INVALID');
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || create) throw e;
  }
  return folder;
}
export async function readChannelState(
  channel: CollectionChannel,
  database = configuredTaskDatabase(),
): Promise<ChannelState> {
  const file = path.join(await directory(database, channel), 'state.json');
  let value: ChannelState;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2)
      throw Error('CHANNEL_STATE_INVALID');
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw Error('CHANNEL_STATE_INVALID');
    return {
      version: 1,
      revision: 0,
      paused: false,
      archived: [],
      receipts: [],
    };
  }
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.paused !== 'boolean' ||
    !Array.isArray(value.archived) ||
    !Array.isArray(value.receipts) ||
    value.archived.length > 20000 ||
    value.receipts.length > 1000 ||
    value.archived.some(
      (r) =>
        !r ||
        typeof r.kind !== 'string' ||
        !/^[a-z-]{1,40}$/.test(r.kind) ||
        typeof r.id !== 'string' ||
        !/^[A-Za-z0-9:_-]{1,180}$/.test(r.id) ||
        !/^[a-f0-9]{64}$/.test(r.digest),
    ) ||
    value.receipts.some(
      (r) =>
        !r ||
        !/^[a-f0-9]{64}$/.test(r.digest) ||
        !/^[a-f0-9]{64}$/.test(r.backupSha256) ||
        !Number.isSafeInteger(r.at) ||
        r.at < 0,
    ) ||
    new Set(value.archived.map((r) => JSON.stringify([r.kind, r.id]))).size !==
      value.archived.length
  )
    throw Error('CHANNEL_STATE_INVALID');
  return value;
}
export async function historyArchived(
  channel: CollectionChannel,
  kind: string,
  id: string,
  database?: string,
) {
  return (await readChannelState(channel, database)).archived.some(
    (r) => r.kind === kind && r.id === id,
  );
}
export async function visibleHistory<T>(
  channel: CollectionChannel,
  kind: string,
  records: T[],
  id: (row: T) => string,
  database?: string,
) {
  const state = await readChannelState(channel, database);
  const hidden = new Set(
    state.archived.filter((r) => r.kind === kind).map((r) => r.id),
  );
  return records.filter((r) => !hidden.has(id(r)));
}
export async function assertChannelRunnable(
  channel: CollectionChannel,
  ref?: { kind: string; id: string },
  database?: string,
) {
  if (process.env.WECHAT2RSS_RECOVERY_HOLD === '1')
    throw Error('CHANNEL_GLOBAL_RECOVERY_HELD');
  if (
    process.env.WEWE_MANAGED_RUNTIME_MODE === 'manual-xhs-v1' &&
    channel === 'wechat'
  )
    throw Error('CHANNEL_MANAGED_WECHAT_PAUSED');
  const state = await readChannelState(channel, database);
  if (state.paused) throw Error('CHANNEL_PAUSED');
  if (ref && state.archived.some((r) => r.kind === ref.kind && r.id === ref.id))
    throw Error('CHANNEL_TASK_ARCHIVED');
  return state;
}

/** Keep channel administration outside a clock tick that can admit source work. */
export async function runChannelSchedule(
  channel: CollectionChannel,
  tick: (notBefore: number) => Promise<void>,
) {
  if (process.env.WEWE_MANAGED_RUNTIME_MODE !== 'scheduled-dual-v1') {
    await assertChannelRunnable(channel);
    return tick(0);
  }
  return withChannelExecution(channel, async () => {
    const state = await assertChannelRunnable(channel);
    if (!state.archived.length || !state.receipts.length)
      throw Error('CHANNEL_STATE_INVALID');
    const notBefore =
      Math.max(...state.receipts.map((receipt) => receipt.at)) + 1;
    if (!Number.isSafeInteger(notBefore)) throw Error('CHANNEL_STATE_INVALID');
    await tick(notBefore);
  });
}

async function activeExecutions(folder: string) {
  const names = (await fs.readdir(folder)).filter((n) =>
    /^execution-[a-f0-9-]{36}\.json$/.test(n),
  );
  if (names.length > 1000) throw Error('CHANNEL_STATE_INVALID');
  let active = false;
  for (const name of names) {
    const file = path.join(folder, name);
    let raw: string;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20)
        throw Error('CHANNEL_STATE_INVALID');
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!/^[1-9]\d{0,9}$/.test(raw)) throw Error('CHANNEL_STATE_INVALID');
    let alive = true;
    try {
      process.kill(Number(raw), 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (alive) {
      active = true;
      continue;
    }
    // Only an expired execution ownership marker. Source unknown/fence rows are
    // untouched; a dead owner is never interpreted as proof of non-dispatch.
    await fs.unlink(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return active;
}
async function enter<T>(
  channel: CollectionChannel,
  db: string,
  lease: { users: number; exclusive: boolean; release: () => Promise<void> },
  operation: () => Promise<T>,
) {
  const permit = { channel, database: db, active: true, lease };
  try {
    return await scope.run(permit, operation);
  } finally {
    permit.active = false;
    if (--lease.users === 0) await lease.release();
  }
}
/** Exclusive local administration. A live source owner makes preview/cleanup
 * fail closed; another channel never shares this lock or ownership markers. */
export async function withChannelLease<T>(
  channel: CollectionChannel,
  operation: () => Promise<T>,
  database = configuredTaskDatabase(),
): Promise<T> {
  const db = await fs.realpath(database),
    held = scope.getStore();
  if (held?.active && held.channel === channel && held.database === db) {
    if (!held.lease.exclusive) throw Error('CHANNEL_BUSY');
    held.lease.users++;
    return enter(channel, db, held.lease, operation);
  }
  const folder = await directory(db, channel, true);
  const release = await batchStorageLock(folder);
  if (!release) throw Error('CHANNEL_BUSY');
  try {
    if (await activeExecutions(folder)) throw Error('CHANNEL_BUSY');
  } catch (error) {
    await release();
    throw error;
  }
  return enter(channel, db, { users: 1, exclusive: true, release }, operation);
}
/** Register execution without replacing the established per-channel queues or
 * their source-risk/limit checks. Registration and administration are exclusive;
 * active executions may coexist exactly as the existing runners allow. */
export async function withChannelExecution<T>(
  channel: CollectionChannel,
  operation: () => Promise<T>,
  ref?: { kind: string; id: string },
  database = configuredTaskDatabase(),
): Promise<T> {
  const db = await fs.realpath(database),
    held = scope.getStore();
  if (held?.active && held.channel === channel && held.database === db) {
    if (held.lease.exclusive) throw Error('CHANNEL_ADMIN_SOURCE_FORBIDDEN');
    held.lease.users++;
    return enter(channel, db, held.lease, async () => {
      await assertChannelRunnable(channel, ref, db);
      return operation();
    });
  }
  const folder = await directory(db, channel, true);
  const deadline = performance.now() + 5000;
  let release = await batchStorageLock(folder);
  while (!release && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    release = await batchStorageLock(folder);
  }
  if (!release) throw Error('CHANNEL_BUSY');
  const claim = path.join(folder, `execution-${randomUUID()}.json`);
  try {
    await activeExecutions(folder);
    await assertChannelRunnable(channel, ref, db);
    const handle = await fs.open(claim, 'wx', 0o600);
    try {
      await handle.writeFile(String(process.pid));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await release();
  }
  return enter(
    channel,
    db,
    { users: 1, exclusive: false, release: () => fs.unlink(claim) },
    operation,
  );
}
/** Non-SQLite integrations retain their existing source admission. */
export async function withConfiguredChannelExecution<T>(
  channel: CollectionChannel,
  operation: () => Promise<T>,
  ref?: { kind: string; id: string },
) {
  if (process.env.WECHAT2RSS_RECOVERY_HOLD === '1')
    throw Error('CHANNEL_GLOBAL_RECOVERY_HELD');
  if (
    process.env.WEWE_MANAGED_RUNTIME_MODE === 'manual-xhs-v1' &&
    channel === 'wechat'
  )
    throw Error('CHANNEL_MANAGED_WECHAT_PAUSED');
  if (!(process.env.DATABASE_URL || '').startsWith('file:')) return operation();
  return withChannelExecution(channel, operation, ref);
}
/** A timer observes a busy/paused lane and defers; it must not become a failed
 * request or an unhandled rejection merely because another owner is active. */
export async function runChannelWorker(
  channel: CollectionChannel,
  operation: () => Promise<void>,
  database: string,
) {
  try {
    await withChannelExecution(channel, operation, undefined, database);
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'CHANNEL_BUSY',
        'CHANNEL_PAUSED',
        'CHANNEL_MANAGED_WECHAT_PAUSED',
        'CHANNEL_GLOBAL_RECOVERY_HELD',
        'CHANNEL_TASK_ARCHIVED',
      ].includes(error.message)
    )
      return;
    throw error;
  }
}
/** Call only while holding this channel's lease and the existing protected write admission. */
export async function commitChannelState(
  channel: CollectionChannel,
  next: ChannelState,
  database = configuredTaskDatabase(),
) {
  const held = scope.getStore();
  if (
    !held?.active ||
    held.channel !== channel ||
    held.database !== (await fs.realpath(database)) ||
    !held.lease.exclusive
  )
    throw Error('CHANNEL_LEASE_REQUIRED');
  const folder = await directory(database, channel, true);
  const target = path.join(folder, 'state.json');
  const temporary = path.join(folder, randomUUID() + '.tmp');
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
