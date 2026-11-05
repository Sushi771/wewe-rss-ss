type CreatorRefreshResult =
  | string
  | { status: string; failureScope?: string; failedCount?: number };

type RefreshStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type RefreshOutcome = { status: string };

export type PersistentCreatorBatch = {
  id: string;
  state: 'running' | 'paused' | 'stopped' | 'complete';
  items: Array<{
    position: number;
    creatorId: string;
    operationId: string;
    state: 'queued' | 'reserved' | 'complete' | 'partial' | 'cancelled';
    outcome?: unknown;
  }>;
};

const batchKey = 'xhs-refresh-batch';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Restore only by inspecting the durable batch, never by creating or advancing. */
export async function inspectPersistentBatch<T extends PersistentCreatorBatch>(
  storage: RefreshStorage,
  status: (id: string) => Promise<T>,
  active: () => Promise<T | null>,
): Promise<T | null> {
  let id: string | null;
  try {
    id = storage.getItem(batchKey);
  } catch {
    throw new Error('无法读取批次身份，已停止。');
  }
  if (id !== null) {
    if (!uuid.test(id)) throw new Error('本地批次身份无效，已停止。');
    const batch = await status(id);
    if (batch.id !== id) throw new Error('批次身份不一致，已停止。');
    return batch;
  }
  const batch = await active();
  if (batch) {
    if (!uuid.test(batch.id)) throw new Error('服务端批次身份无效，已停止。');
    try {
      storage.setItem(batchKey, batch.id);
      if (storage.getItem(batchKey) !== batch.id) throw new Error();
    } catch {
      throw new Error('无法保存批次身份，已停止。');
    }
  }
  return batch;
}

/** Record a client-generated identity before creation; uncertain outcomes remain
 * inspect-only after a reload. An existing or undiscoverable batch blocks create. */
export async function createPersistentBatch<T extends PersistentCreatorBatch>(
  storage: RefreshStorage,
  newId: () => string,
  active: () => Promise<T | null>,
  create: (id: string) => Promise<T>,
): Promise<T> {
  let old: string | null;
  try {
    old = storage.getItem(batchKey);
  } catch {
    throw new Error('无法读取批次身份，已停止。');
  }
  if (old !== null) throw new Error('已有批次身份，请先查看原批次。');
  if (await active()) throw new Error('已有服务端批次，请先查看。');
  const id = newId();
  if (!uuid.test(id)) throw new Error('无法创建批次身份，已停止。');
  try {
    storage.setItem(batchKey, id);
    if (storage.getItem(batchKey) !== id) throw new Error();
  } catch {
    throw new Error('无法保存批次身份，已停止。');
  }
  const batch = await create(id);
  if (batch.id !== id) throw new Error('批次身份不一致，已停止。');
  return batch;
}

/** Clearing identity is a separate user action, permitted only after terminal
 * state has been freshly inspected and still matches the locally saved ID. */
export function forgetTerminalBatch(
  storage: RefreshStorage,
  batch: PersistentCreatorBatch,
) {
  if (!['complete', 'stopped'].includes(batch.state))
    throw new Error('批次尚未结束，不能清除身份。');
  try {
    if (storage.getItem(batchKey) !== batch.id) throw new Error();
    storage.removeItem(batchKey);
  } catch {
    throw new Error('无法清除批次身份，已停止。');
  }
}

export async function advancePersistentBatch<T extends PersistentCreatorBatch>(
  initial: T,
  advance: (id: string) => Promise<T>,
  status: (id: string) => Promise<T>,
  shouldStop: () => boolean,
  onUpdate: (batch: T) => void,
): Promise<T> {
  let current = initial;
  for (let i = 0; i <= initial.items.length && !shouldStop(); i++) {
    if (current.state !== 'running') break;
    const previous = JSON.stringify(current);
    const next = await advance(current.id);
    if (next.id !== current.id) throw new Error('批次身份不一致。');
    if (shouldStop()) {
      current = await status(current.id);
      if (current.id !== initial.id) throw new Error('批次身份不一致。');
      onUpdate(current);
      break;
    }
    current = next;
    onUpdate(current);
    if (
      JSON.stringify(current) === previous ||
      current.items.some((item) => item.state === 'reserved')
    )
      break;
  }
  return current;
}

