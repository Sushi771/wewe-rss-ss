import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';

/** A compact diagnostic read on selection, never an upstream completion claim. */
export default function CacheSyncStatus({ feedId }: { feedId: string }) {
  const status = trpc.feed.cacheSyncStatus.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchOnMount: 'always',
  });
  const feed = status.data?.feeds.find((item) => item.feedId === feedId);
  if (status.isError)
    return (
      <p role="status" className="shrink-0 px-3 py-1 text-xs text-neutral-500">
        上游状态暂无法读取
      </p>
    );
  if (!feed) return null;
  const state =
    feed.paused === true || feed.state === 'paused'
      ? '上游已暂停'
      : feed.state === 'media-pending'
        ? '缓存已同步，正文图片待核'
        : feed.state === 'synced-cache'
          ? '现存缓存已同步'
          : feed.state === 'unavailable'
            ? '缓存检查未完成'
            : '等待缓存变化';
  const time = feed.upstreamCheckTime
    ? `上游最近检查 ${dayjs(feed.upstreamCheckTime).format('MM-DD HH:mm')}`
    : '上游检查未确认';
  return (
    <p
      role="status"
      className="shrink-0 px-3 py-1 text-xs text-neutral-500"
      title={
        feed.nextUpdateTime
          ? `下次上游检查 ${dayjs(feed.nextUpdateTime).format('MM-DD HH:mm')}`
          : undefined
      }
    >
      {time} · {state}
    </p>
  );
}
