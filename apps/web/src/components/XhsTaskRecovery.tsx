import { Button } from '@nextui-org/react';
import { SubscriptionProgress } from './SubscriptionPrimitives';
import {
  taskFinished,
  taskNextStep,
  taskText,
} from '@web/utils/xiaohongshu-subscription';
import type { RecoveredTask } from '@web/utils/xiaohongshu-subscription';

/** Task discovery and selection are local reads; continuation stays explicit. */
export default function XhsTaskRecovery({
  tasks,
  loading,
  error,
  disabled,
  selectedTaskId,
  open,
  onOpenChange,
  onRetry,
  onSelect,
  authorName,
}: {
  tasks: RecoveredTask[];
  loading: boolean;
  error: boolean;
  disabled: boolean;
  selectedTaskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onSelect: (task: RecoveredTask) => void;
  authorName: (creatorId: string) => string;
}) {
  if (!loading && !error && !tasks.length) return null;
  return (
    <SubscriptionProgress
      ariaLabel="最近笔记任务"
      compact
      value={0}
      total={0}
      progressLabel="本地任务记录"
      label="最近笔记任务"
      open={open}
      onOpenChange={onOpenChange}
      summary={open ? '收起最近任务' : '查看最近任务'}
    >
      <Button size="sm" variant="light" isDisabled={loading} onPress={onRetry}>
        重新读取任务
      </Button>
      {loading && <p role="status">正在读取本地任务记录…</p>}
      {error && (
        <p role="alert">
          本地任务记录暂时无法读取。可重新读取；不会自动开始采集。
        </p>
      )}
      <ul className="space-y-2 py-2">
        {tasks.map((task) => (
          <li key={task.taskId} className="min-w-0 rounded border p-2">
            <p className="break-words text-sm">
              {authorName(task.creatorId)} · {taskText(task)}
            </p>
            <p className="break-words text-xs text-neutral-500">
              {taskNextStep(task)}
            </p>
            <Button
              size="sm"
              variant="light"
              isDisabled={disabled || task.taskId === selectedTaskId}
              onPress={() => onSelect(task)}
            >
              {task.taskId === selectedTaskId
                ? '正在查看此任务'
                : taskFinished(task)
                  ? '查看未完成任务'
                  : '查看当前任务'}
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-500">
        这里只读取本地任务记录。继续未完成内容需要再次点击确认。
      </p>
    </SubscriptionProgress>
  );
}
