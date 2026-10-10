import {
  Button,
  Progress,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from '@nextui-org/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@web/utils/trpc';

type Props = {
  feeds: { id: string; mpName: string }[];
  adding: boolean;
  onSaved: (reveal: boolean) => Promise<void>;
};

type Exception = {
  key: string;
  batchId?: string;
  taskId?: string;
  name: string;
  state: string;
};
const notificationKey = 'wewe-subscription-notifications-v1';
function readNotifications(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(notificationKey) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved)
      ? saved
      : {};
  } catch {
    return {};
  }
}
function reason(state: string) {
  return state === 'blocked'
    ? '需要检查账号或完成官方验证。'
    : '暂未完成，请检查账号和服务后重试。';
}

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
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const items = batches.data?.items || [];
  const legacy = useLegacySubscriptionTasks({
    feeds,
    adding,
    onSaved,
    excluded: items.flatMap((batch) =>
      batch.items.flatMap((item) => (item.taskId ? [item.taskId] : [])),
    ),
  });
  const notified = useRef(readNotifications());
  const initialized = useRef(false);
  const activeBefore = useRef(new Set<string>());
  const active = items.filter(
    (batch) =>
      ['queued', 'running', 'paused'].includes(batch.state) ||
      batch.items.some((item) =>
        ['submitting', 'waiting'].includes(item.state),
      ),
  );
  useEffect(() => {
    if (!batches.data) return;
    const fresh: Exception[] = [];
    const observe = (key: string, signature: string, exception: Exception) => {
      const previous = notified.current[key];
      if (
        ['failed', 'blocked'].includes(exception.state) &&
        previous !== signature &&
        (initialized.current || adding || previous !== undefined)
      )
        fresh.push(exception);
      notified.current[key] = signature;
    };
    for (const batch of batches.data.items) {
      for (const item of batch.items)
        observe(`${batch.batchId}:${item.index}`, item.state, {
          key: `${batch.batchId}:${item.index}`,
          batchId: batch.batchId,
          name:
            feeds.find((feed) => feed.id === item.feedId)?.mpName ||
            `第 ${item.index + 1} 条`,
          state: item.state,
        });
      if (
        activeBefore.current.has(batch.batchId) &&
        batch.state === 'completed' &&
        batch.items.length > 0 &&
        batch.items.every((item) => item.state === 'succeeded')
      )
        toast.success(
          `添加完成 ${batch.items.length} / 共 ${batch.items.length}`,
          { duration: 3000 },
        );
    }
    const excluded = batches.data.items.flatMap((batch) =>
      batch.items.flatMap((item) => (item.taskId ? [item.taskId] : [])),
    );
    for (const task of (legacy.tasks.data?.items || []).filter(
      (task) => !excluded.includes(task.taskId),
    )) {
      if (
        task.state === 'succeeded' &&
        ['pending', 'running'].includes(notified.current[task.taskId])
      )
        toast.success('添加完成 1 / 共 1', { duration: 3000 });
      observe(task.taskId, task.state, {
        key: task.taskId,
        taskId: task.taskId,
        name:
          feeds.find((feed) => feed.id === task.feedId)?.mpName ||
          '先前添加任务',
        state: task.state,
      });
    }
    activeBefore.current = new Set(
      batches.data.items
        .filter(
          (batch) =>
            ['queued', 'running', 'paused'].includes(batch.state) ||
            batch.items.some((item) =>
              ['submitting', 'waiting'].includes(item.state),
            ),
        )
        .map((batch) => batch.batchId),
    );
    initialized.current = true;
    try {
      localStorage.setItem(notificationKey, JSON.stringify(notified.current));
    } catch {
      /* In-memory dedup still applies. */
    }
    if (fresh.length)
      setExceptions((previous) => [
        ...previous.filter(
          (old) => !fresh.some((item) => item.key === old.key),
        ),
        ...fresh,
      ]);
  }, [batches.data, legacy.tasks.data, adding, feeds]);
  const closeExceptions = () => setExceptions([]);
  const completed = active
    .flatMap((batch) => batch.items)
    .filter((item) => item.state === 'succeeded').length;
  const total =
    active.reduce((sum, batch) => sum + batch.items.length, 0) +
    legacy.pending.filter((task) => ['pending', 'running'].includes(task.state))
      .length;
  const waiting = active.some((batch) =>
    batch.items.some((item) => item.state === 'waiting'),
  );
  const paused = active.some((batch) => batch.state === 'paused');
  return (
    <>
      {adding && total === 0 && (
        <section
          aria-label="订阅添加进度"
          aria-live="polite"
          className="subscription-progress-summary"
        >
          <Progress
            aria-label="正在受理添加请求"
            label="正在受理添加请求"
            isIndeterminate
            size="sm"
          />
        </section>
      )}
      {total > 0 && (
        <section
          aria-label="订阅添加进度"
          aria-live="polite"
          className="subscription-progress-summary"
        >
          <Progress
            aria-label="已完成的订阅数量"
            value={completed}
            maxValue={total}
            showValueLabel={false}
            label={`已完成 ${completed} / 共 ${total}${paused ? ' · 已暂停' : waiting ? ' · 等待缓存' : ' · 处理中'}`}
            size="sm"
          />
          {active.map((batch) => (
            <Button
              key={batch.batchId}
              size="sm"
              variant="light"
              isDisabled={!!acting}
              isLoading={acting === batch.batchId}
              onPress={() => act(batch.batchId, 'stop')}
            >
              停止未执行项
            </Button>
          ))}
          {active
            .filter((batch) => batch.state === 'paused')
            .map((batch) => (
              <Button
                key={`resume:${batch.batchId}`}
                size="sm"
                variant="light"
                isDisabled={!!acting}
                isLoading={acting === batch.batchId}
                onPress={() => act(batch.batchId, 'resume')}
              >
                检查账号后继续
              </Button>
            ))}
        </section>
      )}
      {(batches.isError ||
        legacy.tasks.isError ||
        refreshError ||
        legacy.error) && (
        <p role="status" className="px-3 text-xs">
          {refreshError || legacy.error
            ? '订阅已保存，列表尚未显示。'
            : '进度暂时无法读取。'}
          <Button
            size="sm"
            variant="light"
            onPress={async () => {
              if (refreshError || legacy.error) {
                try {
                  await onSaved(true);
                  setRefreshError(false);
                  legacy.setError(false);
                } catch {
                  setRefreshError(true);
                }
              } else {
                await batches.refetch();
                await legacy.tasks.refetch();
              }
            }}
          >
            重新读取进度
          </Button>
        </p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      <Modal
        isOpen={exceptions.length > 0}
        onOpenChange={(open) => {
          if (!open) closeExceptions();
        }}
        portalContainer={
          typeof document === 'undefined' ? undefined : document.body
        }
        placement="center"
        scrollBehavior="inside"
        isKeyboardDismissDisabled={false}
        classNames={{
          backdrop: 'subscription-dialog-backdrop',
          wrapper: 'subscription-dialog-overlay',
          base: 'subscription-dialog',
          header: 'subscription-dialog-header',
          body: 'subscription-dialog-body',
          footer: 'subscription-dialog-footer',
          closeButton: 'subscription-dialog-close',
        }}
      >
        <ModalContent>
          <ModalHeader>添加需要处理（{exceptions.length} 条）</ModalHeader>
          <ModalBody tabIndex={0} aria-label="添加异常">
            <p role="alert">部分订阅暂未完成，其他任务继续在后台处理。</p>
            <details className="subscription-task-reason">
              <summary>查看需要处理的订阅</summary>
              {exceptions.map((item) => (
                <p key={item.key}>
                  {item.name}：{reason(item.state)}
                </p>
              ))}
            </details>
            {[
              ...new Set(
                exceptions.flatMap((item) =>
                  item.batchId &&
                  items.some(
                    (batch) =>
                      batch.batchId === item.batchId &&
                      batch.state === 'paused',
                  )
                    ? [item.batchId]
                    : [],
                ),
              ),
            ].map((batchId) => (
              <Button
                key={batchId}
                isDisabled={!!acting}
                isLoading={acting === batchId}
                onPress={() => act(batchId, 'resume')}
              >
                检查账号后继续
              </Button>
            ))}
            {exceptions
              .filter((item) => item.taskId)
              .map((item) => (
                <Button
                  key={item.key}
                  onPress={async () => {
                    if (legacy.busy.current) return;
                    legacy.busy.current = true;
                    try {
                      await legacy.resume.mutateAsync({ taskId: item.taskId! });
                      await legacy.tasks.refetch({ throwOnError: true });
                    } catch {
                      legacy.setError(true);
                    } finally {
                      legacy.busy.current = false;
                    }
                  }}
                >
                  检查账号后继续检查
                </Button>
              ))}
          </ModalBody>
          <ModalFooter>
            <span className="text-xs">关闭提示不取消后台任务。</span>
            <Button variant="flat" onPress={closeExceptions}>
              知道了
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
};

export default SubscriptionTasks;

/** Accepted tasks from before batch support remain recoverable after reload. */
const useLegacySubscriptionTasks = ({
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
      (task) =>
        !!task.taskId &&
        !excluded.includes(task.taskId) &&
        task.state !== 'succeeded',
    ) || [];
  return { pending, tasks, error, setError, resume, busy };
};
