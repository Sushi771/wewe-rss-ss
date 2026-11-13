import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';

/** Local in-memory diagnostics only; polling never requests the upstream. */
export default function CacheSyncStatus({ feedId }: { feedId: string }) {
  const status = trpc.feed.cacheSyncStatus.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchOnMount: 'always',
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const feed = status.data?.feeds.find((item) => item.feedId === feedId);
  const media = status.data?.media?.find((item) => item.feedId === feedId);
  if (status.isError)
    return (
      <p role="status" className="shrink-0 px-3 py-1 text-xs text-neutral-500">
        更新状态暂无法读取，请稍后查看
      </p>
    );
  const pause = status.data?.mediaPause;
  if (
    !feed &&
    !media &&
    !status.data?.mediaFailure &&
    pause !== 'local-cache-only'
  )
    return null;
  const state =
    pause === 'local-cache-only' && status.data?.metadataFailure
      ? '本地缓存暂无法读取，已有内容保留'
      : feed?.paused === true || feed?.state === 'paused'
        ? '更新已暂停'
        : feed?.state === 'media-pending'
          ? '文章已同步，部分正文或图片待确认'
          : feed?.state === 'synced-cache'
            ? '已保存内容已同步'
            : feed?.state === 'unavailable'
              ? '内容检查未完成'
              : '等待内容更新';
  const time = feed?.upstreamCheckTime
    ? `最近检查 ${dayjs(feed.upstreamCheckTime).format('MM-DD HH:mm')}`
    : '最近检查尚未确认';
  const mediaState =
    pause === 'local-cache-only'
      ? '仅同步本地缓存正文；保留已有内嵌图片，外部图片未新抓取、未验证'
      : status.data?.mediaFailure
        ? '图片补齐暂停，请查看详情'
        : media
          ? [
              media.failed ? `图片补齐失败 ${media.failed} 篇` : '',
              media.unconfirmed
                ? `图片完整性待确认 ${media.unconfirmed} 篇`
                : '',
              media.pending ? `图片待补 ${media.pending} 篇` : '',
              media.nextRetryAt
                ? `重试 ${dayjs(media.nextRetryAt).format('MM-DD HH:mm')}（已尝试 ${media.attempts}/4）`
                : '',
              pause === 'disabled'
                ? '自动图片下载已关闭'
                : pause === 'blocked'
                  ? '图片下载受限，已暂停'
                  : pause === 'night'
                    ? '夜间暂停图片下载'
                    : pause === 'metadata'
                      ? '等待更新状态确认'
                      : '',
            ]
              .filter(Boolean)
              .join('；')
          : '';
  return (
    <p
      role="status"
      className="shrink-0 px-3 py-1 text-xs text-neutral-500"
      title={
        [
          feed?.nextUpdateTime
            ? `下次检查 ${dayjs(feed.nextUpdateTime).format('MM-DD HH:mm')}`
            : '',
          status.data?.mediaFailure || media?.code || '',
        ]
          .filter(Boolean)
          .join('；') || undefined
      }
    >
      {time} · {state}
      {mediaState ? ` · ${mediaState}` : ''}
    </p>
  );
}