/** Persist identity before submission. An unresolved earlier operation is
 * inspected only: a missing receipt is not permission to submit again. */
export async function refreshCreatorWithReceipt<T extends RefreshOutcome>(
  creatorId: string,
  storage: RefreshStorage,
  newId: () => string,
  submit: (operationId: string) => Promise<T>,
  inspect: (operationId: string) => Promise<{ state: string; outcome?: T }>,
  onOperation?: (operationId: string) => void,
): Promise<T> {
  const key = `xhs-refresh-operation:${encodeURIComponent(creatorId)}`;
  let operationId: string | null;
  try {
    operationId = storage.getItem(key);
  } catch {
    throw new Error('无法读取本地更新回执，已停止。');
  }
  if (operationId !== null) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        operationId,
      )
    )
      throw new Error('本地更新回执无效，已停止。');
    onOperation?.(operationId);
    const receipt = await inspect(operationId);
    if (
      receipt.state !== 'complete' ||
      !receipt.outcome ||
      !['complete', 'partial'].includes(receipt.outcome.status)
    )
      throw new Error('上次更新结果尚未确认，已停止；不会重复提交。');
    try {
      if (storage.getItem(key) !== operationId) throw new Error();
      storage.removeItem(key);
    } catch {
      throw new Error('更新已完成，但本地回执未能清除；已停止。');
    }
    return receipt.outcome;
  }
  operationId = newId();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      operationId,
    )
  )
    throw new Error('无法创建更新身份，已停止。');
  try {
    storage.setItem(key, operationId);
    if (storage.getItem(key) !== operationId) throw new Error();
  } catch {
    throw new Error('无法保存本地更新回执，已停止。');
  }
  onOperation?.(operationId);
  const outcome = await submit(operationId);
  if (!['complete', 'partial'].includes(outcome.status))
    throw new Error('更新结果尚未确认，已停止；不会重复提交。');
  const receipt = await inspect(operationId);
  if (
    receipt.state !== 'complete' ||
    !receipt.outcome ||
    !['complete', 'partial'].includes(receipt.outcome.status)
  )
    throw new Error('更新回执尚未确认，已停止；不会重复提交。');
  try {
    if (storage.getItem(key) !== operationId) throw new Error();
    storage.removeItem(key);
  } catch {
    throw new Error('更新已完成，但本地回执未能清除；已停止。');
  }
  return receipt.outcome;
}

/** Continue only when the service explicitly identifies isolated note failures. */
export async function refreshCreatorBatch(
  ids: string[],
  refresh: (id: string) => Promise<CreatorRefreshResult>,
  shouldStop: () => boolean = () => false,
): Promise<{
  completed: number;
  partial: number;
  failedNotes: number;
  stopped?: boolean;
  remaining: number;
  failedId?: string;
  error?: string;
}> {
  let completed = 0;
  let partial = 0;
  let failedNotes = 0;
  for (const id of ids) {
    if (shouldStop())
      return {
        completed,
        partial,
        failedNotes,
        remaining: ids.length - completed - partial,
        stopped: true,
      };
    let result: CreatorRefreshResult;
    try {
      result = await refresh(id);
    } catch (cause) {
      return {
        completed,
        partial,
        failedNotes,
        remaining: ids.length - completed - partial - 1,
        failedId: id,
        error:
          cause instanceof Error ? cause.message : '更新未完成，既有归档保留。',
      };
    }
    const status = typeof result === 'string' ? result : result?.status;
    if (
      status === 'complete' &&
      (typeof result === 'string' ||
        (result.failureScope === undefined &&
          (result.failedCount === undefined || result.failedCount === 0)))
    ) {
      completed++;
    } else if (
      typeof result === 'object' &&
      result !== null &&
      status === 'partial' &&
      result.failureScope === 'article' &&
      Number.isSafeInteger(result.failedCount) &&
      (result.failedCount || 0) > 0
    ) {
      partial++;
      failedNotes += result.failedCount!;
    } else {
      return {
        completed,
        partial,
        failedNotes,
        remaining: ids.length - completed - partial - 1,
        failedId: id,
      };
    }
  }
  return { completed, partial, failedNotes, remaining: 0 };
}
