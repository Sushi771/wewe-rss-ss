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
export type RecoveredTask = XhsSubscriptionTask;

export function preferredRecoveredTask(tasks: readonly RecoveredTask[]) {
  return (
    tasks.find((task) => !taskFinished(task)) ||
    tasks.find((task) => task.resumable || taskSettling(task))
  );
}

export function canAdoptRecoveredTask(input: {
  requestedGeneration: number;
  currentGeneration: number;
  busy: boolean;
  alreadyRecovered: boolean;
}) {
  return (
    input.requestedGeneration === input.currentGeneration &&
    !input.busy &&
    !input.alreadyRecovered
  );
}

export function taskNextStep(task: SubscriptionTask) {
  if (taskSettling(task))
    return '正在结束当前保存，请等待确认；不会重复开始任务。';
  if (!taskFinished(task)) return '正在查看已存在任务的进度，不会创建新采集。';
  if (task.state === 'completed')
    return '此任务已完成，可继续阅读或导出已保存内容。';
  if (
    task.code?.startsWith('XHS_SOURCE_') ||
    task.code === 'XHS_SESSION_REQUIRED'
  )
    return '请先通过本机安全工具处理连接、验证或访问限制，再明确继续；已有内容保留。';
  if (task.code === 'XHS_RESUME_DIRECTORY_CHANGED')
    return '请选回此任务原来的保存目录，再继续未完成内容。';
  return task.resumable
    ? `任务尚未完成${task.remaining > 0 ? `，剩余 ${task.remaining} 项` : ''}。点击“继续未完成任务”后才会再次执行；已有内容保留。`
    : '任务尚未完成，请重新读取状态确认下一步；已有内容保留。';
}
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

/** Compose the existing verified text/image response for the shared inert reader.
 * Note text remains text, including HTML-looking snippets and literal symbols. */
export function noteReaderHtml(body: {
  text: string;
  images: readonly string[];
}) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char]!,
    );
  return `<article><p style="white-space:pre-wrap">${escape(body.text)}</p>${body.images.map((src, index) => `<img src="${escape(src)}" alt="第 ${index + 1} 张归档图片">`).join('')}</article>`;
}

/** Keep per-author authorization and ZIP boundaries while reporting one frozen scope. */
export async function exportArchiveGroups<
  T extends { notes: number },
>(options: {
  notes: readonly { id: string; creatorId: string }[];
  send: (creatorId: string, ids: string[]) => Promise<T>;
  save: (
    receipt: T,
    part: number,
    parts: number,
    creatorId: string,
    authors: number,
  ) => void;
  signal: AbortSignal;
  onProgress: (completed: number, total: number) => void;
}) {
  const groups = new Map<string, string[]>();
  for (const note of options.notes) {
    const ids = groups.get(note.creatorId) || [];
    if (!ids.includes(note.id)) ids.push(note.id);
    groups.set(note.creatorId, ids);
  }
  const total = [...groups.values()].reduce((sum, ids) => sum + ids.length, 0);
  let completed = 0;
  for (const [creatorId, ids] of groups) {
    const offset = completed;
    const result = await exportArchiveBatches({
      ids,
      signal: options.signal,
      send: (ids) => options.send(creatorId, ids),
      save: (receipt, part, parts) =>
        options.save(receipt, part, parts, creatorId, groups.size),
      onProgress: (count) => options.onProgress(offset + count, total),
    });
    completed += result.completed;
    if (result.cancelled) return { completed, total, cancelled: true };
  }
  return { completed, total, cancelled: false };
}
