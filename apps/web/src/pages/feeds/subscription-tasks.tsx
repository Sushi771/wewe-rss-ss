import { Button } from '@nextui-org/react';
import { useRef, useState } from 'react';
import { trpc } from '@web/utils/trpc';

type Props = {
  feeds: { id: string; mpName: string }[];
  adding: boolean;
  onSaved: (reveal: boolean) => Promise<void>;
};

/** Durable local progress only; the backend owns submission and sequencing. */
const SubscriptionTasks = ({ feeds, adding, onSaved }: Props) => {
  const seen = useRef(new Map<string, string>());
  const busy = useRef(false);
  const [refreshError, setRefreshError] = useState(false);
  const [acting, setActing] = useState<string>();
  const [actionError, setActionError] = useState('');
  const batches = trpc.feed.subscriptionBatches.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (data, query) =>
      query.state.status === 'error'
        ? false
        : adding ||
            data?.items.some(
              (batch) =>
                ['queued', 'running'].includes(batch.state) ||
                batch.items.some((item) =>
                  ['submitting', 'waiting'].includes(item.state),
                ),
            )
          ? 3000
          : false,
    async onSuccess(data) {
      const changes = data.items
        .flatMap((batch) =>
          batch.items.map((item) => ({
            ...item,
            key: `${batch.batchId}:${item.index}`,
          })),
        )
        .filter(
          (item) =>
            item.feedId &&
            seen.current.get(item.key) !==
              `${item.state}:${item.feedId}:${item.bodyReady}`,
        );
      if (!changes.length) return;
      try {
        await onSaved(
          adding ||
            changes.some(
              (item) =>
                seen.current.has(item.key) ||
                item.state === 'waiting' ||
                item.state === 'succeeded',
            ),
        );
        for (const item of changes)
          seen.current.set(
            item.key,
            `${item.state}:${item.feedId}:${item.bodyReady}`,
          );
        setRefreshError(false);
      } catch {
        setRefreshError(true);
      }
    },
  });
  const stop = trpc.feed.stopSubscriptionBatch.useMutation({ retry: false });
  const resume = trpc.feed.resumeSubscriptionBatch.useMutation({
    retry: false,
  });
  const act = async (batchId: string, action: 'stop' | 'resume') => {
    if (busy.current) return;
    busy.current = true;
    setActing(batchId);
    setActionError('');
    try {
      await (action === 'stop' ? stop : resume).mutateAsync({ batchId });
      await batches.refetch({ throwOnError: true });
    } catch {
      setActionError('操作结果暂未确认，请重新读取进度后核对。');
    } finally {
      busy.current = false;
      setActing(undefined);
    }
  };
  const items = batches.data?.items || [];
  const active = items.some(
    (batch) =>
      ['queued', 'running', 'paused'].includes(batch.state) ||
      batch.items.some((item) =>
        ['submitting', 'waiting'].includes(item.state),
      ),
  );
  if (!items.length && !batches.isError)
    return (
      <LegacySubscriptionTasks
        feeds={feeds}
        adding={adding}
        onSaved={onSaved}
        excluded={items.flatMap((batch) =>
          batch.items.flatMap((item) => (item.taskId ? [item.taskId] : [])),
        )}
      />
    );
  const labels = {
    queued: '等待处理',
    submitting: '正在提交',
    waiting: '等待首批缓存，完成后自动处理下一条',
    succeeded: '处理完成',
    failed: '未完成',
    blocked: '已暂停，请检查账号登录或官方验证',
    cancelled: '已停止，未提交',
    skipped: '重复链接，已跳过',
  };
  return (
    <section
      aria-label="订阅添加任务"
      className="shrink-0 border-b px-3 py-2 text-sm"
    >
      <LegacySubscriptionTasks
        feeds={feeds}
        adding={adding}
        onSaved={onSaved}
        excluded={items.flatMap((batch) =>
          batch.items.flatMap((item) => (item.taskId ? [item.taskId] : [])),
        )}
      />
      <details open={active || batches.isError || refreshError || undefined}>
        <summary className="cursor-pointer">添加进度与记录</summary>
        {batches.isError && (
          <p role="alert">
            添加进度暂时无法读取，已提交的任务不会重新发送。
            <Button size="sm" variant="light" onPress={() => batches.refetch()}>
              重新读取进度
            </Button>
          </p>
        )}
        {refreshError && (
          <p role="alert">
            订阅已保存，列表尚未显示。
            <Button
              size="sm"
              variant="light"
              onPress={async () => {
                try {
                  await onSaved(true);
                  setRefreshError(false);
                } catch {
                  setRefreshError(true);
                }
              }}
            >
              重新读取列表
            </Button>
          </p>
        )}
        {actionError && <p role="alert">{actionError}</p>}
        {items.map((batch) => (
          <div key={batch.batchId} className="mt-2 space-y-2">
            <p>
              本批 {batch.items.length} 条
              {batch.state === 'paused'
                ? ' · 已暂停'
                : batch.state === 'stopped'
                  ? ' · 已停止未执行项'
                  : batch.state === 'completed'
                    ? ' · 处理结束'
                    : ' · 依次处理'}
            </p>
            <ul role="status" aria-live="polite" className="space-y-2">
              {batch.items.map((item) => (
                <li key={item.index} className="flex flex-wrap gap-2">
                  <span>
                    第 {item.index + 1} 条：
                    {feeds.find((feed) => feed.id === item.feedId)?.mpName ||
                      '公众号待确认'}
                  </span>
                  <span>{labels[item.state]}</span>
                  {item.state === 'succeeded' && item.bodyReady === true && (
                    <span>正文已确认完成</span>
                  )}
                  {item.feedId && item.state !== 'succeeded' && (
                    <span>订阅已保存</span>
                  )}
                  {item.state === 'succeeded' && item.bodyReady === false && (
                    <span>正文尚未确认完整</span>
                  )}
                  {item.message && <span>{item.message}</span>}
                </li>
              ))}
            </ul>
            {['queued', 'running', 'paused'].includes(batch.state) && (
              <Button
                size="sm"
                variant="light"
                isLoading={acting === batch.batchId}
                isDisabled={!!acting}
                onPress={() => act(batch.batchId, 'stop')}
              >
                停止未执行项
              </Button>
            )}
            {batch.state === 'paused' && (
              <Button
                size="sm"
                variant="light"
                isLoading={acting === batch.batchId}
                isDisabled={!!acting}
                onPress={() => act(batch.batchId, 'resume')}
              >
                检查账号后继续
              </Button>
            )}
          </div>
        ))}
      </details>
    </section>
  );
};
export default SubscriptionTasks;

