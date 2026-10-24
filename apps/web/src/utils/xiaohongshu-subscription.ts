/** Local contract boundary until the server router includes subscription tasks. */
export type SubscriptionResolution = {
  resolutionId: string;
  inputKind: 'note' | 'profile';
  author: { id: string; name: string; profileUrl: string; avatarUrl?: string };
  existingCreatorId: string | null;
  expiresAt: string | number;
};
export type SubscriptionTask = {
  kind: 'list' | 'download';
  state:
    | 'queued'
    | 'running'
    | 'completed'
    | 'partial'
    | 'blocked'
    | 'cancelled'
    | 'failed';
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  remaining: number;
  code?: string;
  message?: string;
};
export type TaskReceipt = { taskId: string; creatorId?: string };
export type SubscriptionClient = {
  resolveSubscription: {
    mutate(input: { url: string }): Promise<SubscriptionResolution>;
  };
  subscribe: {
    mutate(input: {
      resolutionId: string;
      groupId?: string;
    }): Promise<{ creatorId: string; created: boolean; subscribed: true }>;
  };
  refresh: { mutate(input: { id: string }): Promise<TaskReceipt> };
  downloadNotes: {
    mutate(input: {
      creatorId: string;
      noteIds: string[];
      pickToken?: string;
    }): Promise<TaskReceipt>;
  };
  task: { query(input: { taskId: string }): Promise<SubscriptionTask> };
  cancelTask: { mutate(input: { taskId: string }): Promise<unknown> };
};
export const taskFinished = (task: SubscriptionTask) =>
  task.state !== 'queued' && task.state !== 'running';

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
  query: SubscriptionClient['task']['query'];
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
      if (taskFinished(task)) return;
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
