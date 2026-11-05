import { SubscriptionProgress } from '@web/components/SubscriptionPrimitives';
import { Button } from '@nextui-org/react';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@web/utils/trpc';

type Batch = {
  batchId: string;
  state: string;
  updatedAt?: number;
  coverage?: {
    expected: number;
    submitted: number;
    completed: number;
    pending: number;
    legitimateSkipped: number;
    excluded: number;
    anomalies: number;
    fullyUpdated: boolean;
    items: { feedId?: string; status: string; reason: string }[];
  };
  items: {
    index: number;
    state: string;
    feedId?: string;
    accepted?: boolean;
    message: string;
  }[];
};

/** Displays the original durable batch; querying and stopping never submit /add. */
export default function ManualRefreshProgress({
  batch,
  feeds,
  onChange,
}: {
  batch?: Batch;
  feeds: { id: string; mpName: string }[];
  onChange: () => Promise<unknown>;
}) {
  const stop = trpc.feed.stopSubscriptionBatch.useMutation({ retry: false });
  const resume = trpc.feed.resumeSubscriptionBatch.useMutation({
    retry: false,
  });
  const busy = useRef(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [disclosure, setDisclosure] = useState<{
    batchId: string;
    open: boolean;
  }>();
  const coverage = batch?.coverage;
  const fullySuccessful = Boolean(
    batch?.state === 'completed' &&
    coverage?.fullyUpdated &&
    coverage.expected > 0 &&
    coverage.completed === coverage.expected &&
    coverage.submitted === coverage.expected &&
    !coverage.pending &&
    !coverage.legitimateSkipped &&
    !coverage.excluded &&
    !coverage.anomalies &&
    batch.items.every((item) => item.state === 'succeeded'),
  );
  const previous = useRef<{ batchId: string; state: string }>();
  const [recentSuccess, setRecentSuccess] = useState<string>();
  const batchId = batch?.batchId;
  const batchState = batch?.state;
  useEffect(() => {
    const before = previous.current;
    previous.current =
      batchId && batchState ? { batchId, state: batchState } : undefined;
    setRecentSuccess(undefined);
    // Initial history is quiet. Only an observed running -> successful transition
    // gets brief feedback, with no toast and no replay when the page is reopened.
    if (
      fullySuccessful &&
      before?.batchId === batchId &&
      ['queued', 'running'].includes(before?.state || '')
    ) {
      setRecentSuccess(batchId);
      const timer = setTimeout(() => setRecentSuccess(undefined), 5000);
      return () => clearTimeout(timer);
    }
  }, [batchId, batchState, fullySuccessful]);
  if (
    !batch ||
    (!['queued', 'running', 'paused'].includes(batch.state) && !batch.coverage)
  )
    return null;
  const accepted = batch.items.filter((item) => item.accepted).length;
  const synced = batch.items.filter(
    (item) => item.state === 'succeeded',
  ).length;
  const queued = batch.items.filter((item) => item.state === 'queued').length;
  const failed = batch.items.filter((item) =>
    ['blocked', 'failed'].includes(item.state),
  );
  const canResume =
    batch.state === 'paused' &&
    failed.length > 0 &&
    failed.every((item) => item.accepted);
  const act = async (action: 'stop' | 'resume') => {
    if (busy.current) return;
    busy.current = true;
    setActing(true);
    setError('');
    try {
      await (action === 'stop' ? stop : resume).mutateAsync({
        batchId: batch.batchId,
      });
      await onChange();
    } catch {
      setError('状态读取失败，请重新读取。');
    } finally {
      busy.current = false;
      setActing(false);
    }
  };
  const status = batch.coverage
    ? fullySuccessful
      ? '已全部更新'
      : batch.coverage.anomalies
        ? '需核对'
        : batch.coverage.pending
          ? '等待完成'
          : batch.coverage.legitimateSkipped || batch.coverage.excluded
            ? '部分订阅已跳过'
            : '需核对'
    : batch.state === 'paused'
      ? '已暂停'
      : '更新中';
  const finished =
    Number.isSafeInteger(batch.updatedAt) &&
    batch.updatedAt! > 0 &&
    batch.updatedAt! <= Date.now() + 300000
      ? new Date(batch.updatedAt!)
      : undefined;
  const lastSuccess = finished
    ? `上次更新成功 ${new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(finished)}`
    : '上次更新成功';
  // Polling may change the batch state. Only a new batch gets its default;
  // the user's choice for this batch must survive running/paused/completed.
  const detailsOpen =
    disclosure?.batchId === batch.batchId
      ? disclosure.open
      : batch.state === 'paused';
  return (
    <SubscriptionProgress
      ariaLabel={fullySuccessful ? '最近更新' : '全部更新进度'}
      compact={fullySuccessful}
      value={batch.coverage ? batch.coverage.completed : accepted}
      total={batch.items.length}
      progressLabel="已开始更新的订阅数量"
      label={
        batch.coverage
          ? `已完成 ${batch.coverage.completed}/${batch.coverage.expected} · ${status}`
          : `共 ${batch.items.length} 个 · 排队 ${queued} · 已开始 ${accepted} · 内容已同步 ${synced} · ${status}`
      }
      open={detailsOpen}
      onOpenChange={(open) => setDisclosure({ batchId: batch.batchId, open })}
      summary={
        fullySuccessful
          ? recentSuccess === batch.batchId
            ? '本轮全部更新完成。'
            : lastSuccess
          : detailsOpen
            ? '收起逐号进度'
            : '查看逐号进度'
      }
      notice={
        !fullySuccessful && batch.coverage && batch.coverage.anomalies > 0 ? (
          <p role="alert">部分更新需要处理，请查看详情。</p>
        ) : null
      }
      actions={
        <>
          {' '}
          {['queued', 'running', 'paused'].includes(batch.state) && (
            <Button
              size="sm"
              variant="light"
              isDisabled={acting}
              onPress={() => void act('stop')}
            >
              停止剩余更新
            </Button>
          )}
          {canResume && (
            <Button
              size="sm"
              variant="light"
              isDisabled={acting}
              onPress={() => void act('resume')}
            >
              继续处理
            </Button>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      }
    >
      {' '}
      {batch.coverage && (
        <p>
          {`本轮应更新 ${batch.coverage.expected} · 本轮已提交 ${batch.coverage.submitted} · 已完成 ${batch.coverage.completed} · 已跳过 ${batch.coverage.legitimateSkipped} · 待完成 ${batch.coverage.pending} · 异常 ${batch.coverage.anomalies}。`}
          {fullySuccessful ? '本轮全部更新完成。' : '本轮尚未全部更新完成。'}
        </p>
      )}
      <ul>
        {batch.items.map((item) => (
          <li key={item.index} className="py-1 text-xs">
            {feeds.find((feed) => feed.id === item.feedId)?.mpName ||
              `第 ${item.index + 1} 个公众号`}
            ：
            {item.state === 'queued'
              ? '排队，尚未发送'
              : item.state === 'submitting'
                ? '正在开始，结果待确认'
                : item.state === 'cancelled'
                  ? '已取消，未发送'
                  : item.state === 'succeeded'
                    ? '内容已同步'
                    : item.state === 'waiting'
                      ? '等待内容同步'
                      : '检查未完成'}
          </li>
        ))}
      </ul>
    </SubscriptionProgress>
  );
}