/** Accepted tasks from before batch support remain recoverable after reload. */
const LegacySubscriptionTasks = ({
  feeds,
  onSaved,
  excluded = [],
}: Props & { excluded?: string[] }) => {
  const seen = useRef(new Map<string, string>());
  const busy = useRef(false);
  const [error, setError] = useState(false);
  const tasks = trpc.feed.subscriptionTasks.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (data, query) =>
      query.state.status === 'error'
        ? false
        : data?.items.some(
              (task) =>
                (!excluded.includes(task.taskId) ||
                  task.phase === 'metadata') &&
                ['pending', 'running'].includes(task.state),
            )
          ? 3000
          : false,
    async onSuccess(data) {
      for (const task of data.items) {
        const key = `${task.state}:${task.feedId}:${task.phase}`;
        if (
          (excluded.includes(task.taskId) && task.phase !== 'metadata') ||
          !task.feedId ||
          seen.current.get(task.taskId) === key
        )
          continue;
        try {
          await onSaved(true);
          seen.current.set(task.taskId, key);
          setError(false);
        } catch {
          setError(true);
        }
      }
    },
  });
  const resume = trpc.feed.resumeSubscriptionTask.useMutation({ retry: false });
  const pending =
    tasks.data?.items.filter(
      (task) => !excluded.includes(task.taskId) && task.state !== 'succeeded',
    ) || [];
  if (!pending.length && !tasks.isError && !error) return null;
  return (
    <details open>
      <summary>先前添加任务</summary>
      {(tasks.isError || error) && (
        <p role="alert">
          先前任务或本地列表暂时无法读取。
          <Button size="sm" variant="light" onPress={() => tasks.refetch()}>
            重新读取
          </Button>
        </p>
      )}
      <div role="status" aria-live="polite">
        {pending.map((task) => (
          <p key={task.taskId}>
            {feeds.find((feed) => feed.id === task.feedId)?.mpName ||
              '先前提交的公众号'}
            ：
            {task.state === 'blocked'
              ? '已暂停，请检查账号或官方验证。'
              : task.state === 'failed'
                ? '暂未完成。'
                : '仍在处理，完成后自动更新列表。'}
            {['blocked', 'failed'].includes(task.state) && (
              <Button
                size="sm"
                variant="light"
                onPress={async () => {
                  if (busy.current) return;
                  busy.current = true;
                  try {
                    await resume.mutateAsync({ taskId: task.taskId });
                    await tasks.refetch({ throwOnError: true });
                    setError(false);
                  } catch {
                    setError(true);
                  } finally {
                    busy.current = false;
                  }
                }}
              >
                检查账号后继续检查
              </Button>
            )}
          </p>
        ))}
      </div>
    </details>
  );
};
