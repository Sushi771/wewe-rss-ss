import type {
  XhsSubscriptionResolution,
  XhsSubscriptionTask,
} from '@wewe-rss/shared';

export type SubscriptionResolution = XhsSubscriptionResolution;
/** The optimistic receipt has counts before the first persisted task response. */
export type SubscriptionTask = Omit<
  XhsSubscriptionTask,
  'taskId' | 'creatorId' | 'message'
> & { message?: string; resumable?: boolean };
export type TaskReceipt = { taskId: string; creatorId?: string };
export const taskFinished = (task: SubscriptionTask) =>
  task.state !== 'queued' && task.state !== 'running';

export const taskSettling = (task: SubscriptionTask) =>
  taskFinished(task) && task.state !== 'completed' && task.resumable === false;

export function selectedImageNotes<T extends { id: string; kind: string }>(
  notes: T[],
  selected: Set<string>,
): T[] {
  return notes.filter(
    (note) => note.kind === 'image-text' && selected.has(note.id),
  );
}

export function taskText(task: SubscriptionTask): string {
  const states = {
    queued: '等待中',
    running: '进行中',
    completed: '已完成',
    partial: '部分完成',
    blocked: '暂时无法继续',
    cancelled: '已取消',
    failed: '未完成',
  };
  return `${task.kind === 'list' ? '更新笔记列表' : '下载并保存图文'}：${states[task.state]}。共 ${task.total} 篇，完成 ${task.completed}，跳过 ${task.skipped}，失败 ${task.failed}，剩余 ${task.remaining}。${task.message || ''}`;
}

/** Poll receipts only: a lost status response must never start another download. */
export async function watchSubscriptionTask(options: {
  taskId: string;
  query: (input: { taskId: string }) => Promise<SubscriptionTask>;
  signal: AbortSignal;
  onTask: (task: SubscriptionTask) => void;
  onError: (cause: unknown) => void;
  interval?: number;
}) {
  while (!options.signal.aborted) {
    try {
      const task = await options.query({ taskId: options.taskId });
      if (options.signal.aborted) return;
      options.onTask(task);
      if (taskFinished(task) && !taskSettling(task)) return;
    } catch (cause) {
      if (options.signal.aborted) return;
      options.onError(cause);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, options.interval ?? 1500);
      options.signal.addEventListener('abort', done, { once: true });
      if (options.signal.aborted) done();
    });
  }
}

/** Loading another page never changes the selected IDs from earlier pages. */
export function toggleLoadedSelection(
  previous: Set<string>,
  ids: readonly string[],
  selected: boolean,
) {
  const next = new Set(previous);
  for (const id of ids) {
    if (selected) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Each ZIP is bounded; a lost response stops the operation without replay. */
export async function exportArchiveBatches<
  T extends { notes: number },
>(options: {
  ids: readonly string[];
  send: (ids: string[]) => Promise<T>;
  save: (receipt: T, part: number, parts: number) => void;
  signal: AbortSignal;
  onProgress: (completed: number, total: number) => void;
}) {
  const ids = [...new Set(options.ids)];
  let completed = 0;
  const parts = Math.ceil(ids.length / 100);
  for (let offset = 0; offset < ids.length; offset += 100) {
    if (options.signal.aborted)
      return { completed, total: ids.length, cancelled: true };
    const batch = ids.slice(offset, offset + 100);
    const receipt = await options.send(batch);
    if (receipt.notes !== batch.length)
      throw new Error('导出回执篇数与所选范围不一致，已停止后续分批。');
    // A cancellation can arrive while the current ZIP is being generated.
    if (options.signal.aborted)
      return { completed, total: ids.length, cancelled: true };
    options.save(receipt, offset / 100 + 1, parts);
    completed += batch.length;
    options.onProgress(completed, ids.length);
  }
  return { completed, total: ids.length, cancelled: false };
}
