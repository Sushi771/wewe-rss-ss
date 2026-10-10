import { Button, Progress } from '@nextui-org/react';
import { useRef, useState } from 'react';
import { trpc } from '@web/utils/trpc';

type Batch = {
  batchId: string;
  state: string;
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
  if (!batch || !['queued', 'running', 'paused'].includes(batch.state))
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
  const status = batch.state === 'paused' ? '已暂停' : '更新中';
  return (
    <section
      aria-label="全部更新进度"
      aria-live="polite"
      className="subscription-progress-summary"
    >
      <Progress
        size="sm"
        value={accepted}
        maxValue={batch.items.length}
        aria-label="上游更新受理数量"
        label={`共 ${batch.items.length} 个 · 排队 ${queued} · 上游已受理 ${accepted} · 缓存已同步 ${synced} · ${status}`}
      />
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
          继续检查缓存
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <details open={batch.state === 'paused'}>
        <summary>查看逐号进度</summary>
        <ul>
          {batch.items.map((item) => (
            <li key={item.index} className="py-1 text-xs">
              {feeds.find((feed) => feed.id === item.feedId)?.mpName ||
                `第 ${item.index + 1} 个公众号`}
              ：
              {item.state === 'queued'
                ? '排队，尚未发送'
                : item.state === 'submitting'
                  ? '正在提交，回执待确认'
                  : item.state === 'cancelled'
                    ? '已取消，未发送'
                    : item.state === 'succeeded'
                      ? '缓存已同步'
                      : item.state === 'waiting'
                        ? '等待缓存'
                        : '检查未完成'}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
